#!/usr/bin/env node
'use strict';
/**
 * Fills the data store with a demo season so you can click through the whole
 * app without an Odds API key: one finished week with results and one open
 * week with live pick deadlines.
 *
 *   node scripts/seed-demo.js            # writes ./data/pool.json
 *   DATA_FILE=/tmp/demo.json node scripts/seed-demo.js
 *
 * Demo PINs are 1111 / 2222 / 3333 / 4444 / 5555 so they are easy to type.
 * Never run this against real pool data - it overwrites everything.
 */

const { loadEnvFile, buildConfig } = require('../src/config');
const { createStore } = require('../src/store');
const state = require('../src/state');
const timeutil = require('../src/time');

loadEnvFile();
const config = buildConfig(process.env);

const mins = (n) => new Date(Date.now() + n * 60000).toISOString();

let counter = 0;
function game(sport, awayTeam, homeTeam, commenceTime, spread, final = null, labels = {}) {
  counter += 1;
  return {
    id: `demo_${counter}`,
    sport,
    commenceTime,
    homeTeam,
    awayTeam,
    homeLabel: labels.home || null,
    awayLabel: labels.away || null,
    spread,
    spreadSource: 'DraftKings',
    spreadCapturedAt: timeutil.ctToUtc(timeutil.ctDate(new Date()), 10, 2).toISOString(),
    spreadManual: false,
    final,
  };
}

function build() {
  const doc = state.defaultDoc(config.season);
  const pins = ['1111', '2222', '3333', '4444', '5555'];
  doc.participants.forEach((p, i) => { p.pin = pins[i]; });
  const [evan, p2, p3, p4, p5] = doc.participants;

  /* ---- week 1: finished, fully scored -------------------------------- */
  const lastSunday = timeutil.addDays(timeutil.nextSunday(timeutil.ctDate(new Date())), -7);
  const lastSaturday = timeutil.addDays(lastSunday, -1);
  const pSat = (h, m = 0) => timeutil.ctToUtc(lastSaturday, h, m).toISOString();
  const pSun = (h, m = 0) => timeutil.ctToUtc(lastSunday, h, m).toISOString();
  const w1 = state.newWeek(1, lastSunday, lastSaturday);
  w1.status = 'complete';
  w1.linesLockedAt = timeutil.ctToUtc(timeutil.addDays(lastSaturday, -1), 10, 3).toISOString();
  w1.lineSource = 'DraftKings';
  const done = (homeScore, awayScore, at) => ({ homeScore, awayScore, at, source: 'manual' });
  w1.games = [
    game('ncaaf', 'Texas Longhorns', 'Michigan Wolverines', pSat(11), 7.5, done(17, 28, pSat(14, 30)), { away: '#4 Texas', home: '#12 Michigan' }),
    game('ncaaf', 'Alabama Crimson Tide', 'Georgia Bulldogs', pSat(14, 30), -2.5, done(27, 24, pSat(18)), { away: '#8 Alabama', home: '#2 Georgia' }),
    game('ncaaf', 'Penn State Nittany Lions', 'Ohio State Buckeyes', pSat(18, 30), -6, done(31, 20, pSat(22)), { away: '#10 Penn State', home: '#3 Ohio State' }),
    game('nfl', 'Philadelphia Eagles', 'Dallas Cowboys', pSun(12), -7.5, done(31, 20, pSun(15, 10)), {}),
    game('nfl', 'Chicago Bears', 'Green Bay Packers', pSun(12), -8, done(20, 24, pSun(15, 10)), {}),
    game('nfl', 'Seattle Seahawks', 'San Francisco 49ers', pSun(15, 25), -3, done(24, 21, pSun(18, 30)), {}),
    game('nfl', 'Miami Dolphins', 'Buffalo Bills', pSun(19, 20), -6.5, done(30, 13, pSun(22, 30)), {}),
  ];
  w1.survivorLockAt = w1.games.find((g) => g.sport === 'nfl').commenceTime;
  doc.weeks['1'] = w1;

  const sides = {
    [evan.id]: ['away', 'home', 'home', 'home', 'away', 'home', 'home'],
    [p2.id]: ['home', 'away', 'home', 'away', 'home', 'away', 'home'],
    [p3.id]: ['away', 'away', 'away', 'home', 'away', 'away', 'away'],
    [p4.id]: ['home', 'home', 'home', 'home', 'home', 'home', 'away'],
    [p5.id]: ['away', 'home', 'away', 'away', 'away', 'home', 'home'],
  };
  for (const [pid, picks] of Object.entries(sides)) {
    picks.forEach((side, i) => {
      doc.picks[state.pickKey(1, pid, w1.games[i].id)] = { side, at: pSat(9, 30) };
    });
  }
  const w1Survivor = {
    [evan.id]: 'Dallas Cowboys',
    [p2.id]: 'Buffalo Bills',
    [p3.id]: 'Green Bay Packers',   // lost -> strike
    [p4.id]: 'San Francisco 49ers',
    [p5.id]: 'Philadelphia Eagles', // lost -> strike
  };
  for (const [pid, team] of Object.entries(w1Survivor)) {
    doc.survivorPicks[state.survivorKey(1, pid)] = { team, at: pSat(9, 30) };
  }

  /* ---- week 2: published, picks open --------------------------------- */
  const today = timeutil.ctDate(new Date());
  const sunday = timeutil.nextSunday(today);
  const saturday = timeutil.addDays(sunday, -1);
  const sat = (h, m = 0) => timeutil.ctToUtc(saturday, h, m).toISOString();
  const sun = (h, m = 0) => timeutil.ctToUtc(sunday, h, m).toISOString();
  const w2 = state.newWeek(2, sunday, saturday);
  w2.status = 'published';
  w2.linesLockedAt = timeutil.ctToUtc(today, 10, 4).toISOString();
  w2.lineSource = 'DraftKings';
  w2.games = [
    game('ncaaf', 'Oklahoma Sooners', 'Texas Longhorns', sat(11), -3.5, null, { away: '#9 Oklahoma', home: '#4 Texas' }),
    game('ncaaf', 'Notre Dame Fighting Irish', 'USC Trojans', sat(14, 30), 2.5, null, { away: '#6 Notre Dame', home: '#15 USC' }),
    game('ncaaf', 'Oregon Ducks', 'Washington Huskies', sat(18, 30), 6, null, { away: '#5 Oregon', home: '#18 Washington' }),
    game('nfl', 'Minnesota Vikings', 'Detroit Lions', sun(12), -3),
    game('nfl', 'New York Jets', 'New England Patriots', sun(12), -1.5),
    game('nfl', 'Cleveland Browns', 'Baltimore Ravens', sun(12), -9.5),
    // Dallas is already used by Evan in week 1, so the "used" state is visible.
    game('nfl', 'Dallas Cowboys', 'Washington Commanders', sun(12), 1.5),
    game('nfl', 'Arizona Cardinals', 'Los Angeles Rams', sun(15, 5), -6),
    game('nfl', 'Tampa Bay Buccaneers', 'New Orleans Saints', sun(15, 25), 1),
    game('nfl', 'Denver Broncos', 'Kansas City Chiefs', sun(15, 25), -7),
    game('nfl', 'Houston Texans', 'Indianapolis Colts', sun(19, 20), 2.5),
  ];
  doc.weeks['2'] = w2;

  // A couple of players have already put week 2 picks in.
  doc.picks[state.pickKey(2, evan.id, w2.games[0].id)] = { side: 'home', at: mins(-200) };
  doc.picks[state.pickKey(2, evan.id, w2.games[3].id)] = { side: 'away', at: mins(-200) };
  doc.picks[state.pickKey(2, p2.id, w2.games[0].id)] = { side: 'away', at: mins(-190) };
  doc.picks[state.pickKey(2, p3.id, w2.games[0].id)] = { side: 'home', at: mins(-180) };
  doc.survivorPicks[state.survivorKey(2, evan.id)] = { team: 'Baltimore Ravens', at: mins(-200) };
  doc.settings.currentWeek = 2;

  doc.settings.currentWeek = 2;
  state.logAudit(doc, 'commissioner', 'demo.seed', { weeks: 2, note: 'demo data' });
  return doc;
}

(async () => {
  const store = createStore(config, () => build());
  await store.mutate((doc) => {
    const fresh = build();
    for (const key of Object.keys(doc)) delete doc[key];
    Object.assign(doc, fresh);
  });
  console.log('Seeded demo data.');
  console.log('  storage:', config.storage === 'file' ? config.dataFile : config.storage);
  console.log('  participant PINs: Evan 1111 · Player 2 2222 · Player 3 3333 · Player 4 4444 · Player 5 5555');
  console.log('  admin PIN:', config.adminPin);
  process.exit(0);
})();
