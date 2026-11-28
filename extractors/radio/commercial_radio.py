"""Official BCC, UFO, KISS and Metro Broadcast players and programme schedules."""
import json
import re
from datetime import datetime, timedelta
from functools import lru_cache
from urllib.parse import urljoin, urlsplit

from radio_http import fetch
from taiwan_radio import ZONE, clean, moment

BCC = "https://www.bcc.com.tw"
UFO = "https://www.uforadio.com.tw"
KISS = "https://www.kiss.com.tw"
METRO = "https://www.metroradio.com.hk"
BCC_GUIDES = {
    "bcc-news": ("中廣新聞網", 1, "news_program.asp"),
    "bcc-pop": ("中廣流行網", 2, "news2_list.asp"),
    "bcc-music": ("中廣音樂網", 3, "news3_list.asp"),
    "bcc-country": ("中廣鄉親網", 6, "news6_program.asp"),
    "bcc-531": ("I go 531", 4, "news4_program.asp"),
}
METRO_GUIDES = {
    "metro-info": ("新城知訊台 FM99.7", "997", "Live997.aspx", "997/Program/Schedule/Default2024.aspx"),
    "metro-finance": ("新城財經台 FM104", "MF", "LiveMF.aspx", "MetroFinance/Multimedia/ProgramTimeTable2024.aspx"),
    "metro-plus": ("新城采訊台 AM1044", "1044", "LivePlus.aspx", "1044/Schedule/Default2024.aspx"),
}
STATIONS = {**{k: v[0] for k, v in BCC_GUIDES.items()}, "bcc-531": "中廣 i go 531",
            "ufo-fm": "飛碟電台 FM92.1", "kiss-fm": "KISS Radio 大眾廣播 FM99.9",
            **{k: v[0] for k, v in METRO_GUIDES.items()}}
REGIONS = {key: "香港" if key in METRO_GUIDES else "台湾" for key in STATIONS}
LOGOS = {key: key + ".svg" if key in METRO_GUIDES else key.split("-")[0] + ".png" for key in STATIONS}


def guide_url(key):
    if key in BCC_GUIDES:
        return BCC + "/" + BCC_GUIDES[key][2]
    if key in METRO_GUIDES:
        return METRO + "/" + METRO_GUIDES[key][3]
    return UFO + "/schedule" if key == "ufo-fm" else KISS + "/show/showtime.php"


def page_url(key):
    if key in METRO_GUIDES:
        return METRO + "/superhome/" + METRO_GUIDES[key][2]
    if key == "kiss-fm":
        return KISS + "/radio_hq.php"
    return UFO + "/" if key == "ufo-fm" else guide_url(key)


@lru_cache(maxsize=1)
def bcc_players():
    data = json.loads(fetch(BCC + "/webapi/BCCRadioWebAPI/ChannelInfoBat"))
    return {row["name"]: row["iosStream"] for row in data}


def live_url(key):
    if key in BCC_GUIDES:
        url = bcc_players()[BCC_GUIDES[key][0]]
    else:
        page = fetch(page_url(key)).decode(errors="replace")
        if key == "kiss-fm":
            frame = re.search(r'<iframe\b[^>]*\bsrc="([^"]*hichannel2\.php\?api=1)"', page)
            if not frame:
                raise ValueError("KISS 官网未提供直播播放器")
            page = fetch(urljoin(KISS, frame[1])).decode()
        source = re.search(r'<source\s+src="(https://[^"]+)"', page)
        if not source:
            raise ValueError(f"{key} 官网播放器未提供音源")
        url = source[1].replace("&amp;", "&")
    if urlsplit(url).scheme != "https" or not urlsplit(url).hostname:
        raise ValueError(f"{key} 官网音源无效")
    return url


def slot(day, start, stop, title):
    start, stop = moment(day, start), moment(day, stop)
    if stop < start:
        stop += timedelta(days=1)
    return start, stop, clean(title)


def bcc_guide(key, today):
    page = fetch(guide_url(key)).decode(errors="replace")
    dates = { (int(month), int(day)): int(offset) for offset, month, day in
              re.findall(r'onclick="block_program\((-?\d+)\)"[^>]*>\s*(\d+)月(\d+)日', page)}
    pattern = (r'<div class="tm2(?:_2)?">\s*(\d\d:\d\d)~(\d\d:\d\d)?\s*</div>'
               r'\s*<div class="tt34(?:_2)?">.*?</div>\s*<div class="tt33(?:_2)?">(.*?)</div>')
    rows = []
    for day in (today, today + timedelta(days=1)):
        offset = dates[(day.month, day.day)]
        feed = fetch(f"{BCC}/_ajax/program_{BCC_GUIDES[key][1]}.asp?dt={offset}").decode()
        matches = re.findall(pattern, feed, re.S)
        if not matches or len(matches) != len(re.findall(r'<div class="tm2(?:_2)?">', feed)):
            raise ValueError(f"{key} 官网节目格式有变 {day}")
        # The next dated grid supersedes any continuation after midnight.
        # A blank stop is omitted unless the next listed start supplies the boundary.
        limit = moment(day, "24:00")
        daily = []
        for index, (a, b, name) in enumerate(matches):
            if not b:
                if index + 1 < len(matches):
                    b = matches[index + 1][0]
                else:
                    next_date = day + timedelta(days=1)
                    next_offset = dates[(next_date.month, next_date.day)]
                    next_feed = fetch(f"{BCC}/_ajax/program_{BCC_GUIDES[key][1]}.asp?dt={next_offset}").decode()
                    first = re.search(pattern, next_feed, re.S)
                    if not first or first[1] != "00:00":
                        continue
                    b = "24:00"
            start, stop, title = slot(day, a, b, name)
            daily.append((start, min(stop, limit), title))
        # For contradictory entries keep both official names during their overlap.
        cuts = sorted({t for a, b, _ in daily for t in (a, b)})
        for a, b in zip(cuts, cuts[1:]):
            names = list(dict.fromkeys(title for start, stop, title in daily if start <= a < stop))
            if names:
                rows.append((a, b, " ／ ".join(names)))
    return rows


def ufo_guide(today):
    rows = []
    for day in (today, today + timedelta(days=1)):
        page = fetch(f"{UFO}/schedule?weekday={day.weekday()}").decode()
        blocks = re.findall(fr'<li class="program week{day.weekday()}">(.*?)</li>', page, re.S)
        if not blocks:
            raise ValueError(f"飞碟官网未提供星期排期 {day}")
        for block in blocks:
            times = re.search(r'class="time">\s*(\d\d:\d\d)<br\s*/?>(\d\d:\d\d)', block)
            title = re.search(r'class="name">\s*<a[^>]*>(.*?)</a>', block, re.S)
            if not times or not title:
                raise ValueError(f"飞碟节目格式有变 {day}")
            rows.append(slot(day, *times.groups(), title[1]))
    return rows


def kiss_guide(today):
    page = fetch(guide_url("kiss-fm")).decode(errors="replace")
    table = page.split('<table id="showtable"', 1)[-1].split("</table>", 1)[0]
    if re.findall(r"<th>(.*?)</th>", table) != ["時段", "週日", "週一", "週二 - 週五", "週六"]:
        raise ValueError("KISS 周表栏目有变")
    columns = [[] for _ in range(4)]
    ends = [0] * 4
    for tr in re.findall(r"<tr\b[^>]*>(.*?)</tr>", table, re.S)[1:]:
        cells = re.findall(r"<td\b([^>]*)>(.*?)</td>", tr, re.S)
        hour = int(cells[0][1])
        free = [i for i, end in enumerate(ends) if end == hour]
        if len(free) != len(cells) - 1:
            raise ValueError(f"KISS 周表列数有变 {hour}")
        for col, (attrs, content) in zip(free, cells[1:]):
            span = re.search(r'rowspan="(\d+)"', attrs)
            ends[col] = hour + (int(span[1]) if span else 1)
            name = re.search(r"<li[^>]*>(.*?)(?:<br|</li>)", content, re.S)
            if not name:
                raise ValueError(f"KISS 缺少节目名 {hour}")
            columns[col].append((f"{hour:02}:00", f"{ends[col]:02}:00", name[1]))
    if ends != [24] * 4:
        raise ValueError("KISS 周表不完整")
    rows = []
    for day in (today, today + timedelta(days=1)):
        column = {6: 0, 0: 1, 5: 3}.get(day.weekday(), 2)
        rows.extend(slot(day, *entry) for entry in columns[column])
    return rows


def metro_guide(key, today):
    channel = METRO_GUIDES[key][1]
    url = f"https://mobilecms.metroradio.com.hk/api/Programs/WeeklySchedule?channel={channel}&date={today}"
    grid = json.loads(fetch(url))["result"]
    if grid["channel"] != channel:
        raise ValueError(f"新城官网频道不符 {key}")
    start, end = moment(today, "00:00"), moment(today + timedelta(days=2), "00:00")
    rows = []
    for day in grid["days"]:
        for show in day["programs"]:
            a, b = (datetime.fromisoformat(show[k]).replace(tzinfo=ZONE) for k in ("timeFrom", "timeTo"))
            if a < end and b > start:
                rows.append((max(start, a), min(end, b), clean(show["programTitle"])))
    return rows


def guide_rows(key, today):
    if key in METRO_GUIDES:
        rows = metro_guide(key, today)
    elif key in BCC_GUIDES:
        rows = bcc_guide(key, today)
    else:
        rows = ufo_guide(today) if key == "ufo-fm" else kiss_guide(today)
    previous = moment(today, "00:00")
    for start, stop, title in rows:
        if not title or start < previous or stop <= start:
            raise ValueError(f"官网排期异常 {key} {start} {stop} {title}")
        previous = stop
    if len({r[0].date() for r in rows}) != 2:
        raise ValueError(f"缺少两日排期 {key}")
    return rows
