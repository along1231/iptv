import { execFile, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { once } from 'node:events'
import guangdongEpg from '../gdtv/epg.js'
import { dalianRadioCatalog } from './dalian.js'
import dalianEpg from '../dalian/epg.js'
import { guangdong } from './guangdong.js'
import { shanghaiDays } from '../../utils/epgXmltv.js'

const run = promisify(execFile)
const worker = fileURLToPath(new URL('./worker.py', import.meta.url))
const streams = new Map()
const guides = new Map()

// Share requests from simultaneous listeners and from both days of an XMLTV refresh.
function cached(map, key, ttl, load) {
  const now = Date.now()
  for (const [id, value] of map) if (value.until <= now) map.delete(id)
  if (!map.has(key)) {
    const entry = { until: Infinity }
    entry.promise = Promise.resolve().then(load).then(value => {
      entry.until = Date.now() + ttl
      return value
    }).catch(error => {
      map.delete(key)
      throw error
    })
    map.set(key, entry)
  }
  return map.get(key).promise
}

async function request(mode, key, ...args) {
  try {
    const { stdout } = await run('python3', ['-B', worker, mode, key, ...args], {
      timeout: 120000, maxBuffer: 4 * 1024 * 1024,
    })
    return JSON.parse(stdout)
  } catch (error) {
    // Child process errors can include the broadcaster's temporary URL on stderr.
    throw Error(`广播 ${key} ${mode === 'guide' ? '节目单' : '取址'}失败（${error.code || error.signal || '响应无效'}）`)
  }
}

export function stream(key) {
  if (key.startsWith('cn-dalian-')) {
    return cached(streams, 'dalian', 20000, dalianRadioCatalog).then(catalog => {
      const url = catalog.get(key.slice('cn-dalian-'.length))
      if (!url) throw Error('大连广播目录缺少此频率')
      return url
    })
  }
  return cached(streams, key, 20000, () => key.startsWith('gdtv-') ? guangdong(key.slice(5)) : request('stream', key))
}

export async function programmes(key, day, options) {
  if (!/^\d{8}$/.test(day)) throw Error('广播节目单日期无效')
  if (key.startsWith('gdtv-')) return guangdongEpg.programmes(key.slice(5), day, options)
  if (key.startsWith('cn-dalian-')) return dalianEpg.programmes(key.slice('cn-dalian-'.length), day, options)
  const [today, tomorrow] = shanghaiDays(Date.now(), 2)
  const anchor = day === tomorrow ? today : day
  const rows = await cached(guides, key + '/' + anchor, 300000, () => request('guide', key, anchor))
  const start = Date.parse(day.slice(0, 4) + '-' + day.slice(4, 6) + '-' + day.slice(6) + 'T00:00:00+08:00')
  return rows.filter(row => row.title && row.stop > row.start && row.start >= start && row.start < start + 86400000)
}

const children = new Set()
export function closeAudio() {
  for (const child of children) child.kill('SIGKILL')
}

let listeners = 0
export async function audio(key, station, method) {
  const aac = key.startsWith('ner-')
  const headers = { 'Content-Type': aac ? 'audio/aac' : 'audio/mpeg', 'Cache-Control': 'no-store' }
  if (method === 'HEAD' || method === 'OPTIONS') return { headers }
  if (method !== 'GET') return { status: 405 }
  if (listeners >= 16) return { status: 503, body: '广播试听连接已满' }
  listeners++
  let child
  let disposed = false
  const dispose = () => {
    if (disposed) return
    disposed = true
    listeners--
    children.delete(child)
    child?.kill('SIGKILL')
  }
  try {
    if (aac) {
      child = spawn('python3', ['-B', worker, 'aac', key], { stdio: ['ignore', 'pipe', 'ignore'] })
    } else {
      const referer = station.relay ? ['-referer', new URL(station.page).origin + '/'] : []
      const url = await stream(key)
      child = spawn('ffmpeg', ['-nostdin', '-v', 'error', '-rw_timeout', '15000000', ...referer,
        '-i', url, '-map', '0:a:0', '-c:a', 'libmp3lame', '-b:a', '96k', '-f', 'mp3',
        '-flush_packets', '1', 'pipe:1'], { stdio: ['ignore', 'pipe', 'ignore'] })
    }
    children.add(child)
    const signal = AbortSignal.timeout(45000)
    await Promise.race([once(child.stdout, 'readable', { signal }), once(child, 'exit', { signal })])
    if (!child.stdout.readableLength) throw Error('无法打开广播')
    return { headers, body: child.stdout, dispose }
  } catch {
    dispose()
    return { status: 502, body: '暂时无法打开广播音频' }
  }
}
