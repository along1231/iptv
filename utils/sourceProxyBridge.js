import { Server } from 'proxy-chain'
import { requiredProxyUrl } from './outboundProxy.js'

// Chromium、FFmpeg 和 Python 支持的代理协议及认证方式不同。每个任务只拿到自己的
// 临时回环 HTTP 入口，上游凭据留在 Node 进程内，任务结束时关闭监听和现有连接。
export async function openSourceProxy() {
  const upstreamProxyUrl = requiredProxyUrl().replace(/^socks5:/i, 'socks5h:')
  const server = new Server({
    host: '127.0.0.1', port: 0,
    prepareRequestFunction: () => ({ upstreamProxyUrl }),
  })
  await server.listen()
  const url = 'http://127.0.0.1:' + server.port
  return {
    url,
    launchOptions: { args: ['--proxy-server=' + url, '--proxy-bypass-list=<-loopback>', '--disable-quic',
      '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'] },
    env: { ...process.env, http_proxy: url, https_proxy: url, HTTP_PROXY: url, HTTPS_PROXY: url,
      ALL_PROXY: url, all_proxy: url, NO_PROXY: '', no_proxy: '', IPTV_RADIO_PROXY: url },
    close: () => server.close(true),
  }
}
