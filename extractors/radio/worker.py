"""One allowlisted radio request. JSON results, or raw ADTS for the NER relay."""
import json
import sys
from datetime import datetime, timedelta
from urllib.parse import urlsplit

import commercial_radio
import macau
import ner_audio
import rthk
import taiwan
import tv_radio


def source(key):
    if key in rthk.HK_STATIONS:
        return rthk
    for provider in (commercial_radio, macau, taiwan, tv_radio):
        if key in provider.STATIONS:
            return provider
    raise ValueError("未知广播频率")


def main():
    mode, key, *args = sys.argv[1:]
    provider = source(key)
    if mode == "guide":
        day = datetime.strptime(args[0], "%Y%m%d").date()
        if provider is rthk:
            rows = rthk.day_guide(key, day) + rthk.day_guide(key, day + timedelta(days=1))
        else:
            rows = provider.guide_rows(key, day)
        result = [{"title": title, "start": int(start.timestamp() * 1000),
                   "stop": int(stop.timestamp() * 1000)} for start, stop, title in rows]
    elif mode in ("stream", "aac"):
        result = macau.resolve(key) if provider is macau else provider.live_url(key)
        url = urlsplit(result)
        if url.scheme not in ("http", "https") or not url.hostname or url.username or url.password:
            raise ValueError("官网未提供有效广播地址")
        if mode == "aac":
            if not key.startswith("ner-"):
                raise ValueError("此频道未提供 AAC")
            for _, _, chunk in ner_audio.segments(result):
                sys.stdout.buffer.write(chunk)
                sys.stdout.buffer.flush()
            return
    else:
        raise ValueError("未知广播请求")
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
