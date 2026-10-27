'use strict';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/** 実時刻の時計 */
function systemClock() {
  return { now: () => new Date() };
}

/** テスト用の固定時計（進めたり差し替えたりできる） */
function fixedClock(iso) {
  let t = new Date(iso);
  if (Number.isNaN(t.getTime())) throw new Error(`fixedClock: 不正な日時 ${iso}`);
  return {
    now: () => new Date(t.getTime()),
    set(iso2) { t = new Date(iso2); },
    advance(ms) { t = new Date(t.getTime() + ms); },
  };
}

/** 日時文字列/Date を Date に。解釈できなければ null（捏造しない） */
function parseDate(value) {
  if (value == null || value === '') return null;
  const d = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function toIso(value) {
  const d = parseDate(value);
  return d ? d.toISOString() : null;
}

/** 指定タイムゾーンオフセット（分）での日付キー YYYY-MM-DD */
function dayKey(date, tzOffsetMinutes = 540) {
  const shifted = new Date(date.getTime() + tzOffsetMinutes * 60 * 1000);
  return shifted.toISOString().slice(0, 10);
}

module.exports = { DAY_MS, HOUR_MS, systemClock, fixedClock, parseDate, toIso, dayKey };
