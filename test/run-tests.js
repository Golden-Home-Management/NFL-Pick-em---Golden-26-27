'use strict';
/**
 * End-to-end tests for the GHM Football Pool.
 * Runs the real HTTP app against a mocked Odds API and a temp data file.
 *
 *   npm test
 */

const assert = require('assert');
const { startServer, client } = require('./harness');
const { installMockOdds, NFL_EVENTS } = require('./mock-odds');
const odds = require('../src/odds');
const timeutil = require('../src/time');

let passed = 0;
const failures = [];
const groups = [];

function group(name) {
  groups.push(name);
  console.log(`\n\x1b[1m${name}\x1b[0m`);
}

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  \x1b[31m✗ ${name}\x1b[0m\n      ${err.message}`);
  }
}

const iso = (minutesFromNow) => new Date(Date.now() + minutesFromNow * 60000).toISOString();

/* ========================================================================= */
/* 1. Pure scoring rules                                                     */
/* ========================================================================= */

function testScoringUnits() {
  group('ATS + survivor rules');
  const scoring = require('../src/scoring');

  const g = (spread, home, away) => ({
    id: 'g', sport: 'nfl', commenceTime: '2026-09-13T17:00:00Z',
    homeTeam: 'Dallas Cowboys', awayTeam: 'Philadelphia Eagles',
    spread, final: { homeScore: home, awayScore: away },
  });

  check('favourite covers: -7.5, wins by 11 -> home win / away loss', () => {
    assert.strictEqual(scoring.gradeAts(g(-7.5, 31, 20), 'home'), 'win');
    assert.strictEqual(scoring.gradeAts(g(-7.5, 31, 20), 'away'), 'loss');
  });
  check('favourite fails to cover: -7.5, wins by 3', () => {
    assert.strictEqual(scoring.gradeAts(g(-7.5, 24, 21), 'home'), 'loss');
    assert.strictEqual(scoring.gradeAts(g(-7.5, 24, 21), 'away'), 'win');
  });
  check('exact push on a whole number: -3, wins by 3 -> push both sides', () => {
    assert.strictEqual(scoring.gradeAts(g(-3, 24, 21), 'home'), 'push');
    assert.strictEqual(scoring.gradeAts(g(-3, 24, 21), 'away'), 'push');
  });
  check('underdog spread is the mirror image (+3 dog loses by 2 -> win)', () => {
    assert.strictEqual(scoring.gradeAts(g(-3, 23, 21), 'away'), 'win');
  });
  check('pick-em line (0) grades on the straight-up result', () => {
    assert.strictEqual(scoring.gradeAts(g(0, 21, 20), 'home'), 'win');
    assert.strictEqual(scoring.gradeAts(g(0, 20, 20), 'home'), 'push');
  });
  check('half-point line can never push', () => {
    assert.strictEqual(scoring.gradeAts(g(-0.5, 20, 20), 'home'), 'loss');
    assert.strictEqual(scoring.gradeAts(g(-0.5, 20, 20), 'away'), 'win');
  });
  check('no final score -> ungraded (null)', () => {
    const ungraded = { ...g(-3, 0, 0), final: null };
    assert.strictEqual(scoring.gradeAts(ungraded, 'home'), null);
  });
  check('points: win 1, push 0.5, loss 0', () => {
    assert.strictEqual(scoring.ATS_POINTS.win, 1);
    assert.strictEqual(scoring.ATS_POINTS.push, 0.5);
    assert.strictEqual(scoring.ATS_POINTS.loss, 0);
  });
  check('straight-up grading drives survivor', () => {
    assert.strictEqual(scoring.gradeStraightUp(g(-7.5, 31, 20), 'Dallas Cowboys'), 'win');
    assert.strictEqual(scoring.gradeStraightUp(g(-7.5, 31, 20), 'Philadelphia Eagles'), 'loss');
    assert.strictEqual(scoring.gradeStraightUp(g(-7.5, 20, 20), 'Dallas Cowboys'), 'tie');
  });
  check('a game locks exactly at kickoff', () => {
    const future = { commenceTime: iso(1) };
    const past = { commenceTime: iso(-1) };
    assert.strictEqual(scoring.isGameLocked(future), false);
    assert.strictEqual(scoring.isGameLocked(past), true);
  });

  group('Sportsbook hierarchy (one frozen line, never an average)');
  const mkEvent = (books) => ({
    id: 'e', commence_time: '2026-09-13T17:00:00Z', home_team: 'H', away_team: 'A',
    bookmakers: books.map(([key, point]) => ({
      key, markets: [{ key: 'spreads', outcomes: [{ name: 'H', point }, { name: 'A', point: -point }] }],
    })),
  });
  check('DraftKings wins when present', () => {
    const r = odds.chooseSpread(mkEvent([['fanduel', -3], ['draftkings', -3.5], ['betmgm', -4]]));
    assert.strictEqual(r.source, 'DraftKings');
    assert.strictEqual(r.spread, -3.5);
  });
  check('falls back to FanDuel', () => {
    const r = odds.chooseSpread(mkEvent([['betmgm', -4], ['fanduel', -3]]));
    assert.strictEqual(r.source, 'FanDuel');
  });
  check('falls back to BetMGM', () => {
    assert.strictEqual(odds.chooseSpread(mkEvent([['betmgm', -4], ['bovada', -9]])).source, 'BetMGM');
  });
  check('falls back to Caesars', () => {
    assert.strictEqual(odds.chooseSpread(mkEvent([['williamhill_us', -4], ['bovada', -9]])).source, 'Caesars');
  });
  check('returns null when only unlisted books have a line (commissioner enters it)', () => {
    assert.strictEqual(odds.chooseSpread(mkEvent([['bovada', -9], ['pinnacle', -8]])), null);
  });

  group('Central time handling');
  check('Sunday noon CT is stored/read correctly across DST', () => {
    assert.strictEqual(timeutil.ctWeekday('2026-09-13T17:00:00Z'), 'Sunday');
    assert.strictEqual(timeutil.formatKickoff('2026-09-13T17:00:00Z'), 'Sun 12:00 PM CT');
    assert.strictEqual(timeutil.formatKickoff('2027-01-10T18:00:00Z'), 'Sun 12:00 PM CT');
  });
  check('late Sunday night games stay on Sunday in Central', () => {
    assert.strictEqual(timeutil.ctWeekday('2026-09-14T00:20:00Z'), 'Sunday');
    assert.strictEqual(timeutil.ctDate('2026-09-14T00:20:00Z'), '2026-09-13');
  });
  check('Monday night is Monday in Central', () => {
    assert.strictEqual(timeutil.ctWeekday('2026-09-15T00:15:00Z'), 'Monday');
  });
}

/* ========================================================================= */
/* 2. Friday import workflow                                                 */
/* ========================================================================= */

async function testFridayWorkflow() {
  group('Friday workflow: import, filter, freeze');
  const mock = installMockOdds();
  const srv = await startServer();
  const admin = client(srv.base);
  const anon = client(srv.base);

  try {
    let res = await admin.post('/api/admin/state');
    res = await admin.get('/api/admin/state');
    check('admin endpoints reject an unauthenticated caller', () => {
      assert.strictEqual(res.status, 401);
    });

    res = await admin.post('/api/admin/login', { pin: '0000' });
    check('wrong commissioner PIN is rejected', () => assert.strictEqual(res.status, 401));

    res = await admin.post('/api/admin/login', { pin: '9137' });
    check('correct commissioner PIN signs in', () => assert.strictEqual(res.status, 200));

    res = await admin.post('/api/admin/week/start', { sundayDate: '2026-09-13' });
    const startOut = res.data;
    check('Start Next Week creates week 1', () => {
      assert.strictEqual(res.status, 200);
      assert.strictEqual(startOut.week, 1);
      assert.strictEqual(startOut.saturdayDate, '2026-09-12');
    });

    res = await admin.get('/api/admin/week?week=1');
    const week = res.data;

    check('only Sunday NFL games are imported (Thursday and Monday excluded)', () => {
      assert.strictEqual(week.nfl.length, 4, `expected 4 Sunday games, got ${week.nfl.length}`);
      const ids = week.nfl.map((g) => g.id);
      assert.ok(!ids.includes('nfl-thu'), 'Thursday game leaked in');
      assert.ok(!ids.includes('nfl-mon'), 'Monday game leaked in');
      for (const g of week.nfl) {
        assert.strictEqual(timeutil.ctWeekday(g.commenceTime), 'Sunday');
      }
    });

    check('games arrive in chronological order', () => {
      const times = week.nfl.map((g) => new Date(g.commenceTime).getTime());
      assert.deepStrictEqual(times, [...times].sort((a, b) => a - b));
    });

    check('every spread comes from DraftKings and records source + timestamp', () => {
      for (const g of week.nfl) {
        assert.strictEqual(g.spreadSource, 'DraftKings');
        assert.strictEqual(typeof g.spread, 'number');
        assert.ok(g.spreadCapturedAt, 'no capture timestamp');
      }
    });

    check('exactly 3 Saturday college games are suggested and selected', () => {
      assert.strictEqual(week.college.length, 3);
      for (const g of week.college) {
        assert.strictEqual(timeutil.ctWeekday(g.commenceTime), 'Saturday');
      }
    });

    check('the suggestion ranks marquee matchups first', () => {
      const chosen = week.college.map((g) => g.id).sort();
      assert.deepStrictEqual(chosen, ['cfb-1', 'cfb-2', 'cfb-3']);
    });

    check('Friday college games are never candidates', () => {
      assert.ok(!week.collegeCandidates.some((g) => g.id === 'cfb-fri'));
      assert.strictEqual(week.collegeCandidates.length, 5);
    });

    // The commissioner swaps one college game for another.
    res = await admin.post('/api/admin/week/select-college', {
      week: 1, gameIds: ['cfb-1', 'cfb-2', 'cfb-4'],
    });
    const afterSwap = (await admin.get('/api/admin/week?week=1')).data;
    check('commissioner can replace an individual college game', () => {
      assert.strictEqual(res.status, 200);
      assert.deepStrictEqual(afterSwap.college.map((g) => g.id).sort(), ['cfb-1', 'cfb-2', 'cfb-4']);
    });

    // Put the marquee game back.
    await admin.post('/api/admin/week/select-college', { week: 1, gameIds: ['cfb-1', 'cfb-2', 'cfb-3'] });

    res = await anon.get('/api/week?week=1');
    check('a draft week is invisible to participants', () => assert.strictEqual(res.status, 403));

    // A manual line correction is recorded.
    const target = afterSwap.nfl[0];
    res = await admin.post('/api/admin/game/spread', {
      week: 1, gameId: target.id, spread: -6.5, reason: 'DK had a typo',
    });
    check('commissioner can enter a line manually', () => assert.strictEqual(res.status, 200));

    res = await admin.post('/api/admin/week/publish', { week: 1 });
    const publish = res.data;
    check('Publish & Lock freezes the week', () => {
      assert.strictEqual(res.status, 200, JSON.stringify(publish));
      assert.ok(publish.linesLockedAt);
      assert.ok(String(publish.lineSource).includes('DraftKings'));
    });

    res = await anon.get('/api/week?week=1');
    check('participants can see the week once published', () => {
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.data.nfl.length, 4);
      assert.ok(res.data.linesLockedLabel.includes('CT'));
    });
    check('the locked-line stamp names the sportsbook', () => {
      assert.ok(res.data.lineSource.includes('DraftKings'), res.data.lineSource);
    });

    // Lines must not move after the lock, even though the book has.
    const before = (await anon.get('/api/week?week=1')).data.nfl.map((g) => g.spread);
    const moved = NFL_EVENTS.map((e) => ({
      ...e,
      bookmakers: e.bookmakers.map((b) => ({
        ...b,
        markets: b.markets.map((m) => ({
          ...m,
          outcomes: m.outcomes.map((o) => ({ ...o, point: o.point + 3 })),
        })),
      })),
    }));
    mock.restore();
    const mock2 = installMockOdds({ nfl: moved });
    res = await admin.post('/api/admin/week/refresh-lines', { week: 1 });
    const after = (await anon.get('/api/week?week=1')).data.nfl.map((g) => g.spread);
    check('Refresh Lines is refused once the week is published', () => {
      assert.strictEqual(res.status, 403);
    });
    check('published spreads do not move when the sportsbook moves', () => {
      assert.deepStrictEqual(after, before);
    });

    // Unlock -> refresh -> lines move again; recorded in the audit log.
    await admin.post('/api/admin/week/unlock', { week: 1, reason: 'testing a data error' });
    res = await admin.post('/api/admin/week/refresh-lines', { week: 1 });
    const refreshed = (await admin.get('/api/admin/week?week=1')).data.nfl.map((g) => g.spread);
    check('an unlocked week can be refreshed', () => {
      assert.strictEqual(res.status, 200);
      assert.notDeepStrictEqual(refreshed, before);
    });
    mock2.restore();

    res = await admin.get('/api/admin/audit');
    const actions = res.data.audit.map((a) => a.action);
    check('every commissioner action is written to the audit log', () => {
      for (const a of ['week.create', 'week.import-nfl', 'week.select-college', 'game.spread-override', 'week.publish', 'week.unlock', 'week.refresh-lines']) {
        assert.ok(actions.includes(a), `missing audit entry: ${a}`);
      }
    });
    check('the audit log records the before/after of a line override', () => {
      const entry = res.data.audit.find((a) => a.action === 'game.spread-override');
      assert.strictEqual(entry.detail.after, -6.5);
      assert.strictEqual(entry.detail.reason, 'DK had a typo');
    });
  } finally {
    installMockOdds().restore();
    await srv.close();
  }
}

/* ========================================================================= */
/* 3. Publishing guards + API failure fallback                               */
/* ========================================================================= */

async function testPublishGuards() {
  group('Publish guards and Odds API failure fallback');
  const noLine = [{
    id: 'nfl-noline', commence_time: '2026-09-13T17:00:00Z',
    home_team: 'Dallas Cowboys', away_team: 'Philadelphia Eagles',
    bookmakers: [{ key: 'bovada', markets: [{ key: 'spreads', outcomes: [{ name: 'Dallas Cowboys', point: -7 }, { name: 'Philadelphia Eagles', point: 7 }] }] }],
  }];
  let mock = installMockOdds({ nfl: noLine, ncaaf: [] });
  const srv = await startServer();
  const admin = client(srv.base);
  try {
    await admin.post('/api/admin/login', { pin: '9137' });
    await admin.post('/api/admin/week/start', { sundayDate: '2026-09-13' });

    let res = await admin.post('/api/admin/week/publish', { week: 1 });
    check('publishing is blocked while a game has no spread', () => {
      assert.strictEqual(res.status, 400);
      assert.ok(/no spread/i.test(res.data.error), res.data.error);
    });

    const w = (await admin.get('/api/admin/week?week=1')).data;
    check('a game none of the four books priced comes through with a null spread', () => {
      assert.strictEqual(w.nfl.length, 1);
      assert.strictEqual(w.nfl[0].spread, null);
    });

    await admin.post('/api/admin/game/spread', { week: 1, gameId: 'nfl-noline', spread: -7, reason: 'no DK/FD/MGM/Caesars line' });
    res = await admin.post('/api/admin/week/publish', { week: 1 });
    check('after manual entry the week publishes', () => assert.strictEqual(res.status, 200));
    check('the frozen line is attributed to the commissioner', () => {
      assert.strictEqual(res.data.lineSource, 'Commissioner');
    });

    // Now simulate a total Odds API outage on the next week.
    mock.restore();
    mock = installMockOdds({ fail: true });
    res = await admin.post('/api/admin/week/start', {});
    check('Start Next Week survives an Odds API outage and still creates the week', () => {
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.data.week, 2);
      assert.ok(res.data.notes.some((n) => /failed/i.test(n)), JSON.stringify(res.data.notes));
    });

    res = await admin.post('/api/admin/game/add', {
      week: 2, sport: 'nfl', awayTeam: 'Chicago Bears', homeTeam: 'Green Bay Packers',
      commenceTime: '2026-09-20T17:00:00Z', spread: -6,
    });
    check('games can be added by hand when the feed is down', () => assert.strictEqual(res.status, 200));

    // Pressing Start Next Week again must not spawn a third week while week 2
    // is still an unpublished draft.
    res = await admin.post('/api/admin/week/start', {});
    check('Start Next Week is idempotent while the newest week is a draft', () => {
      assert.strictEqual(res.data.week, 2);
    });
    const weekList = (await admin.get('/api/admin/state')).data.weeks.map((w) => w.number);
    check('no duplicate week was created', () => assert.deepStrictEqual(weekList, [1, 2]));

    res = await admin.post('/api/admin/week/publish', { week: 2 });
    check('a hand-built week publishes normally', () => assert.strictEqual(res.status, 200));
  } finally {
    mock.restore();
    await srv.close();
  }
}

/* ========================================================================= */
/* 4. Participant gameplay: picks, locking, survivor, scoring, standings     */
/* ========================================================================= */

async function testCron() {
  group('Scheduled Friday capture');
  const mock = installMockOdds();
  const off = await startServer();
  const offClient = client(off.base);
  try {
    const res = await offClient.post('/api/cron/prepare-week?key=whatever');
    check('the cron endpoint is off unless CRON_SECRET is set', () => assert.strictEqual(res.status, 404));
  } finally {
    await off.close();
  }

  const srv = await startServer({ cronSecret: 'friday-secret' });
  const cron = client(srv.base);
  const admin = client(srv.base);
  try {
    let res = await cron.post('/api/cron/prepare-week?key=wrong');
    check('a wrong cron key is rejected', () => assert.strictEqual(res.status, 401));

    res = await cron.post('/api/cron/prepare-week?key=friday-secret');
    const hourCt = timeutil.ctParts(new Date()).hour;
    check('outside the 10 AM Central hour it does nothing (DST-proof double schedule)', () => {
      if (hourCt === 10) assert.strictEqual(res.data.week, 1);
      else assert.strictEqual(res.data.skipped, true);
    });

    res = await cron.post('/api/cron/prepare-week?key=friday-secret&force=1');
    check('with force=1 it builds the week and captures the lines', () => {
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.data.week, 1);
      assert.ok(res.data.ranAt.includes('CT'));
    });

    await admin.post('/api/admin/login', { pin: '9137' });
    const wk = (await admin.get('/api/admin/week?week=1')).data;
    check('the scheduled capture leaves a reviewable draft, never a published week', () => {
      assert.strictEqual(wk.status, 'draft');
      assert.ok(wk.nfl.length > 0);
      assert.ok(wk.college.length > 0);
    });
    const audit = (await admin.get('/api/admin/audit')).data.audit;
    check('the capture is attributed to the scheduler in the audit log', () => {
      const e = audit.find((a) => a.action === 'week.friday-capture');
      assert.ok(e, 'no friday-capture audit entry');
      assert.strictEqual(e.actor, 'scheduled-capture');
    });

    res = await cron.post('/api/cron/prepare-week?key=friday-secret&force=1');
    const list = (await admin.get('/api/admin/state')).data.weeks.map((w) => w.number);
    check('running twice does not create a second week', () => {
      assert.deepStrictEqual(list, [1]);
    });
  } finally {
    mock.restore();
    await srv.close();
  }
}

async function testGameplay() {
  group('Participants: picks, locks and visibility');
  const mock = installMockOdds({ nfl: [], ncaaf: [] });
  const srv = await startServer();
  const admin = client(srv.base);
  const evan = client(srv.base);
  const sarah = client(srv.base);
  const anon = client(srv.base);

  try {
    await admin.post('/api/admin/login', { pin: '9137' });
    await admin.post('/api/admin/week/start', { sundayDate: timeutil.ctDate(new Date()) });

    // Build a controlled slate: three games still to come, one already kicked off.
    const add = async (body) => (await admin.post('/api/admin/game/add', { week: 1, ...body })).data.gameId;
    const gCover = await add({ sport: 'nfl', awayTeam: 'Philadelphia Eagles', homeTeam: 'Dallas Cowboys', commenceTime: iso(120), spread: -7.5 });
    const gDog = await add({ sport: 'nfl', awayTeam: 'Chicago Bears', homeTeam: 'Green Bay Packers', commenceTime: iso(180), spread: -8 });
    const gPush = await add({ sport: 'nfl', awayTeam: 'Seattle Seahawks', homeTeam: 'San Francisco 49ers', commenceTime: iso(240), spread: -3 });
    const gKicked = await add({ sport: 'nfl', awayTeam: 'Miami Dolphins', homeTeam: 'Buffalo Bills', commenceTime: iso(-60), spread: -6.5 });
    const cA = await add({ sport: 'ncaaf', awayTeam: 'Texas Longhorns', homeTeam: 'Michigan Wolverines', commenceTime: iso(90), spread: 7.5 });
    const cB = await add({ sport: 'ncaaf', awayTeam: 'Alabama Crimson Tide', homeTeam: 'Georgia Bulldogs', commenceTime: iso(100), spread: -2.5 });
    const cC = await add({ sport: 'ncaaf', awayTeam: 'Penn State Nittany Lions', homeTeam: 'Ohio State Buckeyes', commenceTime: iso(-30), spread: -6 });

    // Survivor stays open even though one NFL game has kicked off.
    await admin.post('/api/admin/week/deadlines', { week: 1, survivorLockAt: iso(120) });
    let res = await admin.post('/api/admin/week/publish', { week: 1 });
    assert.strictEqual(res.status, 200, `publish failed: ${JSON.stringify(res.data)}`);

    // ---- participant sign-in
    const boot = (await anon.get('/api/bootstrap')).data;
    check('the pool starts with the five requested participant slots', () => {
      assert.strictEqual(boot.participants.length, 5);
      assert.deepStrictEqual(boot.participants.map((p) => p.name), ['Evan', 'Player 2', 'Player 3', 'Player 4', 'Player 5']);
    });
    check('the permanent URL always resolves to the newest published week', () => {
      assert.strictEqual(boot.currentWeek, 1);
    });

    const state = (await admin.get('/api/admin/state')).data;
    const pEvan = state.participants[0];
    const pSarah = state.participants[1];

    res = await evan.post('/api/login', { participantId: pEvan.id, pin: '0000' });
    check('a wrong participant PIN is rejected', () => assert.strictEqual(res.status, 401));

    res = await evan.post('/api/login', { participantId: pEvan.id, pin: pEvan.pin });
    check('participant 1 signs in with their PIN', () => {
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.data.me.name, 'Evan');
    });

    // Participant 2 arrives via their personal link instead of a PIN.
    res = await sarah.get(`/api/bootstrap?p=${pSarah.token}`);
    check('participant 2 signs in with their personal link (no PIN needed)', () => {
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.data.me.id, pSarah.id);
    });
    res = await sarah.get('/api/bootstrap');
    check('the personal link leaves them signed in on later visits', () => {
      assert.strictEqual(res.data.me.id, pSarah.id);
    });

    res = await anon.post('/api/picks', { week: 1, picks: [{ gameId: gCover, side: 'home' }] });
    check('an unauthenticated caller cannot submit picks', () => assert.strictEqual(res.status, 401));

    // ---- pick submission
    res = await evan.post('/api/picks', {
      week: 1,
      picks: [
        { gameId: gCover, side: 'home' },
        { gameId: gDog, side: 'away' },
        { gameId: gPush, side: 'home' },
        { gameId: cA, side: 'away' },
        { gameId: cB, side: 'home' },
      ],
    });
    check('participant 1 submits picks and they are all accepted', () => {
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.data.accepted.length, 5);
      assert.strictEqual(res.data.rejected.length, 0);
      assert.ok(res.data.savedAt, 'no submission timestamp stored');
    });

    res = await evan.get('/api/week?week=1');
    check('saved picks come back on the participant view with a timestamp', () => {
      const g = res.data.nfl.find((x) => x.id === gCover);
      assert.strictEqual(g.myPick, 'home');
      assert.ok(g.myPickAt);
    });

    res = await sarah.post('/api/picks', {
      week: 1,
      picks: [
        { gameId: gCover, side: 'away' },
        { gameId: gDog, side: 'home' },
        { gameId: gPush, side: 'away' },
        { gameId: cA, side: 'home' },
        { gameId: cB, side: 'away' },
      ],
    });
    check('participant 2 submits a different set of picks', () => {
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.data.rejected.length, 0);
    });

    // ---- visibility
    res = await evan.get('/api/week?week=1');
    check('other players\' picks are hidden before a game locks', () => {
      const g = res.data.nfl.find((x) => x.id === gCover);
      assert.strictEqual(g.locked, false);
      assert.strictEqual(g.picks, undefined, 'pick list leaked before lock');
      assert.strictEqual(g.pickPct, undefined, 'pick percentage leaked before lock');
    });
    check('picks on an already-kicked-off game are visible to everyone', () => {
      const g = res.data.nfl.find((x) => x.id === gKicked);
      assert.strictEqual(g.locked, true);
      assert.ok(Array.isArray(g.picks));
      assert.ok(g.pickPct);
    });
    check('the college game that already kicked off reveals its picks too', () => {
      const g = res.data.college.find((x) => x.id === cC);
      assert.strictEqual(g.locked, true);
      assert.ok(Array.isArray(g.picks));
    });

    // ---- change before lock
    res = await evan.post('/api/picks', { week: 1, picks: [{ gameId: gCover, side: 'away' }] });
    check('a pick can be changed while the game is still open', () => {
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.data.rejected.length, 0);
    });
    res = await evan.get('/api/week?week=1');
    check('the changed pick is what is stored', () => {
      assert.strictEqual(res.data.nfl.find((x) => x.id === gCover).myPick, 'away');
    });
    await evan.post('/api/picks', { week: 1, picks: [{ gameId: gCover, side: 'home' }] });

    // ---- blocked after lock
    res = await evan.post('/api/picks', { week: 1, picks: [{ gameId: gKicked, side: 'home' }] });
    check('a pick on a game that already kicked off is refused', () => {
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.data.accepted.length, 0);
      assert.strictEqual(res.data.rejected.length, 1);
      assert.ok(/locked/i.test(res.data.rejected[0].reason), res.data.rejected[0].reason);
    });
    res = await evan.get('/api/week?week=1');
    check('nothing was written for the locked game', () => {
      assert.strictEqual(res.data.nfl.find((x) => x.id === gKicked).myPick, null);
    });

    res = await evan.post('/api/picks', {
      week: 1,
      picks: [
        { gameId: gKicked, side: 'away' },  // locked
        { gameId: gPush, side: 'away' },    // still open
      ],
    });
    check('a mixed submission saves the open game and rejects only the locked one', () => {
      assert.strictEqual(res.data.accepted.length, 1);
      assert.strictEqual(res.data.accepted[0].gameId, gPush);
      assert.strictEqual(res.data.rejected.length, 1);
      assert.strictEqual(res.data.rejected[0].gameId, gKicked);
    });
    await evan.post('/api/picks', { week: 1, picks: [{ gameId: gPush, side: 'home' }] });

    res = await evan.post('/api/picks', { week: 1, picks: [{ gameId: 'not-a-game', side: 'home' }] });
    check('a pick on a game outside this week is refused', () => {
      assert.strictEqual(res.data.rejected.length, 1);
    });
    res = await evan.post('/api/picks', { week: 1, picks: [{ gameId: gPush, side: 'sideways' }] });
    check('an invalid side is refused', () => {
      assert.strictEqual(res.data.rejected.length, 1);
    });

    /* ------------------------------------------------------------ survivor */
    group('Survivor');

    res = await evan.get('/api/survivor?week=1');
    check('survivor offers both teams from every Sunday game', () => {
      assert.strictEqual(res.data.me.options.length, 8);
      assert.ok(res.data.me.options.some((o) => o.team === 'Dallas Cowboys'));
    });
    check('a team whose game already kicked off is not selectable', () => {
      const o = res.data.me.options.find((x) => x.team === 'Buffalo Bills');
      assert.strictEqual(o.locked, true);
    });
    check('college teams never appear in survivor', () => {
      assert.ok(!res.data.me.options.some((o) => /Longhorns|Bulldogs/.test(o.team)));
    });
    check('every player starts with 0 strikes and alive', () => {
      for (const b of res.data.board) {
        assert.strictEqual(b.strikes, 0);
        assert.strictEqual(b.alive, true);
      }
    });
    check('other players\' survivor picks are hidden before the lock', () => {
      assert.strictEqual(res.data.locked, false);
      for (const b of res.data.board) assert.strictEqual(b.weekPick, undefined);
    });

    res = await evan.post('/api/survivor', { week: 1, team: 'Buffalo Bills' });
    check('a survivor pick on a kicked-off team is refused', () => {
      assert.strictEqual(res.status, 403);
    });
    res = await evan.post('/api/survivor', { week: 1, team: 'Texas Longhorns' });
    check('a survivor pick on a team not in the slate is refused', () => {
      assert.strictEqual(res.status, 400);
    });

    res = await evan.post('/api/survivor', { week: 1, team: 'Dallas Cowboys' });
    check('participant 1 takes Dallas in week 1', () => assert.strictEqual(res.status, 200));
    res = await sarah.post('/api/survivor', { week: 1, team: 'Philadelphia Eagles' });
    check('participant 2 takes Philadelphia in week 1', () => assert.strictEqual(res.status, 200));

    /* ------------------------------------------------------------- scoring */
    group('Results, ATS scoring and standings');

    // Enter finals. Dallas -7.5 wins by 11 (covers). Green Bay -8 loses.
    // San Francisco -3 wins by exactly 3 => push.
    const score = (gameId, homeScore, awayScore) =>
      admin.post('/api/admin/game/score', { week: 1, gameId, homeScore, awayScore });
    await score(gCover, 31, 20);
    await score(gDog, 20, 24);
    await score(gPush, 24, 21);
    await score(cA, 17, 28);   // Michigan +7.5 at home, loses by 11 -> Texas covers
    await score(cB, 20, 19);   // Georgia -2.5 wins by 1 -> fails to cover

    res = await admin.post('/api/admin/game/score', { week: 1, gameId: gCover, homeScore: 'x', awayScore: 3 });
    check('a non-numeric score is refused', () => assert.strictEqual(res.status, 400));

    res = await evan.get('/api/results?week=1');
    const evanRow = res.data.weekly.find((r) => r.name === 'Evan');
    const sarahRow = res.data.weekly.find((r) => r.name === 'Player 2');
    check('ATS win scores 1 point', () => {
      const g = res.data.games.find((x) => x.id === gCover);
      assert.strictEqual(g.myResult, 'win');
    });
    check('a push scores 0.5 for both sides', () => {
      const g = res.data.games.find((x) => x.id === gPush);
      assert.strictEqual(g.myResult, 'push');
      const both = g.picks.filter((p) => p.side);
      assert.ok(both.length >= 2);
      for (const p of both) assert.strictEqual(p.result, 'push');
    });
    check('weekly total for participant 1 is 3.5 (3 wins, 1 push, 1 loss)', () => {
      assert.strictEqual(evanRow.points, 3.5, JSON.stringify(evanRow));
      assert.strictEqual(evanRow.wins, 3);
      assert.strictEqual(evanRow.pushes, 1);
      assert.strictEqual(evanRow.losses, 1);
    });
    check('weekly total for participant 2 is 1.5 (1 win, 1 push, 3 losses)', () => {
      assert.strictEqual(sarahRow.points, 1.5, JSON.stringify(sarahRow));
      assert.strictEqual(sarahRow.wins, 1);
      assert.strictEqual(sarahRow.pushes, 1);
      assert.strictEqual(sarahRow.losses, 3);
    });
    check('the two participants score differently from the same slate', () => {
      assert.notStrictEqual(evanRow.points, sarahRow.points);
    });
    check('the weekly leader is ranked first', () => {
      assert.strictEqual(res.data.weekly[0].name, 'Evan');
      assert.strictEqual(res.data.weekly[0].rank, 1);
    });
    check('players who made no picks score zero and still appear', () => {
      const zero = res.data.weekly.filter((r) => r.points === 0);
      assert.strictEqual(zero.length, 3);
    });
    check('pick percentage is reported per game once it locks', () => {
      const g = res.data.games.find((x) => x.id === gCover);
      assert.strictEqual(g.pickPct.total, 2);
      assert.strictEqual(g.pickPct.homePct, 50);
      assert.strictEqual(g.pickPct.awayPct, 50);
    });

    res = await evan.get('/api/standings?week=1');
    check('season standings match week 1 while only one week exists', () => {
      assert.strictEqual(res.data.season.find((r) => r.name === 'Evan').points, 3.5);
    });
    check('survivor board updates from the final scores', () => {
      const e = res.data.survivor.find((s) => s.name === 'Evan');
      const s = res.data.survivor.find((s) => s.name === 'Player 2');
      assert.strictEqual(e.strikes, 0);
      assert.strictEqual(e.alive, true);
      assert.deepStrictEqual(e.teamsUsed, ['Dallas Cowboys']);
      assert.strictEqual(s.strikes, 1, 'Philadelphia lost, that is a strike');
      assert.strictEqual(s.alive, true, 'two-strike rule keeps them alive');
    });

    res = await admin.post('/api/admin/game/score', { week: 1, gameId: gCover, homeScore: 20, awayScore: 31 });
    check('the commissioner can override a result', () => assert.strictEqual(res.status, 200));
    res = await evan.get('/api/standings?week=1');
    check('an overridden result flows through to standings and survivor', () => {
      assert.strictEqual(res.data.weekly.find((r) => r.name === 'Evan').points, 2.5);
      assert.strictEqual(res.data.survivor.find((s) => s.name === 'Evan').strikes, 1);
    });
    await score(gCover, 31, 20); // put it back

    /* --------------------------------------------------------- week two */
    group('Starting the next week');

    await admin.post('/api/admin/week/complete', { week: 1 });
    const w1Sunday = (await admin.get('/api/admin/week?week=1')).data.sundayDate;
    res = await admin.post('/api/admin/week/start', {});
    check('Start Next Week creates week 2 without touching week 1', () => {
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.data.week, 2);
    });
    check('the new week lands on the Sunday after the previous week, not the same one', () => {
      assert.ok(res.data.sundayDate > w1Sunday, `${res.data.sundayDate} should be after ${w1Sunday}`);
      assert.strictEqual(res.data.saturdayDate, timeutil.addDays(res.data.sundayDate, -1));
    });

    const add2 = async (body) => (await admin.post('/api/admin/game/add', { week: 2, ...body })).data.gameId;
    const w2Dallas = await add2({ sport: 'nfl', awayTeam: 'Dallas Cowboys', homeTeam: 'New York Giants', commenceTime: iso(2000), spread: 3 });
    const w2Packers = await add2({ sport: 'nfl', awayTeam: 'Minnesota Vikings', homeTeam: 'Green Bay Packers', commenceTime: iso(2100), spread: -4 });
    await add2({ sport: 'nfl', awayTeam: 'Philadelphia Eagles', homeTeam: 'Washington Commanders', commenceTime: iso(2200), spread: 2.5 });
    await admin.post('/api/admin/week/publish', { week: 2 });

    res = await anon.get('/api/bootstrap');
    check('the same bookmarked URL now shows week 2 automatically', () => {
      assert.strictEqual(res.data.currentWeek, 2);
      assert.deepStrictEqual(res.data.weeks, [1, 2]);
    });
    res = await evan.get('/api/week?week=1');
    check('week 1 results are still readable after the new week opens', () => {
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.data.nfl.find((g) => g.id === gCover).myResult, 'win');
    });

    res = await evan.get('/api/survivor?week=2');
    check('a team used in week 1 is flagged as used in week 2', () => {
      const dallas = res.data.me.options.find((o) => o.team === 'Dallas Cowboys');
      assert.strictEqual(dallas.used, true);
      const packers = res.data.me.options.find((o) => o.team === 'Green Bay Packers');
      assert.strictEqual(packers.used, false);
    });
    res = await evan.post('/api/survivor', { week: 2, team: 'Dallas Cowboys' });
    check('re-using a team is refused server-side', () => {
      assert.strictEqual(res.status, 400);
      assert.ok(/already used/i.test(res.data.error), res.data.error);
    });
    res = await evan.post('/api/survivor', { week: 2, team: 'Green Bay Packers' });
    check('a fresh team is accepted', () => assert.strictEqual(res.status, 200));

    res = await evan.get('/api/survivor?week=2');
    check('previous picks are listed with their result', () => {
      const h = res.data.me.status.history;
      assert.deepStrictEqual(
        h.map((x) => [x.week, x.team, x.result]),
        [[1, 'Dallas Cowboys', 'survived'], [2, 'Green Bay Packers', 'pending']]
      );
    });

    // Season totals accumulate.
    await admin.post('/api/admin/game/score', { week: 2, gameId: w2Packers, homeScore: 30, awayScore: 10 });
    await evan.post('/api/picks', { week: 2, picks: [{ gameId: w2Packers, side: 'home' }] });
    res = await evan.get('/api/standings?week=2');
    check('season points accumulate across weeks', () => {
      assert.strictEqual(res.data.weekly.find((r) => r.name === 'Evan').points, 1);
      assert.strictEqual(res.data.season.find((r) => r.name === 'Evan').points, 4.5);
    });

    /* ------------------------------------------------ strike rule change */
    group('Commissioner controls');

    res = await admin.post('/api/admin/settings', { strikeRule: 3 });
    check('only a 1- or 2-strike rule is accepted', () => assert.strictEqual(res.status, 400));

    res = await admin.post('/api/admin/settings', { strikeRule: 1 });
    check('the commissioner can switch to 1-strike elimination', () => assert.strictEqual(res.status, 200));
    res = await evan.get('/api/standings?week=2');
    check('switching to 1 strike eliminates the player who already has one', () => {
      const s = res.data.survivor.find((x) => x.name === 'Player 2');
      assert.strictEqual(s.alive, false);
      assert.strictEqual(s.eliminatedWeek, 1);
      assert.strictEqual(res.data.strikeRule, 1);
    });
    res = await sarah.post('/api/survivor', { week: 2, team: 'Philadelphia Eagles' });
    check('an eliminated player cannot make a survivor pick', () => {
      assert.strictEqual(res.status, 403);
      assert.ok(/eliminated/i.test(res.data.error), res.data.error);
    });
    await admin.post('/api/admin/settings', { strikeRule: 2 });
    res = await evan.get('/api/standings?week=2');
    check('switching back to 2 strikes revives them', () => {
      assert.strictEqual(res.data.survivor.find((x) => x.name === 'Player 2').alive, true);
    });

    res = await admin.post('/api/admin/participants', {
      participants: [{ id: pSarah.id, name: 'Sarah' }],
    });
    check('the commissioner can rename a participant', () => assert.strictEqual(res.status, 200));
    res = await anon.get('/api/bootstrap');
    check('the new name shows everywhere immediately', () => {
      assert.ok(res.data.participants.some((p) => p.name === 'Sarah'));
    });
    res = await evan.get('/api/standings?week=1');
    check('renaming keeps that participant\'s existing picks and points', () => {
      const row = res.data.weekly.find((r) => r.name === 'Sarah');
      assert.strictEqual(row.points, 1.5);
    });

    const oldPin = pSarah.pin;
    await admin.post('/api/admin/participants', { participants: [{ id: pSarah.id, resetPin: true }] });
    const newState = (await admin.get('/api/admin/state')).data;
    check('a PIN can be reissued', () => {
      assert.notStrictEqual(newState.participants[1].pin, oldPin);
    });

    res = await admin.post('/api/admin/participants', { addName: 'Player 6' });
    check('a sixth participant can be added later', () => {
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.data.participants.length, 6);
    });
    await admin.post('/api/admin/participants', { participants: [{ id: res.data.participants[5].id, active: false }] });
    res = await anon.get('/api/bootstrap');
    check('a deactivated participant drops off the public list', () => {
      assert.strictEqual(res.data.participants.length, 5);
    });

    res = await admin.post('/api/admin/pick-override', {
      week: 2, participantId: pEvan.id, gameId: w2Dallas, side: 'away',
    });
    check('the commissioner can correct a pick after the fact', () => assert.strictEqual(res.status, 200));
    res = await admin.get('/api/admin/audit');
    check('pick overrides are logged with before/after', () => {
      const entry = res.data.audit.find((a) => a.action === 'pick.override');
      assert.strictEqual(entry.detail.after, 'away');
      assert.strictEqual(entry.detail.before, null);
    });

    /* --------------------------------------------- auto score fetching */
    group('Auto score retrieval');
    mock.restore();
    const scoreMock = installMockOdds({ scores: { 'nfl-sun-1': { home: 27, away: 17 } } });
    const srv2 = await startServer();
    const admin2 = client(srv2.base);
    try {
      const mockFull = installMockOdds({ scores: { 'nfl-sun-1': { home: 27, away: 17 } } });
      await admin2.post('/api/admin/login', { pin: '9137' });
      await admin2.post('/api/admin/week/start', { sundayDate: '2026-09-13' });
      await admin2.post('/api/admin/week/publish', { week: 1 });
      const r = await admin2.post('/api/admin/week/fetch-scores', { week: 1 });
      check('completed games are pulled from the Odds API scores feed', () => {
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.data.applied, 1);
      });
      const wk = (await admin2.get('/api/admin/week?week=1')).data;
      check('the fetched score is stored and attributed to the API', () => {
        const g = wk.nfl.find((x) => x.id === 'nfl-sun-1');
        assert.deepStrictEqual([g.final.homeScore, g.final.awayScore], [27, 17]);
        assert.strictEqual(g.final.source, 'odds-api');
      });
      await admin2.post('/api/admin/game/score', { week: 1, gameId: 'nfl-sun-1', homeScore: 20, awayScore: 21 });
      await admin2.post('/api/admin/week/fetch-scores', { week: 1 });
      const wk2 = (await admin2.get('/api/admin/week?week=1')).data;
      check('an auto-fetch never overwrites a manual override', () => {
        const g = wk2.nfl.find((x) => x.id === 'nfl-sun-1');
        assert.strictEqual(g.final.homeScore, 20);
        assert.strictEqual(g.final.source, 'manual');
      });
      mockFull.restore();
    } finally {
      scoreMock.restore();
      await srv2.close();
    }
  } finally {
    installMockOdds().restore();
    await srv.close();
  }
}

/* ========================================================================= */
/* 5. Security surface                                                       */
/* ========================================================================= */

async function testSecurity() {
  group('Security');
  const mock = installMockOdds({ nfl: [], ncaaf: [] });
  const srv = await startServer();
  const admin = client(srv.base);
  const player = client(srv.base);
  const attacker = client(srv.base);
  try {
    await admin.post('/api/admin/login', { pin: '9137' });
    await admin.post('/api/admin/week/start', { sundayDate: timeutil.ctDate(new Date()) });
    const gid = (await admin.post('/api/admin/game/add', {
      week: 1, sport: 'nfl', awayTeam: 'Chicago Bears', homeTeam: 'Green Bay Packers',
      commenceTime: iso(120), spread: -6,
    })).data.gameId;
    await admin.post('/api/admin/week/publish', { week: 1 });

    const st = (await admin.get('/api/admin/state')).data;
    const p1 = st.participants[0];
    const p2 = st.participants[1];
    await player.post('/api/login', { participantId: p1.id, pin: p1.pin });

    let res = await player.post('/api/picks', { week: 1, picks: [{ gameId: gid, side: 'home' }] });
    assert.strictEqual(res.status, 200);

    // There is no participantId in the pick payload - identity comes from the
    // signed cookie, so one player simply cannot write another's picks.
    // Identity comes from the signed cookie, so a participantId in the payload
    // is ignored: player 1 can only ever write player 1's row.
    res = await player.post('/api/picks', {
      week: 1, participantId: p2.id, picks: [{ gameId: gid, side: 'away' }],
    });
    const matrix = (await admin.get('/api/admin/week?week=1')).data.picks;
    check('a participantId in the payload cannot redirect a pick to another player', () => {
      assert.strictEqual(res.status, 200);
      assert.strictEqual(matrix.find((m) => m.participantId === p2.id).picks[0].side, null);
      // The write landed on the caller's own row instead.
      assert.strictEqual(matrix.find((m) => m.participantId === p1.id).picks[0].side, 'away');
    });

    attacker.jar.set('ghm_player', `${p1.id}.9999999999999.forgedsignature`);
    res = await attacker.post('/api/picks', { week: 1, picks: [{ gameId: gid, side: 'away' }] });
    check('a forged session cookie is rejected', () => assert.strictEqual(res.status, 401));

    attacker.jar.set('ghm_admin', 'admin.9999999999999.forgedsignature');
    res = await attacker.get('/api/admin/state');
    check('a forged admin cookie is rejected', () => assert.strictEqual(res.status, 401));

    attacker.jar.clear();
    for (const route of [
      '/api/admin/week/publish', '/api/admin/week/start', '/api/admin/game/score',
      '/api/admin/participants', '/api/admin/settings', '/api/admin/pick-override',
      '/api/admin/survivor-override', '/api/admin/week/unlock',
    ]) {
      res = await attacker.post(route, { week: 1 });
      check(`${route} requires the commissioner PIN`, () => assert.strictEqual(res.status, 401));
    }

    res = await player.get('/api/admin/state');
    check('a signed-in participant is not a commissioner', () => assert.strictEqual(res.status, 401));

    // The API key must never leave the server.
    const html = await (await fetch(srv.base + '/')).text();
    const appJs = await (await fetch(srv.base + '/app.js')).text();
    const adminJs = await (await fetch(srv.base + '/admin.js')).text();
    check('the Odds API key never appears in any browser asset', () => {
      for (const body of [html, appJs, adminJs]) {
        assert.ok(!body.includes('test-key'), 'API key value leaked to the client');
        assert.ok(!/apiKey=/.test(body), 'an Odds API request is being built in the browser');
        assert.ok(!/the-odds-api\.com/.test(body), 'the browser is calling the odds provider directly');
      }
    });
    const weekJson = JSON.stringify((await player.get('/api/week?week=1')).data);
    const adminJson = JSON.stringify((await admin.get('/api/admin/state')).data);
    check('the API key never appears in an API response', () => {
      assert.ok(!weekJson.includes('test-key'));
      assert.ok(!adminJson.includes('test-key'));
    });
    const bootJson = JSON.stringify((await player.get('/api/bootstrap')).data);
    check('participant PINs and personal tokens never reach the participant API', () => {
      assert.ok(!bootJson.includes(p1.pin), 'PIN leaked in /api/bootstrap');
      assert.ok(!bootJson.includes(p1.token), 'personal token leaked in /api/bootstrap');
      assert.ok(!weekJson.includes('"pin"'));
    });

    res = await attacker.get('/api/../server.js');
    check('static file serving cannot escape the public directory', () => {
      assert.notStrictEqual(res.status, 200);
    });
  } finally {
    mock.restore();
    await srv.close();
  }
}

/* ========================================================================= */

(async () => {
  testScoringUnits();
  await testFridayWorkflow();
  await testPublishGuards();
  await testCron();
  await testGameplay();
  await testSecurity();

  console.log(`\n${'─'.repeat(58)}`);
  if (failures.length) {
    console.log(`\x1b[31m${failures.length} failed\x1b[0m, ${passed} passed`);
    for (const f of failures) console.log(`  ✗ ${f.name}\n    ${f.err.stack.split('\n').slice(0, 3).join('\n    ')}`);
    process.exit(1);
  }
  console.log(`\x1b[32mAll ${passed} checks passed.\x1b[0m`);
})().catch((err) => {
  console.error('\nTest harness crashed:', err);
  process.exit(1);
});
