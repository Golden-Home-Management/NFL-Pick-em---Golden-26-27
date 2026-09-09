/* GHM Football Pool - commissioner console. */
'use strict';

const A = { state: null, week: null, weekNumber: null };

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );

async function api(path, options = {}) {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: options.body ? { 'Content-Type': 'application/json' } : {},
    ...options,
  });
  let data = {};
  try { data = await res.json(); } catch {}
  if (!res.ok) { const e = new Error(data.error || `Request failed (${res.status})`); e.status = res.status; throw e; }
  return data;
}

let toastTimer;
function toast(msg, kind = '') {
  const el = $('toast');
  el.textContent = msg;
  el.className = `toast ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), kind === 'error' ? 6000 : 2800);
}
/** Transient result of the last action. */
function notice(html, kind = '') {
  $('adminNotice').innerHTML = html ? `<div class="notice ${kind}">${html}</div>` : '';
}

/** Persistent configuration warning; kept separate so actions cannot wipe it. */
function configNotice(html, kind = '') {
  $('adminConfigNotice').innerHTML = html ? `<div class="notice ${kind}">${html}</div>` : '';
}

/** Run an action, show a spinner-ish disabled state, refresh, report errors. */
async function act(button, fn, successMessage) {
  const el = typeof button === 'string' ? $(button) : button;
  if (el) el.disabled = true;
  try {
    const out = await fn();
    await refresh();
    if (successMessage) toast(typeof successMessage === 'function' ? successMessage(out) : successMessage);
    return out;
  } catch (err) {
    toast(err.message, 'error');
    if (err.status === 401) location.reload();
  } finally {
    if (el) el.disabled = false;
  }
}

/* ------------------------------------------------------- datetime helpers */

/** ISO UTC -> value for <input type="datetime-local"> in Central time. */
function isoToLocalInput(iso) {
  if (!iso) return '';
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(iso)).reduce((o, x) => (x.type !== 'literal' ? ((o[x.type] = x.value), o) : o), {});
  const hour = p.hour === '24' ? '00' : p.hour;
  return `${p.year}-${p.month}-${p.day}T${hour}:${p.minute}`;
}

/** Central wall clock from a datetime-local input -> ISO UTC. */
function localInputToIso(value) {
  if (!value) return null;
  const [date, time] = value.split('T');
  const [h, m] = time.split(':').map(Number);
  // Find the UTC instant whose Central rendering matches the entered wall clock.
  let guess = new Date(`${date}T${time}:00Z`);
  for (let i = 0; i < 2; i += 1) {
    const shown = isoToLocalInput(guess.toISOString());
    if (shown === value) break;
    const diff = new Date(`${value}:00Z`) - new Date(`${shown}:00Z`);
    guess = new Date(guess.getTime() + diff);
  }
  return guess.toISOString();
}

function ctTime(iso) {
  return new Date(iso).toLocaleString('en-US', {
    timeZone: 'America/Chicago', weekday: 'short', hour: 'numeric', minute: '2-digit',
  });
}

/* --------------------------------------------------------------- rendering */

function renderWeekPicker() {
  const s = A.state;
  $('weekSelect').innerHTML = s.weeks
    .map((w) => `<option value="${w.number}" ${w.number === A.weekNumber ? 'selected' : ''}>Week ${w.number} — ${w.status}</option>`)
    .join('') || '<option value="">No weeks yet</option>';
  const w = s.weeks.find((x) => x.number === A.weekNumber);
  if (w) {
    $('sundayDate').value = w.sundayDate || '';
    $('saturdayDate').value = w.saturdayDate || '';
    $('weekStatus').innerHTML = `Status: <strong>${esc(w.status)}</strong> ·
      ${w.nflCount} NFL · ${w.collegeCount} college · ${w.scored} scored
      ${w.linesLockedLabel ? `<br>Lines locked ${esc(w.linesLockedLabel)} — source: ${esc(w.lineSource || '')}` : '<br>Lines not locked yet.'}`;
  } else {
    $('weekStatus').textContent = 'No week selected. Press Start Next Week.';
  }
  $('adminSub').textContent = A.weekNumber ? `Week ${A.weekNumber}` : 'No week yet';
  $('strikeRule').value = String(s.settings.strikeRule);
  $('poolNameInput').value = s.settings.poolName;
  configNotice(
    s.oddsApiConfigured
      ? ''
      : '<strong>ODDS_API_KEY is not set on the server.</strong> Imports and auto-scores will fail; enter games, spreads and scores manually until you add the key.',
    'error'
  );
}

function gameRow(g, published) {
  return `<tr data-game="${esc(g.id)}">
    <td style="white-space:nowrap">${esc(g.kickoffLabel)}</td>
    <td>${esc(g.awayLabel || g.awayTeam)} <span style="color:#4A4E55">@</span> ${esc(g.homeLabel || g.homeTeam)}
      ${g.spreadManual ? '<br><span style="font-size:10px;color:#9A4A12">MANUAL LINE</span>' : ''}</td>
    <td class="num">
      <input class="spread-input" type="number" step="0.5" value="${g.spread ?? ''}" data-spread="${esc(g.id)}"
        title="Home spread (negative = home favoured)">
    </td>
    <td style="font-size:11px;white-space:nowrap">${esc(g.spreadSource || '—')}</td>
    <td class="num" style="font-size:11px">${g.pickPct && g.pickPct.total ? `${g.pickPct.awayPct}/${g.pickPct.homePct}` : '—'}</td>
    <td><button class="btn small ghost" data-remove="${esc(g.id)}" ${published ? 'disabled' : ''}>&times;</button></td>
  </tr>`;
}

function renderGames() {
  const w = A.week;
  if (!w) {
    $('nflTable').innerHTML = '<div class="empty">No week loaded.</div>';
    $('collegeSelected').innerHTML = '';
    $('collegeCandidates').innerHTML = '';
    $('scoreTable').innerHTML = '';
    $('pickMatrix').innerHTML = '';
    return;
  }
  const published = w.status !== 'draft';
  const head = `<table><thead><tr><th>Kickoff</th><th>Matchup</th><th class="num">Home spread</th><th>Book</th><th class="num">A/H %</th><th></th></tr></thead><tbody>`;

  $('nflTable').innerHTML = w.nfl.length
    ? head + w.nfl.map((g) => gameRow(g, published)).join('') + '</tbody></table>'
    : '<div class="empty">No Sunday NFL games yet.</div>';

  $('collegeSelected').innerHTML = w.college.length
    ? head + w.college.map((g) => gameRow(g, published)).join('') + '</tbody></table>'
    : '<div class="empty">No college games selected.</div>';

  const selected = new Set(w.college.map((g) => g.id));
  $('collegeCandidates').innerHTML = (w.collegeCandidates || []).length
    ? w.collegeCandidates
        .map(
          (g, i) => `<div><label style="display:flex;gap:8px;align-items:center;cursor:pointer">
        <input type="checkbox" data-cand="${esc(g.id)}" ${selected.has(g.id) ? 'checked' : ''} ${published ? 'disabled' : ''}>
        <span>${i < 3 ? '⭐ ' : ''}${esc(g.awayTeam)} @ ${esc(g.homeTeam)} · ${esc(g.kickoffLabel)} · ${g.spread ?? '—'} · score ${g.suggestionScore ?? '—'}</span>
      </label></div>`
        )
        .join('')
    : '<div style="padding:10px">No candidates loaded. Press "Re-suggest College".</div>';

  const all = [...w.college, ...w.nfl];
  $('scoreTable').innerHTML = all.length
    ? `<table><thead><tr><th>Matchup</th><th class="num">Away</th><th class="num">Home</th><th>Source</th><th></th></tr></thead><tbody>` +
      all
        .map(
          (g) => `<tr>
            <td>${esc(g.awayTeam)} @ ${esc(g.homeTeam)}</td>
            <td class="num"><input class="score-input" type="number" min="0" data-away-score="${esc(g.id)}" value="${g.final ? g.final.awayScore : ''}"></td>
            <td class="num"><input class="score-input" type="number" min="0" data-home-score="${esc(g.id)}" value="${g.final ? g.final.homeScore : ''}"></td>
            <td style="font-size:11px">${g.final ? esc(g.final.source) : '—'}</td>
            <td><button class="btn small ghost" data-save-score="${esc(g.id)}">Save</button></td>
          </tr>`
        )
        .join('') +
      '</tbody></table>'
    : '<div class="empty">No games to score.</div>';

  // Pick matrix - one column per game, plus the survivor pick.
  const cols = all;
  $('pickMatrix').innerHTML = `<table><thead><tr><th>Player</th><th>Survivor</th>${cols
    .map((g) => `<th style="font-size:9px">${esc(g.awayTeam.split(' ').pop())}<br>@${esc(g.homeTeam.split(' ').pop())}</th>`)
    .join('')}</tr></thead><tbody>${w.picks
    .map(
      (p) => `<tr><td style="white-space:nowrap">${esc(p.name)}</td>
      <td><input type="text" list="nflTeamList" style="min-width:130px;min-height:34px;padding:4px 6px"
        data-survivor="${esc(p.participantId)}" value="${esc(p.survivor ? p.survivor.team : '')}"></td>
      ${cols
        .map((g) => {
          const pick = p.picks.find((x) => x.gameId === g.id);
          const side = pick ? pick.side : '';
          return `<td><select data-pick="${esc(p.participantId)}" data-pick-game="${esc(g.id)}" style="min-width:78px;min-height:34px;padding:2px 4px;font-size:11px">
            <option value="" ${!side ? 'selected' : ''}>—</option>
            <option value="away" ${side === 'away' ? 'selected' : ''}>${esc(g.awayTeam.split(' ').pop())}</option>
            <option value="home" ${side === 'home' ? 'selected' : ''}>${esc(g.homeTeam.split(' ').pop())}</option>
          </select></td>`;
        })
        .join('')}</tr>`
    )
    .join('')}</tbody></table>
    <datalist id="nflTeamList">${w.nfl
      .flatMap((g) => [g.awayTeam, g.homeTeam])
      .map((t) => `<option value="${esc(t)}">`)
      .join('')}</datalist>`;

  $('survivorLock').value = isoToLocalInput(w.survivorLockAt);
}

function renderParticipants() {
  const origin = location.origin;
  $('participantTable').innerHTML = `<table><thead><tr><th>Name</th><th>PIN</th><th>Personal link</th><th>Active</th><th></th></tr></thead><tbody>${A.state.participants
    .map(
      (p) => `<tr>
      <td><input type="text" data-pname="${esc(p.id)}" value="${esc(p.name)}" style="min-height:34px;padding:4px 6px"></td>
      <td style="font-family:var(--font-mono)">${esc(p.pin)}</td>
      <td style="font-size:10.5px;word-break:break-all">
        <a href="${origin}/?p=${esc(p.token)}">${origin}/?p=${esc(p.token)}</a>
      </td>
      <td><input type="checkbox" data-pactive="${esc(p.id)}" ${p.active ? 'checked' : ''}></td>
      <td style="white-space:nowrap">
        <button class="btn small ghost" data-reset-pin="${esc(p.id)}">New PIN</button>
        <button class="btn small ghost" data-reset-link="${esc(p.id)}">New link</button>
      </td>
    </tr>`
    )
    .join('')}</tbody></table>
    <div style="padding:10px 14px"><button class="btn small ghost" id="saveParticipantsBtn">Save names &amp; active flags</button></div>`;
}

function renderAudit() {
  $('auditLog').innerHTML = A.state.audit.length
    ? A.state.audit
        .map(
          (a) => `<div>${esc(ctTime(a.at))} · <strong>${esc(a.action)}</strong> · ${esc(
            typeof a.detail === 'object' && a.detail !== null ? JSON.stringify(a.detail) : String(a.detail ?? '')
          ).slice(0, 220)}</div>`
        )
        .join('')
    : '<div>No activity yet.</div>';
}

/* ------------------------------------------------------------------ loader */

async function refresh() {
  A.state = await api('/api/admin/state');
  if (!A.weekNumber || !A.state.weeks.some((w) => w.number === A.weekNumber)) {
    A.weekNumber = A.state.currentWeek || (A.state.weeks.length ? A.state.weeks[A.state.weeks.length - 1].number : null);
  }
  A.week = A.weekNumber ? await api(`/api/admin/week?week=${A.weekNumber}`) : null;
  renderWeekPicker();
  renderGames();
  renderParticipants();
  renderAudit();
}

/* ------------------------------------------------------------------ events */

$('adminLoginBtn').onclick = async () => {
  const err = $('adminLoginError');
  err.classList.add('hidden');
  try {
    await api('/api/admin/login', { method: 'POST', body: JSON.stringify({ pin: $('adminPin').value }) });
    $('adminPin').value = '';
    await start();
  } catch (e) {
    err.textContent = e.message;
    err.classList.remove('hidden');
  }
};
$('adminPin').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('adminLoginBtn').click(); });

$('adminLogoutBtn').onclick = async () => {
  await api('/api/admin/logout', { method: 'POST' });
  location.reload();
};

$('weekSelect').onchange = async (e) => {
  A.weekNumber = Number(e.target.value);
  await refresh();
};

$('startWeekBtn').onclick = async () => {
  const out = await act('startWeekBtn', async () => {
    const body = {};
    if ($('sundayDate').value && A.state.weeks.length === 0) body.sundayDate = $('sundayDate').value;
    const res = await api('/api/admin/week/start', { method: 'POST', body: JSON.stringify(body) });
    A.weekNumber = res.week;
    return res;
  }, 'Week started');
  if (out) {
    const failed = out.notes.some((n) => /failed/i.test(n));
    notice(`<strong>Week ${out.week} ready to review.</strong><br>${out.notes.map(esc).join('<br>')}`, failed ? 'error' : 'ok');
  }
};

$('importNflBtn').onclick = () =>
  act('importNflBtn', () => api('/api/admin/week/import-nfl', { method: 'POST', body: JSON.stringify({ week: A.weekNumber }) }),
    (r) => `Imported ${r.count} Sunday NFL games`);

$('collegeSuggestBtn').onclick = () =>
  act('collegeSuggestBtn', () => api('/api/admin/week/college-suggestions', { method: 'POST', body: JSON.stringify({ week: A.weekNumber }) }),
    (r) => `${r.count} Saturday college games ranked`);

$('refreshLinesBtn').onclick = async () => {
  const r = await act('refreshLinesBtn',
    () => api('/api/admin/week/refresh-lines', { method: 'POST', body: JSON.stringify({ week: A.weekNumber }) }),
    (out) => `${out.changed} line(s) updated, ${out.missing} still missing`);
  if (r && r.errors && r.errors.length) notice(r.errors.map(esc).join('<br>'), 'error');
};

$('publishBtn').onclick = () =>
  act('publishBtn', () => api('/api/admin/week/publish', { method: 'POST', body: JSON.stringify({ week: A.weekNumber }) }),
    (r) => `Week ${r.week} published — lines frozen (${r.lineSource})`);

$('unlockBtn').onclick = () => {
  const reason = prompt('Why are you unlocking this week? (recorded in the audit log)');
  if (reason === null) return;
  return act('unlockBtn', () => api('/api/admin/week/unlock', { method: 'POST', body: JSON.stringify({ week: A.weekNumber, reason }) }), 'Week unlocked');
};

$('completeBtn').onclick = () =>
  act('completeBtn', () => api('/api/admin/week/complete', { method: 'POST', body: JSON.stringify({ week: A.weekNumber }) }), 'Week marked complete');

$('fetchScoresBtn').onclick = async () => {
  const r = await act('fetchScoresBtn',
    () => api('/api/admin/week/fetch-scores', { method: 'POST', body: JSON.stringify({ week: A.weekNumber }) }),
    (out) => `${out.applied} final score(s) applied, ${out.pending} still pending`);
  if (r && r.errors && r.errors.length) notice(r.errors.map(esc).join('<br>'), 'error');
};

$('saveCollegeBtn').onclick = () => {
  const ids = [...document.querySelectorAll('[data-cand]:checked')].map((el) => el.dataset.cand);
  if (ids.length !== 3) { toast('Pick exactly 3 college games', 'error'); return; }
  return act('saveCollegeBtn', () => api('/api/admin/week/select-college', { method: 'POST', body: JSON.stringify({ week: A.weekNumber, gameIds: ids }) }), 'College games saved');
};

$('saveSettingsBtn').onclick = () =>
  act('saveSettingsBtn', () => api('/api/admin/settings', {
    method: 'POST',
    body: JSON.stringify({ strikeRule: Number($('strikeRule').value), poolName: $('poolNameInput').value }),
  }), 'Settings saved');

$('saveDeadlineBtn').onclick = () =>
  act('saveDeadlineBtn', () => api('/api/admin/week/deadlines', {
    method: 'POST',
    body: JSON.stringify({ week: A.weekNumber, survivorLockAt: localInputToIso($('survivorLock').value) }),
  }), 'Deadline saved');

$('addGameBtn').onclick = () =>
  act('addGameBtn', () => api('/api/admin/game/add', {
    method: 'POST',
    body: JSON.stringify({
      week: A.weekNumber,
      sport: $('mgSport').value,
      awayTeam: $('mgAway').value,
      homeTeam: $('mgHome').value,
      commenceTime: localInputToIso($('mgTime').value),
      spread: $('mgSpread').value,
    }),
  }), 'Game added');

$('addParticipantBtn').onclick = () => {
  const name = $('newParticipant').value.trim();
  if (!name) return;
  return act('addParticipantBtn', async () => {
    await api('/api/admin/participants', { method: 'POST', body: JSON.stringify({ addName: name }) });
    $('newParticipant').value = '';
  }, 'Participant added');
};

document.addEventListener('click', async (e) => {
  const save = e.target.closest('[data-save-score]');
  if (save) {
    const id = save.dataset.saveScore;
    const home = document.querySelector(`[data-home-score="${CSS.escape(id)}"]`).value;
    const away = document.querySelector(`[data-away-score="${CSS.escape(id)}"]`).value;
    return act(save, () => api('/api/admin/game/score', {
      method: 'POST',
      body: JSON.stringify({ week: A.weekNumber, gameId: id, homeScore: home, awayScore: away }),
    }), 'Score saved');
  }

  const remove = e.target.closest('[data-remove]');
  if (remove) {
    if (!confirm('Remove this game from the week? Any picks on it are deleted.')) return;
    return act(remove, () => api('/api/admin/game/remove', {
      method: 'POST', body: JSON.stringify({ week: A.weekNumber, gameId: remove.dataset.remove }),
    }), 'Game removed');
  }

  const resetPin = e.target.closest('[data-reset-pin]');
  if (resetPin) {
    return act(resetPin, () => api('/api/admin/participants', {
      method: 'POST', body: JSON.stringify({ participants: [{ id: resetPin.dataset.resetPin, resetPin: true }] }),
    }), 'New PIN issued');
  }

  const resetLink = e.target.closest('[data-reset-link]');
  if (resetLink) {
    return act(resetLink, () => api('/api/admin/participants', {
      method: 'POST', body: JSON.stringify({ participants: [{ id: resetLink.dataset.resetLink, resetLink: true }] }),
    }), 'New personal link issued');
  }

  if (e.target.id === 'saveParticipantsBtn') {
    const updates = [...document.querySelectorAll('[data-pname]')].map((input) => ({
      id: input.dataset.pname,
      name: input.value,
      active: document.querySelector(`[data-pactive="${CSS.escape(input.dataset.pname)}"]`).checked,
    }));
    return act(e.target, () => api('/api/admin/participants', { method: 'POST', body: JSON.stringify({ participants: updates }) }), 'Participants saved');
  }
});

document.addEventListener('change', async (e) => {
  const spread = e.target.closest('[data-spread]');
  if (spread) {
    return act(null, () => api('/api/admin/game/spread', {
      method: 'POST',
      body: JSON.stringify({ week: A.weekNumber, gameId: spread.dataset.spread, spread: spread.value, reason: 'admin edit' }),
    }), 'Line updated');
  }

  const pick = e.target.closest('[data-pick]');
  if (pick) {
    return act(null, () => api('/api/admin/pick-override', {
      method: 'POST',
      body: JSON.stringify({ week: A.weekNumber, participantId: pick.dataset.pick, gameId: pick.dataset.pickGame, side: pick.value }),
    }), 'Pick overridden');
  }

  const surv = e.target.closest('[data-survivor]');
  if (surv) {
    return act(null, () => api('/api/admin/survivor-override', {
      method: 'POST',
      body: JSON.stringify({ week: A.weekNumber, participantId: surv.dataset.survivor, team: surv.value }),
    }), 'Survivor pick overridden');
  }

  if (e.target.id === 'sundayDate' || e.target.id === 'saturdayDate') {
    return act(null, () => api('/api/admin/week/start', {
      method: 'POST',
      body: JSON.stringify({ week: A.weekNumber, sundayDate: $('sundayDate').value, saturdayDate: $('saturdayDate').value }),
    }), 'Dates updated');
  }
});

/* -------------------------------------------------------------------- boot */

async function start() {
  try {
    await refresh();
    $('adminLogin').classList.add('hidden');
    $('adminApp').classList.remove('hidden');
  } catch (err) {
    if (err.status === 401) {
      $('adminLogin').classList.remove('hidden');
      $('adminApp').classList.add('hidden');
    } else {
      notice(esc(err.message), 'error');
    }
  }
}

start();
