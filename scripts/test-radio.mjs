import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'iptv-radio-'))
process.env.mdataDir = dir
process.env.mbuiltInSourcesUrl = ''
try {
  const { listModules, resolverFor, localRequestHandlerFor } = await import('../extractors/registry.js')
  const { logoCandidates } = await import('../utils/updateData.js')
  const { parseInterfaceTxt, generateM3u8 } = await import('../utils/playlistConfig.js')
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
  console.log('广播通过：18 个地区、152 个稳定引用、台标、试听和订阅属性。')
} finally {
  rmSync(dir, { recursive: true, force: true })
}
