import { requestMediaToken } from '../dalian/api.js'
import { API_BASE, APP_VERSION, UA, buildTicket } from '../dalian/auth.js'

export async function dalianRadioCatalog() {
  const { token } = await requestMediaToken()
  const url = new URL('tv/channels', API_BASE)
  url.search = new URLSearchParams({
    siteID: '1', type: '2', appID: '1', siteId: '1', curVersions: '2',
    appVersion: APP_VERSION, latitude: '0', longitude: '0', location: '', deviceId: 'iptv-radio',
  })
  const response = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': UA, source: 'APP', ticket: buildTicket(token) },
    redirect: 'error', signal: AbortSignal.timeout(12000),
  })
  if (!response.ok) throw Error('大连云广播目录 HTTP ' + response.status)
  const payload = await response.json()
  if (Number(payload.status) !== 0) throw Error('大连云广播目录暂不可用')
  const urls = new Map()
  for (const row of payload.data.channels) {
    if (Number(row.siteID) !== 1 || Number(row.type) !== 2 || !row.liveUrl) continue
    const media = new URL(row.liveUrl)
    if (['http:', 'https:'].includes(media.protocol) && media.host === 'livepull.dlrm.cn' && !media.username && !media.password) {
      urls.set(String(row.id), media.href)
    }
  }
  return urls
}
