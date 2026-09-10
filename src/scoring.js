'use strict';
/**
 * Pure functions: ATS grading, survivor grading, weekly + season standings.
 * Nothing in here touches I/O, which makes the whole ruleset easy to test.
 */

const { pickKey, survivorKey, getWeek, weekNumbers, publishedWeekNumbers } = require('./state');

/** A game is locked once its scheduled kickoff has passed. */
function isGameLocked(game, now = new Date()) {
  return new Date(game.commenceTime).getTime() <= now.getTime();
}

/** Survivor locks at kickoff of the first eligible Sunday NFL game of the week. */
function survivorLockTime(week) {
  if (week && week.survivorLockAt) return new Date(week.survivorLockAt);
  const nfl = (week?.games || []).filter((g) => g.sport === 'nfl');
  if (!nfl.length) return null;
  return new Date(Math.min(...nfl.map((g) => new Date(g.commenceTime).getTime())));
}

function isSurvivorLocked(week, now = new Date()) {
  const t = survivorLockTime(week);
  return t ? t.getTime() <= now.getTime() : false;
}

/** Spread that applies to one side. Stored spread is always the home number. */
function spreadFor(game, side) {
  if (game.spread === null || game.spread === undefined) return null;
  return side === 'home' ? game.spread : -game.spread;
}

/**
 * Grade one ATS pick.
 * Returns 'win' | 'loss' | 'push' | null (no final score yet).
 */
function gradeAts(game, side) {
  if (!game.final || game.spread === null || game.spread === undefined) return null;
  const { homeScore, awayScore } = game.final;
  if (typeof homeScore !== 'number' || typeof awayScore !== 'number') return null;
  const own = side === 'home' ? homeScore : awayScore;
  const opp = side === 'home' ? awayScore : homeScore;
  const adjusted = own + spreadFor(game, side);
  if (adjusted > opp) return 'win';
  if (adjusted < opp) return 'loss';
  return 'push';
}

const ATS_POINTS = { win: 1, push: 0.5, loss: 0 };

/** Straight-up result for a team name in a game: 'win' | 'loss' | 'tie' | null */
function gradeStraightUp(game, teamName) {
  if (!game.final) return null;
  const { homeScore, awayScore } = game.final;
  if (typeof homeScore !== 'number' || typeof awayScore !== 'number') return null;
  const isHome = game.homeTeam === teamName;
  const isAway = game.awayTeam === teamName;
  if (!isHome && !isAway) return null;
  const own = isHome ? homeScore : awayScore;
  const opp = isHome ? awayScore : homeScore;
  if (own > opp) return 'win';
  if (own < opp) return 'loss';
  return 'tie';
}

/** Every pick made by everyone for one week, grouped by game. */
function weekPicks(doc, weekNumber) {
  const out = new Map(); // gameId -> Map(participantId -> pick)
  const prefix = `${weekNumber}|`;
  for (const [key, value] of Object.entries(doc.picks)) {
    if (!key.startsWith(prefix)) continue;
    const [, participantId, gameId] = key.split('|');
    if (!out.has(gameId)) out.set(gameId, new Map());
    out.get(gameId).set(participantId, value);
  }
  return out;
}

/** Pick distribution for one game, e.g. { home: 3, away: 2, total: 5, homePct: 60 } */
function pickPercentages(doc, weekNumber, gameId) {
  const byGame = weekPicks(doc, weekNumber).get(gameId) || new Map();
  let home = 0;
  let away = 0;
  for (const p of byGame.values()) {
    if (p.side === 'home') home += 1;
    else if (p.side === 'away') away += 1;
  }
  const total = home + away;
  return {
    home,
    away,
    total,
    homePct: total ? Math.round((home / total) * 100) : null,
    awayPct: total ? Math.round((away / total) * 100) : null,
  };
}

/** Pick'em result for one participant in one week. */
function participantWeekResult(doc, weekNumber, participantId) {
  const week = getWeek(doc, weekNumber);
  if (!week) return { points: 0, wins: 0, losses: 0, pushes: 0, graded: 0, made: 0, games: [] };
  let points = 0;
  let wins = 0;
  let losses = 0;
  let pushes = 0;
  let graded = 0;
  let made = 0;
  const games = [];
  for (const game of week.games) {
    const pick = doc.picks[pickKey(weekNumber, participantId, game.id)] || null;
    const result = pick ? gradeAts(game, pick.side) : null;
    if (pick) made += 1;
    if (result) {
      graded += 1;
      points += ATS_POINTS[result];
      if (result === 'win') wins += 1;
      else if (result === 'loss') losses += 1;
      else pushes += 1;
    }
    games.push({ gameId: game.id, side: pick ? pick.side : null, result });
  }
  return { points: round1(points), wins, losses, pushes, graded, made, games };
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

const DEFAULT_MIN_PICKS = 50;

function minPicksFor(doc) {
  const n = Number(doc.settings ? doc.settings.minPicks : undefined);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_MIN_PICKS;
}

/**
 * ATS winning percentage, out of 100 with one decimal.
 *
 * A push counts as half a win, which keeps this consistent with the pool's own
 * 1 / 0.5 / 0 scale - the percentage is exactly "average points per graded
 * pick". Returns null when nothing has been graded, so callers can show a dash
 * instead of a misleading 0%.
 */
function winPct(points, graded) {
  if (!graded) return null;
  return Math.round((points / graded) * 1000) / 10;
}

/** Weekly pick'em standings. An individual week is still won on total points. */
function weeklyStandings(doc, weekNumber) {
  const rows = doc.participants
    .filter((p) => p.active)
    .map((p) => {
      const r = participantWeekResult(doc, weekNumber, p.id);
      return {
        participantId: p.id,
        name: p.name,
        ...r,
        winPct: winPct(r.points, r.graded),
      };
    });
  return rankByPoints(rows);
}

/**
 * Cumulative season leaderboard, driven by winning percentage.
 *
 * A participant qualifies once they have `settings.minPicks` graded picks (50
 * by default). Everyone appears from week one, but qualified players sort above
 * unqualified ones - otherwise somebody 3-for-3 in September would sit on top
 * of the board for a month.
 */
function seasonStandings(doc) {
  const weeks = publishedWeekNumbers(doc);
  const minPicks = minPicksFor(doc);

  // Needed once per week, not once per week per participant.
  const weeklyByWeek = new Map(weeks.map((w) => [w, weeklyStandings(doc, w)]));

  const rows = doc.participants
    .filter((p) => p.active)
    .map((p) => {
      let points = 0;
      let wins = 0;
      let losses = 0;
      let pushes = 0;
      let graded = 0;
      let made = 0;
      let weeksWon = 0;
      for (const w of weeks) {
        const r = participantWeekResult(doc, w, p.id);
        points += r.points;
        wins += r.wins;
        losses += r.losses;
        pushes += r.pushes;
        graded += r.graded;
        made += r.made;

        const standings = weeklyByWeek.get(w) || [];
        const top = standings[0];
        if (top && top.points > 0 && standings.some((s) => s.graded > 0)) {
          const mine = standings.find((s) => s.participantId === p.id);
          if (mine && mine.points === top.points) weeksWon += 1;
        }
      }
      points = round1(points);
      return {
        participantId: p.id,
        name: p.name,
        points,
        wins,
        losses,
        pushes,
        graded,
        made,
        weeksWon,
        winPct: winPct(points, graded),
        qualified: graded >= minPicks,
        minPicks,
        picksToMinimum: Math.max(0, minPicks - graded),
      };
    });
  return rankByWinPct(rows);
}

/** Sort on total points. Used for a single week. */
function rankByPoints(rows) {
  rows.sort((a, b) => b.points - a.points || b.wins - a.wins || a.name.localeCompare(b.name));
  return assignRanks(rows, (r) => String(r.points));
}

/**
 * Sort on winning percentage, with qualified players above unqualified ones.
 * Total points breaks a percentage tie.
 */
function rankByWinPct(rows) {
  rows.sort(
    (a, b) =>
      Number(b.qualified) - Number(a.qualified) ||
      (b.winPct === null ? -1 : b.winPct) - (a.winPct === null ? -1 : a.winPct) ||
      b.points - a.points ||
      a.name.localeCompare(b.name)
  );
  return assignRanks(rows, (r) => `${r.qualified}|${r.winPct}`);
}

/** Equal keys share a rank; the next distinct key resumes the count. */
function assignRanks(rows, keyOf) {
  let lastKey = null;
  let lastRank = 0;
  rows.forEach((row, i) => {
    const key = keyOf(row);
    if (lastKey !== null && key === lastKey) {
      row.rank = lastRank;
    } else {
      row.rank = i + 1;
      lastRank = row.rank;
      lastKey = key;
    }
  });
  return rows;
}

/**
 * Survivor state for every participant, evaluated over all published weeks in
 * order. A tie counts as survival (the rule is "losing team = strike").
 */
function survivorStandings(doc, throughWeek = null) {
  const strikeRule = doc.settings.strikeRule === 1 ? 1 : 2;
  let weeks = publishedWeekNumbers(doc);
  if (throughWeek !== null) weeks = weeks.filter((w) => w <= throughWeek);

  return doc.participants
    .filter((p) => p.active)
    .map((p) => {
      let strikes = 0;
      let eliminatedWeek = null;
      const history = [];
      const teamsUsed = [];
      for (const w of weeks) {
        const entry = doc.survivorPicks[survivorKey(w, p.id)];
        if (!entry) {
          history.push({ week: w, team: null, result: eliminatedWeek ? 'out' : 'no-pick' });
          continue;
        }
        if (!teamsUsed.includes(entry.team)) teamsUsed.push(entry.team);
        const week = getWeek(doc, w);
        const game = (week?.games || []).find(
          (g) => g.sport === 'nfl' && (g.homeTeam === entry.team || g.awayTeam === entry.team)
        );
        const su = game ? gradeStraightUp(game, entry.team) : null;
        let result = 'pending';
        if (su === 'win') result = 'survived';
        else if (su === 'tie') result = 'tie';
        else if (su === 'loss') {
          result = 'strike';
          if (eliminatedWeek === null) {
            strikes += 1;
            if (strikes >= strikeRule) eliminatedWeek = w;
          }
        }
        history.push({ week: w, team: entry.team, result, pickedAt: entry.at });
      }
      return {
        participantId: p.id,
        name: p.name,
        strikes,
        strikeRule,
        alive: eliminatedWeek === null,
        eliminatedWeek,
        teamsUsed,
        history,
      };
    })
    .sort((a, b) => Number(b.alive) - Number(a.alive) || a.strikes - b.strikes || a.name.localeCompare(b.name));
}

function survivorStatusFor(doc, participantId, throughWeek = null) {
  return survivorStandings(doc, throughWeek).find((s) => s.participantId === participantId) || null;
}

/**
 * Teams a participant may still pick this week: NFL teams playing in this
 * week's Sunday slate that they have not already used in an earlier week.
 */
function survivorOptions(doc, weekNumber, participantId) {
  const week = getWeek(doc, weekNumber);
  if (!week) return [];
  const earlier = publishedWeekNumbers(doc).filter((w) => w < weekNumber);
  const used = new Set();
  for (const w of earlier) {
    const entry = doc.survivorPicks[survivorKey(w, participantId)];
    if (entry) used.add(entry.team);
  }
  const now = new Date();
  const options = [];
  for (const game of week.games.filter((g) => g.sport === 'nfl')) {
    for (const side of ['away', 'home']) {
      const team = side === 'home' ? game.homeTeam : game.awayTeam;
      const opponent = side === 'home' ? game.awayTeam : game.homeTeam;
      options.push({
        team,
        opponent,
        isHome: side === 'home',
        gameId: game.id,
        commenceTime: game.commenceTime,
        used: used.has(team),
        locked: isGameLocked(game, now),
      });
    }
  }
  options.sort(
    (a, b) => new Date(a.commenceTime) - new Date(b.commenceTime) || a.team.localeCompare(b.team)
  );
  return options;
}

module.exports = {
  ATS_POINTS,
  DEFAULT_MIN_PICKS,
  minPicksFor,
  winPct,
  isGameLocked,
  isSurvivorLocked,
  survivorLockTime,
  spreadFor,
  gradeAts,
  gradeStraightUp,
  weekPicks,
  pickPercentages,
  participantWeekResult,
  weeklyStandings,
  seasonStandings,
  survivorStandings,
  survivorStatusFor,
  survivorOptions,
  round1,
};
