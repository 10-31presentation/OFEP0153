// Relative path so it also works under a GitHub Pages project URL (/<repo>/).
const DATA_URL = "data/tamachi.json";
const LINE_STYLES = {
  // Yamanote runs locals only, so its service badge is left blank.
  "山手線": { color: "#80c241", localColor: "#5a9e2a", showService: false },
  "京浜東北線・根岸線": { color: "#00b2e5", localColor: "#0092d0", showService: true }
};
// Like the on-board LED displays (E233 Keihin-Tohoku: local = sky blue, rapid = pink),
// locals use the line color. Colors are slightly darkened so white text stays readable.
const RAPID_COLOR = "#e4007f";
const TRAINS_PER_DIRECTION = 2;
const CLOCK_FONT = '500 88px "Google Sans Code"';
// Timetable hours run 04:00-24:59; earlier times belong to the previous service day.
const SERVICE_DAY_START_HOUR = 4;
const JST_OFFSET_MS = 9 * 60 * 60_000;

const listElement = document.getElementById("train-list");
const emptyElement = document.getElementById("empty-state");
const timeElement = document.getElementById("current-time");
const liveElement = document.getElementById("live-region");
let timetableData = null;
let loadError = false;
let lastSecond = -1;
let lastListState = null;
let lastAnnouncement = "";

function setup() {
  const canvas = createCanvas(480, 110);
  canvas.parent("clock-canvas");
  canvas.elt.setAttribute("aria-hidden", "true");
  // Canvas text does not trigger web font downloads, so request it explicitly; the next per-second redraw picks it up.
  document.fonts.load(CLOCK_FONT);
  frameRate(10);
  loadTimetable();
}

async function loadTimetable() {
  try {
    const response = await fetch(DATA_URL);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    timetableData = await response.json();
  } catch (error) {
    console.error("Failed to load timetable:", error);
    loadError = true;
  }
  lastSecond = -1;
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
  fill("#111");
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

  const upcoming = getUpcomingTrains(now, jst);
  const state = upcoming.map((train) => `${train.timetable.url}:${train.time}:${getRemainingMinutes(train, now)}`).join("|");
  if (state !== lastListState) {
    listElement.replaceChildren(...upcoming.map((train) => createTrainRow(train, now)));
    emptyElement.textContent = "本日の列車の運転は終了しました。";
    emptyElement.hidden = upcoming.length > 0;
    lastListState = state;
  }

  const next = upcoming[0];
  announce(next
    ? `現在時刻 ${currentTime}。次は${getDestinationLabel(next)}、あと${getRemainingMinutes(next, now)}分です。`
    : `現在時刻 ${currentTime}。本日の列車の運転は終了しました。`);
}

function showMessage(message) {
  if (lastListState === message) return;
  listElement.replaceChildren();
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
  // Loop-line trains have no terminal, so show the direction instead.
  return train.destination === "環状運転" ? train.timetable.direction : `${train.destination}行き`;
}

function createTrainRow(train, now) {
  const style = LINE_STYLES[train.timetable.line] ?? { color: "#999", localColor: "#666", showService: true };
  const row = document.createElement("li");
  row.className = "train";
  row.style.setProperty("--route-color", style.color);
  const remaining = getRemainingMinutes(train, now);

  const line = document.createElement("span");
  line.className = "route-bar";
  const lineName = document.createElement("span");
  lineName.className = "sr-only";
  lineName.textContent = train.timetable.line;
  line.append(lineName);

  const service = document.createElement("span");
  service.className = "service";
  if (style.showService) {
    const isRapid = train.type === "快速";
    service.classList.add("is-shown");
    service.style.background = isRapid ? RAPID_COLOR : style.localColor;
    // Each line is its own span so the two-line local label can be staggered like the on-board sign.
    for (const text of isRapid ? ["快速"] : ["各駅", "停車"]) {
      const lineSpan = document.createElement("span");
      lineSpan.textContent = text;
      service.append(lineSpan);
    }
    service.classList.toggle("is-two-line", !isRapid);
  }

  const destination = document.createElement("span");
  destination.className = "destination";
  if (train.destination === "環状運転") {
    const suffix = document.createElement("span");
    suffix.className = "destination-suffix";
    suffix.textContent = "方面";
    destination.append(train.timetable.direction.replace(/方面$/, ""), suffix);
  } else {
    destination.textContent = train.destination;
  }

  const time = document.createElement("time");
  time.className = "departure-time";
  time.dateTime = new Date(train.departureAt).toISOString();
  time.textContent = formatTime(train.hours % 24, train.minutes);

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

  row.append(line, service, destination, time, remainingValue);
  return row;
}
