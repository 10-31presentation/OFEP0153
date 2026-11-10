"""Fetch ODPT public station timetables and build the static Mita departure board.

python3 scripts/build_mita_timetable.py           # refresh from public API
python3 scripts/build_mita_timetable.py --offline # rebuild saved API responses
"""

import argparse
import json
import re
import subprocess
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlencode

ROOT = Path(__file__).resolve().parent.parent
API = 'https://api-public.odpt.org/api/v4/'
CATALOG = 'https://catalog.data.metro.tokyo.lg.jp/dataset/t000018d0000000052'
RESOURCE = 'https://ckan.odpt.org/dataset/r_station_timetable-toei'
PROVIDER = '東京都交通局・公共交通オープンデータ協議会'
STATIONS = {'odpt.Station:Toei.Asakusa.Mita', 'odpt.Station:Toei.Mita.Mita'}
PLATFORMS = {
    ('odpt.Railway:Toei.Asakusa', 'odpt.RailDirection:Southbound'): ('1', '浅草線', '西馬込・羽田空港・京急線方面'),
    ('odpt.Railway:Toei.Asakusa', 'odpt.RailDirection:Northbound'): ('2', '浅草線', '押上・京成線・北総線方面'),
    ('odpt.Railway:Toei.Mita', 'odpt.RailDirection:Southbound'): ('3', '三田線', '目黒・東急線方面'),
    ('odpt.Railway:Toei.Mita', 'odpt.RailDirection:Northbound'): ('4', '三田線', '西高島平方面'),
}
CALENDARS = {'odpt.Calendar:Weekday': 'weekday', 'odpt.Calendar:SaturdayHoliday': 'holiday'}


def read_json(path):
    return json.loads(path.read_text(encoding='utf-8'))


def write_json(path, data):
    # Publish a complete file only after every source has passed validation.
    payload = json.dumps(data, ensure_ascii=False, indent=2) + '\n'
    with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=path.parent, delete=False) as file:
        file.write(payload)
        temporary = Path(file.name)
    temporary.replace(path)


def fetch(kind, **query):
    url = API + kind + ('?' + urlencode(query) if query else '')
    result = subprocess.run(['curl', '--fail', '--silent', '--show-error', '--location',
                             '--retry', '2', '--max-time', '45', url], capture_output=True, check=True)
    records = json.loads(result.stdout)
    if not isinstance(records, list) or not records or (not kind.endswith(".json") and len(records) >= 1000):
        raise ValueError(f'Empty, invalid or possibly truncated response: {kind}')
    return records


def japanese_names(records, title_field):
    return {r['owl:sameAs']: r.get(title_field, {}).get('ja') or r.get('dc:title') for r in records}


def normalize(source, names, holidays):
    types = japanese_names(source['trainTypes'], 'odpt:trainTypeTitle')
    names = {**names, **japanese_names(source['stations'], 'odpt:stationTitle')}
    boards = []
    seen = set()
    for raw in source['timetables']:
        if raw.get('odpt:station') not in STATIONS or raw.get('odpt:operator') != 'odpt.Operator:Toei':
            raise ValueError('Unexpected operator or station')
        railway = raw['odpt:railway']
        if raw['odpt:station'] != railway.replace('odpt.Railway:', 'odpt.Station:') + '.Mita':
            raise ValueError('Station and railway do not match')
        platform, line, direction = PLATFORMS[(railway, raw['odpt:railDirection'])]
        day_type = CALENDARS[raw['odpt:calendar']]
        if (platform, day_type) in seen:
            raise ValueError('Duplicate platform/calendar')
        seen.add((platform, day_type))
        departures = []
        for item in raw['odpt:stationTimetableObject']:
            value = item['odpt:departureTime']
            if not re.fullmatch(r'(?:[01][0-9]|2[0-7]):[0-5][0-9]', value):
                raise ValueError(f'Invalid departure time: {value}')
            hour, minute = map(int, value.split(':'))
            if hour < 4:
                hour += 24
            destinations = item['odpt:destinationStation']
            if not destinations:
                raise ValueError('Missing destination station')
            destination = '・'.join(names[station] for station in destinations)
            train_type = types[item['odpt:trainType']]
            if not destination or not train_type:
                raise ValueError('Missing Japanese label')
            departures.append({'time': f'{hour:02d}:{minute:02d}', 'type': train_type,
                               'destination': destination, 'destinationStationIds': destinations,
                               'trainTypeId': item['odpt:trainType'],
                               'trainNumber': item.get('odpt:trainNumber'), 'notes': []})
        if not departures:
            raise ValueError('Empty timetable')
        departures.sort(key=lambda item: item['time'])
        boards.append({'id': raw['owl:sameAs'], 'line': line, 'platform': platform,
                       'direction': direction, 'dayType': day_type,
                       'issued': raw.get('dct:issued'), 'modified': raw.get('dc:date'),
                       'url': RESOURCE, 'departures': departures})
    if seen != {(p, d) for p in '1234' for d in ('weekday', 'holiday')}:
        raise ValueError('Both calendars are required for all four platforms')
    return {'station': '三田', 'source': PROVIDER, 'sourceType': 'odpt:StationTimetable',
            'catalogUrl': CATALOG, 'resourceUrl': RESOURCE,
            'license': 'CC BY 4.0', 'licenseUrl': 'https://creativecommons.org/licenses/by/4.0/',
            'fetchedAt': source['fetchedAt'], 'holidays': holidays,
            'timetables': sorted(boards, key=lambda b: (b['platform'], b['dayType']))}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--offline', action='store_true')
    args = parser.parse_args()
    source_path = ROOT / 'data/mita-odpt.json'
    if args.offline:
        source = read_json(source_path)
    else:
        timetables = []
        for station in sorted(STATIONS):
            timetables.extend(fetch('odpt:StationTimetable', **{'odpt:operator': 'odpt.Operator:Toei', 'odpt:station': station}))
        source = {'fetchedAt': datetime.now(timezone.utc).isoformat(timespec='seconds'),
                  'apiBase': API, 'timetables': timetables,
                  'stations': fetch('odpt:Station.json'), 'trainTypes': fetch('odpt:TrainType.json')}
    data = normalize(source, read_json(ROOT / 'data/odpt-station-names.json'), read_json(ROOT / 'data/holidays.json'))
    if not args.offline:
        write_json(source_path, source)
    write_json(ROOT / 'data/mita.json', data)
    for board in data['timetables']:
        print(f'{board["line"]} {board["platform"]}番線 {board["dayType"]}: {len(board["departures"])}本')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, KeyError, TypeError, OSError, subprocess.SubprocessError) as error:
        raise SystemExit(f'ODPT時刻表の更新に失敗しました。既存データは保持されます。原因: {error}')
