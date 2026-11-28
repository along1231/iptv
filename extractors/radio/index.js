import { readFileSync } from 'node:fs'
import { audio, closeAudio, programmes, stream } from './runtime.js'

const readJson = file => JSON.parse(readFileSync(new URL(file, import.meta.url), 'utf8'))
const stations = { ...readJson('./regional_stations.json'), ...readJson('./tv_radio_stations.json') }
const regions = {
  香港: 'hongkong', 广东: 'guangdong', 澳门: 'macau', 台湾: 'taiwan', 福建: 'fujian',
  浙江: 'zhejiang', 江苏: 'jiangsu', 山西: 'shanxi', 陕西: 'shaanxi', 甘肃: 'gansu',
  青海: 'qinghai', 四川: 'sichuan', 内蒙古: 'neimenggu', 河北: 'hebei', 湖北: 'hubei',
  辽宁: 'liaoning', 吉林: 'jilin', 韩国: 'korea',
}

const guideProviders = new Set(['shaoxing', 'fuzhou', 'putian', 'geermu', 'haidong', 'jiangmen',
  'shaanxi', 'shanxi', 'yancheng', 'wuxi', 'nmtv', 'dalian', 'kbs', 'jilin'])

function regionalModule(region, slug) {
  const id = 'radio-' + slug
  const group = region + '广播'
  const entries = Object.entries(stations).filter(([, station]) => station.region === region)
  const byRef = new Map(entries.map(([key]) => ['radio-' + key, key]))
  const channels = entries.map(([key, station]) => ({
    name: station.name, deferredRef: 'radio-' + key, radio: true, catchup: 'none',
    logo: station.icon ? '/radio-icons/' + station.icon : station.logo || '',
  }))
  const guideEntries = entries.filter(([key, station]) => station.provider
    ? guideProviders.has(station.provider)
    : key !== 'rti-5' && key !== 'rti-6')
  const epg = guideEntries.length ? {
    id, days: 2,
    channels: () => guideEntries.map(([key, station]) => ({ key, ref: 'radio-' + key, name: station.name })),
    programmes: (key, day, options) => byRef.has('radio-' + key) ? programmes(key, day, options) : Promise.resolve([]),
  } : undefined
  const icons = new Set(entries.map(([, station]) => station.icon).filter(Boolean))
  function local(path) {
    const file = path.split('/').at(-1)
    if (path.endsWith('/radio-icons/' + file) && icons.has(file)) return { icon: file }
    const ref = file.replace(/\.(?:mp3|aac|m3u8)$/, '')
    const key = byRef.get(ref)
    if (key && (key.startsWith('ner-') || stations[key].relay || file.endsWith('.mp3') || file.endsWith('.aac'))) return { key }
  }
  return {
    id, name: group, category: 'radio', defaultEnabled: false, outputGroupName: group,
    description: region + '地区官方广播，共 ' + entries.length + ' 个频率。',
    capabilities: { cache: 'disk', resolve: true, epg: Boolean(epg), catchup: false },
    catalogVersion: 1, defaultRefreshMinutes: 1440, refreshConfigurable: false,
    refreshDescription: '播放时向电台取址，节目单随订阅刷新。', configSchema: [],
    async fetch() { return { groups: [{ name: group, dataList: channels }], meta: { skipped: [], warnings: [] } } },
    shutdown: closeAudio,
    claimsRef: ref => byRef.has(ref),
    async resolve(ref) {
      try {
        if (byRef.has(ref)) return { url: await stream(byRef.get(ref)) }
      } catch { return { url: '', status: 502, desc: '暂未取得官方广播地址' } }
      return { url: '', status: 404, desc: '未知广播频率' }
    },
    claimsLocalPath: path => Boolean(local(path)),
    async handleLocalRequest({ path, method }) {
      const match = local(path)
      if (!match) return null
      if (match.icon) {
        const mime = { svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg' }
        return { body: readFileSync(new URL('./logos/' + match.icon, import.meta.url)),
          headers: { 'Content-Type': mime[match.icon.split('.').at(-1)], 'Cache-Control': 'public, max-age=86400',
            'Content-Security-Policy': "default-src 'none'; sandbox" } }
      }
      return audio(match.key, stations[match.key], method)
    },
    epg,
  }
}

export default Object.entries(regions).map(([region, slug]) => regionalModule(region, slug))
