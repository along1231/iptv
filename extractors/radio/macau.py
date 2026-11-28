"""Read the two radio channels and dated programme listings from TDM."""
import json
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, time, timedelta
from urllib.parse import urlsplit, urlunsplit
from zoneinfo import ZoneInfo

from radio_http import fetch

SITE = "https://www.tdm.com.mo"
CATALOG = SITE + "/api/v1.0/program-list/Channel?type=radio"
ZONE = ZoneInfo("Asia/Macau")
STATIONS = {"tdm-fm1007": "澳門電台 FM100.7", "tdm-fm98": "Rádio Macau FM98"}
IDS = {"tdm-fm1007": 3, "tdm-fm98": 4}
LANG = {"tdm-fm1007": "zh-Hant", "tdm-fm98": "pt"}


def page_url(key):
    locale = LANG[key].lower()
    return f"{SITE}/{locale}/live?Channel={IDS[key]}&type=radio"


def radio_channel(key):
    channels = json.loads(fetch(CATALOG))["data"]
    for ch in channels:
        if ch["id"] == IDS[key] and ch["slug"] == key.removeprefix("tdm-"):
            return ch
    raise ValueError(f"澳广视电台目录缺少 {key}")


def resolve(key):
    with ThreadPoolExecutor(max_workers=2) as pool:
        station = pool.submit(radio_channel, key)
        route = json.loads(fetch(SITE + "/api/v1/common/get-domain"))["data"]
        parts = urlsplit(station.result()["onlineFeed"])
    origin = f"{parts.scheme}://{parts.netloc}"
    if origin == route["sourceLiveDomain"]:
        origin = route["liveDomain"]
    target = urlsplit(route.get("domains", {}).get(origin, origin))
    if target.scheme != "https" or not (target.hostname or "").endswith(".tdm.com.mo"):
        raise ValueError("澳广视未返回有效的官方直播域名")
    return urlunsplit((target.scheme, target.netloc, parts.path, parts.query, ""))


def day_list(key, day):
    url = f"{SITE}/api/v1.0/program-list/{day}?channelId={IDS[key]}&type=0"
    data = json.loads(fetch(url))["data"]
    if not isinstance(data, list):
        raise ValueError(f"{key} {day} 节目表格式异常")
    return data


def guide_rows(key, day):
    start = datetime.combine(day, time.min, ZONE)
    middle, stop = start + timedelta(days=1), start + timedelta(days=2)
    # Include the preceding overnight show and the first start beyond the export window.
    days = [day + timedelta(days=n) for n in (-1, 0, 1, 2)]
    with ThreadPoolExecutor(max_workers=2) as pool:
        listings = list(pool.map(lambda date: day_list(key, date), days))
    starts = {}
    for entries in listings:
        for entry in entries:
            at = datetime.fromisoformat(entry["date"]).replace(tzinfo=ZONE)
            title = entry["title"].strip()
            if not title:
                raise ValueError(f"{key} {at} 缺少节目名")
            titles = starts.setdefault(at, [])
            if title not in titles:
                titles.append(title)
    rows = []
    times = sorted(starts)
    for begin, end in zip(times, times[1:]):
        begin_clipped, end_clipped = max(begin, start), min(end, stop)
        if begin_clipped >= end_clipped:
            continue
        title = " / ".join(starts[begin])
        if begin_clipped < middle < end_clipped:
            rows.append((begin_clipped, middle, title))
            begin_clipped = middle
        rows.append((begin_clipped, end_clipped, title))
    if not listings[1] or not listings[2] or not rows:
        raise ValueError(f"{key} 官网未提供完整的今明节目表")
    return rows
