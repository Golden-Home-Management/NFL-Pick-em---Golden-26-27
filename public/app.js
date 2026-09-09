/* GHM Football Pool - participant app. Vanilla JS, no build step. */
'use strict';

const state = {
  boot: null,
  week: null,
  weekNumber: null,
  pending: {},      // gameId -> side, not yet submitted
  survivor: null,
  survivorPending: null,
  tab: 'picks',
};

/* ------------------------------------------------------------------ utils */

const $ = (id) => document.getElementById(id);

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

function fmtSpread(n) {
  if (n === null || n === undefined) return 'PK';
  if (n === 0) return 'PK';
  return n > 0 ? `+${n}` : String(n);
}

function fmtPoints(n) {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: options.body ? { 'Content-Type': 'application/json' } : {},
    ...options,
  });
  let data = {};
  try { data = await res.json(); } catch { /* non-JSON error page */ }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

let toastTimer = null;
function toast(message, kind = '') {
  const el = $('toast');
  el.textContent = message;
  el.className = `toast ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), kind === 'error' ? 5200 : 2600);
}

function notice(html, kind = '') {
  $('globalNotice').innerHTML = html ? `<div class="notice ${kind}">${html}</div>` : '';
}

/* ----------------------------------------------------------------- render */

function renderHeader() {
  const b = state.boot;
  $('poolName').textContent = b.poolName;
  $('weekLabel').textContent = state.weekNumber ? `Week ${state.weekNumber} · ${b.season}` : `${b.season} Season`;
  const who = $('whoami');
  if (b.me) {
    who.innerHTML = `<strong>${esc(b.me.name)}</strong><button id="signOut">Not you?</button>`;
    $('signOut').onclick = async () => {
      await api('/api/logout', { method: 'POST' });
      location.href = location.pathname;
    };
  } else {
    who.innerHTML = '';
  }
}

function gameCard(g, opts = {}) {
  const selected = state.pending[g.id] !== undefined ? state.pending[g.id] : g.myPick;
  const dirty = state.pending[g.id] !== undefined && state.pending[g.id] !== g.myPick;
  const kicked = g.locked;
  const status = kicked
    ? g.final
      ? `<span class="final">Final ${esc(g.awayTeam.split(' ').pop())} ${g.final.awayScore} &ndash; ${g.final.homeScore} ${esc(g.homeTeam.split(' ').pop())}</span>`
      : '<span class="lock">Locked &middot; in progress</span>'
    : esc(g.kickoffLabel);

  const side = (which) => {
    const team = which === 'home' ? g.homeLabel : g.awayLabel;
    const spread = which === 'home' ? g.homeSpread : g.awaySpread;
    const isSel = selected === which;
    const result = kicked && g.final && isSel ? g.myResult : null;
    const cls = ['side', result || ''].filter(Boolean).join(' ');
    const score = g.final ? `<span class="score">${which === 'home' ? g.final.homeScore : g.final.awayScore}</span>` : '';
    return `<button class="${cls}" data-game="${esc(g.id)}" data-side="${which}"
      aria-pressed="${isSel}" ${kicked ? 'disabled' : ''}>
      <span class="team">${esc(team)}</span>
      <span class="spread">${fmtSpread(spread)}</span>
      ${score}
    </button>`;
  };

  let foot = '';
  if (kicked && g.picks) {
    const chips = g.picks
      .filter((p) => p.side)
      .map((p) => `<span class="chip ${p.result || ''}">${esc(p.name)} &middot; ${esc(shortTeam(p.team))}</span>`)
      .join('');
    const none = g.picks.filter((p) => !p.side).map((p) => `<span class="chip">${esc(p.name)} &middot; no pick</span>`).join('');
    const pct = g.pickPct;
    const bar =
      pct && pct.total
        ? `<div class="pctbar"><span class="away" style="width:${pct.awayPct}%"></span><span class="home" style="width:${pct.homePct}%"></span></div>
           <div style="display:flex;justify-content:space-between;font-size:11px;margin-top:3px">
             <span>${esc(shortTeam(g.awayTeam))} ${pct.awayPct}%</span>
             <span>${pct.homePct}% ${esc(shortTeam(g.homeTeam))}</span>
           </div>`
        : '<div style="font-size:12px">No picks were made on this game.</div>';
    foot = `<div class="game-foot">${bar}<div class="pickrow">${chips}${none}</div></div>`;
  } else if (opts.showDirty && dirty) {
    foot = '<div class="game-foot">Changed &mdash; press Submit Picks to save.</div>';
  }

  return `<div class="game">
    <div class="game-top"><span>${status}</span>${g.spreadManual ? '<span>Line set by commissioner</span>' : ''}</div>
    <div class="matchup">${side('away')}<div class="vs">AT</div>${side('home')}</div>
    ${foot}
  </div>`;
}

function shortTeam(name) {
  if (!name) return '';
  const parts = String(name).split(' ');
  return parts.length > 1 ? parts.slice(-1)[0] : name;
}

function renderPicks() {
  const w = state.week;
  if (!w) {
    $('collegeGames').innerHTML = '';
    $('nflGames').innerHTML = '<div class="empty">No week has been published yet. Check back Friday.</div>';
    $('submitBar').classList.add('hidden');
    return;
  }
  const opts = { showDirty: true };
  $('collegeGames').innerHTML = w.college.length
    ? w.college.map((g) => gameCard(g, opts)).join('')
    : '<div class="empty">No college games this week.</div>';
  $('nflGames').innerHTML = w.nfl.length
    ? w.nfl.map((g) => gameCard(g, opts)).join('')
    : '<div class="empty">No Sunday NFL games loaded yet.</div>';

  $('lineStamp').textContent = w.linesLockedLabel
    ? `Lines locked ${w.linesLockedLabel} — source: ${w.lineSource || 'commissioner'}`
    : '';

  const all = [...w.college, ...w.nfl];
  const open = all.filter((g) => !g.locked);
  const made = all.filter((g) => (state.pending[g.id] ?? g.myPick)).length;
  const dirty = Object.keys(state.pending).filter((id) => {
    const g = all.find((x) => x.id === id);
    return g && !g.locked && state.pending[id] !== g.myPick;
  }).length;

  if (!state.boot.me) {
    $('submitBar').classList.add('hidden');
    return;
  }
  $('submitBar').classList.remove('hidden');
  const lockedCount = all.length - open.length;
  const stillNeeded = open.filter((g) => !(state.pending[g.id] ?? g.myPick)).length;

  if (dirty > 0) {
    $('submitMeta').textContent = `${dirty} unsaved change${dirty === 1 ? '' : 's'} · ${made} of ${all.length} picked`;
    $('submitBtn').disabled = false;
    $('submitBtn').textContent = 'Submit Picks';
  } else if (open.length === 0) {
    $('submitMeta').textContent = `Every game has kicked off · ${made} of ${all.length} picked`;
    $('submitBtn').disabled = true;
    $('submitBtn').textContent = 'Picks closed';
  } else if (stillNeeded > 0) {
    $('submitMeta').textContent = `${stillNeeded} game${stillNeeded === 1 ? '' : 's'} still need a pick${lockedCount ? ` · ${lockedCount} locked` : ''}`;
    $('submitBtn').disabled = true;
    $('submitBtn').textContent = 'Picks Saved';
  } else {
    $('submitMeta').textContent = `All ${made} picks in${lockedCount ? ` · ${lockedCount} locked` : ''}`;
    $('submitBtn').disabled = true;
    $('submitBtn').textContent = 'Picks Saved';
  }
}

function renderSurvivor() {
  const s = state.survivor;
  if (!s) {
    $('survivorTeams').innerHTML = '<div class="empty">No week has been published yet.</div>';
    $('survivorStatus').innerHTML = '';
    $('survivorHistory').innerHTML = '';
    $('survivorBoard').innerHTML = '';
    return;
  }
  const me = s.me;
  $('survivorLockHint').textContent = s.locked
    ? 'Locked'
    : s.lockLabel ? `Locks ${s.lockLabel}` : '';

  if (me && me.status) {
    const st = me.status;
    $('survivorStatus').innerHTML = `<div class="card"><h3>Your survivor status</h3>
      <table><tbody>
        <tr><td>Status</td><td class="num">${st.alive
          ? '<span class="status-pill alive">&#10003; Alive</span>'
          : `<span class="status-pill out">&#10007; Out (week ${st.eliminatedWeek})</span>`}</td></tr>
        <tr><td>Strikes</td><td class="num">${st.strikes} of ${s.strikeRule}</td></tr>
        <tr><td>Teams used</td><td class="num">${st.teamsUsed.length}</td></tr>
      </tbody></table></div>`;
  } else {
    $('survivorStatus').innerHTML = '';
  }

  if (!me) {
    $('survivorTeams').innerHTML = '<div class="empty">Sign in to make a survivor pick.</div>';
  } else if (me.status && !me.status.alive) {
    $('survivorTeams').innerHTML = `<div class="empty">You were eliminated in week ${me.status.eliminatedWeek}. You can still follow along below.</div>`;
  } else {
    const chosen = state.survivorPending || (me.pick ? me.pick.team : null);
    $('survivorTeams').innerHTML = me.options
      .map((o) => {
        const disabled = o.used || o.locked || s.locked;
        const cls = ['team-card', o.used ? 'used' : '', o.locked || s.locked ? 'locked' : ''].filter(Boolean).join(' ');
        const tag = o.used ? 'Used' : o.locked ? 'Kicked off' : s.locked ? 'Locked' : (chosen === o.team ? 'Your pick' : '');
        return `<button class="${cls}" data-team="${esc(o.team)}" aria-pressed="${chosen === o.team}" ${disabled ? 'disabled' : ''}>
            <span class="name">${esc(o.team)}</span>
            <span class="meta">${o.isHome ? 'vs.' : '@'} ${esc(shortTeam(o.opponent))}<br>${esc(new Date(o.commenceTime).toLocaleTimeString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit' }))} CT</span>
            <span class="tag">${esc(tag)}</span>
          </button>`;
      })
      .join('');
  }

  if (me && me.status && me.status.history.length) {
    const rows = me.status.history
      .filter((h) => h.team)
      .map(
        (h) => `<tr><td>Week ${h.week}</td><td>${esc(h.team)}</td>
          <td class="num">${h.result === 'survived' ? '&#10003;' : h.result === 'strike' ? '&#10007;' : h.result === 'tie' ? 'Tie' : '&mdash;'}</td></tr>`
      )
      .join('');
    $('survivorHistory').innerHTML = rows
      ? `<div class="card"><h3>Your survivor picks</h3><table><tbody>${rows}</tbody></table></div>`
      : '';
  } else {
    $('survivorHistory').innerHTML = '';
  }

  const rows = s.board
    .map((b) => {
      const weekPick = b.weekPick ? esc(b.weekPick.team) : s.locked ? '&mdash;' : '<span style="color:#4A4E55">hidden</span>';
      return `<tr class="${state.boot.me && b.participantId === state.boot.me.id ? 'me' : ''}">
        <td>${esc(b.name)}</td>
        <td>${b.alive ? '<span class="status-pill alive">Alive</span>' : '<span class="status-pill out">Out</span>'}</td>
        <td class="num">${b.strikes}</td>
        <td class="num">${weekPick}</td>
      </tr>`;
    })
    .join('');
  $('survivorBoard').innerHTML = `<div class="card"><h3>Remaining participants</h3>
    <table><thead><tr><th>Player</th><th>Status</th><th class="num">Strikes</th><th class="num">Week ${s.week}</th></tr></thead>
    <tbody>${rows}</tbody></table></div>
    <p class="linestamp">${s.locked ? 'Picks revealed &mdash; the slate is locked.' : 'Everyone’s pick appears once the first Sunday game kicks off.'}</p>`;

  if (me && !s.locked && me.status && me.status.alive) {
    $('submitBar').classList.remove('hidden');
    const chosen = state.survivorPending || (me.pick ? me.pick.team : null);
    const dirty = state.survivorPending && (!me.pick || me.pick.team !== state.survivorPending);
    $('submitMeta').textContent = chosen ? `Survivor pick: ${chosen}` : 'No survivor pick yet';
    $('submitBtn').disabled = !dirty;
    $('submitBtn').textContent = dirty ? 'Save Survivor Pick' : 'Pick Saved';
  } else {
    $('submitBar').classList.add('hidden');
  }
}

function weekPicker(targetId, weeks, current, onChange) {
  const el = $(targetId);
  if (!weeks.length) { el.innerHTML = ''; return; }
  el.innerHTML = `<label for="${targetId}-sel">Week</label>
    <select id="${targetId}-sel">${weeks.map((w) => `<option value="${w}" ${w === current ? 'selected' : ''}>Week ${w}</option>`).join('')}</select>`;
  $(`${targetId}-sel`).onchange = (e) => onChange(Number(e.target.value));
}

async function renderStandings(weekNumber) {
  const data = await api(`/api/standings${weekNumber ? `?week=${weekNumber}` : ''}`);
  weekPicker('standingsWeekPicker', data.weeks, data.week, (w) => renderStandings(w));
  const meId = state.boot.me ? state.boot.me.id : null;

  const row = (r, i) => `<tr class="${r.participantId === meId ? 'me' : ''}">
      <td class="rank">${r.rank}</td><td>${esc(r.name)}</td>
      <td class="num pts">${fmtPoints(r.points)}</td>
      <td class="num">${r.wins}-${r.losses}-${r.pushes}</td></tr>`;

  const survivorRows = data.survivor
    .map(
      (s) => `<tr class="${s.participantId === meId ? 'me' : ''}">
        <td>${esc(s.name)}</td>
        <td>${s.alive ? '<span class="status-pill alive">Alive</span>' : `<span class="status-pill out">Out wk ${s.eliminatedWeek}</span>`}</td>
        <td class="num">${s.strikes}/${s.strikeRule}</td>
        <td style="font-size:12px">${s.teamsUsed.length ? s.teamsUsed.map(shortTeam).map(esc).join(', ') : '&mdash;'}</td>
      </tr>`
    )
    .join('');

  $('standingsContent').innerHTML = `
    <div class="card"><h3>Pick'em &mdash; Week ${data.week ?? '&mdash;'}</h3>
      <table><thead><tr><th></th><th>Player</th><th class="num">Points</th><th class="num">W-L-P</th></tr></thead>
      <tbody>${data.weekly.map(row).join('') || '<tr><td colspan="4">No results yet.</td></tr>'}</tbody></table></div>
    <div class="card"><h3>Pick'em &mdash; Season</h3>
      <table><thead><tr><th></th><th>Player</th><th class="num">Points</th><th class="num">W-L-P</th></tr></thead>
      <tbody>${data.season.map(row).join('')}</tbody></table></div>
    <div class="card"><h3>Survivor</h3>
      <table><thead><tr><th>Player</th><th>Status</th><th class="num">Strikes</th><th>Teams used</th></tr></thead>
      <tbody>${survivorRows}</tbody></table></div>`;
}

async function renderResults(weekNumber) {
  let data;
  try {
    data = await api(`/api/results${weekNumber ? `?week=${weekNumber}` : ''}`);
  } catch (err) {
    $('resultsContent').innerHTML = `<div class="empty">${esc(err.message)}</div>`;
    return;
  }
  weekPicker('resultsWeekPicker', data.weeks, data.week, (w) => renderResults(w));
  const meId = state.boot.me ? state.boot.me.id : null;
  const rows = data.weekly
    .map(
      (r) => `<tr class="${r.participantId === meId ? 'me' : ''}">
        <td class="rank">${r.rank}</td><td>${esc(r.name)}</td>
        <td class="num pts">${fmtPoints(r.points)}</td>
        <td class="num">${r.wins}-${r.losses}-${r.pushes}</td></tr>`
    )
    .join('');
  const graded = data.games.filter((g) => g.final).length;
  $('resultsContent').innerHTML = `
    <div class="card"><h3>Week ${data.week} standings</h3>
      <table><thead><tr><th></th><th>Player</th><th class="num">Points</th><th class="num">W-L-P</th></tr></thead>
      <tbody>${rows}</tbody></table></div>
    <div class="section-head"><h2>Game by game</h2><span class="hint">${graded} of ${data.games.length} final</span></div>
    ${data.games.map((g) => gameCard(g)).join('')}
    <p class="linestamp">${data.linesLockedLabel ? `Lines locked ${esc(data.linesLockedLabel)} — source: ${esc(data.lineSource || '')}` : ''}</p>`;
}

/* ------------------------------------------------------------------ events */

function setTab(tab) {
  state.tab = tab;
  for (const b of document.querySelectorAll('#tabs button')) {
    b.setAttribute('aria-selected', String(b.dataset.tab === tab));
  }
  for (const id of ['picksView', 'survivorView', 'standingsView', 'resultsView']) {
    $(id).classList.add('hidden');
  }
  $('submitBar').classList.add('hidden');
  if (!state.boot.me && (tab === 'picks' || tab === 'survivor')) {
    $('loginView').classList.remove('hidden');
  } else {
    $('loginView').classList.add('hidden');
  }
  if (tab === 'picks') { $('picksView').classList.remove('hidden'); renderPicks(); }
  if (tab === 'survivor') { $('survivorView').classList.remove('hidden'); renderSurvivor(); }
  if (tab === 'standings') { $('standingsView').classList.remove('hidden'); renderStandings(state.weekNumber); }
  if (tab === 'results') { $('resultsView').classList.remove('hidden'); renderResults(state.weekNumber); }
  window.scrollTo({ top: 0 });
}

document.addEventListener('click', async (e) => {
  const tab = e.target.closest('#tabs button');
  if (tab) return setTab(tab.dataset.tab);

  const side = e.target.closest('.side');
  if (side && !side.disabled) {
    if (!state.boot.me) { toast('Sign in first', 'error'); return setTab('picks'); }
    const { game, side: which } = side.dataset;
    state.pending[game] = state.pending[game] === which ? undefined : which;
    if (state.pending[game] === undefined) delete state.pending[game];
    renderPicks();
    return;
  }

  const team = e.target.closest('.team-card');
  if (team && !team.disabled) {
    state.survivorPending = state.survivorPending === team.dataset.team ? null : team.dataset.team;
    renderSurvivor();
    return;
  }
});

$('submitBtn').onclick = async () => {
  const btn = $('submitBtn');
  btn.disabled = true;
  try {
    if (state.tab === 'survivor') {
      await api('/api/survivor', {
        method: 'POST',
        body: JSON.stringify({ week: state.weekNumber, team: state.survivorPending }),
      });
      state.survivorPending = null;
      await loadSurvivor();
      renderSurvivor();
      toast('Survivor pick saved');
    } else {
      const picks = Object.entries(state.pending).map(([gameId, s]) => ({ gameId, side: s }));
      const res = await api('/api/picks', {
        method: 'POST',
        body: JSON.stringify({ week: state.weekNumber, picks }),
      });
      state.pending = {};
      await loadWeek();
      renderPicks();
      if (res.rejected.length) {
        toast(res.rejected[0].reason, 'error');
        notice(
          `<strong>Some picks were not saved.</strong><br>${res.rejected.map((r) => esc(r.reason)).join('<br>')}`,
          'error'
        );
      } else {
        notice('');
        toast('Picks Saved');
      }
    }
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    btn.disabled = false;
  }
};

$('loginBtn').onclick = async () => {
  const err = $('loginError');
  err.classList.add('hidden');
  try {
    const res = await api('/api/login', {
      method: 'POST',
      body: JSON.stringify({ participantId: $('loginWho').value, pin: $('loginPin').value }),
    });
    state.boot.me = res.me;
    $('loginPin').value = '';
    await boot();
    toast(`Welcome, ${res.me.name}`);
  } catch (e) {
    err.textContent = e.message;
    err.classList.remove('hidden');
  }
};

$('loginPin').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('loginBtn').click(); });

/* -------------------------------------------------------------------- boot */

async function loadWeek() {
  try {
    state.week = await api(`/api/week?week=${state.weekNumber}`);
  } catch {
    state.week = null;
  }
}

async function loadSurvivor() {
  try {
    state.survivor = await api(`/api/survivor?week=${state.weekNumber}`);
  } catch {
    state.survivor = null;
  }
}

async function boot() {
  state.boot = await api('/api/bootstrap');
  state.weekNumber = state.boot.currentWeek;
  renderHeader();

  $('loginWho').innerHTML = state.boot.participants
    .map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`)
    .join('');

  if (state.weekNumber) {
    await Promise.all([loadWeek(), loadSurvivor()]);
  }
  // Clean the personal-link token out of the address bar once it has been used.
  if (new URLSearchParams(location.search).get('p') && state.boot.me) {
    history.replaceState({}, '', location.pathname);
  }
  setTab(state.tab);
}

boot().catch((err) => {
  notice(`Could not load the pool: ${esc(err.message)}`, 'error');
});
