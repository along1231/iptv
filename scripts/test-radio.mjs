import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'iptv-radio-'))
process.env.mdataDir = dir
process.env.mbuiltInSourcesUrl = ''
try {
  const { listModules, resolverFor, localRequestHandlerFor } = await import('../extractors/registry.js')
  const { logoCandidates } = await import('../utils/updateData.js')
  const { parseInterfaceTxt, generateM3u8, saveConfig } = await import('../utils/playlistConfig.js')
  const modules = listModules().filter(module => module.category === 'radio')
  const refs = new Set()
  assert.equal(modules.length, 18)
  for (const module of modules) {
    assert.equal(module.defaultEnabled, false)
    const { groups: [group] } = await module.fetch()
    assert.equal(group.name, module.name)
    assert.equal(Boolean(module.epg), module.capabilities.epg)
    for (const { ref, key } of module.epg?.channels() || []) {
      assert.equal(ref, 'radio-' + key)
      assert.ok(group.dataList.some(channel => channel.deferredRef === ref))
    }
    for (const entry of group.dataList) {
      const ref = entry.deferredRef
      assert.equal(entry.radio, true)
      assert.equal(entry.catchup, 'none')
      assert.ok(!refs.has(ref))
      refs.add(ref)
      assert.equal(resolverFor(ref), module)
      assert.equal(localRequestHandlerFor('/' + ref + '.mp3'), module)
      // Merger rejects source data carrying its private substitution token, even in a logo.
      assert.ok(!JSON.stringify(entry).includes('${replace}'))
      const [logo] = logoCandidates({ ...entry, sourceId: 'xt:' + module.id }, group.name, false)
      assert.ok(logo?.url, ref + ' 缺台标')
      if (entry.logo.startsWith('/radio-icons/')) {
        assert.equal(logo.url, '${replace}' + entry.logo)
        const owner = localRequestHandlerFor(entry.logo)
        const image = await owner.handleLocalRequest({ path: entry.logo, method: 'GET' })
        assert.ok(image.body.length > 0)
        assert.match(image.headers['Content-Type'], /^image\//)
      }
    }
  }
  assert.equal(refs.size, 152)
  assert.equal(localRequestHandlerFor('/radio-unknown.mp3'), null)
  assert.equal(localRequestHandlerFor('/radio-icons/missing.svg'), null)
  const head = await localRequestHandlerFor('/radio-ner-1').handleLocalRequest({ path: '/radio-ner-1', method: 'HEAD' })
  assert.equal(head.headers['Content-Type'], 'audio/aac')
  writeFileSync(join(dir, 'interface.txt'), '#EXTM3U\n#EXTINF:-1 tvg-id="电台" radio="true" group-title="香港广播",电台\n${replace}/radio-radio1\n#EXTINF:-1 tvg-id="电视" group-title="香港",电视\n${replace}/tv\n')
  const playlist = generateM3u8(parseInterfaceTxt())
  assert.match(playlist, /radio="true"[^\n]*,电台/)
  assert.equal(playlist.match(/radio="true"/g).length, 1)
  const { interfaceStr } = await import('../utils/appUtils.js')
  const headers = { host: '127.0.0.1:1905' }
  const radioKey = '香港广播::radio-radio1'
  const tvKey = '香港::tv'
  assert.ok(saveConfig('mixed', {
    customGroups: [{ name: '收藏' }],
    channelGroupMap: { [radioKey]: '收藏', [tvKey]: '收藏' },
    channelRenameMap: { [radioKey]: '早间电台' },
    channelOrder: { 收藏: [tvKey, radioKey] },
  }).success)
  for (const [mode, radioPath] of [['', 'radio-radio1'], ['1', 'relay/radio-radio1.m3u8'], ['2', 'proxy/radio-radio1.m3u8']]) {
    const mixedList = interfaceStr('/interface.m3u', headers, '', '', 'mixed', '/demo', mode).content
    const entries = mixedList.split('\n').filter(line => line.startsWith('#EXTINF:'))
    assert.equal(entries.length, 2)
    assert.match(entries[0], /group-title="收藏",电视$/)
    assert.match(entries[1], /radio="true".*group-title="收藏",早间电台$/)
    assert.ok(mixedList.includes('http://127.0.0.1:1905/demo/' + radioPath))
    assert.doesNotMatch(mixedList, /identity-url=/)
    const ordinary = interfaceStr('/interface.m3u', headers, '', '', 'default', '', mode).content
    assert.match(ordinary, /group-title="香港广播",电台/)
    assert.match(ordinary, /group-title="香港",电视/)
  }
  const { default: external, parsePlaylistContent } = await import('../utils/externalSources.js')
  const mixed = [
    '#EXTM3U',
    '#EXTINF:-1 radio="true" group-title="澳门",中文台', 'http://local/ch',
    '#EXTINF:-1 RADIO="1" group-title="香港广播",一台', 'http://local/hk',
    '#EXTINF:-1 radio=true,无分组电台', 'http://local/fm',
    '#EXTINF:-1 radio="false" group-title="香港",电视', 'http://local/tv',
    '#EXTINF:-1 tvg-name="带 radio=1 的台名" group-title="香港",TV radio=1', 'http://local/tv2',
  ].join('\n')
  const parsedChannels = parsePlaylistContent(mixed)
  assert.deepEqual(parsedChannels.map(ch => !!ch.radio), [true, true, true, false, false])
  external.saveSources({ enabled: true, sources: [
    { enabled: true, group: '广东', mode: 'subscription', parsedChannels },
    { enabled: true, group: '澳门', name: '直连电台', radio: true, m3u8Url: 'http://local/direct' },
    { enabled: true, group: '香港', name: '旧直连电视', m3u8Url: 'http://local/old' },
  ] })
  const imported = external.getValidChannels().flatMap(g => g.dataList)
  assert.deepEqual(imported.filter(ch => ch.radio).map(ch => [ch.name, ch.groupTitle]), [
    ['中文台', '澳门广播'], ['直连电台', '澳门广播'], ['一台', '香港广播'], ['无分组电台', '广东广播'],
  ])
  assert.deepEqual(imported.filter(ch => !ch.radio).map(ch => ch.groupTitle), ['香港', '香港', '香港'])
  // 广播端点无后缀、无 Content-Length 且永不结束。验证必须读少量数据后主动断开。
  const { inspectStream } = await import('../utils/webSourceExtractor.js')
  const server = createServer((req, res) => {
    if (req.url === '/mount') {
      res.writeHead(200, { 'Content-Type': 'audio/mpeg' })
      res.write(Buffer.alloc(256, 0xff))
    } else if (req.url.endsWith('.m3u8')) {
      const audio = '#EXT-X-STREAM-INF:BANDWIDTH=64000,CODECS="mp4a.40.2"\na.m3u8\n'
      const video = '#EXT-X-STREAM-INF:BANDWIDTH=640000,RESOLUTION=640x360\nv.m3u8\n'
      res.end('#EXTM3U\n' + ({ '/audio.m3u8': audio, '/mixed.m3u8': audio + video }[req.url] || '#EXTINF:3,\na.ts\n'))
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end('<html>播放器登录页面</html>')
    }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const origin = 'http://127.0.0.1:' + server.address().port
    const { serveRadioMode } = await import('../utils/radioPlayback.js')
    const { lookup: lookupProxyTarget } = await import('../utils/hlsProxy.js')
    const ref = 'cr-0123456789abcdef'
    const playback = createServer((req, res) => {
      const [, mode, path] = req.url.split('/')
      return serveRadioMode(req, res, { ref, mode, source: { url: origin + '/' + path } })
    })
    await new Promise(resolve => playback.listen(0, '127.0.0.1', resolve))
    const local = 'http://127.0.0.1:' + playback.address().port
    try {
      const relay = await (await fetch(local + '/relay/audio.m3u8')).text()
      assert.ok(relay.includes(origin + '/a.ts'))
      const proxy = await (await fetch(local + '/proxy/audio.m3u8')).text()
      assert.ok(!proxy.includes(origin))
      const key = proxy.match(/^(s[0-9a-f]{16})\.ts$/m)?.[1]
      assert.equal(lookupProxyTarget(key)?.url, origin + '/a.ts')
      assert.equal(lookupProxyTarget(key)?.pid, ref)
      for (const mode of ['relay', 'proxy']) {
        const response = await fetch(local + '/' + mode + '/mount', { signal: AbortSignal.timeout(2500) })
        assert.equal(response.headers.get('content-type'), 'audio/mpeg')
        const reader = response.body.getReader()
        assert.equal((await reader.read()).value[0], 0xff)
        await reader.cancel()
      }
    } finally {
      playback.closeAllConnections()
      await new Promise(resolve => playback.close(resolve))
    }
    assert.equal(await inspectStream(origin + '/mount'), 'audio')
    assert.equal(await inspectStream(origin + '/audio.m3u8'), 'audio')
    assert.equal(await inspectStream(origin + '/mixed.m3u8'), 'video')
    assert.equal(await inspectStream(origin + '/unknown.m3u8'), 'hls')
    assert.equal(await inspectStream(origin + '/wrong.mp3'), '')
    const flags = parsePlaylistContent('#EXTM3U\n#EXTINF:-1,MP3\nhttp://local/fm.mp3\n#EXTINF:-1 radio="false",TV\nhttp://local/no.mp3')
    assert.deepEqual(flags.map(ch => !!ch.radio), [true, false])
  } finally {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
  console.log('广播通过：18 个地区、152 个稳定引用、台标、试听和订阅属性。')
} finally {
  rmSync(dir, { recursive: true, force: true })
}
