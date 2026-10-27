'use strict';
/* 操作画面。2秒ごとに /api/state を取得して描画する */
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (iso) => { if (!iso) return '-'; const d = new Date(iso); return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', hour12: false }); };
  const STATE_JA = { candidate: '候補', reserved: '予約中', sending: '送信中', succeeded: '成功', skipped: '見送り', failed_before_send: '送信前失敗', unknown: '結果不明', blocked: '外部制限' };
  const VERDICT_JA = { adopt: '採用', hold: '保留', reject: '不採用' };
  let state = null;
  let lastCollect = null;
  let previewCache = [];

  async function api(method, path, body) {
    const res = await fetch(path, { method, headers: { 'content-type': 'application/json', 'x-note-tool': '1' }, body: body ? JSON.stringify(body) : undefined });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || res.statusText);
    return json;
  }
  function dialog(title, obj) { $('dlg-title').textContent = title; $('dlg-body').textContent = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2); $('dlg').showModal(); }
  $('dlg-close').onclick = () => $('dlg').close();

  function renderHeader() {
    $('f-adapter').textContent = `接続: ${state.adapter.name === 'mock' ? 'モック（実noteに接続しない）' : '実note（CDP）'}`;
    const real = state.flags.enableRealActions;
    $('f-real').textContent = `実アクション: ${real ? 'ON（ドライランを外すと送信）' : 'OFF（初期状態）'}`;
    $('f-real').className = `flag ${real ? 'on' : 'off'}`;
    $('f-sched').textContent = `定期実行: ${state.flags.schedulerEnabled ? 'ON' : 'OFF'}`;
    $('f-sched').className = `flag ${state.flags.schedulerEnabled ? 'on' : 'off'}`;
    $('f-lock').textContent = `実行ロック: ${state.executorLock ? state.executorLock.holder : 'なし'}`;
    $('f-now').textContent = `DB: ${state.dbPath}　${fmt(state.now)}`;
  }

  function renderAccounts() {
    const box = $('accounts');
    box.innerHTML = '';
    for (const a of state.accounts) {
      const l = a.pools.like;
      const card = document.createElement('div');
      card.className = `card${a.id === state.selectedAccountId ? ' selected' : ''}`;
      const BK = { external_limit: '外部制限', auth: '認証切れ・認証要求', permission_unknown: '権限不明（403）' };
      const blk = a.block ? `<span class="err">${esc(BK[a.block.kind] || a.block.kind)}: ${esc(a.block.message)}（内部回復では解除されない） <button data-clear="${a.id}">解除を確認した</button></span>` : '<span class="ok">外部制限・認証切れなし</span>';
      card.innerHTML = `<h3><span>${esc(a.name)} <span class="muted">${esc(a.url)}</span></span><button data-select="${a.id}" ${a.id === state.selectedAccountId ? 'disabled' : ''}>選択</button></h3>
        <dl class="kv">
          <dt>接続</dt><dd>port ${a.cdpPort} <button data-verify="${a.id}">ログインID照合</button> <span id="sess-${a.id}" class="muted"></span></dd>
          <dt>担当</dt><dd>${a.assigned} 人（候補 ${a.targets.candidate} / 成功 ${a.targets.succeeded} / 見送り ${a.targets.skipped} / 結果不明 ${a.targets.unknown} / 送信前失敗 ${a.targets.failed_before_send} / 外部制限 ${a.targets.blocked}）</dd>
          <dt>送信</dt><dd>試行 ${a.attempts.attempted} / 成功 ${a.attempts.succeeded} / 結果不明 ${a.attempts.unknown} / 失敗 ${a.attempts.failed}（ドライラン ${a.attempts.dry_run}）</dd>
          <dt>成果</dt><dd>スキ返し ${a.outcomes.sukiReturn} / フォロー増加 ${a.outcomes.followGained}（確認できた相手との一致のみ。全体の増加を効果と断定しない）</dd>
          <dt>like 枠</dt><dd>内部残数 ${l.credits ?? '未設定'} / 容量 ${l.capacity ?? '未設定'}（${l.recoveryIntervalMin ?? '-'}分ごとに +${l.recoveryAmount ?? '-'}、次回回復 ${fmt(l.nextRefillAt)}）<br>
            日次残 ${l.dailyAvailable ?? '-'} / ${l.dailyLimit ?? '未設定'}（本日 ${l.usedToday}、JST ${l.dayKey || ''}）、時間残 ${l.hourlyAvailable ?? '-'} / ${l.hourlyLimit ?? '未設定'}（直近1時間 ${l.usedLastHour}）、引当 ${l.holds}<br>
            <b>有効残数 ${l.effective ?? '-'}</b>${l.valid ? '' : ` <span class="err">${esc(l.validity.message)}</span>`}</dd>
          <dt>制限</dt><dd>${blk}</dd>
          <dt>上限設定</dt><dd><button data-limits="${a.id}">変更</button> <span class="muted">${esc(Object.entries(l.labels || {}).map(([k, v]) => `${k}: ${v}`).join('; '))}</span></dd>
        </dl>`;
      box.appendChild(card);
    }
    box.querySelectorAll('[data-select]').forEach((b) => { b.onclick = async () => { await api('POST', '/api/account', { id: b.dataset.select }); refresh(); loadOwnArticle(); }; });
    box.querySelectorAll('[data-verify]').forEach((b) => { b.onclick = async () => { const r = await api('POST', '/api/session/verify', { accountId: b.dataset.verify }); const el = $(`sess-${b.dataset.verify}`); el.textContent = `${r.ok ? '一致' : '不一致/未取得'}: ${r.message}`; el.className = r.ok ? 'ok' : 'err'; }; });
    box.querySelectorAll('[data-clear]').forEach((b) => { b.onclick = async () => { if (confirm('外部制限が解除されたことを確認しましたか？')) { await api('POST', `/api/limits/${b.dataset.clear}/clear-block`); refresh(); } }; });
    box.querySelectorAll('[data-limits]').forEach((b) => { b.onclick = async () => {
      const a = state.accounts.find((x) => x.id === b.dataset.limits); const l = a.pools.like;
      const daily = prompt('like 日次上限（教材の200件/日は参考値。公式の保証値ではなく「200件まで安全」ではない）', l.dailyLimit ?? ''); if (daily === null) return;
      const hourly = prompt('like 直近1時間上限（教材の50件/時は参考値）', l.hourlyLimit ?? ''); if (hourly === null) return;
      const cap = prompt('内部 credits の容量上限', l.capacity ?? ''); if (cap === null) return;
      const interval = prompt('回復間隔（分。既定20。アプリ内の規則で note 公式の制限ではない）', l.recoveryIntervalMin ?? 20); if (interval === null) return;
      const amt = prompt('回復量（区間ごと。既定1）', l.recoveryAmount ?? 1); if (amt === null) return;
      await api('POST', `/api/limits/${a.id}/like`, { dailyLimit: daily, hourlyLimit: hourly, capacity: cap, recoveryIntervalMin: interval, recoveryAmount: amt });
      refresh();
    }; });
  }

  function renderMode() {
    document.querySelectorAll('input[name=mode]').forEach((r) => { r.checked = r.value === state.mode; r.onchange = async () => { await api('POST', '/api/mode', { mode: r.value }); refresh(); loadOwnArticle(); }; });
  }

  async function loadOwnArticle() {
    try {
      const o = await api('GET', '/api/own-article');
      const pin = o.pinned ? `固定記事「${esc(o.pinned.title)}」スキ ${o.pinned.likeCount}` : '固定記事なし';
      $('own-article').innerHTML = `自分の公開記事: ${o.count ?? '取得失敗'} 件。${pin}。${o.sukiModeAvailable ? '' : `<b class="err">${esc(o.sukiModeMessage)}</b>`} ${o.suggestion ? `<div class="hold">${esc(o.suggestion)}</div>` : ''}`;
    } catch (e) { $('own-article').textContent = `自分の記事情報を取得できない: ${e.message}`; }
  }

  function renderSeeds() {
    const tb = $('seeds').querySelector('tbody');
    tb.innerHTML = '';
    for (const s of state.seeds) {
      const v = s.verification;
      let info = '';
      if (v && v.ok) {
        info = `本人: ${esc(v.creatorDisplayName)}（${esc(v.creatorUrlname)}） フォロー ${v.followingCount ?? '不明'} / フォロワー ${v.followerCount ?? '不明'} / 記事 ${v.noteCount ?? '不明'}`;
        if (v.seedRange) info += `<br><span class="muted">${esc(v.seedRange.materialText)}</span><br>範囲判定: ${v.seedRange.evaluated ? (v.seedRange.ok ? '範囲内' : `範囲外（${esc(v.seedRange.reasons.join('、'))}）`) : esc(v.seedRange.message)}`;
      } else if (v) info = `<span class="err">${esc(v.message)}</span>`;
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${s.mode === 'suki' ? 'スキ獲得' : 'フォロワー獲得'}</td><td>${esc(s.displayName)}<br><span class="muted">${esc(s.note)}</span></td>
        <td>${s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.url)}</a>` : '<span class="err">URL未確認（推測で埋めない）</span>'} ${s.urlConfirmedBySpec ? '<span class="badge">依頼書で確認済みURL</span>' : ''}</td>
        <td>${s.verified ? `<span class="badge adopt">本人確認済 ${fmt(s.verifiedAt)}</span>` : '<span class="badge reject">未確認（収集に使わない）</span>'}${s.enabled ? '' : ' <span class="badge">無効</span>'}</td>
        <td>${info}</td>
        <td><button data-sv="${s.id}" ${s.urlname ? '' : 'disabled'}>確認</button> <button data-su="${s.id}">URL設定</button> <button data-se="${s.id}" data-en="${s.enabled ? 0 : 1}">${s.enabled ? '無効化' : '有効化'}</button> <button data-sd="${s.id}">削除</button></td>`;
      tb.appendChild(tr);
    }
    tb.querySelectorAll('[data-sv]').forEach((b) => { b.onclick = async () => { await api('POST', `/api/seeds/${b.dataset.sv}/verify`); refresh(); }; });
    tb.querySelectorAll('[data-su]').forEach((b) => { b.onclick = async () => { const u = prompt('起点のプロフィールURL（https://note.com/xxxx）'); if (u) { try { await api('POST', `/api/seeds/${b.dataset.su}/url`, { url: u }); } catch (e) { alert(e.message); } refresh(); } }; });
    tb.querySelectorAll('[data-se]').forEach((b) => { b.onclick = async () => { await api('POST', `/api/seeds/${b.dataset.se}/enabled`, { enabled: b.dataset.en === '1' }); refresh(); }; });
    tb.querySelectorAll('[data-sd]').forEach((b) => { b.onclick = async () => { if (confirm('起点を削除しますか？')) { await api('DELETE', `/api/seeds/${b.dataset.sd}`); refresh(); } }; });
  }
  $('seed-add').onclick = async () => {
    try { await api('POST', '/api/seeds', { mode: $('seed-mode').value, url: $('seed-url').value || null, displayName: $('seed-name').value }); $('seed-url').value = ''; $('seed-name').value = ''; refresh(); } catch (e) { alert(e.message); }
  };

  function renderCriteria() {
    $('criteria').innerHTML = state.criteria.map((c) => `<li><b>${esc(c.id)}</b> ${esc(c.text)}<br><span class="src">出典: ${esc(c.source)}${c.extra ? '（追加仕様）' : ''}${c.configKey ? ` ／ 設定キー ${esc(c.configKey)}` : ''}</span></li>`).join('');
    const cv = state.configValues;
    $('cfg-values').innerHTML = `活動条件 ${cv.activityWindowDays.value} 日（${esc(cv.activityWindowDays.kind)}。${esc(cv.activityWindowDays.note)}）／ 固定記事切替の提案しきい値 ${cv.pinSuggestionLikeThreshold.value}（${esc(cv.pinSuggestionLikeThreshold.kind)}）／ 一人につきスキ1件（${esc(cv.oneLikePerPersonProjectWide.kind)}）／ like 枠の初期値: ${esc(Object.entries(cv.limitsPools.like).map(([k, v]) => `${k}=${v ?? '未設定'}`).join('、'))}（区分: ${esc(Object.entries(cv.limitsLabels.like).map(([k, v]) => `${k}=${v}`).join('、'))}）／ ${esc(cv.refillNote || '')}`;
    $('cfg-evidence').checked = !!state.flags.requireReactionEvidence;
    $('cfg-stop-unknown').checked = !!state.flags.stopOnUnknown;
    $('cfg-real').checked = !!state.flags.enableRealActions;
    if (document.activeElement !== $('cfg-following-max')) $('cfg-following-max').value = cv.seedRange.value.followingMax ?? '';
    if (document.activeElement !== $('cfg-follower-min')) $('cfg-follower-min').value = cv.seedRange.value.followerMin ?? '';
  }
  $('cfg-evidence').onchange = async (e) => { await api('POST', '/api/config', { requireReactionEvidence: e.target.checked }); refresh(); };
  $('cfg-stop-unknown').onchange = async (e) => { await api('POST', '/api/config', { stopOnUnknown: e.target.checked }); refresh(); };
  $('cfg-real').onchange = async (e) => {
    if (e.target.checked && !confirm('実アカウントでの送信を有効にします。開始時に「ドライラン」を外した場合のみ実際にスキを送ります。よろしいですか？')) { e.target.checked = false; return; }
    await api('POST', '/api/config', { enableRealActions: e.target.checked }); refresh();
  };
  $('cfg-save-range').onclick = async () => { await api('POST', '/api/config', { seedRange: { followingMax: $('cfg-following-max').value, followerMin: $('cfg-follower-min').value } }); refresh(); };

  function stat(label, value) { return `<div class="stat"><b>${esc(value ?? '-')}</b><span>${esc(label)}</span></div>`; }
  function renderCollect() {
    const c = lastCollect || (state.recentCollections[0] ? { stats: state.recentCollections[0].stats, kind: state.recentCollections[0].kind, seedReports: [], skippedSeeds: [] } : null);
    if (!c || !c.stats) { $('collect-stats').innerHTML = '<span class="muted">まだ収集していません</span>'; return; }
    const s = c.stats;
    $('collect-stats').innerHTML = stat('収集種別', c.kind === 'initial' ? '初回収集' : c.kind === 'update' ? '更新収集' : c.kind) + stat('一覧から取得', s.listedTotal) + stat('新規取得', s.newPersons) + stat('重複除外', s.duplicatesExcluded)
      + stat('条件合格', s.passed) + stat('保留', s.held) + stat('不採用', s.rejected) + stat('活動条件不合格', s.activityFailed) + stat('比率不合格', s.ratioFailed) + stat('実行可能（この担当）', s.executable) + stat('実行可能（全担当）', s.executableAllAccounts) + stat('新規担当割当', s.newlyAssigned);
    $('collect-seeds').innerHTML = (c.seedReports || []).map((r) => `起点 ${esc(r.url)}: ${esc(r.status)}${r.kind ? `（${r.kind === 'initial' ? '初回' : '更新'}、${r.listed} 件）` : ''}${r.message ? ` ${esc(r.message)}` : ''}`).concat((c.skippedSeeds || []).map((r) => `起点 ${esc(r.url || r.displayName)}: 使用せず（${esc(r.reason)}）`)).join('<br>');
  }
  $('collect').onclick = async () => {
    $('collect-msg').textContent = '収集中...';
    try { lastCollect = await api('POST', '/api/collect', {}); $('collect-msg').textContent = lastCollect.stopped ? `停止: ${lastCollect.message}` : '完了'; $('collect-msg').className = lastCollect.stopped ? 'err' : 'ok'; } catch (e) { $('collect-msg').textContent = e.message; $('collect-msg').className = 'err'; }
    refresh();
  };

  function renderPlan() {
    const tb = $('plan').querySelector('tbody');
    tb.innerHTML = state.plan.map((p, i) => `<tr><td>${i + 1}</td><td><a href="${esc(p.profileUrl)}" target="_blank" rel="noopener">${esc(p.displayName || p.urlname)}</a><br><span class="muted">${esc(p.urlname)}</span></td><td>${p.latestNoteUrl ? `<a href="${esc(p.latestNoteUrl)}" target="_blank" rel="noopener">${esc(p.latestNoteUrl)}</a>` : '-'}</td><td>${fmt(p.latestNotePublishedAt)}</td><td>${p.reactionAt ? fmt(p.reactionAt) : '反応日時不明'}</td><td>${esc(p.reasons.filter((r) => r.level === 'info').map((r) => r.message).join('；') || '条件を満たす')}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">実行可能な対象がありません（対象不足のときは件数未達で終了し、補充しません）</td></tr>';
  }

  function renderRun() {
    const r = state.runner;
    const running = r.state === 'running' || r.state === 'paused' || r.state === 'stopping';
    $('run-start').disabled = running; $('run-pause').disabled = r.state !== 'running'; $('run-resume').disabled = r.state !== 'paused'; $('run-stop').disabled = !running;
    const cur = r.current;
    let txt = `状態: ${({ idle: '待機中', running: '実行中', paused: '一時停止', stopping: '停止処理中' })[r.state] || r.state}`;
    if (cur) txt += `　run ${cur.runId}（${cur.dryRun ? 'ドライラン' : '実送信'}、${cur.mode === 'suki' ? 'スキ獲得' : 'フォロワー獲得'}）` + (cur.currentTarget ? `　処理中: ${cur.currentTarget.urlname}` : '');
    if (r.waitReason) txt += `　待機理由: ${r.waitReason}`;
    if (!cur && r.lastRun) txt += `　前回: ${r.lastRun.runId} 停止理由=${r.lastRun.stopReason}`;
    $('run-status').textContent = txt;
    const s = r.summary || (r.lastRun && r.lastRun.summary);
    $('run-summary').innerHTML = s ? stat('予定件数', s.planned ?? '指定なし') + stat('候補', s.considered) + stat('処理', s.processed) + stat('成功', s.succeeded) + stat('既スキ', s.alreadyDone) + stat('結果不明', s.unknown) + stat('送信前失敗', s.failedBeforeSend) + stat('見送り', s.skipped) + stat('外部制限', s.blocked) + stat('ドライラン対象', s.dryRunWouldAct) + stat('未達', s.shortfall ?? '-') + stat('停止理由', s.stopReason ?? '-') : '';
  }
  $('run-start').onclick = async () => {
    const dryRun = $('run-dry').checked;
    if (!dryRun && !confirm('ドライランが外れています。実アカウントで実際にスキを送ります。開始しますか？')) return;
    try { const r = await api('POST', '/api/run/start', { dryRun, maxCount: $('run-max').value || null }); if (!r.started) alert(`開始できません: ${r.message}`); } catch (e) { alert(e.message); }
    refresh();
  };
  $('run-pause').onclick = async () => { await api('POST', '/api/run/pause'); refresh(); };
  $('run-resume').onclick = async () => { await api('POST', '/api/run/resume'); refresh(); };
  $('run-stop').onclick = async () => { await api('POST', '/api/run/stop'); refresh(); };

  function renderUnknown() {
    const rows = previewCache.filter((r) => r.targetState === 'unknown');
    const tb = $('unknown').querySelector('tbody');
    tb.innerHTML = rows.map((r) => `<tr><td>${esc(r.urlname)}</td><td>${esc(r.assignedAccount)}</td><td>${esc(r.latestNoteUrl)}</td><td>${esc(r.targetReason)}</td><td><button data-resolve="${r.personId}">サイト状態を照合して確定</button></td></tr>`).join('') || '<tr><td colspan="5" class="muted">結果不明の対象はありません</td></tr>';
    tb.querySelectorAll('[data-resolve]').forEach((b) => { b.onclick = async () => { const r = await api('POST', `/api/unknown/${b.dataset.resolve}/resolve`, {}); alert(`照合結果: ${r.siteState || r.code} → ${r.state || r.code}`); refresh(); }; });
  }

  async function renderPreview() {
    try { previewCache = await api('GET', '/api/preview'); } catch (e) { return; }
    const adoptOnly = $('preview-adopt-only').checked;
    const tb = $('preview').querySelector('tbody');
    tb.innerHTML = previewCache.filter((r) => !adoptOnly || r.verdict === 'adopt').map((r) => `<tr>
      <td><a href="${esc(r.profileUrl)}" target="_blank" rel="noopener">${esc(r.urlname)}</a><br><span class="muted">${esc(r.displayName)}${r.userId ? ` / id:${esc(r.userId)}` : ''}</span></td>
      <td>${esc(r.seedUrls)}</td><td>${esc(r.seedNoteUrls)}</td><td>${esc(r.listTypes)}</td>
      <td>スキ獲得: <span class="badge ${esc(r.modeFitSuki)}">${esc(VERDICT_JA[r.modeFitSuki] || r.modeFitSuki)}</span><br>フォロワー獲得: <span class="badge ${esc(r.modeFitFollower)}">${esc(VERDICT_JA[r.modeFitFollower] || r.modeFitFollower)}</span></td>
      <td>${esc(r.followingCount)} / ${esc(r.followerCount)}</td>
      <td>${r.latestNoteUrl ? `<a href="${esc(r.latestNoteUrl)}" target="_blank" rel="noopener">${esc(r.latestNoteKey)}</a>` : '-'}<br><span class="muted">${fmt(r.latestNotePublishedAt)}<br>${esc(r.latestNoteEvidence)}</span></td>
      <td>${r.reactionAt === '反応日時不明' ? '反応日時不明' : fmt(r.reactionAt)}<br><span class="muted">${esc(r.reactionEvidence)}</span></td>
      <td>${fmt(r.lastFetchedAt)}</td><td>${esc(r.assignedAccount)}</td>
      <td><span class="badge ${esc(r.targetState)}">${esc(STATE_JA[r.targetState] || r.targetState || '-')}</span><br><span class="muted">${esc(r.targetReason)}</span></td>
      <td><span class="badge ${esc(r.verdict)}">${esc(VERDICT_JA[r.verdict] || r.verdict)}</span><br><span class="muted">${esc(r.reasons.filter((x) => x.level !== 'info').map((x) => x.message).join('；'))}</span></td>
      <td><button data-why="${r.personId}">理由</button></td></tr>`).join('');
    tb.querySelectorAll('[data-why]').forEach((b) => { b.onclick = async () => dialog(`なぜ選ばれたか（台帳ID ${b.dataset.why}）`, await api('GET', `/api/explain/${b.dataset.why}`)); });
    renderUnknown();
  }
  $('preview-adopt-only').onchange = renderPreview;
  $('export').onclick = async () => { try { const r = await api('POST', '/api/export'); $('export-msg').textContent = `出力: ${r.files.rosterCsv}`; } catch (e) { $('export-msg').textContent = e.message; } };

  function renderEvents() {
    $('events').textContent = state.events.map((e) => `${fmt(e.at)} [${e.level}] ${e.accountId || '-'} ${e.code}: ${e.message}`).join('\n');
  }

  async function refresh() {
    try { state = await api('GET', '/api/state'); } catch (e) { $('run-status').textContent = `サーバーに接続できません: ${e.message}`; return; }
    renderHeader(); renderAccounts(); renderMode(); renderSeeds(); renderCriteria(); renderCollect(); renderPlan(); renderRun(); renderEvents();
    await renderPreview();
  }
  refresh().then(loadOwnArticle);
  setInterval(refresh, 2000);
})();
