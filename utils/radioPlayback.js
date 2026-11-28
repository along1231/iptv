import { Readable } from 'node:stream'
import { fetch as directFetch } from 'undici'
import { firstVariantUrl, rewriteManifest } from './appUtils.js'
import { fetchUpstreamResponse, toProxyManifest } from './hlsProxy.js'
import { topVariantFirst } from './hlsTopFirst.js'
import { customSourceFetch, upstreamHeadersOf } from './customSourceProxy.js'
import { outboundProxyUrl, requiredProxyFetch } from './outboundProxy.js'
import { sendLocalMediaResponse } from './localMediaResponse.js'

const types = { m3u8: 'application/vnd.apple.mpegurl', aac: 'audio/aac', mp3: 'audio/mpeg',
  m4a: 'audio/mp4', ogg: 'audio/ogg', opus: 'audio/ogg', flac: 'audio/flac', wav: 'audio/wav' }
const manifestLimit = 2 * 1024 * 1024

export function customRadioFetch(source) {
  return (url, options) => fetchUpstreamResponse(url, {
    ...options, fetchImpl: source.requireProxy ? requiredProxyFetch : source.useProxy ? customSourceFetch : directFetch,
  })
}

// 部分电台地址没有扩展名，甚至返回 application/octet-stream。检查流头后继续用同一连接，
// 避免为判断格式下载整段直播，或在重连时丢掉开头的音频帧。
async function openMedia(url, options, fetchMedia) {
  const response = await fetchMedia(url, options)
  if (!response.ok || !response.body) {
    await response.body?.cancel()
    throw Error('广播上游不可用')
  }
  const reader = response.body.getReader()
  const chunks = []
  let size = 0
  while (size < 16) {
    const { value, done } = await reader.read()
    if (done) break
    chunks.push(value)
    size += value.length
  }
  if (!size) throw Error('空广播流')
  const prefix = Buffer.concat(chunks, size).subarray(0, 32).toString().trimStart()
  if (!prefix.startsWith('#EXTM3U')) {
    if (prefix.startsWith('<') || /text\/html|mpegurl/i.test(response.headers.get('content-type') || '')) {
      throw Error('广播内容无效')
    }
    const body = Readable.from((async function* () {
      yield* chunks
      while (true) {
        const { value, done } = await reader.read()
        if (done) return
        yield value
      }
    })())
    return { response, body }
  }
  while (size <= manifestLimit) {
    const { value, done } = await reader.read()
    if (done) return { text: Buffer.concat(chunks, size).toString(), url: response.url || url }
    chunks.push(value)
    size += value.length
  }
  throw Error('广播清单过大')
}

// 调用方已通过配置取到固定的频道或模块，播放器不能指定回源 URL。
export async function serveRadioMode(req, res, { ref, module, source, mode, extension, config = {}, isBackup = false }) {
  const method = req.method
  const headers = { 'Cache-Control': 'no-store' }
  if (method === 'HEAD' || method === 'OPTIONS') {
    if (types[extension]) headers['Content-Type'] = types[extension]
    return sendLocalMediaResponse(res, method, { headers })
  }
  if (method !== 'GET') return sendLocalMediaResponse(res, method, { status: 405 })
  const ctrl = new AbortController()
  const stop = () => ctrl.abort()
  res.once('close', stop)
  let timer
  try {
    if (module?.claimsLocalPath?.('/' + ref)) {
      const local = await module.handleLocalRequest({ path: '/' + ref, method, config })
      if (local?.status === 502) throw Error('广播音频未能起播')
      return await sendLocalMediaResponse(res, method, local)
    }
    const url = source?.url || (await module.resolve(ref, { config })).url
    if (!url || res.destroyed) throw Error('广播地址不可用')
    const fetchMedia = source ? customRadioFetch(source) : (url, options) => module.fetchProxyMedia(ref, config, url, options)
    const upstreamHeaders = upstreamHeadersOf(source?.opts)
    const options = { upstreamHeaders, signal: ctrl.signal }
    timer = setTimeout(stop, 15000)
    let media = await openMedia(url, options, fetchMedia)
    if (media.body) {
      clearTimeout(timer) // 超时只管起播。连续音频直到播放器断开才结束。
      const mime = media.response.headers.get('content-type')
      const fallback = extension === 'm3u8' ? undefined : types[extension]
      headers['Content-Type'] = /^audio\//i.test(mime || '') ? mime : fallback || mime || 'application/octet-stream'
      return await sendLocalMediaResponse(res, method, { headers, body: media.body, dispose: stop })
    }
    if (source?.topFirst) media.text = topVariantFirst(media.text)
    // 独立音轨须保留主清单的分组选择；普通主清单拍平一层，兼容简单播放器。
    const variant = !/^#EXT-X-MEDIA:.*\bURI="/m.test(media.text) && firstVariantUrl(media.text, media.url)
    if (variant) {
      media = await openMedia(variant, options, fetchMedia)
      if (!media.text) throw Error('广播子清单无效')
    }
    let text = rewriteManifest(media.text, media.url)
    const forceProxy = isBackup || config.useProxy || source?.requireProxy || (source?.useProxy && outboundProxyUrl())
    if (mode === 'proxy' || forceProxy) {
      text = toProxyManifest(text, ref, undefined, upstreamHeaders, undefined, undefined,
        mode === 'relay' ? '../proxy/' : '')
    }
    const body = Buffer.from(text)
    return await sendLocalMediaResponse(res, method, { headers: { ...headers,
      'Content-Type': types.m3u8, 'Content-Length': body.length }, body })
  } catch {
    if (!res.destroyed && !res.headersSent) {
      const alternate = !isBackup && module?.backupRef?.(ref)
      if (alternate) {
        clearTimeout(timer)
        stop()
        return await serveRadioMode(req, res, { ref: alternate, module, mode, config, isBackup: true })
      }
      await sendLocalMediaResponse(res, method, { status: 502, headers, body: '暂时无法取得广播流' })
    }
  } finally {
    clearTimeout(timer)
    res.off('close', stop)
    stop()
  }
}
