import html
import json
import re
from datetime import datetime, time, timedelta
from urllib.parse import urlencode, urlsplit
from zoneinfo import ZoneInfo
from radio_http import fetch

HK = ZoneInfo("Asia/Hong_Kong")
BASE = "https://www.rthk.hk/radio"
HK_STATIONS = {
    "radio1": "香港電台第一台", "radio2": "香港電台第二台", "radio3": "香港電台第三台",
    "radio4": "香港電台第四台", "radio5": "香港電台第五台", "pth": "香港電台普通話台",
    "radiocnrhk": "中央人民廣播電台香港之聲", "radiocmgrgb": "中央廣播電視總台粵港澳大灣區之聲",
}


def live_url(station):
    page = fetch(f"{BASE}/{station}").decode()
    if not re.search(rf'var\s+__channel\s*=\s*"{station}"', page):
        raise ValueError(f"Unexpected station page for {station}")
    player = re.search(r"var\s+__live\s*=\s*(\[.*?\])\s*;", page, re.S)
    if player:
        for url in re.findall(r'''\bfile\s*:\s*["']([^"']+)["']''', player[1]):
            parts = urlsplit(url)
            if parts.scheme == "https" and parts.hostname and parts.path.endswith(".m3u8"):
                return url
    raise ValueError(f"No official live HLS for {station}")


def clean(text):
    return html.unescape(text).replace("\\'", "'").strip()


def day_guide(station, day):
    params = urlencode({"d": day.strftime("%Y%m%d"), "c": station})
    data = json.loads(fetch(f"{BASE}/getTimetable?{params}"))
    if tuple(map(int, (data["y"], data["m"], data["d"]))) != (day.year, day.month, day.day):
        raise ValueError(f"Unexpected timetable date for {station} {day}")
    midnight = datetime.combine(day, time.min, HK)
    tomorrow = midnight + timedelta(days=1)
    previous_end = midnight
    rows = []
    for item in data["timetable"]:
        start = datetime.combine(day, time.fromisoformat(item["start"]), HK)
        end = datetime.combine(day, time.fromisoformat(item["end"]), HK)
        # RTHK repeats the portion after midnight at the top of the next day's guide.
        if end < start:
            end = tomorrow
        title = clean(item["name"])
        if not title or end <= start or start < previous_end:
            raise ValueError(f"Invalid programme at {station} {start}: {title}")
        rows.append((start, end, title))
        previous_end = end
    if not rows:
        raise ValueError(f"Empty timetable for {station} {day}")
    return rows
