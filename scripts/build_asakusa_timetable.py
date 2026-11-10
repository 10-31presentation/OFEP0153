"""Fetch ODPT public station timetables and build the static Asakusa Line departure board.

python3 scripts/build_asakusa_timetable.py           # refresh from public API
python3 scripts/build_asakusa_timetable.py --offline # rebuild saved API responses
"""

import argparse
import json
import re
import subprocess
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlencode
try:
    from . import keikyu_odpt
except ImportError:
    import keikyu_odpt

ROOT = Path(__file__).resolve().parent.parent
API = 'https://api-public.odpt.org/api/v4/'
CATALOG = 'https://catalog.data.metro.tokyo.lg.jp/dataset/t000018d0000000052'
RESOURCE = 'https://ckan.odpt.org/dataset/r_station_timetable-toei'
PROVIDER = '東京都交通局・公共交通オープンデータ協議会'
RAILWAY = 'odpt.Railway:Toei.Asakusa'
DIRECTIONS = {
    'odpt.RailDirection:Southbound': 'south',
    'odpt.RailDirection:Northbound': 'north',
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


def normalize(source, names, holidays, keikyu_source=None):
    types = japanese_names(source['trainTypes'], 'odpt:trainTypeTitle')
    names = {**names, **japanese_names(source['stations'], 'odpt:stationTitle')}
    extra_boards = []
    if keikyu_source:
        extra_boards = keikyu_odpt.station_timetables(keikyu_source)
        types.update(japanese_names(keikyu_source['trainTypes'], 'odpt:trainTypeTitle'))
        names.update(japanese_names(keikyu_source['stations'], 'odpt:stationTitle'))
    stations = sorted([{'id': r['owl:sameAs'], 'name': names[r['owl:sameAs']],
                        'code': r['odpt:stationCode']} for r in source['stations']
                       if r.get('odpt:railway') == RAILWAY], key=lambda station: station['code'])
    if [station['code'] for station in stations] != [f'A-{i:02d}' for i in range(1, 21)]:
        raise ValueError('Expected the 20 official station codes A-01 to A-20')
    station_map = {station['id']: station for station in stations}
    boards = []
    seen = set()
    for raw in source['timetables'] + extra_boards:
        station_id = raw.get('odpt:station')
        is_keikyu = raw in extra_boards
        if is_keikyu:
            direction = 'keikyu'
        else:
            if station_id not in station_map or raw.get('odpt:operator') != 'odpt.Operator:Toei' or raw.get('odpt:railway') != RAILWAY:
                raise ValueError('Unexpected operator, station or railway')
            direction = DIRECTIONS[raw['odpt:railDirection']]
        day_type = CALENDARS[raw['odpt:calendar']]
        key = (station_id, direction, day_type)
        if key in seen:
            raise ValueError('Duplicate station/direction/calendar')
        seen.add(key)
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
        boards.append({'id': raw['owl:sameAs'], 'stationId': station_id,
                       'line': '京急本線' if is_keikyu else '浅草線', 'direction': direction, 'dayType': day_type,
                       'issued': raw.get('dct:issued'), 'modified': raw.get('dc:date'),
                       'url': keikyu_odpt.RESOURCE if is_keikyu else RESOURCE, 'departures': departures})
    for station in stations:
        expected = ['north'] if station['code'] == 'A-01' else ['south'] if station['code'] == 'A-20' else ['south', 'north']
        if station['code'] == 'A-07':
            station['keikyuAvailable'] = bool(keikyu_source)
            if keikyu_source:
                expected.append('keikyu')
        actual = {(direction, day) for sid, direction, day in seen if sid == station['id']}
        if actual != {(direction, day) for direction in expected for day in ('weekday', 'holiday')}:
            raise ValueError(f'Missing or unexpected direction/calendar: {station["code"]}')
        station['directions'] = expected
    metadata = {'line': '浅草線', 'source': PROVIDER, 'sourceType': 'odpt:StationTimetable',
                'catalogUrl': CATALOG, 'resourceUrl': RESOURCE,
                'license': 'CC BY 4.0', 'licenseUrl': 'https://creativecommons.org/licenses/by/4.0/',
                'fetchedAt': source['fetchedAt']}
    output = {}
    for station in stations:
        output[station['code']] = {**metadata, 'station': station, 'holidays': holidays,
                                  'timetables': [board for board in boards if board['stationId'] == station['id']]}
    if keikyu_source:
        data = output['A-07']
        data['keikyuFetchedAt'] = keikyu_source['fetchedAt']
        data['license'] = 'CC BY 4.0（都営） / 公共交通オープンデータチャレンジ限定ライセンス（京急）'
        data['keikyuResourceUrl'] = keikyu_odpt.RESOURCE
        data['keikyuLicenseUrl'] = keikyu_odpt.LICENSE_URL
    return {**metadata, 'stations': stations}, output


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--offline', action='store_true')
    args = parser.parse_args()
    source_path = ROOT / 'data/asakusa-odpt.json'
    if args.offline:
        source = read_json(source_path)
    else:
        timetables = fetch('odpt:StationTimetable', **{'odpt:operator': 'odpt.Operator:Toei', 'odpt:railway': RAILWAY})
        source = {'fetchedAt': datetime.now(timezone.utc).isoformat(timespec='seconds'),
                  'apiBase': API, 'timetables': timetables,
                  'stations': fetch('odpt:Station.json'), 'trainTypes': fetch('odpt:TrainType.json')}
    keikyu_path = ROOT / 'data/keikyu-odpt.json'
    token = keikyu_odpt.get_token(ROOT)
    keikyu_source = read_json(keikyu_path) if keikyu_path.exists() else None
    if token and not args.offline:
        keikyu_source = keikyu_odpt.fetch_source(token)
    manifest, station_data = normalize(source, read_json(ROOT / 'data/odpt-station-names.json'), read_json(ROOT / 'data/holidays.json'), keikyu_source)
    if not args.offline:
        write_json(source_path, source)
        if keikyu_source:
            write_json(keikyu_path, keikyu_source)
    directory = ROOT / 'data/asakusa'
    directory.mkdir(exist_ok=True)
    for code, data in station_data.items():
        write_json(directory / f'{code}.json', data)
    write_json(directory / 'index.json', manifest)
    write_json(directory / 'labels.json', {
        'stations': {**read_json(ROOT / 'data/odpt-station-names.json'), **japanese_names(source['stations'], 'odpt:stationTitle')},
        'types': japanese_names(source['trainTypes'], 'odpt:trainTypeTitle')})
    if not keikyu_source:
        print('泉岳寺の京急線方面は未取得です。ODPT_CHALLENGE_TOKENを設定すると取得できます。')
    print(f'浅草線 {len(station_data)}駅 / {sum(len(d["timetables"]) for d in station_data.values())}時刻表を更新しました。')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, KeyError, TypeError, OSError, subprocess.SubprocessError) as error:
        raise SystemExit(f'ODPT時刻表の更新に失敗しました。既存データは保持されます。原因: {error}')
