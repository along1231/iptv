"""Police, Hakka, Voice of Han, Kaohsiung and ICRT official radio sources."""
import hashlib
import html
import json
import re
import subprocess
from datetime import datetime, time, timedelta
from functools import lru_cache
from pathlib import Path
from urllib.parse import parse_qs, quote, urlencode, urljoin, urlsplit
from zoneinfo import ZoneInfo

from radio_http import fetch

ZONE = ZoneInfo("Asia/Taipei")
PBS = "https://www.pbs.npa.gov.tw"
PBS_LIST = PBS + "/ch/app/programList/list?id=18112&module=programlist"
PBS_PLAYER = "https://www.pbs.gov.tw/live/index.html?name="
PBS_NAMES = {"pbs": "全國治安交通網", "tps": "臺北分臺", "scs": "新竹分臺", "tcs": "臺中分臺",
             "tns": "臺南分臺", "kss": "高雄分臺", "els": "宜蘭分臺", "hls": "花蓮分臺", "tts": "臺東分臺"}
HAKKA = "https://www.hakkaradio.org.tw"
VOH = "https://audio.voh.com.tw"
VOH_GUIDE = VOH + "/tw/PublicInfo/ugC_PublicInfo_Detail.aspx?CID=1&ID=26"
VOH_CHANNELS = {"voh-fm": "1", "voh-am": "2"}
KBS = "https://www.kbs.gov.tw"
ICRT = "https://www.icrt.com.tw"
ICRT_GUIDE = ICRT + "/schedule.php?mlevel1=12&mlevel2=30"
STATIONS = {**{"pbs-" + k: "警廣 · " + v for k, v in PBS_NAMES.items()}, "hakka-main": "講客廣播電臺",
            "voh-fm": "漢聲廣播電臺 FM", "voh-am": "漢聲廣播電臺 AM", "kbs-fm": "高雄廣播電臺 FM94.3",
            "kbs-am": "高雄廣播電臺 AM1089", "icrt-fm": "ICRT 台北國際社區廣播電台"}
LOGOS = {org: org + ".png" for org in ("pbs", "hakka", "voh", "kbs", "icrt")}


def page_url(key):
    org, ident = key.split("-")
    if org == "pbs":
        return PBS_PLAYER + ident.upper()
    if org == "voh":
        return VOH + "/TW/Program/ugC_AMFM.aspx?Type=" + VOH_CHANNELS[key]
    return {"hakka": HAKKA + "/schedule/view", "kbs": KBS + "/index.aspx#/ListenOnline",
            "icrt": ICRT + "/icrt_channel.php"}[org]


def guide_url(key):
    org, _ = key.split("-")
    return {"pbs": PBS_LIST, "voh": VOH_GUIDE, "icrt": ICRT_GUIDE,
            "kbs": KBS + "/index.aspx#/ProgramList", "hakka": HAKKA + "/schedule/view"}[org]


def post_json(url, params):
    body = urlencode(params).encode()
    return json.loads(subprocess.check_output(["curl", "-fsSL", "--max-time", "25", "--retry", "1",
                                               "--data-binary", "@-", url], input=body))


def voh_live(key):
    # The official player requests its public IP and passes it to VideoDisplay on play.
    ip = json.loads(fetch("https://api.ipify.org?format=json"))["ip"]
    channel = VOH_CHANNELS[key]
    data = post_json(VOH + "/API/ugC_ProgramHandle.ashx",
                     {"Type": "VideoDisplay", "PlayChannel": channel, "IP": ip})
    if str(data["PlayChannel"]) != channel or not data["token"] or urlsplit(data["Url"]).scheme != "https":
        raise ValueError("漢聲未提供所选频道的直播地址")
    return data["Url"] + "?" + urlencode({"token": data["token"], "expires": data["expires"]})


@lru_cache(maxsize=1)
def pbs_directory():
    page = fetch(PBS_LIST).decode()
    stations = {}
    for block in page.split('class="pic"')[1:]:
        detail = re.search(r'href="(/ch/app/programList/detail\?[^"]+)"', block)
        code = re.search(r'href="https://www\.pbs\.gov\.tw/live/index\.html\?name=([A-Z]+)"', block)
        if detail and code:
            stations[code[1].lower()] = parse_qs(urlsplit(html.unescape(detail[1])).query)
    if not PBS_NAMES.keys() <= stations.keys():
        raise ValueError("警广目录缺少频道")
    return stations


def pbs_streams():
    pbs_directory()
    page = fetch(PBS_PLAYER + "PBS").decode()
    script = re.search(r'<script src="([^"]*/my\.js)"', page)
    config = fetch(urljoin(PBS_PLAYER, script[1])).decode() if script else ""
    route = re.search(r"src:\s*'(https://[^']+)'\s*\+\s*x\s*\+\s*'([^']+)'", config)
    special = re.search(r"x\s*==\s*'PBS'\s*\?\s*'([^']+)'", config)
    if not route or not special:
        raise ValueError("警广官网播放器配置有变")
    return {"pbs-" + k: route[1] + (special[1] if k == "pbs" else k.upper()) + route[2] for k in PBS_NAMES}


def hakka_stream():
    page = fetch(HAKKA + "/schedule/view").decode()
    for script in re.findall(r'<link rel="modulepreload"[^>]+href="([^"]+\.js)"', page):
        code = fetch(urljoin(HAKKA, script)).decode()
        main = re.search(r'sublive\?[`"]https://[^`"]+[`"]:[`"](https://[^`"]+/hls\.m3u8)[`"]', code)
        if main:
            return {"hakka-main": main[1]}
    raise ValueError("讲客常态直播地址缺失")


def kbs_streams():
    page = fetch(KBS + "/index.aspx").decode()
    bundle = re.search(r'<script src="(/bundles/home[^"]*)"', page)
    code = fetch(urljoin(KBS, html.unescape(bundle[1]))).decode() if bundle else ""
    streams = dict(re.findall(r'live_(FM|AM):"(https://[^"]+\.m3u8)"', code))
    return {"kbs-" + key.lower(): streams[key] for key in ("FM", "AM")}


def icrt_stream():
    page = re.sub(r"<!--.*?-->", "", fetch(page_url("icrt-fm")).decode(), flags=re.S)
    tag = re.search(r'<source\s+src="(https://[^"]+)"', page)
    if not tag:
        raise ValueError("ICRT 播放器缺少音源")
    return {"icrt-fm": html.unescape(tag[1])}


def moment(day, clock):
    if clock == "24:00":
        day, clock = day + timedelta(days=1), "00:00"
    return datetime.combine(day, time.fromisoformat(clock), ZONE)


def by_start(day, listing):
    starts = sorted(listing)
    if not starts or len({clock for clock, _ in starts}) != len(starts):
        raise ValueError(f"空节目表或开播时刻重复 {day}")
    return [(moment(day, clock), moment(day, end), name)
            for (clock, name), end in zip(starts, [c for c, _ in starts[1:]] + ["24:00"])]


def pbs_guide(ident, today):
    directory = pbs_directory()[ident]
    start = moment(today, "00:00")
    stop = start + timedelta(days=2)
    shows = []
    for n in (-1, 0, 1):
        day = today + timedelta(days=n)
        params = {k: directory[k][0].strip() for k in ("module", "id", "serno", "stationSerno")}
        params.update(day=day.isoweekday(), type="json")
        entries = json.loads(fetch(PBS + "/ch/app/openData/programList/detail?" + urlencode(params)))
        if not entries:
            raise ValueError(f"警广 {ident} 未返回星期 {day.isoweekday()} 的节目表")
        for item in entries:
            if item["stationName"] != PBS_NAMES[ident]:
                raise ValueError(f"警广频率不符 {ident}")
            a, b = [moment(day, item[k]) for k in ("startTime", "endTime")]
            if b < a:
                b += timedelta(days=1)
            if a < stop and b > start:
                shows.append((a, b, item["subject"].strip()))
    # News bulletins have their own slots within magazine programmes.
    bounds = sorted({start, start + timedelta(days=1), stop} |
                    {max(a, start) for a, _, _ in shows} | {min(b, stop) for _, b, _ in shows})
    rows = []
    for a, b in zip(bounds, bounds[1:]):
        active = sorted((end - begin, title) for begin, end, title in shows if begin <= a < end)
        if active:
            name = " / ".join(dict.fromkeys(t for length, t in active if length == active[0][0]))
            rows.append((a, b, name))
    return rows


def hakka_day(day):
    entries = json.loads(fetch("https://api.hakkaradio.org.tw/api/schedule/dayOfWeek?day=" + str(day.isoweekday())))
    news = {e["start"][:2] for e in entries if e["id"] == 131}
    shows = []
    for e in entries:
        clock, end = e["start"], e["end"]
        hour = clock[:2]
        if e["id"] == 131:
            clock, end = hour + ":00", hour + ":03"
        elif hour in news and clock.endswith(":00"):
            clock = hour + ":04"
        shows.append((moment(day, clock), moment(day, end) + timedelta(minutes=1), e["title"].strip()))
    shows.sort()
    # The station sometimes lists the next show inside the preceding show's stated range.
    return [(a, min(b, shows[i + 1][0]) if i + 1 < len(shows) else b, name) for i, (a, b, name) in enumerate(shows)]


@lru_cache(maxsize=1)
def voh_table():
    page = fetch(VOH_GUIDE).decode()
    match = re.search(r'href="([^"]+2026節目表\.pdf)"', page)
    if not match or hashlib.sha256(fetch(urljoin(VOH, quote(match[1])))).hexdigest() != (
            "a1b6d738c1c0daa4426488582a47861546415b0b31843e596385cae03cc7c850"):
        raise ValueError("汉声年度节目表已变更，需要重新核对")
    lines = Path(__file__).with_name("voh-2026.tsv").read_text().splitlines()
    return [line.split("\t") for line in lines if line and not line.startswith("#")]


def voh_day(band, day):
    if day.year != 2026:
        return []
    shows = {clock[:2] + ":" + clock[2:]: title for ident, days, clock, title in voh_table()
             if ident == band and str(day.isoweekday()) in days}
    # Date-limited amendments printed on the last panel of the official schedule.
    if band == "fm" and day.isoweekday() == 7 and day.month <= 5:
        shows.update({"05:00": "漢聲劇場", "05:30": "聽！故事", "11:00": "不明兵日記", "11:30": "蘇珊Sofa事"})
    if band == "fm" and day.isoweekday() == 3 and day.month >= 9:
        shows["00:00"] = "好好過日子"
    if band == "am" and day.isoweekday() == 7 and day.month <= 3:
        shows["12:20"] = "島嶼廚房"
    return [row for row in by_start(day, shows.items()) if row[2] != "收播"]


@lru_cache(maxsize=1)
def kbs_tables():
    return {c["Name"]: c["Content1"] for c in post_json(KBS + "/GetProgramList.aspx", {})["Data"]}


def clean(value):
    return " ".join(html.unescape(re.sub(r"<[^>]+>", " ", value)).split())


def kbs_day(band, day):
    source = kbs_tables()[{"fm": "FM94.3", "am": "AM1089"}[band]]
    label = {6: "星期六", 7: "星期日"}.get(day.isoweekday(), "星期一至星期五")
    blocks = re.split(r'<div class="pl_week">([^<]+)</div>', source)
    block = dict(zip(blocks[1::2], blocks[2::2]))[label]
    pairs = re.findall(r'<ul[^>]*>\s*<li>(.*?)</li>\s*<li>(.*?)</li>', block, re.S)
    return by_start(day, [(clean(c), clean(n)) for c, n in pairs])


def icrt_day(day):
    sunday = day - timedelta(days=day.isoweekday() % 7)
    page = fetch(ICRT_GUIDE + "&week_date=" + sunday.isoformat()).decode()
    blocks = re.split(r'<div class="titlesBox">\w+<br\s*/?>\s*([\d-]+)</div>', page)
    block = dict(zip(blocks[1::2], blocks[2::2])).get(day.isoformat(), "")
    shows = re.findall(r'<div class="mob_grid[^"]*"[^>]*>\s*(\d\d:\d\d)\s*~\s*(\d\d:\d\d)<br\s*/?>(.*?)</div>', block, re.S)
    return [(moment(day, a), moment(day, "24:00" if b == "00:00" else b), clean(name)) for a, b, name in shows]


def guide_rows(key, today):
    org, band = key.split("-")
    if org == "pbs":
        return pbs_guide(band, today)
    rows = []
    for day in (today, today + timedelta(days=1)):
        if org == "voh":
            rows.extend(voh_day(band, day))
        elif org == "kbs":
            rows.extend(kbs_day(band, day))
        elif org == "icrt":
            rows.extend(icrt_day(day))
        else:
            rows.extend(hakka_day(day))
    return rows
