// Read the programme/stream configuration used by the public radio players.
import {createDecipheriv} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {encryptBase64} from '../nmtv/xxtea.js';
import {parsePortalResponse} from '../nmtv/api.js';
import {decryptJlntvResponse} from '../jlntv/api.js';

import { fetch as undiciFetch, ProxyAgent } from 'undici';
const proxy = process.env.IPTV_RADIO_PROXY;
const dispatcher = proxy && new ProxyAgent(proxy);
const fetchOfficial = dispatcher ? (url, options) => undiciFetch(url, {...options, dispatcher}) : fetch;

const [provider, id, date] = process.argv.slice(2);
if (provider === 'shaanxi') {
  const source = execFileSync('curl', ['-fsSL', '--max-time', '15', 'http://toutiao.cnwest.com/static/v1/stream.js'], {encoding:'utf8'});
  const tv = /\bsTV\s*=\s*"([^"]+)"/.exec(source)?.[1];
  const radio = /\bsRadio\s*=\s*"([^"]+)"/.exec(source)?.[1];
  if (!tv || !radio) throw Error('陕西官网未返回播放器配置');
  const decipher = createDecipheriv('aes-128-cbc', Buffer.from(tv.slice(0, 16)), Buffer.from(radio.slice(0, 16)));
  decipher.setAutoPadding(false);
  const clear = Buffer.concat([decipher.update(Buffer.from(radio.slice(16), 'base64')), decipher.final()]);
  console.log(JSON.stringify(JSON.parse(clear.toString('utf8').replace(/\0+$/, ''))));
} else if (provider === 'jiangmen') {
  const {dailyKey, infoUrl, readOfficial} = await import('../jiangmen/protocol.js');
  const info = JSON.parse(await readOfficial(infoUrl(), {fetchImpl: fetchOfficial}));
  const row = info.channels.find(c => c.i === id && String(c.t) === '2');
  if (!row || row.l !== 'http://tideweblive.jmtv.cn' || !row.r.some(rate => rate.n === 64)) throw Error('江门广播配置已变');
  console.log(row.l + '/lsdream/' + id + '/64/' + (info.play.dl === 1 ? dailyKey(id) : 'live') + '.m3u8');
} else if (provider === 'jilin' && !date) {
  const res = await fetchOfficial('https://clientapi.jlntv.cn/broadcast/list?page=1&size=10000&type=0', {
    headers: {'Client-Type': 'web'}, signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw Error('吉林广播目录 HTTP ' + res.status);
  const row = decryptJlntvResponse(await res.text()).data.find(r => String(r.id) === id &&
    r.contentType === 'broadcast' && r.data.type === 0);
  if (!row?.data.streamUrl) throw Error('吉林广播目录缺少此频率');
  console.log(row.data.streamUrl);
} else if (provider === 'nmtv' || provider === 'jilin') {
  const endpoint = date ? 'programs' : 'list';
  const params = date ? {broadcastId: Number(id), date, sort: 1} : {type: 0, size: 100};
  const origin = provider === 'jilin' ? 'https://clientapi.jlntv.cn' : 'https://api-bt.nmtv.cn';
  const page = provider === 'jilin' ? 'https://m.jlntv.cn/' : 'https://www.nmtv.cn/liveBroadcast';
  const response = await fetchOfficial(origin + '/broadcast/' + endpoint, {
    method: 'POST',
    body: encryptBase64(JSON.stringify(params), '5b28bae827e651b3'),
    headers: {'Client-Type': 'web', 'Content-Type': 'application/json', Origin: new URL(page).origin, Referer: page},
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw Error('广播接口 HTTP ' + response.status);
  const text = await response.text();
  const rows = provider === 'jilin' ? decryptJlntvResponse(text).data : parsePortalResponse(text);
  if (date) {
    console.log(JSON.stringify(rows.filter(r => String(r.broadcastId) === id && (provider === 'jilin' || r.date === date))
      .map(r => [r.startTime, r.endTime, r.title])));
  } else {
    const entry = rows.find(r => String(r.id) === id);
    if (!entry?.data?.streamUrl) throw Error('内蒙古官网广播已下架');
    console.log(entry.data.streamUrl);
  }
} else if (provider === 'shanxi') {
  const {provinceInfoUrl, parseProvinceInfo, provinceStreamUrl} = await import('../shanxi/api.js');
  const response = await fetchOfficial(provinceInfoUrl(), {signal: AbortSignal.timeout(15000)});
  if (!response.ok) throw Error('山西广播目录 HTTP ' + response.status);
  console.log(provinceStreamUrl({channelCode: id, name: id}, parseProvinceInfo(await response.text())));
} else {
  throw Error('未知播放器');
}
