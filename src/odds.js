'use strict';
/**
 * The Odds API client (https://the-odds-api.com/).
 *
 * The API key is read from the environment on the server and is never sent to
 * the browser. Every response the browser sees has already been reduced to
 * "game + one frozen spread".
 */

const { ctWeekday, ctDate, ctParts } = require('./time');
const { cfbBrandScore } = require('./teams');

const BASE = 'https://api.the-odds-api.com/v4';

const SPORT_KEYS = {
  nfl: 'americanfootball_nfl',
  ncaaf: 'americanfootball_ncaaf',
};

/**
 * Sportsbook preference order. We freeze ONE book's line so scoring stays
 * deterministic - we deliberately do not average books.
 */
const BOOK_PRIORITY = [
  { key: 'draftkings', title: 'DraftKings' },
  { key: 'fanduel', title: 'FanDuel' },
  { key: 'betmgm', title: 'BetMGM' },
  { key: 'williamhill_us', title: 'Caesars' },
  { key: 'caesars', title: 'Caesars' },
];

class OddsApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'OddsApiError';
    this.status = status;
  }
}

async function apiGet(pathname, params, apiKey, { timeoutMs = 15000 } = {}) {
  if (!apiKey) throw new OddsApiError('ODDS_API_KEY is not configured on the server', 500);
  const url = new URL(BASE + pathname);
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  url.searchParams.set('apiKey', apiKey);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, { signal: controller.signal });
  } catch (err) {
    throw new OddsApiError(`Could not reach The Odds API: ${err.message}`, 502);
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  if (!res.ok) {
    // Strip the key out of anything we might surface or log.
    throw new OddsApiError(
      `The Odds API returned ${res.status}: ${text.slice(0, 300).replace(apiKey, '***')}`,
      res.status
    );
  }
  const quota = {
    remaining: res.headers.get('x-requests-remaining'),
    used: res.headers.get('x-requests-used'),
  };
  try {
    return { data: JSON.parse(text), quota };
  } catch {
    throw new OddsApiError('The Odds API returned a response that was not JSON', 502);
  }
}

/**
 * Pick the spread from the highest-priority book available for this event.
 * Returns { spread, source, book } where `spread` is relative to the HOME team,
 * or null when none of the preferred books have posted a line.
 */
function chooseSpread(event) {
  const books = event.bookmakers || [];
  for (const pref of BOOK_PRIORITY) {
    const book = books.find((b) => b.key === pref.key);
    if (!book) continue;
    const market = (book.markets || []).find((m) => m.key === 'spreads');
    if (!market) continue;
    const home = (market.outcomes || []).find((o) => o.name === event.home_team);
    if (!home || typeof home.point !== 'number') continue;
    return { spread: home.point, source: pref.title, book: pref.key, lastUpdate: market.last_update || book.last_update || null };
  }
  return null;
}

/** Turn a raw Odds API event into the game shape we store. */
function toGame(event, sport) {
  const chosen = chooseSpread(event);
  return {
    id: event.id,
    sport,
    commenceTime: event.commence_time,
    homeTeam: event.home_team,
    awayTeam: event.away_team,
    homeLabel: null,
    awayLabel: null,
    spread: chosen ? chosen.spread : null,
    spreadSource: chosen ? chosen.source : null,
    spreadCapturedAt: chosen ? new Date().toISOString() : null,
    spreadManual: false,
    final: null,
  };
}

/**
 * Fetch spreads for one sport and keep only games kicking off on the given
 * Central-time calendar date(s).
 */
async function fetchGames({ sport, dates, apiKey }) {
  const sportKey = SPORT_KEYS[sport];
  if (!sportKey) throw new OddsApiError(`Unknown sport ${sport}`, 400);
  const { data, quota } = await apiGet(`/sports/${sportKey}/odds`, {
    regions: 'us',
    markets: 'spreads',
    oddsFormat: 'american',
  }, apiKey);

  const wanted = new Set(dates);
  const games = data
    .filter((e) => wanted.has(ctDate(e.commence_time)))
    .map((e) => toGame(e, sport))
    .sort((a, b) => new Date(a.commenceTime) - new Date(b.commenceTime));
  return { games, quota };
}

/** Sunday NFL games only - Thursday and Monday games are never included. */
async function fetchNflSunday({ sundayDate, apiKey }) {
  const { games, quota } = await fetchGames({ sport: 'nfl', dates: [sundayDate], apiKey });
  return { games: games.filter((g) => ctWeekday(g.commenceTime) === 'Sunday'), quota };
}

/** Saturday college games - the pool of candidates for the featured three. */
async function fetchCollegeSaturday({ saturdayDate, apiKey }) {
  const { games, quota } = await fetchGames({ sport: 'ncaaf', dates: [saturdayDate], apiKey });
  return { games: games.filter((g) => ctWeekday(g.commenceTime) === 'Saturday'), quota };
}

/**
 * Rank Saturday college candidates so the commissioner gets a sensible
 * "suggested top 3" without a second data source. Signals we can get from the
 * odds feed alone:
 *   - brand prominence of both teams (national relevance / TV appeal)
 *   - how many sportsbooks posted a line (market interest)
 *   - how close the line is (matchup quality)
 *   - a small bump for the prime-time window
 */
function scoreCollegeGame(game, raw) {
  const brandHome = cfbBrandScore(game.homeTeam);
  const brandAway = cfbBrandScore(game.awayTeam);
  const brand = (brandHome + brandAway) * 8 + Math.min(brandHome, brandAway) * 6;
  const books = raw && raw.bookmakers ? raw.bookmakers.length : 0;
  const liquidity = Math.min(books, 12) * 1.5;
  const spread = game.spread === null ? 14 : Math.abs(game.spread);
  const closeness = Math.max(0, 14 - spread) * 1.5;
  const hourCt = ctParts(game.commenceTime).hour;
  const primeTime = hourCt >= 14 ? 4 : 0;
  return Math.round((brand + liquidity + closeness + primeTime) * 10) / 10;
}

/**
 * Fetch Saturday college games and return them ranked, with the top 3 flagged
 * as the suggestion. The commissioner always makes the final selection.
 */
async function fetchCollegeSuggestions({ saturdayDate, apiKey }) {
  const sportKey = SPORT_KEYS.ncaaf;
  const { data, quota } = await apiGet(`/sports/${sportKey}/odds`, {
    regions: 'us',
    markets: 'spreads',
    oddsFormat: 'american',
  }, apiKey);

  const candidates = data
    .filter((e) => ctDate(e.commence_time) === saturdayDate && ctWeekday(e.commence_time) === 'Saturday')
    .map((e) => {
      const game = toGame(e, 'ncaaf');
      game.suggestionScore = scoreCollegeGame(game, e);
      return game;
    })
    .sort((a, b) => b.suggestionScore - a.suggestionScore || new Date(a.commenceTime) - new Date(b.commenceTime));

  return { candidates, suggested: candidates.slice(0, 3), quota };
}

/**
 * Final scores. The Odds API /scores endpoint covers both sports and is far
 * cheaper than a second provider; `daysFrom` may be 1-3.
 */
async function fetchScores({ sport, daysFrom = 3, apiKey }) {
  const sportKey = SPORT_KEYS[sport];
  if (!sportKey) throw new OddsApiError(`Unknown sport ${sport}`, 400);
  const { data, quota } = await apiGet(`/sports/${sportKey}/scores`, { daysFrom }, apiKey);
  const out = new Map();
  for (const event of data) {
    if (!event.completed || !Array.isArray(event.scores)) continue;
    const home = event.scores.find((s) => s.name === event.home_team);
    const away = event.scores.find((s) => s.name === event.away_team);
    if (!home || !away) continue;
    out.set(event.id, {
      homeScore: Number(home.score),
      awayScore: Number(away.score),
      homeTeam: event.home_team,
      awayTeam: event.away_team,
    });
  }
  return { scores: out, quota };
}

module.exports = {
  SPORT_KEYS,
  BOOK_PRIORITY,
  OddsApiError,
  chooseSpread,
  toGame,
  fetchGames,
  fetchNflSunday,
  fetchCollegeSaturday,
  fetchCollegeSuggestions,
  fetchScores,
  scoreCollegeGame,
};
