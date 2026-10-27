'use strict';

/**
 * 名簿・結果の CSV/JSON 出力（「オートいいね機能」配下 exports/ に保存）。
 */

const fs = require('node:fs');
const path = require('node:path');
const { OP } = require('./ledger');
const { parseDate } = require('./clock');

/** 日時を JST（+09:00）の ISO 表記にする。解釈できない値はそのまま */
function jst(v) {
  const d = parseDate(v);
  if (!d) return v == null ? '' : String(v);
  const t = new Date(d.getTime() + 9 * 3600e3);
  return `${t.toISOString().slice(0, 19).replace('T', ' ')}+09:00`;
}

function csvCell(v) {
  if (v == null) return '';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows, columns) {
  const head = columns.map((c) => csvCell(c.label)).join(',');
  const body = rows.map((r) => columns.map((c) => csvCell(typeof c.get === 'function' ? c.get(r) : r[c.key])).join(','));
  return '﻿' + [head, ...body].join('\r\n') + '\r\n';
}

function buildRosterRows(ledger, accountsById = {}) {
  const rows = [];
  for (const p of ledger.listPersons()) {
    const sources = ledger.sourcesOf(p.id);
    const evals = ledger.evaluationsOf(p.id);
    const fit = ledger.modeFitOf(p.id);
    const assignment = ledger.getAssignment(p.id);
    const target = ledger.getTarget(p.id, OP.LIKE);
    const reaction = sources.filter((s) => s.reactionAt).sort((a, b) => (a.reactionAt < b.reactionAt ? 1 : -1))[0];
    const latest = p.latestNote && p.latestNote.note ? p.latestNote.note : null;
    rows.push({
      personId: p.id,
      userId: p.userId || '',
      urlname: p.urlname,
      profileUrl: p.profileUrl,
      displayName: p.displayName,
      identityConfirmed: p.identityConfirmed ? 'はい' : 'いいえ',
      seedUrls: [...new Set(sources.map((s) => s.seedUrl))].join(' | '),
      seedNoteUrls: [...new Set(sources.map((s) => s.seedNoteUrl).filter(Boolean))].join(' | '),
      listTypes: [...new Set(sources.map((s) => s.listType === 'note_likes' ? '記事のスキ一覧' : 'フォロワー一覧'))].join(' | '),
      modeFitSuki: fit.suki || '未評価',
      modeFitFollower: fit.follower || '未評価',
      followingCount: p.followingCount == null ? (p.countsRaw ? `不明(${p.countsRaw})` : '不明') : p.followingCount,
      followerCount: p.followerCount == null ? (p.countsRaw ? `不明(${p.countsRaw})` : '不明') : p.followerCount,
      latestNoteUrl: latest ? latest.url : '',
      latestNoteKey: latest ? latest.key : '',
      latestNotePublishedAt: latest ? jst(latest.publishedAt) : '',
      latestNoteEvidence: p.latestNote ? (p.latestNote.evidence || p.latestNote.message || p.latestNote.code) : '',
      reactionAt: reaction ? jst(reaction.reactionAt) : '反応日時不明',
      reactionEvidence: reaction ? reaction.reactionEvidence : (sources.find((s) => s.orderEvidence) ? sources.find((s) => s.orderEvidence).orderEvidence : ''),
      lastFetchedAt: p.lastFetchedAt ? jst(p.lastFetchedAt) : '',
      assignedAccount: assignment ? (accountsById[assignment.accountId] ? accountsById[assignment.accountId].name : assignment.accountId) : '',
      targetState: target ? target.state : '',
      targetReason: target ? [target.reasonCode, target.reasonText].filter(Boolean).join(': ') : '',
      decisions: evals.map((e) => `${e.mode}/${e.accountId}: ${e.verdict}（${e.reasons.filter((r) => r.level !== 'info').map((r) => r.message).join('; ') || '条件を満たす'}）`).join(' | '),
    });
  }
  return rows;
}

const ROSTER_COLUMNS = [
  { key: 'personId', label: '台帳ID' }, { key: 'userId', label: 'userId' }, { key: 'urlname', label: '対象ID' }, { key: 'profileUrl', label: '対象URL' },
  { key: 'displayName', label: '表示名' }, { key: 'identityConfirmed', label: '本人確認' }, { key: 'seedUrls', label: '起点URL' }, { key: 'seedNoteUrls', label: '起点記事URL' },
  { key: 'listTypes', label: '発見した一覧の種類' }, { key: 'modeFitSuki', label: 'スキ獲得 適合' }, { key: 'modeFitFollower', label: 'フォロワー獲得 適合' },
  { key: 'followingCount', label: 'フォロー数' }, { key: 'followerCount', label: 'フォロワー数' }, { key: 'latestNoteUrl', label: '最新記事URL' }, { key: 'latestNoteKey', label: '最新記事ID' },
  { key: 'latestNotePublishedAt', label: '最新記事公開日時' }, { key: 'latestNoteEvidence', label: '活動の確認方法' }, { key: 'reactionAt', label: '反応日時' }, { key: 'reactionEvidence', label: '反応の根拠' },
  { key: 'lastFetchedAt', label: '最終取得時刻' }, { key: 'assignedAccount', label: '担当アカウント' }, { key: 'targetState', label: '状態' }, { key: 'targetReason', label: '状態の理由' }, { key: 'decisions', label: '採否と理由' },
];

function buildResultRows(ledger, accountsById = {}) {
  const rows = [];
  for (const t of ledger.listTargets({ opType: OP.LIKE })) {
    if (t.state === 'candidate') continue;
    const p = ledger.getPerson(t.personId);
    rows.push({
      urlname: p ? p.urlname : t.personId,
      displayName: p ? p.displayName : '',
      account: accountsById[t.accountId] ? accountsById[t.accountId].name : (t.accountId || ''),
      opType: t.opType,
      state: t.state,
      noteUrl: t.noteUrl || '',
      sendingStartedAt: t.sendingStartedAt ? jst(t.sendingStartedAt) : '',
      finishedAt: t.finishedAt ? jst(t.finishedAt) : '',
      reason: [t.reasonCode, t.reasonText].filter(Boolean).join(': '),
    });
  }
  return rows;
}

const RESULT_COLUMNS = [
  { key: 'urlname', label: '対象ID' }, { key: 'displayName', label: '表示名' }, { key: 'account', label: '担当アカウント' }, { key: 'opType', label: '操作種別' },
  { key: 'state', label: '状態' }, { key: 'noteUrl', label: '対象記事URL' }, { key: 'sendingStartedAt', label: '送信開始' }, { key: 'finishedAt', label: '確定時刻' }, { key: 'reason', label: '理由' },
];

function exportAll({ ledger, accounts, exportDir, clock }) {
  fs.mkdirSync(exportDir, { recursive: true });
  const stamp = `${jst(clock.now()).slice(0, 19).replace(/[: ]/g, '-')}JST`;
  const accountsById = Object.fromEntries((accounts || []).map((a) => [a.id, a]));
  const roster = buildRosterRows(ledger, accountsById);
  const results = buildResultRows(ledger, accountsById);
  const outcomes = ledger.listOutcomes().map((o) => { const p = ledger.getPerson(o.personId); return { ...o, urlname: p ? p.urlname : '' }; });
  const files = {
    rosterCsv: path.join(exportDir, `roster_${stamp}.csv`),
    resultsCsv: path.join(exportDir, `results_${stamp}.csv`),
    json: path.join(exportDir, `export_${stamp}.json`),
  };
  fs.writeFileSync(files.rosterCsv, toCsv(roster, ROSTER_COLUMNS));
  fs.writeFileSync(files.resultsCsv, toCsv(results, RESULT_COLUMNS));
  fs.writeFileSync(files.json, JSON.stringify({ exportedAt: jst(clock.now()), timezone: 'JST(+09:00)', roster, results, outcomes, attempts: ledger.attemptStats() }, null, 2));
  return { files, counts: { roster: roster.length, results: results.length, outcomes: outcomes.length } };
}

module.exports = { exportAll, buildRosterRows, buildResultRows, toCsv, jst, ROSTER_COLUMNS, RESULT_COLUMNS };
