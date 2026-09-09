'use strict';
/**
 * Stand-in for The Odds API so the whole weekly workflow can be tested without
 * spending real API calls. Install with installMockOdds(); restore with the
 * returned function.
 */

const realFetch = globalThis.fetch;

/** Times are Central: CDT is UTC-5 in September. */
const NFL_EVENTS = [
  // Thursday night - must be excluded from both competitions.
  event('nfl-thu', '2026-09-10T23:20:00Z', 'Kansas City Chiefs', 'Baltimore Ravens', -3.5),
  // Sunday slate.
  event('nfl-sun-1', '2026-09-13T17:00:00Z', 'Dallas Cowboys', 'Philadelphia Eagles', -7.5),
  event('nfl-sun-2', '2026-09-13T17:00:00Z', 'Green Bay Packers', 'Chicago Bears', -8),
  event('nfl-sun-3', '2026-09-13T20:25:00Z', 'San Francisco 49ers', 'Seattle Seahawks', -3),
  event('nfl-sun-4', '2026-09-14T00:20:00Z', 'Buffalo Bills', 'Miami Dolphins', -6.5), // Sunday 7:20 PM CT
  // Monday night - must be excluded.
  event('nfl-mon', '2026-09-15T00:15:00Z', 'Detroit Lions', 'New York Giants', -5.5),
];

const CFB_EVENTS = [
  event('cfb-1', '2026-09-12T19:30:00Z', 'Michigan Wolverines', 'Texas Longhorns', 7.5, 9),
  event('cfb-2', '2026-09-12T23:30:00Z', 'Georgia Bulldogs', 'Alabama Crimson Tide', -2.5, 11),
  event('cfb-3', '2026-09-13T00:00:00Z', 'Ohio State Buckeyes', 'Penn State Nittany Lions', -6, 10),
  event('cfb-4', '2026-09-12T16:00:00Z', 'Kent State Golden Flashes', 'Ball State Cardinals', -1, 3),
  event('cfb-5', '2026-09-12T18:00:00Z', 'Texas State Bobcats', 'Georgia State Panthers', -4.5, 4),
  // Friday game - never a candidate.
  event('cfb-fri', '2026-09-11T23:00:00Z', 'Boise State Broncos', 'Fresno State Bulldogs', -10, 6),
];

function event(id, commence, home, away, homeSpread, bookCount = 8) {
  const books = [];
  const names = [
    ['draftkings', 'DraftKings'],
    ['fanduel', 'FanDuel'],
    ['betmgm', 'BetMGM'],
    ['williamhill_us', 'Caesars'],
    ['bovada', 'Bovada'],
    ['pointsbetus', 'PointsBet'],
    ['betrivers', 'BetRivers'],
    ['unibet_us', 'Unibet'],
    ['wynnbet', 'WynnBET'],
    ['superbook', 'SuperBook'],
    ['betonlineag', 'BetOnline'],
    ['lowvig', 'LowVig'],
  ];
  for (const [key, title] of names.slice(0, bookCount)) {
    books.push({
      key,
      title,
      markets: [
        {
          key: 'spreads',
          last_update: '2026-09-11T15:00:00Z',
          outcomes: [
            { name: home, point: homeSpread, price: -110 },
            { name: away, point: -homeSpread, price: -110 },
          ],
        },
      ],
    });
  }
  return { id, commence_time: commence, home_team: home, away_team: away, bookmakers: books };
}

/**
 * options.nfl / options.ncaaf may be arrays (payload override) and
 * options.scores a map of eventId -> { home, away }.
 */
function installMockOdds(options = {}) {
  const calls = [];
  globalThis.fetch = async (input, init) => {
    const url = input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url);
    // Only stand in for The Odds API - everything else (the test client talking
    // to our own server) goes through untouched.
    if (url.hostname !== 'api.the-odds-api.com') return realFetch(input, init);
    calls.push(url.pathname + '?' + url.searchParams.toString().replace(/apiKey=[^&]*/, 'apiKey=REDACTED'));
    if (options.fail) {
      return new Response('{"message":"boom"}', { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
    let payload;
    if (url.pathname.includes('americanfootball_nfl/scores') || url.pathname.includes('americanfootball_ncaaf/scores')) {
      const source = url.pathname.includes('nfl') ? NFL_EVENTS : CFB_EVENTS;
      payload = source.map((e) => {
        const s = (options.scores || {})[e.id];
        return {
          id: e.id,
          completed: Boolean(s),
          home_team: e.home_team,
          away_team: e.away_team,
          scores: s ? [{ name: e.home_team, score: String(s.home) }, { name: e.away_team, score: String(s.away) }] : null,
        };
      });
    } else if (url.pathname.includes('americanfootball_nfl')) {
      payload = options.nfl || NFL_EVENTS;
    } else {
      payload = options.ncaaf || CFB_EVENTS;
    }
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'x-requests-remaining': '480', 'x-requests-used': '20' },
    });
  };
  return { calls, restore: () => { globalThis.fetch = realFetch; } };
}

module.exports = { installMockOdds, NFL_EVENTS, CFB_EVENTS };
