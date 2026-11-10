import copy
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
from scripts import build_asakusa_timetable as importer


class OdptImportTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source = importer.read_json(ROOT / 'data/asakusa-odpt.json')
        cls.names = importer.read_json(ROOT / 'data/odpt-station-names.json')
        cls.holidays = importer.read_json(ROOT / 'data/holidays.json')

    def normalize(self, source=None, names=None):
        return importer.normalize(source or self.source, self.names if names is None else names, self.holidays)

    def test_every_api_departure_survives_conversion(self):
        manifest, station_data = self.normalize()
        data = {**manifest, "timetables": [b for station in station_data.values() for b in station["timetables"]]}
        self.assertEqual([s["code"] for s in manifest["stations"]], [f"A-{i:02d}" for i in range(1, 21)])
        for raw in self.source['timetables']:
            board = next(b for b in data['timetables'] if b['id'] == raw['owl:sameAs'])
            self.assertEqual(len(board['departures']), len(raw['odpt:stationTimetableObject']))
            expected = []
            for item in raw['odpt:stationTimetableObject']:
                hour, minute = map(int, item['odpt:departureTime'].split(':'))
                expected.append((f'{hour + (24 if hour < 4 else 0):02d}:{minute:02d}', item.get('odpt:trainNumber'), item['odpt:trainType'], item['odpt:destinationStation']))
            actual = [(d['time'], d['trainNumber'], d['trainTypeId'], d['destinationStationIds']) for d in board['departures']]
            self.assertEqual(actual, sorted(expected, key=lambda x: x[0]))
        self.assertEqual(data['sourceType'], 'odpt:StationTimetable')
        self.assertEqual(data['catalogUrl'], importer.CATALOG)
        self.assertEqual(data['license'], 'CC BY 4.0')

    def test_missing_duplicate_or_wrong_station_is_rejected(self):
        for mutation in ['missing', 'duplicate', 'wrong_station']:
            source = copy.deepcopy(self.source)
            if mutation == 'missing':
                source['timetables'].pop()
            elif mutation == 'duplicate':
                source['timetables'].append(source['timetables'][0])
            else:
                source['timetables'][0]['odpt:station'] = 'odpt.Station:Toei.Mita.Mita'
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                self.normalize(source)

    def test_missing_labels_and_bad_times_are_rejected(self):
        with self.assertRaises(KeyError):
            self.normalize(names={})
        source = copy.deepcopy(self.source)
        source['timetables'][0]['odpt:stationTimetableObject'][0]['odpt:departureTime'] = '12:99'
        with self.assertRaises(ValueError):
            self.normalize(source)

    def test_fetch_failure_keeps_existing_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'data').mkdir()
            for name in ['asakusa-odpt.json']:
                (root / 'data' / name).write_text('existing data')
            with patch.object(importer, 'ROOT', root), patch.object(importer, 'fetch', side_effect=OSError('network failed')), patch('sys.argv', ['build_asakusa_timetable.py']):
                with self.assertRaises(OSError):
                    importer.main()
            for name in ['asakusa-odpt.json']:
                self.assertEqual((root / 'data' / name).read_text(), 'existing data')



class KeikyuIntegrationTests(unittest.TestCase):
    setUpClass = OdptImportTests.__dict__["setUpClass"]
    def sample(self):
        # Synthetic schema fixture only; never used as application timetable data.
        station_id = 'odpt.Station:Keikyu.Main.Sengakuji'
        return {'fetchedAt': '2026-11-03T00:00:00+00:00', 'stationId': station_id,
                'stations': [{'owl:sameAs': station_id, 'dc:title': '泉岳寺'},
                             {'owl:sameAs': 'odpt.Station:Keikyu.Airport.HanedaAirportTerminal1and2', 'dc:title': '羽田空港第1・第2ターミナル'}],
                'trainTypes': [{'owl:sameAs': 'odpt.TrainType:Keikyu.Express', 'dc:title': '急行'}],
                'timetables': [{'owl:sameAs': 'test:' + day, 'odpt:operator': 'odpt.Operator:Keikyu',
                                'odpt:railway': 'odpt.Railway:Keikyu.Main', 'odpt:station': station_id,
                                'odpt:railDirection': 'odpt.RailDirection:Outbound', 'odpt:calendar': 'odpt.Calendar:' + day,
                                'odpt:stationTimetableObject': [{'odpt:departureTime': '00:05',
                                    'odpt:destinationStation': ['odpt.Station:Keikyu.Airport.HanedaAirportTerminal1and2'],
                                    'odpt:trainType': 'odpt.TrainType:Keikyu.Express', 'odpt:trainNumber': 'test'}]}
                               for day in ['Weekday', 'SaturdayHoliday']]}

    def test_keikyu_is_separate_from_nishimagome_and_retains_own_license(self):
        index, data = importer.normalize(self.source, self.names, self.holidays, self.sample())
        station = next(s for s in index['stations'] if s['code'] == 'A-07')
        self.assertEqual(station['directions'], ['south', 'north', 'keikyu'])
        self.assertTrue(station['keikyuAvailable'])
        self.assertEqual(len(data['A-07']['timetables']), 6)
        self.assertEqual(len(data['A-08']['timetables']), 4)
        for b in data['A-07']['timetables']:
            if b['direction'] == 'keikyu':
                self.assertEqual(b['departures'][0]['time'], '24:05')
                self.assertIn('羽田空港', b['departures'][0]['destination'])
        self.assertIn('チャレンジ限定', data['A-07']['license'])

    def test_missing_or_wrong_keikyu_calendar_does_not_publish(self):
        source = self.sample()
        source['timetables'].pop()
        with self.assertRaises(ValueError):
            importer.normalize(self.source, self.names, self.holidays, source)

    def test_token_is_never_a_process_argument_or_error_message(self):
        from scripts import keikyu_odpt
        import types
        with patch.object(keikyu_odpt.subprocess, 'run', return_value=types.SimpleNamespace(returncode=22)) as call:
            with self.assertRaises(ValueError) as error:
                keikyu_odpt.fetch('odpt:Station', 'private-test-token')
            self.assertNotIn('private-test-token', str(call.call_args.args))
            self.assertNotIn('private-test-token', str(error.exception))


if __name__ == '__main__':
    unittest.main()
