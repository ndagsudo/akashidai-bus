"use strict";

/* ========================================================================
 * 明石台バス検索 - アプリ本体
 * 時刻表データは data/timetable.json に分離してある。
 * ダイヤ改正があった場合は、そのファイルだけを更新すればよい。
 * ====================================================================== */

const STALE_THRESHOLD_DAYS = 90; // 確認日からこの日数を超えたら更新確認バナーを出す
const IMMINENT_MINUTES = 5;      // 発車5分前からは目立たせる
const PARK_PREFERENCE_THRESHOLD = 15; // 行き検索: 明石台七丁目の待ち時間がこれ(分)より長く
                                        // 明石台公園前の方が短い場合に公園前を推す
const UPCOMING_LIMIT = 5; // 「次の○本」表示の件数

let timetable = null;
let currentDirection = null; // 'outbound' | 'inbound'
let referenceDate = new Date(); // 検索基準日時（手動指定時はここが変わる）
let isManualTime = false;
let tickTimer = null;

/* ---------------------------- 日付・祝日ユーティリティ ---------------------------- */

function pad2(n) { return String(n).padStart(2, "0"); }

function formatDateKey(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function formatMinutesToHHMM(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${pad2(h)}:${pad2(m)}`;
}

function timeStrToMinutes(t) {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

// 春分の日・秋分の日 (海上保安庁の近似式。1980-2099年で有効)
function springEquinoxDay(year) {
  return Math.floor(20.8431 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4));
}
function autumnEquinoxDay(year) {
  return Math.floor(23.2488 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4));
}

// 第n月曜日(ハッピーマンデー)
function nthMondayDate(year, month, n) {
  const d = new Date(year, month - 1, 1);
  const dow = d.getDay(); // 0=日
  const firstMonday = 1 + ((8 - dow) % 7);
  return new Date(year, month - 1, firstMonday + (n - 1) * 7);
}

// 指定年の「国民の祝日」を YYYY-MM-DD -> 名称 のマップで返す
function buildNationalHolidays(year) {
  const map = {};
  const add = (month, day, name) => {
    const d = new Date(year, month - 1, day);
    map[formatDateKey(d)] = name;
  };
  add(1, 1, "元日");
  add(1, nthMondayDate(year, 1, 2).getDate(), "成人の日");
  add(2, 11, "建国記念の日");
  if (year >= 2020) add(2, 23, "天皇誕生日");
  add(3, springEquinoxDay(year), "春分の日");
  add(4, 29, "昭和の日");
  add(5, 3, "憲法記念日");
  add(5, 4, "みどりの日");
  add(5, 5, "こどもの日");
  // 2020年・2021年は東京オリンピック特例で日付が変則だったが、
  // 本アプリが対象とする期間では通常ルールのみを扱う。
  add(7, nthMondayDate(year, 7, 3).getDate(), "海の日");
  add(8, 11, "山の日");
  add(9, nthMondayDate(year, 9, 3).getDate(), "敬老の日");
  add(9, autumnEquinoxDay(year), "秋分の日");
  add(10, nthMondayDate(year, 10, 2).getDate(), "スポーツの日");
  add(11, 3, "文化の日");
  add(11, 23, "勤労感謝の日");

  // 振替休日: 祝日が日曜なら、その後最初の祝日でない日を振替休日にする
  const dates = Object.keys(map).sort();
  for (const key of dates) {
    const d = new Date(key + "T00:00:00");
    if (d.getDay() === 0) {
      let next = new Date(d);
      do {
        next.setDate(next.getDate() + 1);
      } while (map[formatDateKey(next)]);
      map[formatDateKey(next)] = "振替休日";
    }
  }
  // 国民の休日: 前後を祝日に挟まれた平日
  const finalDates = Object.keys(map).sort();
  for (const key of finalDates) {
    const d = new Date(key + "T00:00:00");
    const next = new Date(d);
    next.setDate(next.getDate() + 2);
    const between = new Date(d);
    between.setDate(between.getDate() + 1);
    const betweenKey = formatDateKey(between);
    if (!map[betweenKey] && map[formatDateKey(next)] && between.getDay() !== 0) {
      map[betweenKey] = "国民の休日";
    }
  }
  return map;
}

let holidayCache = {};
function isNationalHoliday(date) {
  const year = date.getFullYear();
  if (!holidayCache[year]) {
    holidayCache[year] = Object.assign(
      {},
      buildNationalHolidays(year - 1),
      buildNationalHolidays(year),
      buildNationalHolidays(year + 1)
    );
  }
  const key = formatDateKey(date);
  return holidayCache[year][key] || null;
}

// "weekday" | "saturday" | "holiday"
function getDayType(date) {
  const key = formatDateKey(date);
  const special = (timetable.meta.specialScheduleDates || []).find(s => s.date === key);
  if (special) return special.dayType;

  if (isNationalHoliday(date)) return "holiday";
  const dow = date.getDay();
  if (dow === 0) return "holiday"; // 日曜
  if (dow === 6) return "saturday";
  return "weekday";
}

function dayTypeLabel(dt) {
  return { weekday: "平日ダイヤ", saturday: "土曜ダイヤ", holiday: "日祝ダイヤ" }[dt] || dt;
}

const WEEKDAY_JP = ["日", "月", "火", "水", "木", "金", "土"];

/* ---------------------------- データ読み込み ---------------------------- */

async function loadTimetable() {
  try {
    const res = await fetch("data/timetable.json", { cache: "no-cache" });
    if (!res.ok) throw new Error("fetch failed");
    const data = await res.json();
    localStorage.setItem("timetable-cache", JSON.stringify(data));
    localStorage.setItem("timetable-cache-time", String(Date.now()));
    return data;
  } catch (e) {
    const cached = localStorage.getItem("timetable-cache");
    if (cached) return JSON.parse(cached);
    throw e;
  }
}

/* ---------------------------- 便リスト計算 ---------------------------- */

function getSchedule(direction, stopKey, dayType) {
  const route = timetable.directions[direction].routes[stopKey];
  return route.schedules[dayType] || [];
}

// 指定時刻以降(今日)の便を返す。各要素に stopKey, minutes を付与
function upcomingForRoute(direction, stopKey, dayType, nowMinutes) {
  const route = timetable.directions[direction].routes[stopKey];
  const schedule = getSchedule(direction, stopKey, dayType);
  return schedule
    .map(entry => ({
      ...entry,
      stopKey,
      minutes: timeStrToMinutes(entry.time),
      route,
    }))
    .filter(e => e.minutes >= nowMinutes)
    .sort((a, b) => a.minutes - b.minutes);
}

/* ---------------------------- 描画: ホーム ---------------------------- */

function initHome() {
  const confirmedDate = new Date(timetable.meta.confirmedDate + "T00:00:00");
  const ageDays = Math.floor((Date.now() - confirmedDate.getTime()) / 86400000);
  document.getElementById("stale-banner").hidden = ageDays <= STALE_THRESHOLD_DAYS;

  document.getElementById("btn-outbound").addEventListener("click", () => openResult("outbound"));
  document.getElementById("btn-inbound").addEventListener("click", () => openResult("inbound"));
}

function openResult(direction) {
  currentDirection = direction;
  isManualTime = false;
  referenceDate = new Date();
  document.getElementById("screen-home").hidden = true;
  document.getElementById("screen-result").hidden = false;
  document.getElementById("result-title").textContent =
    timetable.directions[direction].label;
  document.getElementById("manual-time-panel").hidden = true;
  renderResult();
  startTicking();
}

function goHome() {
  stopTicking();
  document.getElementById("screen-result").hidden = true;
  document.getElementById("screen-home").hidden = false;
}

function startTicking() {
  stopTicking();
  tickTimer = setInterval(() => {
    if (!isManualTime) {
      referenceDate = new Date();
      renderResult();
    }
  }, 60 * 1000);
}
function stopTicking() {
  if (tickTimer) clearInterval(tickTimer);
  tickTimer = null;
}

/* ---------------------------- 描画: 結果画面 ---------------------------- */

function renderContextBar(dayType) {
  const d = referenceDate;
  const dateStr = `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日(${WEEKDAY_JP[d.getDay()]}) ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  document.getElementById("context-datetime").textContent =
    dateStr + (isManualTime ? "（指定した日時）" : "（現在時刻）");
  const holidayName = isNationalHoliday(d);
  document.getElementById("context-daytype").textContent =
    dayTypeLabel(dayType) + (holidayName ? ` ・ ${holidayName}` : "");
}

function renderFooterMeta() {
  const notes = timetable.meta.generalNotes || [];
  const lines = notes.map(n => `・${n}`).join("<br>");
  document.getElementById("footer-meta").innerHTML =
    `データ確認日: ${timetable.meta.confirmedDate}<br>${lines}`;
}

function busRowHtml(entry, nowMinutes, opts) {
  opts = opts || {};
  const wait = entry.minutes - nowMinutes;
  const stopDef = timetable.stops[entry.stopKey];
  const badgeClass = entry.stopKey === "akashidai7" ? "seven" : "park";
  const imminent = wait <= IMMINENT_MINUTES;
  const destLabel = entry.route.destination
    ? `${entry.route.lineName} ${entry.route.destination}行き`
    : entry.route.lineName;
  const noteHtml = entry.note ? `<div class="bus-row-note">${entry.note}</div>` : "";
  return `
    <div class="bus-row ${imminent ? "imminent" : ""} ${opts.top ? "top" : ""}">
      <div class="stop-badge ${badgeClass}">${stopDef.shortName}</div>
      <div class="bus-row-main">
        <div class="bus-row-time">${entry.time}発</div>
        <div class="bus-row-dest">${destLabel}</div>
        ${noteHtml}
      </div>
      <div class="bus-row-wait">あと${wait}分</div>
    </div>`;
}

function renderResult() {
  if (!timetable) return;
  const dayType = getDayType(referenceDate);
  renderContextBar(dayType);
  renderFooterMeta();

  const nowMinutes = referenceDate.getHours() * 60 + referenceDate.getMinutes();
  const body = document.getElementById("result-body");

  if (currentDirection === "outbound") {
    body.innerHTML = renderOutbound(dayType, nowMinutes);
  } else {
    body.innerHTML = renderInbound(dayType, nowMinutes);
  }
}

function renderOutbound(dayType, nowMinutes) {
  const seven = upcomingForRoute("outbound", "akashidai7", dayType, nowMinutes);
  const park = upcomingForRoute("outbound", "akashidaiPark", dayType, nowMinutes);

  const sevenNext = seven[0] || null;
  const parkNext = park[0] || null;

  let recommendStop, reason;
  if (!sevenNext && !parkNext) {
    return emptyNoteHtml("outbound");
  } else if (!sevenNext) {
    recommendStop = "akashidaiPark";
    reason = "本日、明石台七丁目発の便は終了しました。明石台公園前をご利用ください。";
  } else if (!parkNext) {
    recommendStop = "akashidai7";
    reason = "明石台七丁目発の便をご利用ください。";
  } else {
    const diff = sevenNext.minutes - parkNext.minutes;
    if (diff > PARK_PREFERENCE_THRESHOLD) {
      recommendStop = "akashidaiPark";
      reason = `明石台七丁目の次の便まで${diff}分ありますが、明石台公園前なら${parkNext.minutes - nowMinutes}分後に乗れます。明石台公園前がおすすめです。`;
    } else {
      recommendStop = "akashidai7";
      reason = "自宅に近い明石台七丁目の便をご利用ください。";
    }
  }

  const recEntry = recommendStop === "akashidai7" ? sevenNext : parkNext;
  const recCardClass = recommendStop === "akashidaiPark" ? "recommend-card park" : "recommend-card";
  const recLabel = recommendStop === "akashidaiPark" ? "明石台公園前" : "明石台七丁目";
  const wait = recEntry.minutes - nowMinutes;

  let html = `
    <div class="${recCardClass}">
      <div class="recommend-label">おすすめ</div>
      <div class="recommend-stop">${recLabel}</div>
      <div class="recommend-time">${recEntry.time}発</div>
      <div class="recommend-wait">あと${wait}分</div>
      <div class="recommend-reason">${reason}</div>
    </div>`;

  html += `<div class="section-title">明石台七丁目 発（${timetable.directions.outbound.routes.akashidai7.lineName}）</div>`;
  html += listOrEmpty(seven, nowMinutes, "明石台七丁目");

  html += `<div class="section-title">明石台公園前 発（${timetable.directions.outbound.routes.akashidaiPark.lineName}）</div>`;
  html += listOrEmpty(park, nowMinutes, "明石台公園前");

  return html;
}

function renderInbound(dayType, nowMinutes) {
  const seven = upcomingForRoute("inbound", "akashidai7", dayType, nowMinutes);
  const park = upcomingForRoute("inbound", "akashidaiPark", dayType, nowMinutes);

  if (seven.length === 0 && park.length === 0) {
    return emptyNoteHtml("inbound");
  }

  const combined = seven.concat(park).sort((a, b) => a.minutes - b.minutes).slice(0, UPCOMING_LIMIT);
  const top = combined[0];

  let warningHtml = "";
  if (top.stopKey === "akashidaiPark") {
    const nextSeven = seven.find(e => e.minutes > top.minutes);
    if (nextSeven) {
      const delay = nextSeven.minutes - top.minutes;
      warningHtml = `
        <div class="warning-banner">
          <strong>⚠ 明石台公園前行きが先に発車します</strong>
          明石台七丁目行きを待つと、${delay}分遅くなります。乗り遅れに注意してください。
          （明石台公園前までの徒歩時間は未確認です）
        </div>`;
    }
  }

  const topStopDef = timetable.stops[top.stopKey];
  const topRouteDesc = top.stopKey === "akashidai7"
    ? `${timetable.directions.inbound.routes.akashidai7.lineName}（泉中央駅発車時刻）`
    : `${timetable.directions.inbound.routes.akashidaiPark.lineName}（明石台公園前 到着/通過時刻）`;

  let html = "";
  html += warningHtml;
  html += `
    <div class="recommend-card ${top.stopKey === "akashidaiPark" ? "park" : ""}">
      <div class="recommend-label">次のバス</div>
      <div class="recommend-stop">${topStopDef.shortName}行き</div>
      <div class="recommend-time">${top.time}発</div>
      <div class="recommend-wait">あと${top.minutes - nowMinutes}分</div>
      <div class="recommend-reason">${topRouteDesc}</div>
    </div>`;

  html += `<div class="section-title">発車時刻順（この後 ${combined.length}本）</div>`;
  html += `<div class="bus-list">`;
  combined.forEach((e, i) => {
    html += busRowHtml(e, nowMinutes, { top: i === 0 });
  });
  html += `</div>`;

  html += `<div class="section-title">内訳</div>`;
  html += `<div class="section-title" style="font-weight:600;font-size:0.9rem;">明石台七丁目行き（泉中央駅発）</div>`;
  html += listOrEmpty(seven, nowMinutes, "明石台七丁目");
  html += `<div class="section-title" style="font-weight:600;font-size:0.9rem;">明石台公園前行き（明石台公園前 発着時刻）</div>`;
  html += listOrEmpty(park, nowMinutes, "明石台公園前");

  return html;
}

function listOrEmpty(list, nowMinutes, stopLabel) {
  if (list.length === 0) {
    return `<div class="empty-note">本日、${stopLabel}方面の便は見つかりませんでした。<br>
      <a href="https://transfer.navitime.biz/miyagikotsu/pc/map/Top" target="_blank" rel="noopener">宮城交通 公式時刻表で確認する</a></div>`;
  }
  let html = `<div class="bus-list">`;
  list.slice(0, UPCOMING_LIMIT).forEach((e, i) => {
    html += busRowHtml(e, nowMinutes, { top: i === 0 });
  });
  html += `</div>`;
  return html;
}

function emptyNoteHtml(direction) {
  return `<div class="empty-note">
    本日運行の便は全て終了しているか、まだ見つかっていません。<br>
    日付や時刻を変えて検索するか、公式サイトで確認してください。<br>
    <a href="https://transfer.navitime.biz/miyagikotsu/pc/map/Top" target="_blank" rel="noopener">宮城交通 公式時刻表</a>
  </div>`;
}

/* ---------------------------- 全便を見るモード ---------------------------- */

let showingAll = false;

function renderAllSchedule() {
  const dayType = getDayType(referenceDate);
  const nowMinutes = referenceDate.getHours() * 60 + referenceDate.getMinutes();
  const body = document.getElementById("result-body");
  const dir = currentDirection;
  const routes = timetable.directions[dir].routes;

  let html = "";
  for (const stopKey of ["akashidai7", "akashidaiPark"]) {
    const route = routes[stopKey];
    const schedule = route.schedules[dayType] || [];
    html += `<div class="full-table">
      <h3>${timetable.stops[stopKey].name}（${route.lineName}）</h3>
      <div class="full-table-grid">`;
    schedule.forEach(e => {
      const mins = timeStrToMinutes(e.time);
      const past = mins < nowMinutes;
      html += `<span class="full-table-chip ${past ? "past" : ""}">${e.time}${e.note ? " *" : ""}</span>`;
    });
    html += `</div></div>`;
  }
  html += `<p class="disclaimer">* 印は経由地等の注記あり。グレー表示は発車済みの便です。</p>`;
  body.innerHTML = html;
}

/* ---------------------------- 手動日時指定 ---------------------------- */

function openManualPanel() {
  const panel = document.getElementById("manual-time-panel");
  const d = referenceDate;
  document.getElementById("input-date").value = formatDateKey(d);
  document.getElementById("input-time").value = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  panel.hidden = false;
}

function applyManualTime() {
  const dateVal = document.getElementById("input-date").value;
  const timeVal = document.getElementById("input-time").value;
  if (!dateVal || !timeVal) return;
  const [y, m, dd] = dateVal.split("-").map(Number);
  const [hh, mm] = timeVal.split(":").map(Number);
  referenceDate = new Date(y, m - 1, dd, hh, mm);
  isManualTime = true;
  showingAll = false;
  document.getElementById("manual-time-panel").hidden = true;
  renderResult();
}

/* ---------------------------- 初期化 ---------------------------- */

async function main() {
  try {
    timetable = await loadTimetable();
  } catch (e) {
    document.getElementById("app").innerHTML =
      `<div class="screen"><p style="padding-top:40px;text-align:center;">
      時刻表データの読み込みに失敗しました。通信状態を確認して再読み込みしてください。</p></div>`;
    return;
  }

  initHome();

  document.getElementById("btn-back").addEventListener("click", () => {
    showingAll = false;
    goHome();
  });
  document.getElementById("btn-refresh").addEventListener("click", () => {
    if (!isManualTime) referenceDate = new Date();
    showingAll = false;
    renderResult();
  });
  document.getElementById("btn-now").addEventListener("click", () => {
    isManualTime = false;
    showingAll = false;
    referenceDate = new Date();
    document.getElementById("manual-time-panel").hidden = true;
    renderResult();
  });
  document.getElementById("btn-manual").addEventListener("click", () => {
    openManualPanel();
  });
  document.getElementById("btn-cancel-manual").addEventListener("click", () => {
    document.getElementById("manual-time-panel").hidden = true;
  });
  document.getElementById("btn-apply-manual").addEventListener("click", applyManualTime);
  document.getElementById("btn-show-all").addEventListener("click", () => {
    showingAll = !showingAll;
    document.getElementById("btn-show-all").textContent = showingAll ? "絞り込み表示に戻す" : "全便を見る";
    if (showingAll) {
      renderAllScheduleWrapper();
    } else {
      renderResult();
    }
  });

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("service-worker.js").catch(() => {});
  }
}

function renderAllScheduleWrapper() {
  const dayType = getDayType(referenceDate);
  renderContextBar(dayType);
  renderFooterMeta();
  renderAllSchedule();
}

document.addEventListener("DOMContentLoaded", main);
