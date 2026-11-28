import { readFileSync } from 'node:fs'
import { launchBrowser, closeBrowser } from '../../utils/browserLauncher.js'

const stations = JSON.parse(readFileSync(new URL('./guangdong.json', import.meta.url)))
export async function guangdong(id) {
  if (!Object.hasOwn(stations, id)) throw Error('未知广东广播频率')
  const browser = await launchBrowser({ label: '广东广播' })
  try {
    return await collect(browser, id)
  } finally {
    await closeBrowser(browser, { label: '广东广播' })
  }
}

async function collect(browser, id) {
  const page = await browser.newPage();
  page.setDefaultTimeout(45000);
  try {
    const api = (response, path) => response.request().method() === "GET" && response.status() === 200 &&
      new URL(response.url()).origin === "https://gdtv-api.gdtv.cn" &&
      new URL(response.url()).pathname === "/api/tv/v2/" + path;
    const catalog = page.waitForResponse(r => api(r, "tvChannel") &&
      new URL(r.url()).searchParams.has("category")).then(r => r.json());
    const stationFrom = rows => {
      const station = rows.find(row => String(row.pk) === id && row.category === 1);
      if (!station || station.name !== stations[id]) throw Error("官网目录与登记频道不匹配");
      return station;
    };
    // Use the HLS request actually made by this channel's public web player.
    const media = page.waitForResponse(response => {
      const url = new URL(response.url());
      return response.request().method() === "GET" && response.ok() && url.protocol === "https:" && url.hostname.endsWith(".gdtv.cn") &&
        url.pathname.startsWith("/audio/") && url.pathname.endsWith(".m3u8");
    }).then(response => response.url());
    const result = Promise.all([media, catalog]).then(([url, rows]) => {
      const expected = new URL(JSON.parse(stationFrom(rows).playUrl).hd);
      if (new URL(url).pathname !== expected.pathname) throw Error("直播路径与官网频率不符");
      return url;
    });
    const [value] = await Promise.all([result, page.goto("https://www.gdtv.cn/audioChannelDetail/"+id,
      {waitUntil:"domcontentloaded",timeout:45000})]);
    return value;
  } finally { await page.close(); }
}
