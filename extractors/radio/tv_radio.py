"""Radio services found in existing television catalogues. Station IDs are allowlisted."""
import json
import re
import subprocess
from datetime import datetime, time, timedelta
from pathlib import Path
from urllib.parse import urlencode, urlsplit, urljoin
from zoneinfo import ZoneInfo

import kbs_radio
from radio_http import fetch

ROOT = Path(__file__).resolve().parent
ZONE = ZoneInfo("Asia/Shanghai")
CATALOG = json.loads((ROOT / "tv_radio_stations.json").read_bytes())
STATIONS = {k: v["name"] for k, v in CATALOG.items()}
NMIP = {"shaoxing": "https://app.shaoxing.com.cn", "fuzhou": "https://app.zohi.tv"}
TENMA = {"haidong": "https://hdapp.hdhhy.cn", "geermu": "https://grmapp.geermurmt.cn"}
M2O = {"putian": "https://mapi.ptbtv.com"}
YC = "https://frontendyc.0515yc.cn/cloudlive-manage-mapi/api/topic/"
GANSU = "https://app-api.gstv.com.cn/gs/liveRoomConfig/getTvBroadcastLiveList"
GZ = "https://gzbn.gztv.com:7443/media-cloud-manage-app/liveChannel/queryLiveChannelList?type=2"


def page_url(key):
    return CATALOG[key]["page"]


def referrer(key):
    parts = urlsplit(page_url(key))
    return f"{parts.scheme}://{parts.netloc}/"


def get(url):
    return json.loads(fetch(url))


def bridge(provider, ident, *args):
    return subprocess.check_output(["node", str(ROOT / "tv_radio_player.mjs"), provider, ident, *args],
                                   timeout=35, text=True).strip()


def match(rows, field, ident):
    for row in rows:
        if str(row[field]) == ident:
            return row
    raise ValueError(f"官方目录已找不到频道 {ident}")


def tenma(provider, ident):
    return get(TENMA[provider] + "/tenma01ds_tvradio/Apphome/home?" +
               urlencode({"channel_id": ident, "channel_type": 2}))["data"]


def yc_program(key, day):
    page = fetch(page_url(key)).decode()
    secret = re.search(r"sort_id:'592759960396386304',\s*app_secret:'([^']+)'", page)
    if not secret:
        raise ValueError("盐城广播页配置已变")
    data = get(YC + "program/list?" + urlencode({"app_secret": secret[1], "topic_id": CATALOG[key]["id"], "date": day}))
    if data.get("error_code") != 200:
        raise ValueError("盐城节目表接口未返回成功")
    return data["result"]


def live_url(key):
    station = CATALOG[key]
    provider, ident, page = station["provider"], station["id"], station["page"]
    if provider in ("shanxi", "jiangmen", "nmtv", "jilin"):
        url = bridge(provider, ident)
    elif provider == "shaanxi":
        url = json.loads(bridge(provider, ident))[ident]["m3u8"]
    elif provider == "kbs":
        url = kbs_radio.live_url(ident)
    elif provider == "hubei":
        page_source = fetch(page).decode()
        block = page_source.split("audioList: [", 1)[1].split("],", 1)[0]
        active = re.sub(r"^\s*//[^\n]*", "", block, flags=re.M)
        entries = re.findall(r'id:\s*(\d+),\s*name:\s*"[^"]+",\s*fm:\s*"[^"]+",\s*stream:\s*"([^"]+)"', active)
        try:
            url = dict(entries)[ident]
        except KeyError:
            raise ValueError("长江云播放器已移除该频率") from None
    elif provider == "wuxi":
        source = fetch(page).decode()
        block = re.search(r"""window\[\s*['"]LIVE_CHANNELS['"]\s*\]\s*=\s*""", source)
        if not block:
            raise ValueError("无锡分享页缺少官网目录")
        rows, _ = json.JSONDecoder().raw_decode(source[block.end():])
        row = match(rows, "id", ident)
        if str(row["audio_only"]) != "1" or urlsplit(row["m3u8"]).hostname != "bb-live.wifiwx.com":
            raise ValueError("无锡官网没有发布此广播")
        url = row["m3u8"].replace("http://", "https://", 1)
    elif provider == "ningde":
        endpoint = "https://app.0593tv.cn/jhxtapi/jhxt/Live/detail"
        body = urlencode({"uid": 0, "device": "", "nid": "", "lid": ident, "siteid": 1})
        data = json.loads(subprocess.check_output(["curl", "-fsSL", "--max-time", "18", "-d", body, endpoint]))
        row = data["data"]
        if int(data["code"]) != 200 or str(row["id"]) != ident or row["type_info"]["name"] != "广播" or str(row["status"]) != "1":
            raise ValueError("宁德官网没有发布此广播")
        url = row["link"]
    elif provider == "hebei":
        endpoint = "https://api.cmc.hebrts.cn/scms/api/com/article/getArticleList?catalogId=32556&siteId=1"
        data = json.loads(subprocess.check_output(["curl", "-fsSL", "--max-time", "18", "-X", "POST", endpoint]))
        row = match(data["returnData"]["news"], "id", ident)
        url = row["liveAudio"][0]["formats"][0]["url"]
    elif provider == "sctv":
        source = fetch(page).decode().replace(r'\"', '"')
        rows, _ = json.JSONDecoder().raw_decode(source.split('"radio":', 1)[1])
        row = match(rows, "id", ident)
        if row.get("allowPlay") != 1:
            raise ValueError("当前频道未开放播放")
        url = row["playAddress"]
    elif provider == "gansu":
        data = json.loads(subprocess.check_output(["curl", "-fsSL", "--max-time", "18", "-H",
            "Content-Type: application/json", "-d", '{"type":2}', GANSU]))
        row = match(data["data"], "id", ident)
        if row["type"] != 2 or not row["shelfStatus"]:
            raise ValueError("甘肃广播已下架")
        url = row["liveUrl"]
    elif provider == "guangzhou":
        url = match(get(GZ)["data"], "code", ident)["httpUrl"]
    elif provider in NMIP:
        base = NMIP[provider] + "/video/player/"
        row = get(base + "stream?" + urlencode({"stream_id": ident, "site_id": "10001"}))
        if str(row["id"]) != ident or str(row["live_type"]) != "2" or str(row["access_type"]) != "1":
            raise ValueError("官网未开放该广播")
        url = row["play_url"]
        if int(row.get("play_control") or 0):
            control = get(base + "getcontrol?" + urlencode({"stream_id": ident, "site_id": "10001"}))
            if not control["state"]:
                raise ValueError("官方播放器暂未开放此频道")
            url = control["data"]
    elif provider in M2O:
        row = match(get(M2O[provider] + "/api/v1/channel.php"), "id", ident)
        if str(row["audio_only"]) != "1":
            raise ValueError("官方目录不再标为广播")
        url = row["m3u8"]
    elif provider in TENMA:
        row = match(tenma(provider, ident)["channel_info"], "id", ident)
        if int(row["channel_type"]) != 2:
            raise ValueError("官网频道类型已变")
        url = row["m3u8"]
    elif provider == "yancheng":
        now = datetime.now(ZONE)
        show = next((r for r in yc_program(key, now.date()) if str(r.get("playing")) == "1"
                     and str(r.get("can_play")) == "1" and int(r["star_time_timestamp"]) <= now.timestamp()
                     < int(r["end_time_timestamp"])), None)
        if not show:
            raise ValueError("盐城当前无开放的直播条目")
        url = show["m3u8"]
    elif provider in ("ganzi", "dazhou"):
        row = get(urljoin(page, "/cms/home/content?id=" + ident))
        url = next(r["m3u8_url"] for r in row["exdata"]["lives"] if r["type"] == 2)
    elif provider == "mianyang":
        source = fetch(page).decode(errors="replace")
        found = re.search(r'"m3u8"\s*:\s*"([^"]+)"', source)
        if not found:
            raise ValueError("官网未返回广播流")
        url = urljoin(page, found[1])
    else:
        raise ValueError("未知广播来源")
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.hostname or parts.username or parts.password:
        raise ValueError("官网广播地址无效")
    return url


def epoch(value):
    return datetime.fromtimestamp(int(value), ZONE)


def local(value):
    return datetime.fromisoformat(value).replace(tzinfo=ZONE)


def tide_guide(url):
    text = fetch(url).decode("utf-8-sig").strip()
    wrapped = re.fullmatch(r"liveList\.jsonpCallback\((.*)\)\s*;?", text, re.S)
    if not wrapped:
        raise ValueError("官网节目表格式已变")
    return [(local(r["start_time"]), local(r["end_time"]), r["name"]) for r in json.loads(wrapped[1])
            if r.get("start_time") and r.get("end_time")]


def guide_rows(key, day):
    station = CATALOG[key]
    provider, ident = station["provider"], station["id"]
    start = datetime.combine(day, time.min, ZONE)
    end = start + timedelta(days=2)
    rows = []
    if provider in ("shanxi", "jiangmen"):
        rows = tide_guide(station["guide"])
    elif provider == "shaanxi":
        # The player publishes its current day only. Tomorrow's grid is not dated.
        source = json.loads(bridge(provider, ident))[ident].get("playlist")
        if source and day == datetime.now(ZONE).date():
            text = fetch(source).decode().strip()
            data = json.loads(text.split("=", 1)[1].strip().rstrip(";"))
            for r in data:
                a = local(f'{day} {r["start"]}')
                b = start + timedelta(days=1) if r["end"] in ("00:00","24:00") else local(f'{day} {r["end"]}')
                rows.append((a, b, r["name"]))
    elif provider == "kbs":
        rows = kbs_radio.guide_rows(ident, start, end)
    elif provider in ("nmtv", "jilin"):
        for offset in (0, 1):
            date = (day + timedelta(days=offset)).isoformat()
            shows = json.loads(bridge(provider, ident, date))
            for a, b, title in shows:
                stop = epoch(b // 1000)
                if stop.time() == time(23, 59, 59) or provider == "nmtv":
                    stop += timedelta(seconds=1)
                rows.append((epoch(a // 1000), stop, title))
    elif provider in TENMA:
        for entry in tenma(provider, ident)["programs"]:
            rows.extend((epoch(r["start_time"]), epoch(r["end_time"] + 1), r["program_name"]) for r in entry["program"])
    elif provider in NMIP or provider in M2O or provider in ("yancheng", "wuxi"):
        for offset in (0, 1):
            date = day + timedelta(days=offset)
            if provider in NMIP:
                since = int((start + timedelta(days=offset)).timestamp())
                data = get(NMIP[provider] + "/video/player/playbill?" + urlencode({"site_id": 10001,
                    "stream_id": ident, "start_time": since, "end_time": since + 86400}))
                if data["state"] is not True:
                    raise ValueError("官方节目表接口异常")
                rows.extend((epoch(r["starttime"]), epoch(r["endtime"]), r["name"]) for r in data["data"])
            elif provider in M2O or provider == "wuxi":
                zone = (date - datetime.now(ZONE).date()).days
                params = {"channel_id": ident, "zone": zone}
                if provider == "wuxi":
                    endpoint = "https://bb-mapi.wifiwx.com/api/open/wxbb/ds_program.php"
                    params.update(appid="m2oszr2ukmxzvqr4ai", appkey="7fbab2da9b4c7cd2405ffa7e8097cc22")
                else:
                    endpoint = M2O[provider] + "/api/v1/program.php"
                data = get(endpoint + "?" + urlencode(params))
                if not isinstance(data, list):
                    raise ValueError("M2O 节目表接口异常")
                rows.extend((epoch(r["start_time"]), epoch(int(r["start_time"]) + int(r["toff"])), r["theme"]) for r in data)
            else:
                rows.extend((epoch(r["star_time_timestamp"]), epoch(r["end_time_timestamp"]), r["title"])
                            for r in yc_program(key, date))
    valid = sorted(set((max(a,start),min(b,end),t.strip()) for a,b,t in rows
                       if a < end and b > start and b > a and t and t.strip() not in (station["name"], "当日回放", "精彩节目", "节目预告")))
    result = []
    for a,b,t in valid:
        if result and result[-1][0] == a:
            continue
        if result and result[-1][1] > a:
            prev,_,title = result[-1]
            result[-1] = (prev,a,title)
        result.append((a,b,t))
    return result
