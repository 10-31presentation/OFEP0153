const { test } = require('node:test');
const assert = require('node:assert/strict');
const live = require('../positions.js');
const labels = require('../data/asakusa/labels.json');
const stations = require('../data/asakusa/index.json').stations;
const now = Date.parse('2026-11-03T12:00:00+09:00');
const train = {
  'owl:sameAs':'sample', 'odpt:operator':'odpt.Operator:Toei',
  'odpt:railway':'odpt.Railway:Toei.Asakusa',
  'dc:date':new Date(now - 10_000).toISOString(), 'dct:valid':new Date(now + 290_000).toISOString(),
  'odpt:fromStation':'odpt.Station:Toei.Asakusa.Sengakuji',
  'odpt:toStation':'odpt.Station:Toei.Asakusa.Mita',
  'odpt:railDirection':'odpt.RailDirection:Northbound',
  'odpt:trainType':'odpt.TrainType:Toei.RapidLimitedExpress',
  'odpt:destinationStation':['odpt.Station:Keisei.Main.KeiseiTakasago'], 'odpt:delay':60
};

test('station and segment positions use the actual API fields', () => {
  const moving = live.normalize([train], labels, now)[0];
  assert.equal(moving.fromName, '泉岳寺');
  assert.equal(moving.toName, '三田');
  assert.equal(moving.type, '快特');
  assert.equal(moving.delay, 60);
  assert.equal(moving.direction, 'north');
  const stopped = live.normalize([{...train,'odpt:toStation':null}],labels,now)[0];
  assert.equal(stopped.toName, null);
  assert.equal(stopped.fromName, '泉岳寺');
});

test('expired, stale, other-railway and invalid records are not shown as live', () => {
  for(const patch of [
    {'dct:valid':new Date(now-1).toISOString()},
    {'dc:date':new Date(now-121_000).toISOString()},
    {'dc:date':'invalid'}, {'odpt:railway':'odpt.Railway:Toei.Mita'},
    {'odpt:fromStation':'missing'}, {'odpt:railDirection':'unknown'}
  ]) assert.equal(live.normalize([{...train,...patch}],labels,now).length, 0);
  assert.throws(()=>live.normalize({error:'failure'},labels,now));
  assert.deepEqual(live.normalize([],labels,now),[]);
});

test('station selection filters positions to two adjacent stations in either direction', () => {
  const trains=live.normalize([train],labels,now);
  assert.equal(live.nearby(trains,stations,'A-08',false).length,1);
  assert.equal(live.nearby(trains,stations,'A-20',false).length,0);
  assert.equal(live.nearby(trains,stations,'A-20',true).length,1);
});

test('missing destination and delay are not presented as confirmed values', () => {
  const result=live.normalize([{...train,'odpt:delay':null,'odpt:destinationStation':[]}],labels,now)[0];
  assert.equal(result.delay,null);
  assert.equal(result.destination,'行き先不明');
});

test('route diagram places stopped trains on stations and moving trains between stations', () => {
  const moving = live.normalize([train], labels, now)[0];
  const stopped = live.normalize([{...train,'odpt:toStation':null}], labels, now)[0];
  const rows = live.routeRows([moving,stopped],stations,'A-08',false);
  const stop = rows.find(row=>row.kind==='station'&&row.station.code==='A-07');
  assert.equal(stop.trains.length,1);
  const segment = rows.find(row=>row.kind==='segment' && row.trains.length);
  assert.equal(segment.index,6); // A-07 -> A-08 interval
  assert.equal(segment.trains[0].toName,'三田');
  assert.equal(rows.filter(row=>row.kind==='station').length,5);
  assert.equal(live.routeRows([],stations,'A-20',true).length,39);
});

test('trains crossing the edge of the nearby diagram stay visible without moving to a station', () => {
  const boundary={...live.normalize([train],labels,now)[0],from:stations[4].id,to:stations[5].id};
  const rows=live.routeRows([boundary],stations,'A-08',false);
  assert.equal(rows[0].kind,'segment');
  assert.equal(rows[0].trains.length,1);
});


test('the route skeleton never changes when trains enter, leave or share a location', () => {
  const moving = live.normalize([train],labels,now)[0];
  const stopped = {...moving, to:null};
  const skeleton = rows => rows.map(row => [row.kind,row.index,row.station?.code]);
  for (const all of [false,true]) {
    for (const code of ['A-01','A-08','A-20']) {
      const empty = skeleton(live.routeRows([],stations,code,all));
      for (const records of [[moving],[stopped],[moving,stopped,{...stopped,id:'second'}]]) {
        assert.deepEqual(skeleton(live.routeRows(records,stations,code,all)),empty);
      }
    }
  }
});
