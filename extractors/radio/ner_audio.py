"""Read the education station's short-window AAC HLS over one persistent connection."""
import os
import re
from http.client import HTTPException, HTTPSConnection
from time import monotonic, sleep
from urllib.parse import urljoin, urlsplit


def segments(master):
    origin = urlsplit(master)
    if origin.scheme != "https" or not (origin.hostname or "").endswith(".ner.gov.tw"):
        raise ValueError("教育电台直播主机不符")
    proxy = os.environ.get("IPTV_RADIO_PROXY")
    if proxy:
        endpoint = urlsplit(proxy)
        conn = HTTPSConnection(endpoint.hostname, endpoint.port, timeout=10)
        conn.set_tunnel(origin.hostname, origin.port or 443)
    else:
        conn = HTTPSConnection(origin.hostname, timeout=10)

    def read(url):
        parts = urlsplit(url)
        if (parts.scheme, parts.netloc) != (origin.scheme, origin.netloc):
            raise ValueError("教育电台直播分片主机不符")
        conn.request("GET", parts.path + ("?" + parts.query if parts.query else ""))
        response = conn.getresponse()
        content = response.read()
        if response.status == 404:
            return None
        if response.status != 200:
            raise ValueError(f"教育电台直播返回 HTTP {response.status}")
        return content

    try:
        playlist = (read(master) or b"").decode()
        variant = re.search(r"(?m)^#EXT-X-STREAM-INF:[^\n]*\n\s*([^#\s]+)", playlist)
        if not variant:
            raise ValueError("教育电台未返回音频直播索引")
        media = urljoin(master, variant[1])
        last = None
        received = monotonic()
        while monotonic() - received < 15:
            page = (read(media) or b"").decode()
            sequence = re.search(r"#EXT-X-MEDIA-SEQUENCE:(\d+)", page)
            entries = re.findall(r"#EXTINF:([\d.]+),[^\n]*\n\s*([^#\s]+)", page)
            if not sequence or not entries:
                raise ValueError("教育电台分片索引为空")
            first = int(sequence[1])
            for i, (duration, path) in enumerate(entries):
                number = first + i
                if (last is None and i < len(entries) - 1) or (last is not None and number <= last):
                    continue
                data = read(urljoin(media, path))
                if data is None:
                    continue
                # Apple's packed audio format carries an ID3 timestamp before ADTS frames.
                if data.startswith(b"ID3") and len(data) >= 10:
                    size = 0
                    for value in data[6:10]:
                        size = (size << 7) | value
                    data = data[10 + size:]
                if len(data) < 7 or data[0] != 255 or (data[1] & 0xf6) != 0xf0:
                    raise ValueError("教育电台直播分片缺少 AAC 帧")
                received = monotonic()
                last = number
                yield number, float(duration), data
            if "#EXT-X-ENDLIST" in page:
                raise ValueError("教育电台直播已结束")
            sleep(0.15)
        raise ValueError("教育电台直播索引停止更新")
    except HTTPException as error:
        raise OSError(f"教育电台直播连接中断 {error}") from error
    finally:
        conn.close()
