"""Fetch Sengakuji's Keikyu departures using an ODPT Challenge 2026 token.

The token is used only by this build-time module and is never written to output.
"""
import json
import os
import subprocess
from datetime import datetime, timezone
from urllib.parse import urlencode

API = 'https://api-challenge.odpt.org/api/v4/'
RESOURCE = 'https://ckan.odpt.org/dataset/keikyu__r_station_timetable'
LICENSE_URL = 'https://developer.odpt.org/challenge_license'
SENGAKUJI = 'odpt.Station:Toei.Asakusa.Sengakuji'


def get_token(root):
    token = os.environ.get('ODPT_CHALLENGE_TOKEN', '').strip()
    if token:
        return token
    path = root / '.env'
    if path.exists():
        for line in path.read_text(encoding='utf-8').splitlines():
            key, separator, value = line.strip().partition('=')
            if separator and key == 'ODPT_CHALLENGE_TOKEN':
                return value.strip().strip('"\'')
    return ''


def fetch(kind, token, **query):
    url = API + kind + '?' + urlencode({**query, 'acl:consumerKey': token})
    # Pass the URL via stdin, so the token cannot appear in process arguments.
    result = subprocess.run(['curl', '--config', '-', '--fail', '--silent', '--show-error',
                             '--max-time', '45'], input='url = ' + json.dumps(url) + '\n',
                            capture_output=True, text=True)
    if result.returncode:
        # curl's stderr can contain the request URL. Do not propagate it.
        raise ValueError('京急ODPTの取得に失敗しました。チャレンジ2026用トークンとネットワークを確認してください。')
    try:
        records = json.loads(result.stdout)
    except ValueError:
        raise ValueError('京急ODPTがJSON以外の応答を返しました。') from None
    if not isinstance(records, list) or not records or len(records) >= 1000:
        raise ValueError('京急ODPTの応答が空・不正・取得上限に達しています。')
    return records


def fetch_source(token):
    stations = fetch('odpt:Station', token, **{'odpt:operator': 'odpt.Operator:Keikyu'})
    matches = [r for r in stations if (r.get('odpt:stationTitle', {}).get('ja') or r.get('dc:title')) == '泉岳寺']
    if len(matches) != 1:
        raise ValueError('京急の駅マスターで泉岳寺を一意に特定できませんでした。')
    station_id = matches[0]['owl:sameAs']
    return {'fetchedAt': datetime.now(timezone.utc).isoformat(timespec='seconds'),
            'stationId': station_id, 'stations': stations,
            'timetables': fetch('odpt:StationTimetable', token, **{'odpt:operator': 'odpt.Operator:Keikyu', 'odpt:station': station_id}),
            'trainTypes': fetch('odpt:TrainType', token, **{'odpt:operator': 'odpt.Operator:Keikyu'})}


def station_timetables(source):
    """Validate raw Keikyu records, then alias just this station for the shared UI."""
    boards = []
    days = set()
    for raw in source['timetables']:
        if raw.get('odpt:operator') != 'odpt.Operator:Keikyu' or raw.get('odpt:station') != source['stationId'] or raw.get('odpt:railway') != 'odpt.Railway:Keikyu.Main':
            raise ValueError('京急の泉岳寺以外の時刻表が含まれています。')
        day = raw['odpt:calendar']
        if day not in ('odpt.Calendar:Weekday', 'odpt.Calendar:SaturdayHoliday') or day in days:
            raise ValueError('京急の泉岳寺のカレンダーが重複・未対応です。')
        direction = raw['odpt:railDirection'].split(':')[-1].split('.')[-1]
        if direction not in ('Outbound', 'Southbound'):
            raise ValueError('京急の泉岳寺の下り方面を確認できませんでした。')
        if not raw.get('odpt:stationTimetableObject'):
            raise ValueError('京急の泉岳寺の時刻表が空です。')
        days.add(day)
        boards.append({**raw, 'odpt:station': SENGAKUJI})
    if len(days) != 2:
        raise ValueError('京急の泉岳寺は平日・土休日の両方が必要です。')
    return boards
