import { resolveSrv } from 'node:dns/promises'
import { directoryCatalog, directoryRegions } from './browserCatalog.js'
import { proxyAwareFetch } from '../../utils/systemProxy.js'
import { requiredProxyFetch, outboundProxyKey } from '../../utils/outboundProxy.js'
import { createGuardedFetch } from '../../utils/logoCache.js'
import { fetchUpstreamResponse } from '../../utils/hlsProxy.js'
import { inspectStream } from '../../utils/webSourceExtractor.js'

const publicFetch = createGuardedFetch()
const publicProxyFetch = createGuardedFetch({ fetchImpl: requiredProxyFetch })
const snapshots = new Map()
const selections = new WeakMap()
const codes = Object.keys(directoryRegions)

async function mirrors() {
  const records = await resolveSrv('_api._tcp.radio-browser.info').catch(() => [])
  return [...new Set([...records.map(r => r.name).filter(host => /^[a-z0-9-]+\.api\.radio-browser\.info$/i.test(host)),
    'de1.api.radio-browser.info'])]
}

async function fetchRegion(host, code, fetchImpl, signal) {
  const rows = []
  const size = 2000
  for (let offset = 0; ; offset += size) {
    const url = new URL('/json/stations/bycountrycodeexact/' + code, 'https://' + host)
    url.search = new URLSearchParams({ hidebroken: 'true', order: 'stationuuid', limit: size, offset })
    const response = await fetchImpl(url.href, { signal, headers: { 'User-Agent': 'iPTV-RadioBrowser/1.0' } })
    if (!response.ok) {
      await response.body?.cancel()
      throw Error('Radio Browser HTTP ' + response.status)
    }
    const page = await response.json()
    if (!Array.isArray(page) || (!offset && !page.length)) throw Error('Radio Browser 地区目录为空或格式错误')
    rows.push(...page)
    if (page.length < size) return rows
  }
}

export async function loadDirectory({ hosts, fetchImpl = proxyAwareFetch, timeoutMs = 15000 } = {}) {
  let lastError
  for (const host of hosts || await mirrors()) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const pages = await Promise.all(codes.map(code => fetchRegion(host, code, fetchImpl, controller.signal)))
      return directoryCatalog(pages.flat())
    } catch (err) {
      lastError = err
    } finally {
      clearTimeout(timer)
      controller.abort()
    }
  }
  throw lastError || Error('Radio Browser 镜像不可用')
}

// Even when only HK is enabled, its frequencies can be filed under CN in the directory.
function snapshot(useProxy) {
  const key = useProxy ? 'proxy:' + outboundProxyKey() : 'default'
  const existing = snapshots.get(key)
  if (existing && Date.now() < existing.until) return existing.promise
  const entry = { until: Date.now() + 60000 }
  entry.promise = loadDirectory({ fetchImpl: useProxy ? requiredProxyFetch : proxyAwareFetch })
    .catch(error => { if (snapshots.get(key) === entry) snapshots.delete(key); throw error })
  snapshots.set(key, entry)
  return entry.promise
}

export async function resolveDirectoryStation(station, fetchImpl, inspect = inspectStream) {
  if (!station?.lines.length) return { url: '', status: 404, desc: '此电台已移出目录' }
  if (station.lines.length === 1) return { url: station.lines[0].url }
  // Start candidates in preference order. Probe small batches to bound startup latency.
  for (let i = 0; i < station.lines.length; i += 3) {
    const lines = station.lines.slice(i, i + 3)
    const results = await Promise.all(lines.map(line => inspect(line.url, { fetchImpl })))
    const index = results.findIndex(kind => kind === 'audio' || kind === 'hls' || (kind === 'video' && station.officialRadioRef?.startsWith('radio-tdm-')))
    if (index !== -1) return { url: lines[index].url }
  }
  return { url: '', status: 502, desc: '本次未能打开该电台的任何目录线路' }
}

export function regionDirectory(id, code, region, getGroups, loadCatalog = snapshot) {
  const refPattern = new RegExp('^radio-rb-' + code.toLowerCase() + '-[a-f0-9]{16}$')
  let cachedGroups, byRef, backups
  function refreshIndex() {
    const groups = getGroups(id)
    if (groups !== cachedGroups) {
      byRef = new Map()
      backups = new Map()
      for (const group of groups) {
        for (const channel of group.dataList) {
          if (!refPattern.test(channel.deferredRef)) continue
          byRef.set(channel.deferredRef, channel)
          if (channel.officialRadioRef) backups.set(channel.officialRadioRef, channel.deferredRef)
        }
      }
      cachedGroups = groups
    }
  }
  function station(ref) {
    refreshIndex()
    return byRef.get(ref)
  }
  return {
    id, name: region + '广播', category: 'radio', region, defaultEnabled: false,
    description: region + '网络广播。目录每日刷新，同台合并线路，已启用的官方频率排在前面。',
    capabilities: { resolve: true, cache: 'disk', epg: false, catchup: false }, playbackRequiresEnabled: true,
    catalogVersion: 4, defaultRefreshMinutes: 1440,
    configSchema: [{ key: 'useProxy', type: 'boolean', default: false, label: '经网络代理转发',
      hint: '目录、线路检测和播放使用「设置 → 网络代理」配置的出口。' }],
    async fetch(config = {}) {
      const catalog = await loadCatalog(config.useProxy === true)
      return { groups: [{ name: region + '广播', dataList: catalog[code].filter(station => station.region === region) }] }
    },
    backupRef(ref) { refreshIndex(); return backups.get(ref) },
    claimsCachedRef: ref => refPattern.test(ref),
    claimsRef: ref => refPattern.test(ref) && Boolean(station(ref)),
    radioExtension(ref) {
      const lines = station(ref)?.lines || []
      return lines.every(line => line.extension === lines[0].extension) ? lines[0]?.extension || '' : ''
    },
    resolve(ref, { config = {} } = {}) {
      const channel = station(ref)
      const fetchImpl = config.useProxy ? publicProxyFetch : publicFetch
      if (!channel || channel.lines.length < 2) return resolveDirectoryStation(channel, fetchImpl)
      // Reuse the selection across the browser's format check and HLS playlist reloads.
      const route = config.useProxy ? 'proxy:' + outboundProxyKey() : 'default'
      const current = selections.get(channel)
      if (current?.route === route && Date.now() < current.until) return current.promise
      const entry = { route, until: Infinity }
      entry.promise = resolveDirectoryStation(channel, fetchImpl).then(result => {
        entry.until = Date.now() + (result.url ? 20000 : 0)
        return result
      }).finally(() => {
        if (entry.until === Infinity) entry.until = 0
      })
      selections.set(channel, entry)
      return entry.promise
    },
    fetchProxyMedia(ref, config, url, options) {
      return fetchUpstreamResponse(url, { ...options, fetchImpl: config.useProxy ? publicProxyFetch : publicFetch })
    },
  }
}
