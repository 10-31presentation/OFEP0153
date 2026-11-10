"""Fetch JR East timetables for Tamachi station and write them as JSON.

Usage: python3 scripts/fetch_tamachi_timetable.py
Output: data/tamachi.json
"""

import html
import json
import re
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path

BASE_URL = "https://timetables.jreast.co.jp/2610/timetable/tt0976/"
# Page IDs: 097601x = Yamanote outer, 02x = Yamanote inner,
# 03x = Keihin-Tohoku southbound, 04x = northbound; x0 = weekday, x1 = Sat/holiday.
PAGE_IDS = ["0976010", "0976011", "0976020", "0976021", "0976030", "0976031", "0976040", "0976041"]
HOLIDAYS_URL = "https://holidays-jp.github.io/api/v1/date.json"
OUTPUT = Path(__file__).resolve().parent.parent / "data" / "tamachi.json"
# Hours before this belong to the previous service day (e.g. 0時 -> 24:xx).
SERVICE_DAY_START_HOUR = 4


def fetch(url):
    # curl uses the system certificate store; python.org builds of Python may lack one.
    result = subprocess.run(
        ["curl", "-sSfL", "--max-time", "30", "-A", "Mozilla/5.0", url],
        capture_output=True, check=True,
    )
    return result.stdout.decode("utf-8")


def strip_tags(text):
    return html.unescape(re.sub(r"<[^>]+>", "", text)).strip()


def parse_legend(page):
    legend_html = page[page.find("<!-- 凡例 -->"):]
    legend = {}
    for title, body in re.findall(r"<dt>(.*?)</dt>\s*<dd>(.*?)</dd>", legend_html, re.S):
        pairs = [strip_tags(span).split("=", 1) for span in re.findall(r"<span[^>]*>(.*?)</span>", body, re.S)]
        legend[strip_tags(title)] = {key: value for key, value in pairs}
    return legend


def parse_page(page_id, page):
    heading = strip_tags(re.search(r"<h2>(田町駅.*?)</h2>", page).group(1))
    match = re.match(r"田町駅\s+(\S+)\s+(.+?)\s*\((.+)\)$", heading)
    line, direction, bound = match.groups()
    day_label = strip_tags(re.search(r'<h3 class="(?:weekday|holiday)">(.*?)</h3>', page).group(1))

    legend = parse_legend(page)
    train_types = legend["列車種別・列車名"]
    destinations = legend["行き先・経由"]
    marks = legend.get("変更・注意マーク", {})

    departures = []
    for hour, cell in re.findall(r'<tr id="time_(\d+)">.*?<td>.*?</td>\s*<td>(.*?)</td>\s*</tr>', page, re.S):
        hour = int(hour)
        service_hour = hour + 24 if hour < SERVICE_DAY_START_HOUR else hour
        for train, dest, misc, body in re.findall(
            r'data-train="([^"]*)" data-dest="([^"]*)" data-misc="([^"]*)">(.*?)</div>', cell, re.S
        ):
            minute = int(re.search(r'<span class="minute">(\d+)</span>', body).group(1))
            departures.append({
                "time": f"{service_hour:02d}:{minute:02d}",
                "type": train_types[train],
                "destination": destinations[dest],
                "notes": [marks[m] for m in misc if m in marks],
            })

    return {
        "line": line,
        "direction": direction,
        "bound": bound,
        "dayType": "weekday" if day_label == "平日" else "holiday",
        "dayLabel": day_label,
        "url": f"{BASE_URL}{page_id}.html",
        "departures": departures,
    }


def main():
    timetables = []
    for page_id in PAGE_IDS:
        timetables.append(parse_page(page_id, fetch(f"{BASE_URL}{page_id}.html")))
        time.sleep(1)

    data = {
        "station": "田町",
        "source": "JR東日本 駅の時刻表 (https://timetables.jreast.co.jp/)",
        "sourceNote": "JRデータの内容は、株式会社交通新聞社発行の「JR時刻表」2026年10月号に基づいています。",
        "fetchedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "timeFormat": "HH:MM; hours >= 24 are after midnight on the same service day",
        # Japanese national holidays use the Sat/holiday timetable.
        "holidays": json.loads(fetch(HOLIDAYS_URL)),
        "timetables": timetables,
    }
    OUTPUT.parent.mkdir(exist_ok=True)
    OUTPUT.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    for t in timetables:
        print(f"{t['line']} {t['direction']} {t['dayLabel']}: {len(t['departures'])} departures")


if __name__ == "__main__":
    main()
