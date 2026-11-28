"""Abridged RTHK radio1 timetable for 2026-11-28, as returned by getTimetable."""
from datetime import date, datetime
import json
from pathlib import Path
import sys
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "extractors" / "radio"))
import rthk

day = date(2026, 11, 28)
payload = {"y": "2026", "m": "11", "d": "28", "timetable": [
    {"start": "00:00", "end": "01:00", "name": "那些年 張偉基"},
    {"start": "22:20", "end": "00:00", "name": r"What\'s Up Bro"},
]}
with patch.object(rthk, "fetch", return_value=json.dumps(payload).encode()):
    first, last = rthk.day_guide("radio1", day)
    assert first[0] == datetime(2026, 11, 28, tzinfo=rthk.HK)
    assert last == (datetime(2026, 11, 28, 22, 20, tzinfo=rthk.HK),
                    datetime(2026, 11, 29, tzinfo=rthk.HK), "What's Up Bro")
    try:
        rthk.day_guide("radio1", date(2026, 11, 29))
    except ValueError:
        pass
    else:
        raise AssertionError("wrong-day schedule accepted")

print("香港广播跨日排期、标题转义及日期校验通过")
