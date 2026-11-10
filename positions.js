/* ODPT Toei public Train API: station/segment positions, never interpolated GPS. */
const AsakusaLive = (() => {
  const API = 'https://api-public.odpt.org/api/v4/odpt:Train?odpt:operator=odpt.Operator:Toei&odpt:railway=odpt.Railway:Toei.Asakusa';
  const RAILWAY = 'odpt.Railway:Toei.Asakusa';
  const INTERVAL = 30_000;
  const MAX_AGE = 120_000;

  function normalize(records, labels, now = Date.now()) {
    if (!Array.isArray(records)) throw new Error('Invalid live train response');
    return records.flatMap(record => {
      const updated = Date.parse(record['dc:date']);
      const valid = Date.parse(record['dct:valid']);
      if (record['odpt:operator'] !== 'odpt.Operator:Toei' || record['odpt:railway'] !== RAILWAY ||
          !Number.isFinite(updated) || !Number.isFinite(valid) || valid <= now ||
          updated < now - MAX_AGE || updated > now + 60_000) return [];
      const from = record['odpt:fromStation'];
      const to = record['odpt:toStation'];
      if (!from || !labels.stations[from] || (to && !labels.stations[to])) return [];
      const direction = record['odpt:railDirection'];
      if (!['odpt.RailDirection:Northbound', 'odpt.RailDirection:Southbound'].includes(direction)) return [];
      const destinations = record['odpt:destinationStation'];
      return [{ id: record['owl:sameAs'] || record['@id'], from, to,
        direction: direction.endsWith('Northbound') ? 'north' : 'south',
        fromName: labels.stations[from], toName: to ? labels.stations[to] : null,
        destination: Array.isArray(destinations) && destinations.length
          ? destinations.map(id => labels.stations[id] || '行き先不明').join('・') : '行き先不明',
        type: labels.types[record['odpt:trainType']] || '種別不明',
        number: record['odpt:trainNumber'] || '', updated,
        delay: Number.isFinite(record['odpt:delay']) && record['odpt:delay'] >= 0 ? record['odpt:delay'] : null }];
    });
  }

  function nearby(trains, stations, code, all) {
    const index = stations.findIndex(station => station.code === code);
    const byId = new Map(stations.map((station, i) => [station.id, i]));
    return trains.filter(train => all || [train.from, train.to].some(id =>
      byId.has(id) && Math.abs(byId.get(id) - index) <= 2))
      .sort((a, b) => (byId.get(a.from) ?? 99) - (byId.get(b.from) ?? 99) || a.direction.localeCompare(b.direction));
  }

  function routeRows(trains, stations, code, all) {
    const selected = stations.findIndex(station => station.code === code);
    const first = all ? 0 : Math.max(0, selected - 2);
    const last = all ? stations.length - 1 : Math.min(stations.length - 1, selected + 2);
    const indexes = new Map(stations.map((station, i) => [station.id, i]));
    const stops = new Map(), segments = new Map();
    for (const train of nearby(trains, stations, code, all)) {
      const from = indexes.get(train.from), to = indexes.get(train.to);
      const moving = train.to && to !== undefined && from !== undefined && Math.abs(from - to) === 1;
      const target = moving ? segments : stops;
      const index = moving ? Math.min(from, to) : from;
      if (index === undefined) continue;
      if (!target.has(index)) target.set(index, []);
      target.get(index).push(train);
    }
    const rows = [];
    if (first > 0) rows.push({kind:'segment', index:first-1, trains:segments.get(first-1) || []});
    for (let i=first; i<=last; i++) {
      rows.push({kind:'station', index:i, station:stations[i], trains:stops.get(i) || []});
      if (i < stations.length - 1) rows.push({kind:'segment', index:i, trains:segments.get(i) || []});
    }
    return rows;
  }

  function start(stations, palette) {
    const list = document.getElementById('position-list');
    const status = document.getElementById('position-status');
    const scope = document.getElementById('position-scope');
    const select = document.getElementById('station-select');
    let raw = [], labels = null, lastFetch = null, failed = false, busy = false, timer = null, all = false, selectedTrain = null, revealedCode = null;
    const detail = document.getElementById("position-detail");
    const clock = value => new Intl.DateTimeFormat('ja-JP', {
      timeZone: 'Asia/Tokyo', hour:'2-digit', minute:'2-digit', second:'2-digit'
    }).format(new Date(value));
    const node = (tag, className, value) => {
      const element = document.createElement(tag);
      element.className = className;
      if (value !== undefined) element.textContent = value;
      return element;
    };
    function render() {
      const valid = labels ? normalize(raw, labels) : [];
      const shown = nearby(valid, stations, select.value, all);
      const place = all ? '浅草線全線' : `${stations.find(s => s.code === select.value)?.name || ''}駅周辺（前後2駅）`;
      const scrollTop = list.parentElement.scrollTop;
      const laneScroll = new Map(Array.from(list.querySelectorAll('[data-lane-key]'), lane => [lane.dataset.laneKey, lane.scrollLeft]));
      const focusedTrain = document.activeElement?.dataset?.trainId;
      const focusedStation = document.activeElement?.dataset?.stationCode;
      list.replaceChildren(...routeRows(valid, stations, select.value, all).map(slot => {
        const row = node('li', `route-row route-${slot.kind === "station" ? "stop" : "segment"}`);
        const south = node('div', 'route-lane route-south');
        const north = node('div', 'route-lane route-north');
        south.dataset.laneKey = `${slot.kind}:${slot.index}:south`;
        north.dataset.laneKey = `${slot.kind}:${slot.index}:north`;
        const center = slot.station ? node('button', 'route-station') : node('span', 'route-connector');
        if (slot.station) {
          center.type = 'button';
          center.dataset.stationCode = slot.station.code;
          center.setAttribute('aria-label', `${slot.station.code} ${slot.station.name}駅を選択`);
          center.setAttribute('aria-pressed', String(slot.station.code === select.value));
          if (slot.station.code === select.value) row.classList.add('is-selected');
          center.append(node('span', 'route-code', slot.station.code), node('span', 'route-name', slot.station.name));
          center.addEventListener('click', () => {
            select.value = slot.station.code;
            select.dispatchEvent(new Event('change', {bubbles:true}));
          });
        } else center.setAttribute('aria-hidden', 'true');
        for (const train of slot.trains) {
          const marker = node('button', 'map-train');
          marker.type = 'button';
          marker.dataset.trainId = train.id;
          marker.setAttribute('aria-pressed', String(selectedTrain === train.id));
          marker.setAttribute('aria-label', `${train.type} ${train.destination}行き、${train.to ? `${train.fromName}から${train.toName}の間を走行中` : `${train.fromName}に停車中`}。詳細を表示`);
          const color = palette[train.type] || palette['普通'];
          marker.style.setProperty('--service-background', color.background);
          marker.style.setProperty('--service-foreground', color.foreground);
          const symbol = node('span', `train-symbol is-${train.direction}`);
          symbol.setAttribute('aria-hidden', 'true');
          const badge = node('span', 'map-service', train.type);
          const shortDestination = train.destination.startsWith('羽田空港') ? '羽田空港' : train.destination;
          const title = node('span', 'map-destination', shortDestination);
          marker.append(symbol, badge, title);
          marker.append(node('span', 'map-delay', train.delay > 0 ? (train.delay < 60 ? '1分未満遅れ' : `${Math.ceil(train.delay/60)}分遅れ`) : ''));
          marker.addEventListener('click', () => { selectedTrain = selectedTrain === train.id ? null : train.id; render(); });
          (train.direction === 'south' ? south : north).append(marker);
        }
        row.append(south, center, north);
        return row;
      }));
      list.parentElement.scrollTop = scrollTop;
      for (const lane of list.querySelectorAll('[data-lane-key]')) lane.scrollLeft = laneScroll.get(lane.dataset.laneKey) || 0;
      const current = valid.find(train => train.id === selectedTrain);
      detail.hidden = !current;
      detail.replaceChildren();
      if (current) {
        const heading = node('div', 'detail-heading');
        const badge = node('span', 'service', current.type);
        const color = palette[current.type] || palette['普通'];
        badge.style.setProperty('--service-background', color.background);
        badge.style.setProperty('--service-foreground', color.foreground);
        const close = node('button', 'detail-close', '閉じる');
        close.type = 'button';
        close.addEventListener('click', () => {
          const previous = selectedTrain;
          selectedTrain = null;
          render();
          [...list.querySelectorAll('[data-train-id]')].find(element => element.dataset.trainId === previous)?.focus({preventScroll:true});
        });
        heading.append(badge, node('strong', '', `${current.destination}行き`), close);
        detail.append(heading, node('p', 'detail-location', current.to ? `${current.fromName} → ${current.toName} 間を走行中` : `${current.fromName}に停車中`),
          node('p', 'detail-meta', `${current.number ? `列車番号 ${current.number} · ` : ''}${clock(current.updated)}現在`));
        if (current.delay > 0) detail.append(node('p', 'position-delay', current.delay < 60 ? '1分未満の遅れ' : `約${Math.ceil(current.delay/60)}分の遅れ`));
      } else selectedTrain = null;
      if (focusedTrain) {
        const replacement = [...list.querySelectorAll('[data-train-id]')].find(element => element.dataset.trainId === focusedTrain);
        replacement?.focus({preventScroll:true});
      }
      if (focusedStation) {
        [...list.querySelectorAll('[data-station-code]')].find(element => element.dataset.stationCode === focusedStation)?.focus({preventScroll:true});
      }
      requestAnimationFrame(() => {
        const scroll = list.parentElement;
        if (!scroll.clientHeight || revealedCode === select.value) return;
        const selected = [...list.querySelectorAll('[data-station-code]')].find(element => element.dataset.stationCode === select.value);
        if (selected) {
          scroll.scrollTop += selected.getBoundingClientRect().top - scroll.getBoundingClientRect().top - scroll.clientHeight / 2 + selected.clientHeight / 2;
          revealedCode = select.value;
        }
      });
      let message = `${place} · ${shown.length}本`;
      if (failed) message += valid.length ? ' · 更新に失敗（前回の期限内データ）' : ' · 取得できません。自動で再取得します。';
      else if (!lastFetch) message += ' · 読み込み中…';
      else if (raw.length && !valid.length) message += ' · データが古いため位置を非表示にしています。';
      else if (!raw.length) message += ' · 走行中の列車情報はありません。';
      else if (!shown.length) message += ' · 周辺の列車はありません。全線表示で確認できます。';
      if (lastFetch) message += ` · ${clock(lastFetch)}取得`;
      status.textContent = message;
    }
    async function refresh() {
      if (busy || document.hidden) return;
      busy = true;
      clearTimeout(timer);
      try {
        if (!labels) {
          const response = await fetch('data/asakusa/labels.json', {signal:AbortSignal.timeout(15_000)});
          if (!response.ok) throw new Error('Labels unavailable');
          const candidate = await response.json();
          if (!candidate.stations || !candidate.types) throw new Error('Invalid labels');
          labels = candidate;
        }
        const response = await fetch(API, {cache:'no-store', signal:AbortSignal.timeout(15_000)});
        if (!response.ok) throw new Error('Positions unavailable');
        const records = await response.json();
        normalize(records, labels);
        raw = records;
        lastFetch = Date.now();
        failed = false;
      } catch {
        failed = true;
      } finally {
        busy = false;
        render();
        if (!document.hidden) timer = setTimeout(refresh, INTERVAL);
      }
    }
    select.addEventListener('change', () => { selectedTrain = null; revealedCode = null; render(); });
    document.getElementById('view-positions').addEventListener('click', () => { revealedCode = null; render(); });
    scope.addEventListener('click', () => {
      all = !all;
      revealedCode = null;
      scope.textContent = all ? '駅周辺を表示' : '全線を表示';
      scope.setAttribute('aria-pressed', String(all));
      render();
    });
    document.addEventListener('visibilitychange', () => {
      clearTimeout(timer);
      // Re-check validity immediately when the tab returns to the foreground.
      if (!document.hidden) { render(); refresh(); }
    });
    refresh();
  }
  return { normalize, nearby, routeRows, start };
})();
if (typeof module !== 'undefined') module.exports = AsakusaLive;
