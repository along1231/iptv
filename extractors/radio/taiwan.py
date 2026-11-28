"""Official Taiwanese radio players and daily programme guides."""
import html
import json
import re
from datetime import datetime, time, timedelta
from html.parser import HTMLParser
from urllib.parse import urlencode, urlsplit
from zoneinfo import ZoneInfo

from radio_http import fetch
import taiwan_radio

ZONE = ZoneInfo("Asia/Taipei")
RTI = "https://www.rti.org.tw"
RTI_GUIDE = RTI + "/programschedule?uid=4"
NER_API = "https://webapi.ner.gov.tw/nerwebFront/api"
TBS_API = "https://tbsapi.ginnet.cloud/api"
RTI_LABELS = {"rti-3": "華語線上收聽", "rti-6": "台客粵語和歐美外語Live", "rti-5": "亞洲語言Live"}
NER_NAMES = {"1": "臺北總臺 FM", "2": "臺北總臺 AM", "4": "彰化分臺 FM", "5": "高雄分臺 FM",
             "6": "臺東分臺 FM-1", "7": "臺東分臺 FM-2", "8": "花蓮分臺 FM-1", "9": "花蓮分臺 FM-2"}
STATIONS = {**{k: "央廣 · " + v for k, v in RTI_LABELS.items()},
            **{"ner-" + k: "教育電臺 · " + v for k, v in NER_NAMES.items()},
            "tbs-fm": "臺北廣播電臺 FM93.1", "tbs-am": "臺北廣播電臺 AM1134", **taiwan_radio.STATIONS}
MULTILINGUAL = {"rti-5", "rti-6"}
GUIDE_NOTE = "尚未核实这路多语直播的分时节目表"
LOGOS = {"rti": "rti.png", "ner": "ner.jpg", "tbs": "tbs.png", **taiwan_radio.LOGOS}


def page_url(key):
    if key in taiwan_radio.STATIONS:
        return taiwan_radio.page_url(key)
    org, ident = key.split("-")
    if org == "rti":
        return RTI + "/"
    if org == "ner":
        return "https://www.ner.gov.tw/Program/List/?id=" + ident
    return "https://tradio.gov.taipei/schedule?channel=" + ident


def api(url, params=None):
    if params:
        url += "?" + urlencode(params)
    data = json.loads(fetch(url))
    if data.get("success") is not True:
        raise ValueError(f"官网未返回有效数据 {url}")
    return data


class RtiPlayers(HTMLParser):
    def __init__(self):
        super().__init__()
        self.streams = {}
        self.current_url = None

    def handle_starttag(self, tag, attrs):
        if tag == "a":
            attrs = dict(attrs)
            self.current_url = attrs.get("data-live-url") if "data-program-url" in attrs else None

    def handle_data(self, data):
        if self.current_url and data.strip():
            self.streams[data.strip()] = self.current_url

    def handle_endtag(self, tag):
        if tag == "a":
            self.current_url = None


def education_streams():
    return {str(c["id"]): c["live"] for c in api(NER_API + "/Program/Live")["retData"] if c["isLive"]}


def live_url(key):
    org, ident = key.split("-")
    if org == "rti":
        parser = RtiPlayers()
        parser.feed(fetch(RTI + "/").decode())
        return parser.streams[RTI_LABELS[key]]
    if org == "ner":
        return education_streams()[ident]
    if org == "tbs":
        player = api(TBS_API + "/getLive", {"channel": ident})["item"]
        if player["channel"] != ident:
            raise ValueError("台北电台播放器频率不符")
        embed = fetch(player["player_url"]).decode()
        match = re.search(r"""\bsrc:\s*['"](https://[^'"]+\.m3u8(?:\?[^'"]*)?)['"]""", embed)
        if not match:
            raise ValueError("台北电台播放器未提供 HLS")
        return html.unescape(match[1])
    if org == "voh":
        return taiwan_radio.voh_live(key)
    players = {"pbs": taiwan_radio.pbs_streams, "hakka": taiwan_radio.hakka_stream,
               "kbs": taiwan_radio.kbs_streams, "icrt": taiwan_radio.icrt_stream}
    return players[org]()[key]


def rti_day(day):
    page = fetch(RTI_GUIDE + day.strftime("&date=%Y/%m/%d")).decode()
    listing = page.partition('<div class="programList">')[2]
    starts = re.split(r'<div class="time">\s*(\d\d:\d\d)', listing)
    shows = []
    for clock, item in zip(starts[1::2], starts[2::2]):
        name = re.search(r'<div class="name">\s*<a\b[^>]*>(.*?)</a>', item, re.S)
        if not name:
            raise ValueError(f"央广节目缺少标题 {day} {clock}")
        shows.append((datetime.combine(day, time.fromisoformat(clock), ZONE), html.unescape(name[1]).strip()))
    if not shows or shows[0][0].time() != time.min:
        raise ValueError(f"央广未返回完整的华语网络节目表 {day}")
    ends = [start for start, _ in shows[1:]] + [datetime.combine(day + timedelta(days=1), time.min, ZONE)]
    return [(start, end, name) for (start, name), end in zip(shows, ends)]


def ner_day(ident, day):
    params = {"channel": ident, "date": f"{day} 00:00", "pagesize": 300, "pageindex": 1}
    rows = []
    for entry in api(NER_API + "/ProgramSchedule/DailySchedule", params)["retData"]:
        start = datetime.fromisoformat(entry["programDate"]).replace(tzinfo=ZONE)
        if str(entry["channelId"]) != ident or start.date() != day or start.strftime("%H:%M") != entry["timeStart"]:
            raise ValueError(f"教育电台节目日期或频率不符 {ident} {day}")
        clock = entry["timeEnd"]
        end = datetime.combine(day, time.fromisoformat("00:00" if clock == "24:00" else clock), ZONE)
        if end < start or clock == "24:00":
            end += timedelta(days=1)
        rows.append((start, end, entry["title"].strip()))
    return rows


def tbs_day(band, day):
    params = {"language": "zh-Hant-TW", "date": day.isoformat(), "channel": band}
    rows = []
    for entry in api(TBS_API + "/getProgramItemsByDate", params)["items"]:
        start, end = [datetime.fromisoformat(entry[k]).replace(tzinfo=ZONE) for k in ("recording_start", "recording_end")]
        if entry["channel"] != band or start.date() != day:
            raise ValueError(f"台北电台节目日期或频率不符 {band} {day}")
        rows.append((start, end, entry["program_name"].strip()))
    return rows


def guide_rows(key, today):
    if key in MULTILINGUAL:
        return []
    org, ident = key.split("-")
    if key in taiwan_radio.STATIONS:
        rows = taiwan_radio.guide_rows(key, today)
    else:
        rows = []
        for day in (today, today + timedelta(days=1)):
            if org == "rti":
                rows.extend(rti_day(day))
            elif org == "ner":
                rows.extend(ner_day(ident, day))
            else:
                rows.extend(tbs_day(ident, day))
    previous = None
    for start, end, name in rows:
        if not name or start >= end or (previous and start < previous):
            raise ValueError(f"{key} 节目时段或标题异常 {start} {name}")
        previous = end
    return rows
