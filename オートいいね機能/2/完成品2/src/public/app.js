'use strict';
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (iso) => { if (!iso) return '-'; const d = new Date(iso); return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', hour12: false }); };
  const STATE_JA = { candidate: '候補', reserved: '予約中', sending: '送信中', succeeded: '成功', skipped: '見送り', failed_before_send: '送信前失敗', unknown: '結果不明', blocked: '外部制限' };
  const VERDICT_JA = { adopt: '採用', hold: '保留', reject: '不採用' };
  const BK = { external_limit: '外部制限', auth: '認証切れ・認証要求', permission_unknown: '権限不明（403）' };
  let state = null; let lastCollect = null; let previewCache = [];
  async function api(method, path, body) { const res = await fetch(path, { method, headers: { 'content-type': 'application/json', 'x-note-tool': '1' }, body: body ? JSON.stringify(body) : undefined }); const json = await res.json().catch(() => ({})); if (!res.ok) throw new Error(json.error || res.statusText); return json; }
  function dialog(title, obj) { $('dlg-title').textContent = title; $('dlg-body').textContent = JSON.stringify(obj, null, 2); $('dlg').showModal(); }
  $('dlg-close').onclick = () => $('dlg').close();
  const stat = (label, value) => `<div class="stat"><b>${esc(value ?? '-')}</b><span>${esc(label)}</span></div>`;
  function poolHtml(name, l) {
    return `<b>${name}</b>: 内部 ${l.credits ?? '未設定'}/${l.capacity ?? '未設定'}（${l.recoveryIntervalMin ?? '-'}分ごとに +${l.recoveryAmount ?? '-'}、次回 ${fmt(l.nextRefillAt)}${l.emptySince ? `、残数0の起点 ${fmt(l.emptySince)}` : ''}）、日次残 ${l.dailyAvailable ?? '-'}/${l.dailyLimit ?? '未設定'}（本日 ${l.usedToday}、JST ${l.dayKey || ''}）、時間残 ${l.hourlyAvailable ?? '-'}/${l.hourlyLimit ?? '未設定'}（直近1時間 ${l.usedLastHour}）、引当 ${l.holds} → <b>有効残数 ${l.effective ?? '-'}</b>${l.valid ? '' : ` <span class="err">${esc(l.validity.message)}</span>`}<br><span class="muted">区分: ${esc(Object.entries(l.labels || {}).map(([k, v]) => `${k}=${v}`).join('、'))}</span>`;
  }
  function renderHeader() {
    $('f-adapter').textContent = `接続: ${state.adapter.name === 'mock' ? 'モック（実noteに接続しない）' : '実note（CDP）'}`;
    $('f-fb').textContent = `フォロー返し: ${state.flags.followBackEnabled ? 'ON' : 'OFF（初期状態。候補の確認のみ）'}`; $('f-fb').className = `flag ${state.flags.followBackEnabled ? 'on' : 'off'}`;
    $('f-real').textContent = `実アクション: ${state.flags.enableRealActions ? 'ON' : 'OFF'}`; $('f-real').className = `flag ${state.flags.enableRealActions ? 'on' : 'off'}`;
    $('f-sched').textContent = `定期実行: ${state.flags.schedulerEnabled ? 'ON' : 'OFF'}`; $('f-sched').className = `flag ${state.flags.schedulerEnabled ? 'on' : 'off'}`;
    $('f-lock').textContent = `実行ロック: ${state.executorLock ? state.executorLock.holder : 'なし'}`;
    $('f-now').textContent = `DB: ${state.dbPath}　${fmt(state.now)}`;
    $('refill-note').textContent = state.configValues.refillNote || '';
  }
  function renderAccounts() {
    const box = $('accounts'); box.innerHTML = '';
    for (const a of state.accounts) {
      const card = document.createElement('div'); card.className = `card${a.id === state.selectedAccountId ? ' selected' : ''}`;
      const blk = a.block ? `<span class="err">${esc(BK[a.block.kind] || a.block.kind)}: ${esc(a.block.message)}（内部回復では解除されない） <button data-clear="${a.id}">解除を確認した</button></span>` : '<span class="ok">外部制限・認証切れなし</span>';
      card.innerHTML = `<h3><span>${esc(a.name)} <span class="muted">${esc(a.url)}</span></span><button data-select="${a.id}" ${a.id === state.selectedAccountId ? 'disabled' : ''}>選択</button></h3>
        <dl class="kv">
          <dt>接続</dt><dd>port ${a.cdpPort} <button data-verify="${a.id}">ログインID照合</button> <span id="sess-${a.id}" class="muted"></span></dd>
          <dt>owner</dt><dd>${a.assigned} 人（follow: 候補 ${a.targets.candidate} / 成功 ${a.targets.succeeded} / 見送り ${a.targets.skipped} / 結果不明 ${a.targets.unknown} / 送信前失敗 ${a.targets.failed_before_send} / 外部制限 ${a.targets.blocked}）</dd>
          <dt>送信</dt><dd>試行 ${a.attempts.attempted} / 成功 ${a.attempts.succeeded} / 結果不明 ${a.attempts.unknown} / 失敗 ${a.attempts.failed}（ドライラン ${a.attempts.dry_run}）</dd>
          <dt>follow 枠</dt><dd>${poolHtml('follow_back', a.pools.follow_back)} <button data-limits="${a.id}" data-op="follow_back">設定</button></dd>
          <dt>like 枠</dt><dd>${poolHtml('like', a.pools.like)} <button data-limits="${a.id}" data-op="like">設定</button></dd>
          <dt>制限</dt><dd>${blk}</dd>
          <dt>開始不可の理由</dt><dd>${a.startReasons.length ? a.startReasons.map((r) => `<span class="badge reject">${esc(r.code)}</span> ${esc(r.message)}`).join('<br>') : '<span class="ok">なし</span>'}</dd>
        </dl>`;
      box.appendChild(card);
    }
    box.querySelectorAll('[data-select]').forEach((b) => { b.onclick = async () => { await api('POST', '/api/account', { id: b.dataset.select }); refresh(); }; });
    box.querySelectorAll('[data-verify]').forEach((b) => { b.onclick = async () => { const r = await api('POST', '/api/session/verify', { accountId: b.dataset.verify }); const el = $(`sess-${b.dataset.verify}`); el.textContent = `${r.ok ? '一致' : '不一致/未取得'}: ${r.message}`; el.className = r.ok ? 'ok' : 'err'; }; });
    box.querySelectorAll('[data-clear]').forEach((b) => { b.onclick = async () => { if (confirm('外部制限・認証切れが解除されたことを確認しましたか？')) { await api('POST', `/api/limits/${b.dataset.clear}/clear-block`); refresh(); } }; });
    box.querySelectorAll('[data-limits]').forEach((b) => { b.onclick = async () => {
      const a = state.accounts.find((x) => x.id === b.dataset.limits); const op = b.dataset.op; const l = a.pools[op];
      const daily = prompt(`${op} 日次上限（JST の日付）${op === 'like' ? '。教材の200件/日は参考値で公式の保証値ではない' : '。like の値を流用しない'}`, l.dailyLimit ?? ''); if (daily === null) return;
      const hourly = prompt(`${op} 直近1時間の上限`, l.hourlyLimit ?? ''); if (hourly === null) return;
      const cap = prompt(`${op} 内部 credits の容量上限`, l.capacity ?? ''); if (cap === null) return;
      const credits = prompt(`${op} 現在の内部残数（初期値。空欄なら容量と同じ）`, l.credits ?? ''); if (credits === null) return;
      const interval = prompt('回復間隔（分。既定20。アプリ内の規則で note 公式の制限ではない）', l.recoveryIntervalMin ?? 20); if (interval === null) return;
      const amt = prompt('回復量（区間ごと。既定1）', l.recoveryAmount ?? 1); if (amt === null) return;
      await api('POST', `/api/limits/${a.id}/${op}`, { dailyLimit: daily, hourlyLimit: hourly, capacity: cap, credits: credits === '' ? undefined : credits, recoveryIntervalMin: interval, recoveryAmount: amt });
      refresh();
    }; });
  }
  function renderConfig() {
    $('cfg-fb').checked = !!state.flags.followBackEnabled; $('cfg-real').checked = !!state.flags.enableRealActions; $('cfg-stop-unknown').checked = !!state.flags.stopOnUnknown;
    $('criteria').innerHTML = state.criteria.map((c) => `<li><b>${esc(c.id)}</b> ${esc(c.text)}<br><span class="src">出典: ${esc(c.source)}／区分: ${esc(c.kind)}</span></li>`).join('');
  }
  $('cfg-fb').onchange = async (e) => { if (e.target.checked && !confirm('フォロー返しを有効にします。開始時に「ドライラン」を外し、実アクションが ON の場合のみ実際にフォローします。よろしいですか？')) { e.target.checked = false; return; } await api('POST', '/api/config', { followBackEnabled: e.target.checked }); refresh(); };
  $('cfg-real').onchange = async (e) => { if (e.target.checked && !confirm('実アカウントでの送信を有効にします。よろしいですか？')) { e.target.checked = false; return; } await api('POST', '/api/config', { enableRealActions: e.target.checked }); refresh(); };
  $('cfg-stop-unknown').onchange = async (e) => { await api('POST', '/api/config', { stopOnUnknown: e.target.checked }); refresh(); };
  function renderCollect() {
    const c = lastCollect || (state.recentCollections[0] ? { stats: state.recentCollections[0].stats } : null);
    if (!c || !c.stats) { $('collect-stats').innerHTML = '<span class="muted">まだ収集していません</span>'; return; }
    const s = c.stats;
    $('collect-stats').innerHTML = stat('フォロワー一覧', s.listedTotal) + stat('全件取得', s.followersComplete ? 'はい' : 'いいえ') + stat('新規', s.newPersons) + stat('重複除外', s.duplicatesExcluded) + stat('採用可', s.adoptable) + stat('保留（未確認等）', s.held) + stat('不採用', s.rejected) + stat('他owner競合', s.ownerConflicts) + stat('活動条件不合格', s.activityFailed) + stat('既にフォロー中', s.alreadyFollowing) + stat('未確認', s.unverified) + stat('実行可能', s.executable);
  }
  $('collect').onclick = async () => { $('collect-msg').textContent = '収集中...'; try { lastCollect = await api('POST', '/api/collect', {}); $('collect-msg').textContent = lastCollect.stopped ? `停止: ${lastCollect.message}` : '完了'; } catch (e) { $('collect-msg').textContent = e.message; } refresh(); };
  function renderPlan() {
    $('plan').querySelector('tbody').innerHTML = state.plan.map((p, i) => `<tr><td>${i + 1}</td><td><a href="${esc(p.profileUrl)}" target="_blank" rel="noopener">${esc(p.displayName || p.urlname)}</a><br><span class="muted">${esc(p.urlname)}</span></td><td>${esc(p.userId)}</td><td>${fmt(p.latestNotePublishedAt)}</td><td>${p.relationship ? `相手→自分 ${p.relationship.targetFollowsMe === true ? 'フォロー中' : p.relationship.targetFollowsMe === false ? '未' : '不明'} / 自分→相手 ${p.relationship.iFollowTarget === true ? 'フォロー中' : p.relationship.iFollowTarget === false ? '未' : '不明'}<br><span class="muted">${esc(p.relationship.evidence || '')}</span>` : '不明'}</td><td>${esc(p.reasons.filter((r) => r.level === 'info').map((r) => r.message).join('；') || '条件を満たす')}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">実行可能な対象がありません（対象不足のときは件数未達で終了し、補充しません）</td></tr>';
  }
  function renderRun() {
    const r = state.runner; const running = r.state === 'running' || r.state === 'paused' || r.state === 'stopping';
    $('run-start').disabled = running; $('run-pause').disabled = r.state !== 'running'; $('run-resume').disabled = r.state !== 'paused'; $('run-stop').disabled = !running;
    let txt = `状態: ${({ idle: '待機中', running: '実行中', paused: '一時停止', stopping: '停止処理中' })[r.state] || r.state}`;
    if (r.current) txt += `　run ${r.current.runId}（${r.current.dryRun ? 'ドライラン' : '実送信'}）` + (r.current.currentTarget ? `　処理中: ${r.current.currentTarget.urlname}` : '');
    if (r.waitReason) txt += `　待機理由: ${r.waitReason}`;
    if (!r.current && r.lastRun) txt += `　前回: ${r.lastRun.runId} 停止理由=${r.lastRun.stopReason}`;
    $('run-status').textContent = txt;
    const s = r.summary || (r.lastRun && r.lastRun.summary);
    $('run-summary').innerHTML = s ? stat('予定件数', s.planned ?? '指定なし') + stat('候補', s.considered) + stat('処理', s.processed) + stat('成功', s.succeeded) + stat('既にフォロー中', s.alreadyDone) + stat('結果不明', s.unknown) + stat('送信前失敗', s.failedBeforeSend) + stat('見送り', s.skipped) + stat('外部制限', s.blocked) + stat('ドライラン対象', s.dryRunWouldAct) + stat('未達', s.shortfall ?? '-') + stat('停止理由', s.stopReason ?? '-') : '';
  }
  $('run-start').onclick = async () => { const dryRun = $('run-dry').checked; if (!dryRun && !confirm('ドライランが外れています。実アカウントで実際にフォローします。開始しますか？')) return; try { const r = await api('POST', '/api/run/start', { dryRun, maxCount: $('run-max').value || null }); if (!r.started) alert(`開始できません: ${r.message}`); } catch (e) { alert(e.message); } refresh(); };
  $('run-pause').onclick = async () => { await api('POST', '/api/run/pause'); refresh(); };
  $('run-resume').onclick = async () => { await api('POST', '/api/run/resume'); refresh(); };
  $('run-stop').onclick = async () => { await api('POST', '/api/run/stop'); refresh(); };
  async function renderPreview() {
    try { previewCache = await api('GET', '/api/preview'); } catch (e) { return; }
    const rel = (r) => r.relationship ? `相手→自分 ${r.relationship.targetFollowsMe === true ? '中' : r.relationship.targetFollowsMe === false ? '未' : '不明'} / 自分→相手 ${r.relationship.iFollowTarget === true ? '中' : r.relationship.iFollowTarget === false ? '未' : '不明'}` : '不明';
    $('preview').querySelector('tbody').innerHTML = previewCache.map((r) => `<tr><td><a href="${esc(r.profileUrl)}" target="_blank" rel="noopener">${esc(r.urlname)}</a><br><span class="muted">${esc(r.displayName)}</span></td><td>${esc(r.userId || '不明')}</td><td>${esc(r.followerOf)}</td><td>${esc(rel(r))}</td><td>${fmt(r.latestNotePublishedAt)}<br><span class="muted">${esc(r.latestNoteEvidence)}</span></td><td>${esc(r.owner)}${r.ownerConflict ? `<br><span class="err">競合: ${esc(r.ownerConflict)}</span>` : ''}</td><td><span class="badge ${esc(r.likeState)}">${esc(STATE_JA[r.likeState] || r.likeState || '-')}</span></td><td><span class="badge ${esc(r.followState)}">${esc(STATE_JA[r.followState] || r.followState || '-')}</span><br><span class="muted">${esc(r.followReason)}</span></td><td><span class="badge ${esc(r.verdict)}">${esc(VERDICT_JA[r.verdict] || r.verdict)}</span><br><span class="muted">${esc(r.reasons.filter((x) => x.level !== 'info').map((x) => x.message).join('；'))}</span></td><td><button data-why="${r.personId}">理由</button></td></tr>`).join('');
    document.querySelectorAll('#preview [data-why]').forEach((b) => { b.onclick = async () => dialog(`なぜ選ばれたか（台帳ID ${b.dataset.why}）`, await api('GET', `/api/explain/${b.dataset.why}`)); });
    const unk = previewCache.filter((r) => r.followState === 'unknown');
    $('unknown').querySelector('tbody').innerHTML = unk.map((r) => `<tr><td>${esc(r.urlname)}</td><td>${esc(r.owner)}</td><td>${esc(r.followReason)}</td><td><button data-resolve="${r.personId}">サイト状態を照合して確定</button></td></tr>`).join('') || '<tr><td colspan="4" class="muted">結果不明の対象はありません</td></tr>';
    document.querySelectorAll('#unknown [data-resolve]').forEach((b) => { b.onclick = async () => { const r = await api('POST', `/api/unknown/${b.dataset.resolve}/resolve`, {}); alert(`照合結果: ${r.siteState || r.code} → ${r.state || r.code}`); refresh(); }; });
  }
  $('export').onclick = async () => { try { const r = await api('POST', '/api/export'); $('export-msg').textContent = `出力: ${r.files.rosterCsv}`; } catch (e) { $('export-msg').textContent = e.message; } };
  function renderEvents() { $('events').textContent = state.events.map((e) => `${fmt(e.at)} [${e.level}] ${e.accountId || '-'} ${e.code}: ${e.message}`).join('\n'); }
  async function refresh() { try { state = await api('GET', '/api/state'); } catch (e) { $('run-status').textContent = `サーバーに接続できません: ${e.message}`; return; } renderHeader(); renderAccounts(); renderConfig(); renderCollect(); renderPlan(); renderRun(); renderEvents(); await renderPreview(); }
  refresh(); setInterval(refresh, 2000);
})();
