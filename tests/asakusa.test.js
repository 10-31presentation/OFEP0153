const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const manifest = read('data/asakusa/index.json');

function element() {
  return {
    children: [], hidden: false, textContent: '', className: '', value: '', attributes: {}, listeners: {},
    style: { setProperty() {} }, classList: { add() {} },
    addEventListener(name, callback) { this.listeners[name] = callback; },
    setAttribute(name, value) { this.attributes[name] = value; },
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; }
  };
}

function board() {
  const elements = {};
  const buttons = ['all', 'south', 'north', 'keikyu'].map(direction => ({...element(), dataset:{direction}}));
  const context = vm.createContext({
    document: {
      getElementById(id) { return elements[id] ??= element(); },
      querySelectorAll() { return buttons; }, createElement: element
    }, console: { error() {} },
    fetch: async url => ({ok:true, json:async () => read(url)})
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'sketch.js'), 'utf8'), context);
  return {context, elements, buttons, run: code => vm.runInContext(code, context)};
}

test('all 20 selectable stations load their own departures and official code', async () => {
  const b = board();
  await b.run('loadTimetable()');
  assert.equal(b.elements['station-select'].children.length, 20);
  for (const station of manifest.stations) {
    b.elements['station-select'].value = station.code;
    await b.run(`loadStation('${station.code}')`);
    assert.equal(b.run('timetableData.station.code'), station.code);
    assert.equal(b.elements['station-code'].attributes['aria-label'], `駅番号 ${station.code}`);
    b.run('var now = new Date("2026-11-03T12:00:00+09:00"); var jst = new Date(now.getTime()+JST_OFFSET_MS); updateBoard(now,jst)');
    assert.equal(b.elements['train-list'].children.length, station.directions.length * 4);
    assert.ok(b.run('getUpcomingTrains(now,jst).every(t => t.timetable.stationId === timetableData.station.id)'));
  }
});

test('holiday calendar and service day survive midnight', async () => {
  const b = board(); await b.run('loadTimetable()');
  b.run('var now = new Date("2026-11-03T12:00:00+09:00"); var jst = new Date(now.getTime()+JST_OFFSET_MS)');
  assert.equal(b.run('getUpcomingTrains(now,jst).length'), 8);
  assert.equal(b.run('getUpcomingTrains(now,jst).find(t => t.timetable.direction === "south").time'), '12:04');
  b.run('now = new Date("2026-11-04T00:00:00+09:00"); jst = new Date(now.getTime()+JST_OFFSET_MS)');
  assert.equal(b.run('getUpcomingTrains(now,jst).find(t => t.timetable.direction === "south").time'), '24:05');
  assert.ok(b.run('getUpcomingTrains(now,jst).every(t => t.timetable.dayType === "holiday")'));
});

test('direction filtering and terminal stations expose only available directions', async () => {
  const b = board(); await b.run('loadTimetable()');
  b.run('selectedDirection="south"; var now=new Date("2026-11-04T12:00:00+09:00"); updateBoard(now,new Date(now.getTime()+JST_OFFSET_MS))');
  assert.equal(b.elements['train-list'].children.length, 4);
  b.elements['station-select'].value = 'A-01'; await b.run('loadStation("A-01")');
  assert.equal(b.buttons.find(x=>x.dataset.direction==='south').hidden, true);
  assert.equal(b.run('selectedDirection'), 'all');
  b.elements['station-select'].value = 'A-20'; await b.run('loadStation("A-20")');
  assert.equal(b.buttons.find(x=>x.dataset.direction==='north').hidden, true);
});

test('a slower old request cannot overwrite the newly selected station', async () => {
  const b = board(); await b.run('loadTimetable()');
  const pending = {};
  b.context.fetch = url => new Promise(resolve => {pending[url] = resolve;});
  b.elements['station-select'].value = 'A-01'; const first = b.run('loadStation("A-01")');
  b.elements['station-select'].value = 'A-20'; const second = b.run('loadStation("A-20")');
  pending['data/asakusa/A-20.json']({ok:true,json:async()=>read('data/asakusa/A-20.json')}); await second;
  pending['data/asakusa/A-01.json']({ok:true,json:async()=>read('data/asakusa/A-01.json')}); await first;
  assert.equal(b.run('timetableData.station.code'), 'A-20');
});

test('failed station load clears old departures and shows an actionable error', async () => {
  const b = board(); await b.run('loadTimetable()');
  b.context.fetch = async () => ({ok:false,status:503});
  b.elements['station-select'].value='A-01'; await b.run('loadStation("A-01")');
  assert.equal(b.elements['train-list'].children.length, 0);
  assert.match(b.elements['empty-state'].textContent, /読み込めません/);
  assert.equal(b.elements['empty-state'].hidden, false);
});


test('Sengakuji never labels Nishimagome departures as Keikyu service', async () => {
  const b = board(); await b.run('loadTimetable()');
  b.elements['station-select'].value='A-07'; await b.run('loadStation("A-07")');
  assert.equal(b.buttons.find(x=>x.dataset.direction==='south').textContent, '西馬込方面');
  const data = read('data/asakusa/A-07.json');
  assert.equal(b.buttons.find(x=>x.dataset.direction==='keikyu').disabled, !data.station.keikyuAvailable);
  assert.equal(b.elements['station-data-note'].hidden, Boolean(data.station.keikyuAvailable));
  if (data.station.keikyuAvailable) {
    b.run('selectedDirection="keikyu"; var now=new Date("2026-11-03T12:00:00+09:00"); updateBoard(now,new Date(now.getTime()+JST_OFFSET_MS))');
    assert.ok(b.elements['train-list'].children.length > 0);
  }
});
