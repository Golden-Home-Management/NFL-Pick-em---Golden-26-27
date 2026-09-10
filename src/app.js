'use strict';
/**
 * HTTP application: a small hand-rolled router over node:http so the whole
 * thing runs with one runtime dependency (`pg`, and only when you choose the
 * Postgres backend). The exported handler is a plain (req, res) function, so it
 * works unchanged as a Node server or as a serverless function.
 */

const fsp = require('fs/promises');
const path = require('path');
const { URL } = require('url');

const state = require('./state');
const scoring = require('./scoring');
const odds = require('./odds');
const auth = require('./auth');
const ratelimit = require('./ratelimit');
const timeutil = require('./time');
const { NFL_TEAMS } = require('./teams');
const { createStore } = require('./store');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PARTICIPANT_COOKIE = 'ghm_player';
const ADMIN_COOKIE = 'ghm_admin';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function createApp(config) {
  const store = createStore(config, () => state.defaultDoc(config.season));

  // ---------------------------------------------------------------- helpers

  function send(res, status, body, headers = {}) {
    const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...headers,
    });
    res.end(payload);
  }

  async function readBody(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 1_000_000) throw new HttpError(413, 'Request body too large');
      chunks.push(chunk);
    }
    if (!chunks.length) return {};
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new HttpError(400, 'Invalid JSON body');
    }
  }

  function isSecure(req) {
    return (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
  }

  async function currentParticipant(req) {
    const cookies = auth.parseCookies(req.headers.cookie);
    const url = new URL(req.url, 'http://localhost');
    const doc = await store.read();

    // A personal link (?p=<token>) signs you in for the rest of the session.
    const linkToken = url.searchParams.get('p');
    if (linkToken) {
      const viaLink = state.participantByToken(doc, linkToken);
      if (viaLink && viaLink.active) return { participant: viaLink, viaLink: true };
    }
    const id = auth.readToken(cookies[PARTICIPANT_COOKIE], config.sessionSecret);
    if (!id) return { participant: null, viaLink: false };
    const p = state.participantById(doc, id);
    return { participant: p && p.active ? p : null, viaLink: false };
  }

  function isAdmin(req) {
    const cookies = auth.parseCookies(req.headers.cookie);
    return auth.readToken(cookies[ADMIN_COOKIE], config.sessionSecret) === 'admin';
  }

  function requireAdmin(req) {
    if (!isAdmin(req)) throw new HttpError(401, 'Commissioner sign-in required');
  }

  function requireWeek(doc, number) {
    const week = state.getWeek(doc, number);
    if (!week) throw new HttpError(404, `Week ${number} does not exist`);
    return week;
  }

  // ------------------------------------------------------------ view models

  /**
   * Picks become public once the game can no longer be picked - kickoff has
   * passed, or a final score is already in the book.
   */
  function isRevealed(game, now) {
    return scoring.isGameLocked(game, now) || Boolean(game.final);
  }

  /** Public shape of a game. Other players' picks appear only after kickoff. */
  function gameView(doc, week, game, participantId, now) {
    const locked = scoring.isGameLocked(game, now);
    const mine = participantId ? doc.picks[state.pickKey(week.number, participantId, game.id)] : null;
    const view = {
      id: game.id,
      sport: game.sport,
      commenceTime: game.commenceTime,
      kickoffLabel: timeutil.formatKickoff(game.commenceTime),
      homeTeam: game.homeTeam,
      awayTeam: game.awayTeam,
      homeLabel: game.homeLabel || game.homeTeam,
      awayLabel: game.awayLabel || game.awayTeam,
      spread: game.spread,
      homeSpread: game.spread,
      awaySpread: game.spread === null || game.spread === undefined ? null : -game.spread,
      spreadSource: game.spreadSource,
      spreadManual: !!game.spreadManual,
      locked,
      myPick: mine ? mine.side : null,
      myPickAt: mine ? mine.at : null,
      final: game.final || null,
      myResult: mine ? scoring.gradeAts(game, mine.side) : null,
    };
    if (isRevealed(game, now)) {
      view.picks = pickBreakdown(doc, week.number, game);
      view.pickPct = scoring.pickPercentages(doc, week.number, game.id);
    }
    return view;
  }

  function pickBreakdown(doc, weekNumber, game) {
    return doc.participants
      .filter((p) => p.active)
      .map((p) => {
        const pick = doc.picks[state.pickKey(weekNumber, p.id, game.id)];
        return {
          participantId: p.id,
          name: p.name,
          side: pick ? pick.side : null,
          team: pick ? (pick.side === 'home' ? game.homeTeam : game.awayTeam) : null,
          result: pick ? scoring.gradeAts(game, pick.side) : null,
        };
      });
  }

  function weekView(doc, week, participantId, now = new Date()) {
    const college = week.games.filter((g) => g.sport === 'ncaaf');
    const nfl = week.games.filter((g) => g.sport === 'nfl');
    const byTime = (a, b) => new Date(a.commenceTime) - new Date(b.commenceTime);
    const survivorLock = scoring.survivorLockTime(week);
    return {
      number: week.number,
      status: week.status,
      season: doc.season,
      sundayDate: week.sundayDate,
      saturdayDate: week.saturdayDate,
      linesLockedAt: week.linesLockedAt,
      linesLockedLabel: week.linesLockedAt ? timeutil.formatStamp(week.linesLockedAt) : null,
      lineSource: week.lineSource,
      survivorLockAt: survivorLock ? survivorLock.toISOString() : null,
      survivorLockLabel: survivorLock ? timeutil.formatStamp(survivorLock) : null,
      survivorLocked: scoring.isSurvivorLocked(week, now),
      college: college.sort(byTime).map((g) => gameView(doc, week, g, participantId, now)),
      nfl: nfl.sort(byTime).map((g) => gameView(doc, week, g, participantId, now)),
    };
  }

  function publicParticipants(doc) {
    return doc.participants.filter((p) => p.active).map((p) => ({ id: p.id, name: p.name }));
  }

  function resolveWeekNumber(doc, requested) {
    if (requested !== null && requested !== undefined && requested !== '') {
      const n = Number(requested);
      if (!Number.isInteger(n)) throw new HttpError(400, 'week must be an integer');
      return n;
    }
    const active = state.activePublicWeek(doc);
    if (active === null) throw new HttpError(404, 'No week has been published yet');
    return active;
  }

  // ----------------------------------------------------------- participants

  async function handleLogin(req) {
    const body = await readBody(req);
    const ip = ratelimit.clientIp(req);
    // Throttle on the participant AND the caller, so neither a single account
    // nor a single source can be hammered.
    const keys = [`p:${body.participantId}`, `pip:${ip}`];

    // store.mutate rolls back when its callback throws, so a failed attempt must
    // RETURN a verdict rather than throw - otherwise the counter is discarded and
    // the throttle never engages.
    const verdict = await store.mutate((doc) => {
      for (const key of keys) {
        const wait = ratelimit.lockedFor(doc, key);
        if (wait) return { kind: 'locked', wait };
      }
      const p = state.participantById(doc, body.participantId);
      const good = p && p.active && auth.pinMatches(body.pin, p.pin);
      if (!good) {
        const r = keys.map((k) => ratelimit.recordFailure(doc, k)).pop();
        return { kind: 'bad', lockedSeconds: r.lockedSeconds };
      }
      for (const key of keys) ratelimit.clearFailures(doc, key);
      return {
        kind: 'ok',
        token: auth.makeToken(p.id, config.sessionSecret),
        me: { id: p.id, name: p.name },
      };
    });

    if (verdict.kind === 'locked') {
      throw new HttpError(429, `Too many wrong PINs. Try again in ${Math.ceil(verdict.wait / 60)} minute(s).`);
    }
    if (verdict.kind === 'bad') {
      // Same message whether the participant exists or not.
      throw new HttpError(
        401,
        verdict.lockedSeconds
          ? `That PIN is not right. Too many attempts - locked for ${Math.ceil(verdict.lockedSeconds / 60)} minute(s).`
          : 'That PIN is not right'
      );
    }
    return { token: verdict.token, me: verdict.me };
  }

  async function submitPicks(req, participant) {
    const body = await readBody(req);
    const weekNumber = Number(body.week);
    const submitted = Array.isArray(body.picks) ? body.picks : [];
    const now = new Date();

    return store.mutate((doc) => {
      const week = requireWeek(doc, weekNumber);
      if (week.status === 'draft') throw new HttpError(403, 'That week is not open yet');
      const accepted = [];
      const rejected = [];
      for (const item of submitted) {
        const game = week.games.find((g) => g.id === item.gameId);
        if (!game) {
          rejected.push({ gameId: item.gameId, reason: 'Game is not part of this week' });
          continue;
        }
        if (item.side !== 'home' && item.side !== 'away') {
          rejected.push({ gameId: item.gameId, reason: 'Pick must be home or away' });
          continue;
        }
        const key = state.pickKey(weekNumber, participant.id, game.id);
        const existing = doc.picks[key];
        if (existing && existing.side === item.side) {
          accepted.push({ gameId: game.id, side: item.side, unchanged: true });
          continue;
        }
        // Individual game locking: a missed 12:00 kickoff does not block the
        // 3:25 games.
        if (scoring.isGameLocked(game, now)) {
          rejected.push({
            gameId: game.id,
            reason: `${game.awayTeam} @ ${game.homeTeam} kicked off at ${timeutil.formatKickoff(game.commenceTime)} - that pick is locked`,
          });
          continue;
        }
        doc.picks[key] = { side: item.side, at: now.toISOString() };
        accepted.push({ gameId: game.id, side: item.side, unchanged: false });
      }
      return { accepted, rejected, savedAt: now.toISOString() };
    });
  }

  async function submitSurvivor(req, participant) {
    const body = await readBody(req);
    const weekNumber = Number(body.week);
    const team = String(body.team || '');
    const now = new Date();

    return store.mutate((doc) => {
      const week = requireWeek(doc, weekNumber);
      if (week.status === 'draft') throw new HttpError(403, 'That week is not open yet');

      const game = week.games.find(
        (g) => g.sport === 'nfl' && (g.homeTeam === team || g.awayTeam === team)
      );
      if (!game) throw new HttpError(400, `${team} is not playing in this week's Sunday slate`);

      const status = scoring.survivorStatusFor(doc, participant.id, weekNumber - 1);
      if (status && !status.alive) {
        throw new HttpError(403, `You were eliminated in week ${status.eliminatedWeek}`);
      }
      if (status && status.teamsUsed.includes(team)) {
        throw new HttpError(400, `You already used ${team} this season`);
      }
      if (scoring.isSurvivorLocked(week, now)) {
        throw new HttpError(403, 'Survivor picks locked at the first Sunday kickoff');
      }
      if (scoring.isGameLocked(game, now)) {
        throw new HttpError(403, `${team} has already kicked off`);
      }

      doc.survivorPicks[state.survivorKey(weekNumber, participant.id)] = {
        team,
        at: now.toISOString(),
      };
      return { team, savedAt: now.toISOString() };
    });
  }

  // ------------------------------------------------------------------ admin

  /**
   * The week "Start Next Week" should work on. If the newest week is still a
   * draft, that draft *is* the next week - reuse it. This keeps the button (and
   * the Friday cron) idempotent: pressing it twice never creates two weeks.
   */
  function nextWeekNumber(doc) {
    const nums = state.weekNumbers(doc);
    if (!nums.length) return 1;
    const last = Math.max(...nums);
    return doc.weeks[String(last)].status === 'draft' ? last : last + 1;
  }

  /**
   * Create the next week and, best-effort, populate NFL games + college
   * suggestions + spreads. Any Odds API problem is reported but still leaves an
   * empty week the commissioner can fill in by hand.
   */
  async function prepareNextWeek(opts = {}) {
    const doc0 = await store.read();
    const number = Number(opts.week) || nextWeekNumber(doc0);
    const today = timeutil.ctDate(new Date());

    // Default to the upcoming Sunday, but never to a Sunday the previous week
    // already covers - otherwise starting two weeks on the same day would put
    // both on the same slate.
    let sundayDate = opts.sundayDate;
    if (!sundayDate) {
      sundayDate = timeutil.nextSunday(today);
      const prev = doc0.weeks[String(number - 1)];
      if (prev && prev.sundayDate && sundayDate <= prev.sundayDate) {
        sundayDate = timeutil.addDays(prev.sundayDate, 7);
      }
    }
    const saturdayDate = opts.saturdayDate || timeutil.addDays(sundayDate, -1);

    await store.mutate((doc) => {
      if (!doc.weeks[String(number)]) {
        doc.weeks[String(number)] = state.newWeek(number, sundayDate, saturdayDate);
        state.logAudit(doc, 'commissioner', 'week.create', { week: number, sundayDate, saturdayDate });
      } else {
        doc.weeks[String(number)].sundayDate = sundayDate;
        doc.weeks[String(number)].saturdayDate = saturdayDate;
      }
      doc.settings.currentWeek = number;
    });

    const notes = [];
    let quota = null;
    try {
      const r = await importNfl(number);
      quota = r.quota || quota;
      notes.push(`Imported ${r.count} Sunday NFL games.`);
    } catch (err) {
      notes.push(`NFL import failed: ${err.message}`);
    }
    try {
      const r = await refreshCollegeSuggestions(number);
      quota = r.quota || quota;
      notes.push(`Found ${r.count} Saturday college games; top 3 suggested.`);
    } catch (err) {
      notes.push(`College import failed: ${err.message}`);
    }

    return { week: number, sundayDate, saturdayDate, notes, quota };
  }

  /** Pull Sunday NFL games + frozen spreads into a draft week. */
  async function importNfl(number) {
    const doc = await store.read();
    const week = requireWeek(doc, number);
    if (week.status !== 'draft') throw new HttpError(403, 'Week is published - unlock it before re-importing');
    const { games, quota } = await odds.fetchNflSunday({
      sundayDate: week.sundayDate,
      apiKey: config.oddsApiKey,
    });
    await store.mutate((d) => {
      const w = requireWeek(d, number);
      const college = w.games.filter((g) => g.sport === 'ncaaf');
      // Keep any manual spread corrections the commissioner already made.
      const manual = new Map(w.games.filter((g) => g.spreadManual).map((g) => [g.id, g]));
      w.games = [
        ...games.map((g) => (manual.has(g.id) ? { ...g, ...pickManualFields(manual.get(g.id)) } : g)),
        ...college,
      ];
      state.logAudit(d, 'commissioner', 'week.import-nfl', { week: number, count: games.length });
    });
    return { count: games.length, quota };
  }

  function pickManualFields(game) {
    return {
      spread: game.spread,
      spreadSource: game.spreadSource,
      spreadCapturedAt: game.spreadCapturedAt,
      spreadManual: true,
      homeLabel: game.homeLabel,
      awayLabel: game.awayLabel,
    };
  }

  async function refreshCollegeSuggestions(number) {
    const doc = await store.read();
    const week = requireWeek(doc, number);
    if (week.status !== 'draft') throw new HttpError(403, 'Week is published - unlock it before re-importing');
    const { candidates, suggested, quota } = await odds.fetchCollegeSuggestions({
      saturdayDate: week.saturdayDate,
      apiKey: config.oddsApiKey,
    });
    await store.mutate((d) => {
      const w = requireWeek(d, number);
      w.collegeCandidates = candidates;
      const alreadyChosen = w.games.some((g) => g.sport === 'ncaaf');
      if (!alreadyChosen) {
        w.games = [...w.games.filter((g) => g.sport !== 'ncaaf'), ...suggested.map(stripSuggestion)];
      }
      state.logAudit(d, 'commissioner', 'week.college-suggestions', {
        week: number,
        candidates: candidates.length,
        autoSelected: !alreadyChosen ? suggested.map((g) => `${g.awayTeam} @ ${g.homeTeam}`) : null,
      });
    });
    return { count: candidates.length, suggested, quota };
  }

  function stripSuggestion(game) {
    const { suggestionScore, ...rest } = game;
    return rest;
  }

  /** Re-pull spreads for every game in a draft week (the "Refresh Lines" button). */
  async function refreshLines(number) {
    const doc = await store.read();
    const week = requireWeek(doc, number);
    if (week.status !== 'draft') {
      throw new HttpError(403, 'Lines are locked for this week. Unlock the week to refresh.');
    }
    const wanted = { nfl: [], ncaaf: [] };
    for (const g of week.games) wanted[g.sport].push(g.id);

    const fresh = new Map();
    let quota = null;
    const errors = [];
    for (const sport of ['nfl', 'ncaaf']) {
      if (!wanted[sport].length) continue;
      try {
        const dates =
          sport === 'nfl'
            ? [week.sundayDate]
            : [...new Set(week.games.filter((g) => g.sport === 'ncaaf').map((g) => timeutil.ctDate(g.commenceTime)))];
        const r = await odds.fetchGames({ sport, dates, apiKey: config.oddsApiKey });
        quota = r.quota || quota;
        for (const g of r.games) fresh.set(g.id, g);
      } catch (err) {
        errors.push(`${sport.toUpperCase()}: ${err.message}`);
      }
    }

    const updated = await store.mutate((d) => {
      const w = requireWeek(d, number);
      let changed = 0;
      let missing = 0;
      for (const game of w.games) {
        const f = fresh.get(game.id);
        if (!f || f.spread === null) {
          if (game.spread === null) missing += 1;
          continue;
        }
        if (game.spread !== f.spread || game.spreadSource !== f.spreadSource) changed += 1;
        game.spread = f.spread;
        game.spreadSource = f.spreadSource;
        game.spreadCapturedAt = f.spreadCapturedAt;
        game.spreadManual = false;
      }
      state.logAudit(d, 'commissioner', 'week.refresh-lines', { week: number, changed, missing });
      return { changed, missing };
    });
    return { ...updated, errors, quota };
  }

  /** Freeze the week: spreads can no longer move and participants can pick. */
  async function publishWeek(number) {
    return store.mutate((doc) => {
      const week = requireWeek(doc, number);
      const nfl = week.games.filter((g) => g.sport === 'nfl');
      if (!nfl.length) throw new HttpError(400, 'Import the Sunday NFL games before publishing');
      const missing = week.games.filter((g) => g.spread === null || g.spread === undefined);
      if (missing.length) {
        throw new HttpError(
          400,
          `${missing.length} game(s) still have no spread. Enter them manually or remove the game.`
        );
      }
      const sources = [...new Set(week.games.map((g) => g.spreadSource).filter(Boolean))];
      week.status = 'published';
      week.linesLockedAt = new Date().toISOString();
      week.lineSource = sources.length === 1 ? sources[0] : sources.join(' / ');
      if (!week.survivorLockAt) {
        const lock = scoring.survivorLockTime(week);
        week.survivorLockAt = lock ? lock.toISOString() : null;
      }
      doc.settings.currentWeek = number;
      state.logAudit(doc, 'commissioner', 'week.publish', {
        week: number,
        source: week.lineSource,
        games: week.games.length,
      });
      return { week: number, linesLockedAt: week.linesLockedAt, lineSource: week.lineSource };
    });
  }

  /** Pull final scores from The Odds API for the games in a week. */
  async function fetchWeekScores(number) {
    const doc = await store.read();
    const week = requireWeek(doc, number);
    const sports = [...new Set(week.games.map((g) => g.sport))];
    const found = new Map();
    const errors = [];
    let quota = null;
    for (const sport of sports) {
      try {
        const r = await odds.fetchScores({ sport, daysFrom: 3, apiKey: config.oddsApiKey });
        quota = r.quota || quota;
        for (const [id, s] of r.scores) found.set(id, s);
      } catch (err) {
        errors.push(`${sport.toUpperCase()}: ${err.message}`);
      }
    }
    const result = await store.mutate((d) => {
      const w = requireWeek(d, number);
      let applied = 0;
      for (const game of w.games) {
        const s = found.get(game.id);
        if (!s) continue;
        if (game.final && game.final.source === 'manual') continue; // never clobber a manual override
        game.final = {
          homeScore: s.homeScore,
          awayScore: s.awayScore,
          at: new Date().toISOString(),
          source: 'odds-api',
        };
        applied += 1;
      }
      state.logAudit(d, 'commissioner', 'week.fetch-scores', { week: number, applied });
      return { applied, pending: w.games.filter((g) => !g.final).length };
    });
    return { ...result, errors, quota };
  }

  function adminStateView(doc) {
    const weeks = state.weekNumbers(doc).map((n) => {
      const w = doc.weeks[String(n)];
      return {
        number: n,
        status: w.status,
        sundayDate: w.sundayDate,
        saturdayDate: w.saturdayDate,
        linesLockedAt: w.linesLockedAt,
        linesLockedLabel: w.linesLockedAt ? timeutil.formatStamp(w.linesLockedAt) : null,
        lineSource: w.lineSource,
        nflCount: w.games.filter((g) => g.sport === 'nfl').length,
        collegeCount: w.games.filter((g) => g.sport === 'ncaaf').length,
        scored: w.games.filter((g) => g.final).length,
      };
    });
    return {
      season: doc.season,
      settings: doc.settings,
      participants: doc.participants,
      weeks,
      currentWeek: doc.settings.currentWeek,
      publicWeek: state.activePublicWeek(doc),
      oddsApiConfigured: Boolean(config.oddsApiKey),
      audit: doc.audit.slice(0, 100),
    };
  }

  function adminWeekView(doc, number) {
    const week = requireWeek(doc, number);
    const byTime = (a, b) => new Date(a.commenceTime) - new Date(b.commenceTime);
    const decorate = (g) => ({
      ...g,
      kickoffLabel: timeutil.formatKickoff(g.commenceTime),
      pickPct: scoring.pickPercentages(doc, number, g.id),
    });
    return {
      number: week.number,
      status: week.status,
      sundayDate: week.sundayDate,
      saturdayDate: week.saturdayDate,
      linesLockedAt: week.linesLockedAt,
      linesLockedLabel: week.linesLockedAt ? timeutil.formatStamp(week.linesLockedAt) : null,
      lineSource: week.lineSource,
      // The stored override if there is one, otherwise the first Sunday kickoff.
      survivorLockAt: (scoring.survivorLockTime(week) || {}).toISOString?.() || null,
      survivorLockIsOverride: Boolean(week.survivorLockAt),
      college: week.games.filter((g) => g.sport === 'ncaaf').sort(byTime).map(decorate),
      nfl: week.games.filter((g) => g.sport === 'nfl').sort(byTime).map(decorate),
      collegeCandidates: (week.collegeCandidates || []).map((g) => ({
        ...g,
        kickoffLabel: timeutil.formatKickoff(g.commenceTime),
        selected: week.games.some((s) => s.id === g.id),
      })),
      picks: pickMatrix(doc, number),
      survivor: scoring.survivorStandings(doc, number),
    };
  }

  function pickMatrix(doc, number) {
    const week = state.getWeek(doc, number);
    if (!week) return [];
    return doc.participants.map((p) => ({
      participantId: p.id,
      name: p.name,
      survivor: doc.survivorPicks[state.survivorKey(number, p.id)] || null,
      picks: week.games.map((g) => {
        const pick = doc.picks[state.pickKey(number, p.id, g.id)];
        return {
          gameId: g.id,
          side: pick ? pick.side : null,
          at: pick ? pick.at : null,
          result: pick ? scoring.gradeAts(g, pick.side) : null,
        };
      }),
    }));
  }

  // --------------------------------------------------------------- routing

  const routes = [];
  function route(method, pattern, handler) {
    routes.push({ method, pattern, handler });
  }

  // ---- participant / public API

  route('GET', '/api/bootstrap', async (req) => {
    const doc = await store.read();
    const { participant, viaLink } = await currentParticipant(req);
    const publicWeek = state.activePublicWeek(doc);
    const body = {
      season: doc.season,
      poolName: doc.settings.poolName,
      strikeRule: doc.settings.strikeRule,
      participants: publicParticipants(doc),
      weeks: state.publishedWeekNumbers(doc),
      currentWeek: publicWeek,
      me: participant ? { id: participant.id, name: participant.name } : null,
      isAdmin: isAdmin(req),
      nowCt: timeutil.formatStamp(new Date()),
    };
    const headers = {};
    if (viaLink) {
      headers['Set-Cookie'] = auth.cookieString(
        PARTICIPANT_COOKIE,
        auth.makeToken(participant.id, config.sessionSecret),
        { secure: isSecure(req) }
      );
    }
    return { body, headers };
  });

  route('POST', '/api/login', async (req) => {
    const result = await handleLogin(req);
    return {
      body: { me: result.me },
      headers: {
        'Set-Cookie': auth.cookieString(PARTICIPANT_COOKIE, result.token, { secure: isSecure(req) }),
      },
    };
  });

  route('POST', '/api/logout', async (req) => ({
    body: { ok: true },
    headers: { 'Set-Cookie': auth.cookieString(PARTICIPANT_COOKIE, '', { maxAge: 0, secure: isSecure(req) }) },
  }));

  route('GET', '/api/week', async (req, { query }) => {
    const doc = await store.read();
    const { participant } = await currentParticipant(req);
    const number = resolveWeekNumber(doc, query.get('week'));
    const week = requireWeek(doc, number);
    if (week.status === 'draft' && !isAdmin(req)) throw new HttpError(403, 'That week is not published yet');
    return { body: weekView(doc, week, participant ? participant.id : null) };
  });

  route('POST', '/api/picks', async (req) => {
    const { participant } = await currentParticipant(req);
    if (!participant) throw new HttpError(401, 'Sign in to save picks');
    return { body: await submitPicks(req, participant) };
  });

  route('GET', '/api/survivor', async (req, { query }) => {
    const doc = await store.read();
    const { participant } = await currentParticipant(req);
    const number = resolveWeekNumber(doc, query.get('week'));
    const week = requireWeek(doc, number);
    if (week.status === 'draft' && !isAdmin(req)) throw new HttpError(403, 'That week is not published yet');
    const lock = scoring.survivorLockTime(week);
    const locked = scoring.isSurvivorLocked(week);
    const standings = scoring.survivorStandings(doc);
    const me = participant
      ? {
          pick: doc.survivorPicks[state.survivorKey(number, participant.id)] || null,
          status: standings.find((s) => s.participantId === participant.id) || null,
          options: scoring.survivorOptions(doc, number, participant.id),
        }
      : null;
    return {
      body: {
        week: number,
        strikeRule: doc.settings.strikeRule,
        lockAt: lock ? lock.toISOString() : null,
        lockLabel: lock ? timeutil.formatStamp(lock) : null,
        locked,
        me,
        // Everyone's survivor picks are revealed only once the slate locks.
        board: standings.map((s) => ({
          ...s,
          weekPick: locked ? doc.survivorPicks[state.survivorKey(number, s.participantId)] || null : undefined,
        })),
      },
    };
  });

  route('POST', '/api/survivor', async (req) => {
    const { participant } = await currentParticipant(req);
    if (!participant) throw new HttpError(401, 'Sign in to save a survivor pick');
    return { body: await submitSurvivor(req, participant) };
  });

  route('GET', '/api/standings', async (req, { query }) => {
    const doc = await store.read();
    const weeks = state.publishedWeekNumbers(doc);
    const number = weeks.length ? resolveWeekNumber(doc, query.get('week')) : null;
    return {
      body: {
        week: number,
        weekly: number === null ? [] : scoring.weeklyStandings(doc, number),
        season: scoring.seasonStandings(doc),
        survivor: scoring.survivorStandings(doc),
        strikeRule: doc.settings.strikeRule,
        weeks,
      },
    };
  });

  route('GET', '/api/results', async (req, { query }) => {
    const doc = await store.read();
    const { participant } = await currentParticipant(req);
    const number = resolveWeekNumber(doc, query.get('week'));
    const week = requireWeek(doc, number);
    if (week.status === 'draft' && !isAdmin(req)) throw new HttpError(403, 'That week is not published yet');
    const now = new Date();
    const games = week.games
      .slice()
      .sort((a, b) => new Date(a.commenceTime) - new Date(b.commenceTime))
      .map((g) => ({
        ...gameView(doc, week, g, participant ? participant.id : null, now),
        picks: isRevealed(g, now) ? pickBreakdown(doc, number, g) : null,
      }));
    return {
      body: {
        week: number,
        status: week.status,
        linesLockedLabel: week.linesLockedAt ? timeutil.formatStamp(week.linesLockedAt) : null,
        lineSource: week.lineSource,
        games,
        weekly: scoring.weeklyStandings(doc, number),
        weeks: state.publishedWeekNumbers(doc),
      },
    };
  });

  // ---- admin API

  route('POST', '/api/admin/login', async (req) => {
    const body = await readBody(req);
    const ip = ratelimit.clientIp(req);
    const key = `admin:${ip}`;

    const verdict = await store.mutate((doc) => {
      const wait = ratelimit.lockedFor(doc, key);
      if (wait) return { kind: 'locked', wait };
      if (!auth.pinMatches(body.pin, config.adminPin)) {
        const r = ratelimit.recordFailure(doc, key);
        if (r.lockedSeconds) {
          state.logAudit(doc, 'security', 'admin.login-locked', { ip, failures: r.failures });
        }
        return { kind: 'bad', lockedSeconds: r.lockedSeconds };
      }
      ratelimit.clearFailures(doc, key);
      state.logAudit(doc, 'commissioner', 'admin.login', { ip });
      return { kind: 'ok' };
    });

    if (verdict.kind === 'locked') {
      throw new HttpError(429, `Too many wrong PINs. Try again in ${Math.ceil(verdict.wait / 60)} minute(s).`);
    }
    if (verdict.kind === 'bad') {
      throw new HttpError(
        401,
        verdict.lockedSeconds
          ? `Wrong commissioner PIN. Locked for ${Math.ceil(verdict.lockedSeconds / 60)} minute(s).`
          : 'Wrong commissioner PIN'
      );
    }

    return {
      body: { ok: true },
      headers: {
        'Set-Cookie': auth.cookieString(ADMIN_COOKIE, auth.makeToken('admin', config.sessionSecret), {
          maxAge: 86400 * 30,
          secure: isSecure(req),
        }),
      },
    };
  });

  route('POST', '/api/admin/logout', async (req) => ({
    body: { ok: true },
    headers: { 'Set-Cookie': auth.cookieString(ADMIN_COOKIE, '', { maxAge: 0, secure: isSecure(req) }) },
  }));

  route('GET', '/api/admin/state', async (req) => {
    requireAdmin(req);
    const doc = await store.read();
    return { body: adminStateView(doc) };
  });

  route('GET', '/api/admin/week', async (req, { query }) => {
    requireAdmin(req);
    const doc = await store.read();
    const number = Number(query.get('week') ?? doc.settings.currentWeek);
    return { body: adminWeekView(doc, number) };
  });

  route('POST', '/api/admin/week/start', async (req) => {
    requireAdmin(req);
    const body = await readBody(req);
    return { body: await prepareNextWeek(body) };
  });

  route('POST', '/api/admin/week/import-nfl', async (req) => {
    requireAdmin(req);
    const body = await readBody(req);
    return { body: await importNfl(Number(body.week)) };
  });

  route('POST', '/api/admin/week/college-suggestions', async (req) => {
    requireAdmin(req);
    const body = await readBody(req);
    const r = await refreshCollegeSuggestions(Number(body.week));
    return { body: { count: r.count, quota: r.quota } };
  });

  route('POST', '/api/admin/week/select-college', async (req) => {
    requireAdmin(req);
    const body = await readBody(req);
    const number = Number(body.week);
    const ids = Array.isArray(body.gameIds) ? body.gameIds.slice(0, 3) : [];
    return {
      body: await store.mutate((doc) => {
        const week = requireWeek(doc, number);
        if (week.status !== 'draft') throw new HttpError(403, 'Week is published - unlock it to change games');
        const pool = new Map((week.collegeCandidates || []).map((g) => [g.id, g]));
        for (const g of week.games.filter((x) => x.sport === 'ncaaf')) if (!pool.has(g.id)) pool.set(g.id, g);
        const chosen = ids.map((id) => {
          const g = pool.get(id);
          if (!g) throw new HttpError(400, `Unknown college game ${id}`);
          return stripSuggestion({ ...g });
        });
        week.games = [...week.games.filter((g) => g.sport !== 'ncaaf'), ...chosen];
        state.logAudit(doc, 'commissioner', 'week.select-college', {
          week: number,
          games: chosen.map((g) => `${g.awayTeam} @ ${g.homeTeam}`),
        });
        return { selected: chosen.length };
      }),
    };
  });

  route('POST', '/api/admin/week/refresh-lines', async (req) => {
    requireAdmin(req);
    const body = await readBody(req);
    return { body: await refreshLines(Number(body.week)) };
  });

  route('POST', '/api/admin/week/publish', async (req) => {
    requireAdmin(req);
    const body = await readBody(req);
    return { body: await publishWeek(Number(body.week)) };
  });

  route('POST', '/api/admin/week/unlock', async (req) => {
    requireAdmin(req);
    const body = await readBody(req);
    const number = Number(body.week);
    return {
      body: await store.mutate((doc) => {
        const week = requireWeek(doc, number);
        week.status = 'draft';
        state.logAudit(doc, 'commissioner', 'week.unlock', { week: number, reason: body.reason || null });
        return { week: number, status: week.status };
      }),
    };
  });

  route('POST', '/api/admin/week/complete', async (req) => {
    requireAdmin(req);
    const body = await readBody(req);
    const number = Number(body.week);
    return {
      body: await store.mutate((doc) => {
        const week = requireWeek(doc, number);
        week.status = 'complete';
        state.logAudit(doc, 'commissioner', 'week.complete', { week: number });
        return { week: number, status: week.status };
      }),
    };
  });

  route('POST', '/api/admin/week/deadlines', async (req) => {
    requireAdmin(req);
    const body = await readBody(req);
    const number = Number(body.week);
    return {
      body: await store.mutate((doc) => {
        const week = requireWeek(doc, number);
        if (body.survivorLockAt !== undefined) {
          week.survivorLockAt = body.survivorLockAt ? new Date(body.survivorLockAt).toISOString() : null;
        }
        if (Array.isArray(body.kickoffs)) {
          for (const k of body.kickoffs) {
            const game = week.games.find((g) => g.id === k.gameId);
            if (game && k.commenceTime) game.commenceTime = new Date(k.commenceTime).toISOString();
          }
        }
        state.logAudit(doc, 'commissioner', 'week.deadlines', {
          week: number,
          survivorLockAt: week.survivorLockAt,
          kickoffs: (body.kickoffs || []).length,
        });
        return { survivorLockAt: week.survivorLockAt };
      }),
    };
  });

  route('POST', '/api/admin/game/spread', async (req) => {
    requireAdmin(req);
    const body = await readBody(req);
    const number = Number(body.week);
    const spread = body.spread === null || body.spread === '' ? null : Number(body.spread);
    if (spread !== null && !Number.isFinite(spread)) throw new HttpError(400, 'Spread must be a number');
    return {
      body: await store.mutate((doc) => {
        const week = requireWeek(doc, number);
        const game = week.games.find((g) => g.id === body.gameId);
        if (!game) throw new HttpError(404, 'Game not found in this week');
        const before = game.spread;
        game.spread = spread;
        game.spreadSource = body.source || 'Commissioner';
        game.spreadCapturedAt = new Date().toISOString();
        game.spreadManual = true;
        state.logAudit(doc, 'commissioner', 'game.spread-override', {
          week: number,
          game: `${game.awayTeam} @ ${game.homeTeam}`,
          before,
          after: spread,
          reason: body.reason || null,
          weekWasPublished: week.status !== 'draft',
        });
        return { gameId: game.id, spread: game.spread, source: game.spreadSource };
      }),
    };
  });

  route('POST', '/api/admin/game/labels', async (req) => {
    requireAdmin(req);
    const body = await readBody(req);
    const number = Number(body.week);
    return {
      body: await store.mutate((doc) => {
        const week = requireWeek(doc, number);
        const game = week.games.find((g) => g.id === body.gameId);
        if (!game) throw new HttpError(404, 'Game not found in this week');
        game.homeLabel = body.homeLabel ? String(body.homeLabel).slice(0, 40) : null;
        game.awayLabel = body.awayLabel ? String(body.awayLabel).slice(0, 40) : null;
        state.logAudit(doc, 'commissioner', 'game.labels', {
          week: number,
          game: `${game.awayTeam} @ ${game.homeTeam}`,
          homeLabel: game.homeLabel,
          awayLabel: game.awayLabel,
        });
        return { ok: true };
      }),
    };
  });

  route('POST', '/api/admin/game/score', async (req) => {
    requireAdmin(req);
    const body = await readBody(req);
    const number = Number(body.week);
    return {
      body: await store.mutate((doc) => {
        const week = requireWeek(doc, number);
        const game = week.games.find((g) => g.id === body.gameId);
        if (!game) throw new HttpError(404, 'Game not found in this week');
        if (body.homeScore === null || body.homeScore === '' || body.homeScore === undefined) {
          const before = game.final;
          game.final = null;
          state.logAudit(doc, 'commissioner', 'game.score-cleared', {
            week: number,
            game: `${game.awayTeam} @ ${game.homeTeam}`,
            before,
          });
          return { gameId: game.id, final: null };
        }
        const homeScore = Number(body.homeScore);
        const awayScore = Number(body.awayScore);
        if (!Number.isInteger(homeScore) || !Number.isInteger(awayScore) || homeScore < 0 || awayScore < 0) {
          throw new HttpError(400, 'Scores must be whole numbers');
        }
        const before = game.final;
        game.final = { homeScore, awayScore, at: new Date().toISOString(), source: 'manual' };
        state.logAudit(doc, 'commissioner', 'game.score', {
          week: number,
          game: `${game.awayTeam} @ ${game.homeTeam}`,
          before,
          after: `${awayScore}-${homeScore}`,
        });
        return { gameId: game.id, final: game.final };
      }),
    };
  });

  route('POST', '/api/admin/week/fetch-scores', async (req) => {
    requireAdmin(req);
    const body = await readBody(req);
    return { body: await fetchWeekScores(Number(body.week)) };
  });

  route('POST', '/api/admin/game/add', async (req) => {
    requireAdmin(req);
    const body = await readBody(req);
    const number = Number(body.week);
    return {
      body: await store.mutate((doc) => {
        const week = requireWeek(doc, number);
        if (week.status !== 'draft') throw new HttpError(403, 'Unlock the week before adding games');
        if (!body.homeTeam || !body.awayTeam || !body.commenceTime) {
          throw new HttpError(400, 'homeTeam, awayTeam and commenceTime are required');
        }
        const game = {
          id: `manual_${state.randomId(5)}`,
          sport: body.sport === 'ncaaf' ? 'ncaaf' : 'nfl',
          commenceTime: new Date(body.commenceTime).toISOString(),
          homeTeam: String(body.homeTeam).slice(0, 60),
          awayTeam: String(body.awayTeam).slice(0, 60),
          homeLabel: null,
          awayLabel: null,
          spread: body.spread === undefined || body.spread === '' ? null : Number(body.spread),
          spreadSource: 'Commissioner',
          spreadCapturedAt: new Date().toISOString(),
          spreadManual: true,
          final: null,
        };
        week.games.push(game);
        state.logAudit(doc, 'commissioner', 'game.add-manual', {
          week: number,
          game: `${game.awayTeam} @ ${game.homeTeam}`,
        });
        return { gameId: game.id };
      }),
    };
  });

  route('POST', '/api/admin/game/remove', async (req) => {
    requireAdmin(req);
    const body = await readBody(req);
    const number = Number(body.week);
    return {
      body: await store.mutate((doc) => {
        const week = requireWeek(doc, number);
        if (week.status !== 'draft') throw new HttpError(403, 'Unlock the week before removing games');
        const game = week.games.find((g) => g.id === body.gameId);
        if (!game) throw new HttpError(404, 'Game not found');
        week.games = week.games.filter((g) => g.id !== body.gameId);
        for (const key of Object.keys(doc.picks)) {
          if (key.endsWith(`|${body.gameId}`) && key.startsWith(`${number}|`)) delete doc.picks[key];
        }
        state.logAudit(doc, 'commissioner', 'game.remove', {
          week: number,
          game: `${game.awayTeam} @ ${game.homeTeam}`,
        });
        return { removed: body.gameId };
      }),
    };
  });

  route('POST', '/api/admin/participants', async (req) => {
    requireAdmin(req);
    const body = await readBody(req);
    return {
      body: await store.mutate((doc) => {
        for (const update of body.participants || []) {
          const p = state.participantById(doc, update.id);
          if (!p) continue;
          const before = { name: p.name, active: p.active };
          if (typeof update.name === 'string' && update.name.trim()) p.name = update.name.trim().slice(0, 40);
          if (typeof update.active === 'boolean') p.active = update.active;
          if (update.resetPin) p.pin = state.randomPin();
          if (update.resetLink) p.token = state.randomId(10);
          state.logAudit(doc, 'commissioner', 'participant.update', {
            id: p.id,
            before,
            after: { name: p.name, active: p.active },
            resetPin: !!update.resetPin,
            resetLink: !!update.resetLink,
          });
        }
        if (typeof body.addName === 'string' && body.addName.trim()) {
          const p = state.makeParticipant(body.addName.trim().slice(0, 40));
          doc.participants.push(p);
          state.logAudit(doc, 'commissioner', 'participant.add', { id: p.id, name: p.name });
        }
        return { participants: doc.participants };
      }),
    };
  });

  route('POST', '/api/admin/settings', async (req) => {
    requireAdmin(req);
    const body = await readBody(req);
    return {
      body: await store.mutate((doc) => {
        if (body.strikeRule !== undefined) {
          const rule = Number(body.strikeRule);
          if (rule !== 1 && rule !== 2) throw new HttpError(400, 'Strike rule must be 1 or 2');
          const before = doc.settings.strikeRule;
          doc.settings.strikeRule = rule;
          state.logAudit(doc, 'commissioner', 'settings.strike-rule', { before, after: rule });
        }
        if (typeof body.poolName === 'string' && body.poolName.trim()) {
          doc.settings.poolName = body.poolName.trim().slice(0, 40);
        }
        if (body.currentWeek !== undefined && body.currentWeek !== null) {
          const n = Number(body.currentWeek);
          if (!state.getWeek(doc, n)) throw new HttpError(404, `Week ${n} does not exist`);
          doc.settings.currentWeek = n;
        }
        return doc.settings;
      }),
    };
  });

  route('POST', '/api/admin/pick-override', async (req) => {
    requireAdmin(req);
    const body = await readBody(req);
    const number = Number(body.week);
    return {
      body: await store.mutate((doc) => {
        const week = requireWeek(doc, number);
        const game = week.games.find((g) => g.id === body.gameId);
        if (!game) throw new HttpError(404, 'Game not found in this week');
        const p = state.participantById(doc, body.participantId);
        if (!p) throw new HttpError(404, 'Participant not found');
        const key = state.pickKey(number, p.id, game.id);
        const before = doc.picks[key] || null;
        if (body.side === null || body.side === '') delete doc.picks[key];
        else if (body.side === 'home' || body.side === 'away') {
          doc.picks[key] = { side: body.side, at: new Date().toISOString(), byCommissioner: true };
        } else throw new HttpError(400, 'side must be home, away or empty');
        state.logAudit(doc, 'commissioner', 'pick.override', {
          week: number,
          participant: p.name,
          game: `${game.awayTeam} @ ${game.homeTeam}`,
          before: before ? before.side : null,
          after: body.side || null,
        });
        return { ok: true };
      }),
    };
  });

  route('POST', '/api/admin/survivor-override', async (req) => {
    requireAdmin(req);
    const body = await readBody(req);
    const number = Number(body.week);
    return {
      body: await store.mutate((doc) => {
        requireWeek(doc, number);
        const p = state.participantById(doc, body.participantId);
        if (!p) throw new HttpError(404, 'Participant not found');
        const key = state.survivorKey(number, p.id);
        const before = doc.survivorPicks[key] || null;
        if (!body.team) delete doc.survivorPicks[key];
        else doc.survivorPicks[key] = { team: String(body.team), at: new Date().toISOString(), byCommissioner: true };
        state.logAudit(doc, 'commissioner', 'survivor.override', {
          week: number,
          participant: p.name,
          before: before ? before.team : null,
          after: body.team || null,
        });
        return { ok: true };
      }),
    };
  });

  route('GET', '/api/admin/audit', async (req) => {
    requireAdmin(req);
    const doc = await store.read();
    return { body: { audit: doc.audit } };
  });

  /**
   * Optional Friday automation. Point any free scheduler at
   *   POST /api/cron/prepare-week?key=<CRON_SECRET>
   * and the week is created, the Sunday NFL slate imported, the college top 3
   * suggested and the spreads captured before the commissioner even opens the
   * admin page. It deliberately does NOT publish - a person still reviews and
   * presses Publish & Lock.
   *
   * Schedule it at both 15:00 and 16:00 UTC on Fridays: the handler only acts
   * during the 10 AM Central hour, so exactly one of them runs whether or not
   * daylight saving is in effect. Pass force=1 to bypass the hour check.
   */
  route('POST', '/api/cron/prepare-week', async (req, { query }) => {
    if (!config.cronSecret) throw new HttpError(404, 'Scheduled capture is not enabled (set CRON_SECRET)');
    const key = query.get('key') || req.headers['x-cron-key'];
    if (!auth.pinMatches(key, config.cronSecret)) throw new HttpError(401, 'Bad cron key');
    const hourCt = timeutil.ctParts(new Date()).hour;
    const force = query.get('force') === '1';
    if (!force && hourCt !== 10) {
      return { body: { skipped: true, reason: `it is ${hourCt}:00 Central, not the 10 AM capture hour` } };
    }
    const out = await prepareNextWeek({});
    await store.mutate((doc) => {
      state.logAudit(doc, 'scheduled-capture', 'week.friday-capture', { week: out.week, notes: out.notes });
    });
    return { body: { ...out, ranAt: timeutil.formatStamp(new Date()) } };
  });

  route('GET', '/api/admin/nfl-teams', async (req) => {
    requireAdmin(req);
    return { body: { teams: NFL_TEAMS } };
  });

  // ------------------------------------------------------------ static files

  async function serveStatic(req, res, pathname) {
    let rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    if (rel === 'admin' || rel === 'admin/') rel = 'admin.html';
    const full = path.join(PUBLIC_DIR, rel);
    if (!full.startsWith(PUBLIC_DIR)) {
      send(res, 403, { error: 'Forbidden' });
      return;
    }
    try {
      const data = await fsp.readFile(full);
      const ext = path.extname(full).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=300',
      });
      res.end(data);
    } catch {
      send(res, 404, { error: 'Not found' });
    }
  }

  // --------------------------------------------------------------- handler

  async function handler(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname.replace(/\/+$/, '') || '/';

    if (pathname.startsWith('/api/')) {
      const match = routes.find((r) => r.pattern === pathname && r.method === req.method);
      if (!match) {
        send(res, 404, { error: `No route for ${req.method} ${pathname}` });
        return;
      }
      try {
        const result = await match.handler(req, { query: url.searchParams, url });
        send(res, 200, result.body, result.headers || {});
      } catch (err) {
        const status = err.status || 500;
        if (status >= 500) console.error('[ghm-pool]', req.method, pathname, err);
        send(res, status, { error: err.message || 'Something went wrong' });
      }
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      send(res, 405, { error: 'Method not allowed' });
      return;
    }
    await serveStatic(req, res, pathname);
  }

  handler.store = store;
  handler.config = config;
  return handler;
}

module.exports = { createApp, HttpError };
