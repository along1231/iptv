"""KBS ON AIR radio and its Seoul-time broadcast-day grid."""
from datetime import datetime, timedelta
import json
from urllib.parse import urlencode
from zoneinfo import ZoneInfo

from radio_http import fetch

SEOUL = ZoneInfo("Asia/Seoul")
GUIDE = "https://schedule.kbs.co.kr/?sname=schedule&stype=table&type=radioList"


def live_url(code):
    base = "https://pwwwapi.kbs.co.kr/api/v1/landing/live/channel_code/"
    data = json.loads(fetch(base + code))
    for item in data.get("channel_item", []):
        if item.get("channel_code") == code and item.get("media_type") == "radio" and item.get("service_url"):
            return item["service_url"]
    raise ValueError("KBS 官网没有发布该台音频")


def planned_time(midnight, stamp):
    if len(stamp) != 8 or not stamp.isdigit():
        raise ValueError("KBS 播出时刻格式已变")
    # KBS represents the hours after midnight as 24–29 on the previous broadcast day.
    return midnight + timedelta(hours=int(stamp[:2]), minutes=int(stamp[2:4]), seconds=int(stamp[4:6]))


def guide_rows(code, start, end):
    first = start.astimezone(SEOUL).date() - timedelta(days=1)
    last = (end - timedelta(seconds=1)).astimezone(SEOUL).date()
    query = urlencode({"rtype": "json", "local_station_code": "00", "channel_code": code,
                       "program_planned_date_from": first.strftime("%Y%m%d"),
                       "program_planned_date_to": last.strftime("%Y%m%d")})
    groups = json.loads(fetch("https://static.api.kbs.co.kr/mediafactory/v1/schedule/weekly?" + query))
    rows = []
    for group in groups:
        if group["channel_code"] != code or group["local_station_code"] != "00":
            continue
        midnight = datetime.strptime(group["program_planned_date"], "%Y%m%d").replace(tzinfo=SEOUL)
        for r in group["schedules"]:
            a = planned_time(midnight, r["program_planned_start_time"]).astimezone(start.tzinfo)
            b = planned_time(midnight, r["program_planned_end_time"]).astimezone(start.tzinfo)
            name = r.get("programming_table_title") or r.get("program_title") or ""
            rows.append((a, b, " ".join(name.split())))
    return rows
