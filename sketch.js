// Relative path so it also works under a GitHub Pages project URL (/<repo>/).
const DATA_URL = "data/asakusa/index.json";
const DEFAULT_STATION = "A-08";
// Color families follow Keisei's official stop guide (including its Keikyu legend).
// https://www.keisei.co.jp/keisei/tetudou/railmap/railmap_250401.pdf
// These screen shades preserve those families and give text at least 4.5:1 contrast;
// they are not a claim to reproduce official RGB specifications.
const SERVICE_STYLES = {
  "普通": { background: "#333333", foreground: "#ffffff" },
  "各駅停車": { background: "#333333", foreground: "#ffffff" },
  "快特": { background: "#00803e", foreground: "#ffffff" },
  "特急": { background: "#c62032", foreground: "#ffffff" },
  "急行": { background: "#0066b3", foreground: "#ffffff" },
  "エアポート急行": { background: "#0066b3", foreground: "#ffffff" },
  "快速特急": { background: "#00803e", foreground: "#ffffff" },
  "エアポート快特": { background: "#f08300", foreground: "#1a1a1a" },
  "アクセス特急": { background: "#f08300", foreground: "#1a1a1a" },
  "快速": { background: "#c41e78", foreground: "#ffffff" },
  "通勤特急": { background: "#75cae9", foreground: "#1a1a1a" }
};

function getServiceStyle(train) {
  return SERVICE_STYLES[train.type] ?? SERVICE_STYLES["普通"];
}
const TRAINS_PER_DIRECTION = 4;
const CLOCK_FONT = '500 88px "Google Sans Code"';
// Timetable hours run 04:00-24:59; earlier times belong to the previous service day.
const SERVICE_DAY_START_HOUR = 4;
const JST_OFFSET_MS = 9 * 60 * 60_000;

const trainList = document.getElementById("train-list");
const emptyElement = document.getElementById("empty-state");
const timeElement = document.getElementById("current-time");
const liveElement = document.getElementById("live-region");
const stationSelect = document.getElementById("station-select");
const stationCode = document.getElementById("station-code");
let timetableData = null;
let stations = [];
let loadError = false;
let loadVersion = 0;
let lastSecond = -1;
let lastListState = null;
let lastAnnouncement = "";
let selectedDirection = "all";

stationSelect.addEventListener("change", () => loadStation(stationSelect.value));
document.querySelectorAll("[data-direction]").forEach((button) => {
  button.addEventListener("click", () => {
    if (button.disabled) return;
    selectedDirection = button.dataset.direction;
    updateDirectionButtons();
    lastListState = null;
    refreshBoard();
  });
});

function refreshBoard() {
  const now = new Date();
  updateBoard(now, new Date(now.getTime() + JST_OFFSET_MS));
}

function updateDirectionButtons() {
  const station = stations.find((item) => item.code === stationSelect.value);
  document.querySelectorAll("[data-direction]").forEach((button) => {
    const direction = button.dataset.direction;
    const isSengakuji = station?.code === "A-07";
    button.hidden = direction !== "all" && !station?.directions.includes(direction) && !(direction === "keikyu" && isSengakuji);
    button.disabled = direction === "keikyu" && !station?.keikyuAvailable;
    if (direction === "keikyu") button.textContent = station?.keikyuAvailable ? "京急線方面" : "京急線方面（未取得）";
    button.setAttribute("aria-pressed", String(direction === selectedDirection));
    if (direction === "all") button.textContent = station?.directions.length === 1 ? "すべて" : station?.directions.length === 3 ? "全方面" : "両方面";
    if (direction === "south") button.textContent = station && station.code <= "A-07" ? "西馬込方面" : "西馬込・京急線方面";
  });
  const note = document.getElementById("station-data-note");
  note.hidden = station?.code !== "A-07" || Boolean(station?.keikyuAvailable);
  note.textContent = "京急線方面の時刻表は未取得です。現在は西馬込方面・押上方面のみ表示しています。";
  document.getElementById("keikyu-credit").hidden = !station?.keikyuAvailable;
}

function setup() {
  const canvas = createCanvas(480, 110);
  canvas.parent("clock-canvas");
  canvas.elt.setAttribute("aria-hidden", "true");
  // Canvas text does not trigger web font downloads, so request it explicitly; the next per-second redraw picks it up.
  document.fonts.load(CLOCK_FONT);
  frameRate(10);
  loadTimetable();
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function loadTimetable() {
  try {
    const manifest = await fetchJson(DATA_URL);
    if (manifest.sourceType !== "odpt:StationTimetable" || manifest.stations?.length !== 20) {
      throw new Error("Invalid Asakusa station index");
    }
    stations = manifest.stations;
    if (typeof AsakusaLive !== "undefined") AsakusaLive.start(stations, SERVICE_STYLES);
    stationSelect.replaceChildren(...stations.map((station) => {
      const option = document.createElement("option");
      option.value = station.code;
      option.textContent = `${station.code}　${station.name}`;
      return option;
    }));
    stationSelect.value = DEFAULT_STATION;
    stationSelect.disabled = false;
    await loadStation(DEFAULT_STATION);
  } catch (error) {
    console.error("Failed to load station index:", error);
    loadError = true;
    refreshBoard();
  }
}

async function loadStation(code) {
  const station = stations.find((item) => item.code === code);
  if (!station) return;
  const version = ++loadVersion;
  timetableData = null;
  loadError = false;
  selectedDirection = "all";
  lastListState = null;
  const letter = document.createElement("span");
  letter.textContent = "A";
  const number = document.createElement("span");
  number.textContent = station.code.split("-")[1];
  stationCode.replaceChildren(letter, number);
  stationCode.setAttribute("aria-label", `駅番号 ${station.code}`);
  document.title = `Next Train | ${station.name}駅 ${station.code} | 都営浅草線`;
  document.getElementById("data-updated").textContent = "";
  updateDirectionButtons();
  refreshBoard();
  try {
    const data = await fetchJson(`data/asakusa/${code}.json`);
    if (version !== loadVersion) return;
    if (data.sourceType !== "odpt:StationTimetable" || data.station?.code !== code ||
        !Array.isArray(data.timetables) || data.timetables.length !== station.directions.length * 2) {
      throw new Error("Invalid station timetable data");
    }
    const fetchedAt = new Date(data.fetchedAt);
    document.getElementById("data-updated").textContent = `データ取得：${new Intl.DateTimeFormat("ja-JP", {
      timeZone: "Asia/Tokyo", dateStyle: "medium", timeStyle: "short"
    }).format(fetchedAt)}（日本時間）`;
    if (data.keikyuFetchedAt) {
      document.getElementById("data-updated").textContent += `／京急：${new Intl.DateTimeFormat("ja-JP", {
        timeZone: "Asia/Tokyo", dateStyle: "medium", timeStyle: "short"
      }).format(new Date(data.keikyuFetchedAt))}`;
    }
    timetableData = data;
  } catch (error) {
    if (version !== loadVersion) return;
    console.error("Failed to load timetable:", error);
    loadError = true;
  }
  if (version === loadVersion) refreshBoard();
}

function draw() {
  const now = new Date();
  if (now.getSeconds() === lastSecond) return;
  lastSecond = now.getSeconds();
  // The timetable is in Japan time, so show and compute everything in JST regardless of device timezone.
  const jst = new Date(now.getTime() + JST_OFFSET_MS);
  drawClock(jst);
  updateBoard(now, jst);
}

function drawClock(jst) {
  clear();
  noStroke();
  fill("#1a1a1a");
  textAlign(CENTER, CENTER);
  // p5's textStyle() only offers NORMAL/BOLD, so set the medium weight on the canvas context directly.
  drawingContext.font = CLOCK_FONT;
  text(formatTime(jst.getUTCHours(), jst.getUTCMinutes(), jst.getUTCSeconds()), width / 2, height / 2);
}

function formatTime(hours, minutes, seconds) {
  const base = `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
  return seconds === undefined ? base : `${base}:${String(seconds).padStart(2, "0")}`;
}

function toDateKey(date) {
  return date.toISOString().slice(0, 10);
}

function getUpcomingTrains(now, jst) {
  // Service day = JST date shifted back by the start hour, so 00:30 still uses the previous day's timetable.
  const serviceDay = new Date(jst.getTime() - SERVICE_DAY_START_HOUR * 60 * 60_000);
  const weekday = serviceDay.getUTCDay();
  const isHoliday = weekday === 0 || weekday === 6 || toDateKey(serviceDay) in timetableData.holidays;
  const dayType = isHoliday ? "holiday" : "weekday";
  // Epoch ms of 00:00 JST on the service day.
  const serviceMidnight = Date.UTC(serviceDay.getUTCFullYear(), serviceDay.getUTCMonth(), serviceDay.getUTCDate()) - JST_OFFSET_MS;

  const trains = timetableData.timetables
    .filter((timetable) => timetable.dayType === dayType)
    .flatMap((timetable) => timetable.departures
      .map((departure) => {
        const [hours, minutes] = departure.time.split(":").map(Number);
        return { ...departure, timetable, hours, minutes, departureAt: serviceMidnight + (hours * 60 + minutes) * 60_000 };
      })
      .filter((train) => train.departureAt > now.getTime())
      .slice(0, TRAINS_PER_DIRECTION));
  return trains.sort((a, b) => a.departureAt - b.departureAt);
}

function updateBoard(now, jst) {
  const currentTime = formatTime(jst.getUTCHours(), jst.getUTCMinutes());
  timeElement.dateTime = now.toISOString();
  timeElement.textContent = `現在時刻 ${formatTime(jst.getUTCHours(), jst.getUTCMinutes(), jst.getUTCSeconds())}`;

  if (!timetableData) {
    showMessage(loadError ? "時刻表データを読み込めませんでした。ページを再読み込みしてください。" : "時刻表を読み込んでいます…");
    announce(`現在時刻 ${currentTime}。${emptyElement.textContent}`);
    return;
  }

  const upcoming = getUpcomingTrains(now, jst).filter((train) =>
    selectedDirection === "all" || train.timetable.direction === selectedDirection);
  const state = upcoming.map((train) => `${train.timetable.id}:${train.time}:${getRemainingMinutes(train, now)}`).join("|");
  if (state !== lastListState) {
    trainList.replaceChildren(...upcoming.map((train, order) => createTrainRow(train, now, order)));
    emptyElement.textContent = selectedDirection === "all"
      ? "本日の列車の運転は終了しました。" : "この方面の本日の列車の運転は終了しました。";
    emptyElement.hidden = upcoming.length > 0;
    lastListState = state;
  }

  const next = upcoming[0];
  announce(next
    ? `現在時刻 ${currentTime}。次は${getDestinationLabel(next)}、あと${getRemainingMinutes(next, now)}分です。`
    : `現在時刻 ${currentTime}。${emptyElement.textContent}`);
}

function showMessage(message) {
  if (lastListState === message) return;
  trainList.replaceChildren();
  emptyElement.textContent = message;
  emptyElement.hidden = false;
  lastListState = message;
}

function announce(message) {
  if (message === lastAnnouncement) return;
  liveElement.textContent = message;
  lastAnnouncement = message;
}

function getRemainingMinutes(train, now) {
  return Math.ceil((train.departureAt - now.getTime()) / 60_000);
}

function getDestinationLabel(train) {
  return `${train.destination}行き`;
}

function createTrainRow(train, now, order) {
  const remaining = getRemainingMinutes(train, now);
  const row = document.createElement("li");
  // Trains are sorted, so every "まもなく" row sits at the top and shares the emphasized size.
  row.className = order === 0 || remaining === 1 ? "train is-next" : "train";

  const orderLabel = document.createElement("span");
  orderLabel.className = "sr-only";
  orderLabel.textContent = order === 0 ? "次の電車" : `${order + 1}本目`;

  const service = document.createElement("span");
  service.className = "service";
  service.setAttribute("aria-label", train.type);
  const label = document.createElement("span");
  label.textContent = train.type;
  const serviceStyle = getServiceStyle(train);
  service.style.setProperty("--service-background", serviceStyle.background);
  service.style.setProperty("--service-foreground", serviceStyle.foreground);
  service.append(label);

  const detail = document.createElement("div");
  detail.className = "train-detail";
  const meta = document.createElement("div");
  meta.className = "train-meta";
  const direction = document.createElement("span");
  direction.className = "direction-label";
  direction.textContent = train.timetable.direction === "north" ? "押上方面"
    : train.timetable.direction === "keikyu" ? "品川・横浜・羽田空港方面"
    : stationSelect.value <= "A-07" ? "西馬込方面" : "西馬込・京急線方面";
  meta.append(service, direction);
  const destination = document.createElement("span");
  destination.className = "destination";
  destination.textContent = train.destination;
  detail.append(meta, destination);

  const time = document.createElement("time");
  time.className = "departure-time";
  time.dateTime = new Date(train.departureAt).toISOString();
  time.textContent = formatTime(train.hours % 24, train.minutes);
  time.setAttribute("aria-label", `発車 ${time.textContent}`);

  const remainingValue = document.createElement("span");
  remainingValue.className = "remaining-value";
  if (remaining === 1) {
    remainingValue.classList.add("is-soon");
    remainingValue.textContent = "まもなく";
  } else {
    const unit = document.createElement("span");
    unit.className = "remaining-unit";
    unit.textContent = "分";
    remainingValue.append(String(remaining), unit);
  }

  row.append(orderLabel, detail, time, remainingValue);
  return row;
}


// Native buttons keep the two existing views keyboard-operable.
["departures", "positions"].forEach((view) => {
  document.getElementById(`view-${view}`).addEventListener("click", () => {
    const positions = view === "positions";
    document.getElementById("departure-panel").hidden = positions;
    document.getElementById("positions").hidden = !positions;
    document.getElementById("view-departures").setAttribute("aria-pressed", String(!positions));
    document.getElementById("view-positions").setAttribute("aria-pressed", String(positions));
  });
});
