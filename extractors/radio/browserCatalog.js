import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { toSimplified } from '../../utils/channelNormalize.js'
import { hostableUrl } from '../../utils/logoCache.js'
import { isLanHost } from '../../utils/customSourceProxy.js'

import { mainlandRegion } from './provinces.js'

export const directoryRegions = { CN: '中国大陆', HK: '香港', MO: '澳门', TW: '台湾' }

const read = file => JSON.parse(readFileSync(new URL(file, import.meta.url), 'utf8'))
const official = { ...read('./regional_stations.json'), ...read('./tv_radio_stations.json') }
const regionCode = region => ({ 香港: 'HK', 澳门: 'MO', 台湾: 'TW' })[region] || 'CN'
const radioCharacters = { 話: '话', 粵: '粤', 環: '环', 連: '连', 門: '门', 峽: '峡', 漢: '汉', 聯: '联' }
const radioKey = name => toSimplified(name.normalize('NFKC')).toUpperCase()
  .replace(/[\s\-·「」（）()]/g, '').replace(/[話粵環連門峽漢聯]/g, c => radioCharacters[c])

// Short unqualified names such as “音乐之声” occur in several provinces.
const generic = /^(?:音乐之声|交通之声|城市之声|文体广播|新闻广播|音乐广播|交通广播|综合广播|新闻综合广播|RADIO\d*)$/
const byName = new Map()
for (const [id, { name, region }] of Object.entries(official)) {
  if (region === '韩国') continue
  const variations = [region + name, name, name.replace('广播电视台', '')]
  // “陕西交通广播” is unambiguous. “莆田广播” without its frequency is not.
  const short = name.replace(/\s*(?:FM|AM)\s*\d+(?:\.\d+)?/gi, '').trim()
  if (short !== name && short.length > 4) variations.push(short)
  for (const full of variations) {
    const key = radioKey(full)
    if (!generic.test(key)) byName.set(key, byName.has(key) && byName.get(key) !== id ? null : id)
  }
}
const aliases = {
  '香港新城电台知讯台': 'metro-info', '香港新城电台采讯台': 'metro-plus', '香港新城电台财经台': 'metro-finance',
  '香港普通话台': 'pth', '中广 I GO': 'bcc-531', 'ICRT': 'icrt-fm', 'Radio ICRT': 'icrt-fm',
  '飞碟联播网 飞碟电台': 'ufo-fm', '汉声调频': 'voh-fm', '漢聲調頻': 'voh-fm', '漢聲中波': 'voh-am',
  '台北广播电台': 'tbs-fm', '臺北電台AM': 'tbs-am', '高雄广播电台AM1089': 'kbs-am',
  '大連都市之聲廣播': 'cn-dalian-14',
}
for (const [name, id] of Object.entries(aliases)) {
  byName.set(radioKey(name), id)
}

const religious = /若望三[电電]台|白[陽阳][經经]典|religi|buddh|christian|catholic|gospel|radio\s*maria|bible|jesus|islam|church|supreme\s*master|hwadzan|febc|liangyou|goodnews\.org\.tw|needs\s*radio|主[內内]|[净淨]空|[华華]藏|念佛|佛[教學学经經法音陀堂光]|[彌弥]陀|法[师師会會]|福音|良友|佳音|大[愛爱]|益世|宗教|信仰|天主|基督|星[蹤踪]之[愛爱]|[圣聖]大解[脱脫][经經]|三[時时]系念|梵音/i
const television = /伴音|[卫衛][视視]|\b(?:CCTV|CETV)[- \d]|\bTV\b|(?<!广播)电视台|(?<!廣播)電視台|AI电视|^CGTN - English$|^Ifeng \(Phoenix\)$|^锦州综合频道$/i

function publicUrl(value) {
  if (typeof value !== 'string' || /[\s<>"'$\\{}\x00-\x1f]/.test(value) || !hostableUrl(value)) return ''
  const url = new URL(value)
  return isLanHost(url.hostname) ? '' : url.href
}

// A platform channel ID identifies a frequency across bitrates and CDN hosts.
// In particular the label on a submitted mirror may describe a different station.
const qingtingOfficial = { 1254: 'gdtv-85', 1259: 'gdtv-86', 1260: 'gdtv-87', 1262: 'gdtv-88',
  469: 'gdtv-90', 470: 'gdtv-98', 471: 'gdtv-92' }
const cnrNames = { zgzs: 'CNR-1 中国之声', jjzs: 'CNR-2 经济之声', yyzs: 'CNR-3 音乐之声',
  zgjtgb: 'CNR-15 中国交通广播', gsgljtgb: 'CNR-15 中国交通广播' }
function stationEvidence(url, name, code) {
  const { hostname, pathname } = new URL(url)
  const key = radioKey(name)
  let id, platform
  if (/(^|\.)rthk\.hk$|^rthk[\w-]*\.(?:akamaized\.net|akamaihd\.net)$/.test(hostname)) {
    code = 'HK'
    id = pathname.match(/\/(radio(?:[1-5]|cnrhk|cmgrgb|pth))(?:[/_@.]|$)/i)?.[1]?.toLowerCase()
    if (id === 'radiopth') id = 'pth'
  } else if (/(^|\.)tdm\.com\.mo$/.test(hostname)) {
    code = 'MO'
    id = { rch2a: 'tdm-fm1007', rch1a: 'tdm-fm98' }[pathname.match(/\/(rch[12]a)\./)?.[1]]
  } else if (hostname === 'stream.pbs.gov.tw') {
    code = 'TW'
    id = 'pbs-' + (pathname.match(/\/(?:mp3:)?([a-z]{3})\//i)?.[1] || '').toLowerCase()
  } else if (/(^|\.)(qingting\.fm|qtfm\.cn)$/.test(hostname)) {
    const channel = pathname.match(/^\/live\/(\d+)(?:[/.]|$)/)?.[1]
    if (channel) {
      platform = 'qt-' + channel
      id = qingtingOfficial[channel]
      // Station identity checked against rapi.qingting.fm/channels/<id>.
      if (channel === '20500153') return { code: 'CN', platform, name: 'CityFM城市音乐台' }
      if (channel === '15318703') return { code: 'CN', platform, name: '成都 Hit FM 欧美音乐 88.7' }
    }
  } else if (/(^|\.)cnr\.cn$/.test(hostname)) {
    code = 'CN'
    const channel = pathname.match(/\/live\/(?:wx)?([\w-]+)\//)?.[1]
    if (channel) platform = 'cnr-' + channel
    if (Object.hasOwn(cnrNames, channel)) return { code, platform, name: cnrNames[channel] }
    if (channel === 'xgzs') id = 'radiocnrhk'
  } else if (/^(?:stream|stream-test)\.hkcr\.live$/.test(hostname)) {
    return { code: 'HK', name: 'Hong Kong Community Radio' }
  } else if (/\.cdnstream\.com$/.test(hostname) && /^\/a57743(?:_2)?$/.test(pathname)) {
    return { code: 'HK', name: 'Bridge Radio - 華語 HITS' }
  } else if (hostname === 'hongkongstream.axr.online') {
    return { code: 'HK', name: 'AXR Hong Kong' }
  } else if (hostname.endsWith('.rcs.revma.com')) {
    platform = 'revma-' + pathname
    if (pathname === '/pet2dvug1bkvv') id = 'kbs-fm'
  } else if (hostname === 'flv.ccdntech.com' && pathname.includes(':vod117_Live/')) {
    code = 'TW'
    platform = 'csbc-' + pathname.split('/').slice(0, -1).join('/')
  } else if (hostname.endsWith('.tw')) {
    code = 'TW'
  }
  if (/(?:^|\/)rti3\//i.test(pathname) && hostname.endsWith('.akamaized.net')) id = 'rti-3'
  if (!id && /^(深圳|珠海|中山|大连|台山|福建海峡|海峡之声|中国华艺|成都)/.test(key)) code = 'CN'
  id = official[id] ? id : byName.get(key)
  if (id) return { id, code: regionCode(official[id].region), name: official[id].name, platform }
  return { code, platform, name }
}

function candidate(row) {
  if (!Object.hasOwn(directoryRegions, row?.countrycode) || row.lastcheckok !== 1) return
  const name = String(row.name || '').trim().replace(/\s+/g, ' ').replaceAll("'", '’').replaceAll('"', '＂')
  if (!name || name.length > 150 || /[<>"'\x00-\x1f]|\$\{/.test(name) || /^https?:\/\//i.test(name)) return
  if (religious.test([name, row.tags, row.url, row.homepage, row.url_resolved].join(' ')) ||
      television.test(name) || /(?:^|,)(?:tv|television|hls video)(?:,|$)/i.test(row.tags) ||
      /[电電]台[測测][試试]/.test(name)) return
  const url = publicUrl(row.url_resolved) || publicUrl(row.url)
  if (!url) return
  const { hostname, pathname } = new URL(url)
  if (/(^|\.)hkcable\.com\.hk$/.test(hostname) || hostname === 'miradio.f96.cl') return
  if (/\/audio\/cctv\d/i.test(pathname) || (hostname === 'antiserver.kuwo.cn' && /[?&]rid=MUSIC_/i.test(url))) return
  // These Macau submissions point to Portuguese national stations, VOA or an unrelated stream.
  if (row.countrycode === 'MO' && /(?:^|\.)(?:bauermedia\.pt|rtp\.pt)$|^voa-ingest\.akamaized\.net$/.test(hostname)) return
  if (row.countrycode === 'MO' && (hostname === 'live.top80.fm' || /bigheartfm\.weebly\.com/i.test(row.homepage))) return
  // This submission points at a region-neutral internet station, with no Macau frequency.
  if (row.countrycode === 'MO' && /\.(?:qingting\.fm|qtfm\.cn)$/.test(hostname) && /^\/live\/20071[/.]/.test(pathname)) return
  const evidence = stationEvidence(url, name, row.countrycode)
  return { ...evidence, listed: row.countrycode, url, state: row.state || '', iso: row.iso_3166_2, logo: publicUrl(row.favicon),
    extension: row.hls || /\.m3u8(?:[?#]|$)/i.test(url) ? 'm3u8' :
      ({ MP3: 'mp3', AAC: 'aac', 'AAC+': 'aac', OGG: 'ogg', FLAC: 'flac', OPUS: 'opus' })[row.codec] || '',
    votes: Number(row.votes) || 0 }
}

export function directoryCatalog(rows) {
  const records = rows.map(candidate).filter(Boolean)
  // For identical platform channels prefer the native listing to a cross-border label.
  const byPlatform = new Map()
  const byUrl = new Map()
  for (const row of records) {
    const previous = byUrl.get(row.url)
    if (!previous || (row.id && !previous.id) || (!previous.id && row.votes > previous.votes)) byUrl.set(row.url, row)
    if (!row.platform) continue
    const old = byPlatform.get(row.platform)
    if (!old || (row.id && !old.id) || (!old.id && row.listed === 'CN' && old.listed !== 'CN')) byPlatform.set(row.platform, row)
  }
  const stations = new Map()
  for (const row of records) {
    const representative = byUrl.get(row.url)
    const identity = byPlatform.get(representative.platform) || representative
    let { name, code, id } = identity
    let key = radioKey(name)
    if (!key) continue
    if (!id && generic.test(key)) {
      const qualifier = identity.state || identity.platform || new URL(identity.url).hostname
      name += '（' + String(qualifier).replace(/[^\p{L}\p{N}. -]/gu, '').slice(0, 60) + '）'
      key = radioKey(name)
    }
    const stationKey = code + ':' + (id || key)
    if (!stations.has(stationKey)) {
      const suffix = createHash('sha256').update(stationKey).digest('hex').slice(0, 16)
      const item = { name, radio: true, catchup: 'none', deferredRef: 'radio-rb-' + code.toLowerCase() + '-' + suffix,
        region: id ? official[id].region : code === 'CN' ? mainlandRegion(radioKey(name), identity.state, identity.iso) : directoryRegions[code],
        logo: row.logo, lines: new Map(), code }
      if (id) item.officialRadioRef = 'radio-' + id
      stations.set(stationKey, item)
    }
    const station = stations.get(stationKey)
    if (station.region === '大陆其他' && code === 'CN') station.region = mainlandRegion(radioKey(row.name), row.state, row.iso)
    if (!station.logo && row.logo) station.logo = row.logo
    if (!station.lines.has(row.url)) station.lines.set(row.url, row)
  }
  const groups = Object.fromEntries(Object.keys(directoryRegions).map(code => [code, []]))
  for (const { code, lines, ...channel } of stations.values()) {
    const sorted = [...lines.values()].sort((a, b) => Number(b.url.startsWith('https:')) - Number(a.url.startsWith('https:')) ||
      Number(/chunklist_|index_\d/.test(a.url)) - Number(/chunklist_|index_\d/.test(b.url)) ||
      b.votes - a.votes || a.url.localeCompare(b.url))
    channel.lines = sorted.map(({ url, extension }) => ({ url, extension }))
    groups[code].push(channel)
  }
  for (const list of Object.values(groups)) list.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN') || a.deferredRef.localeCompare(b.deferredRef))
  return groups
}
