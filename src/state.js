'use strict';
/**
 * Shape of the stored document, plus small helpers for reading/creating parts
 * of it. Everything the pool knows lives in one object:
 *
 * {
 *   schema, season,
 *   settings: { strikeRule, poolName, currentWeek },
 *   participants: [ { id, name, pin, token, active } ],
 *   weeks: { "3": Week },
 *   picks: { "3|p1|g7": { side, at } },
 *   survivorPicks: { "3|p1": { team, at } },
 *   audit: [ { at, actor, action, detail } ]
 * }
 *
 * Week = {
 *   number, status: 'draft'|'published'|'complete',
 *   sundayDate, saturdayDate,
 *   linesLockedAt, lineSource,
 *   survivorLockAt,
 *   games: [ Game ],
 *   collegeCandidates: [ Game ]      // pulled but not selected
 * }
 *
 * Game = {
 *   id, sport: 'nfl'|'ncaaf', commenceTime (ISO UTC),
 *   homeTeam, awayTeam, homeLabel, awayLabel,
 *   spread,                          // ALWAYS relative to the home team
 *   spreadSource, spreadCapturedAt, spreadManual,
 *   final: { homeScore, awayScore, at, source } | null
 * }
 */

const crypto = require('crypto');

const DEFAULT_PARTICIPANTS = ['Evan', 'Player 2', 'Player 3', 'Player 4', 'Player 5'];

function randomId(bytes = 6) {
  return crypto.randomBytes(bytes).toString('hex');
}

function randomPin() {
  return String(crypto.randomInt(1000, 10000));
}

function makeParticipant(name) {
  return {
    id: `p_${randomId(4)}`,
    name,
    pin: randomPin(),
    token: randomId(10),
    active: true,
    createdAt: new Date().toISOString(),
  };
}

function defaultDoc(season) {
  return {
    schema: 1,
    season: Number(season) || new Date().getUTCFullYear(),
    settings: {
      poolName: 'GOLDEN FOOTBALL POOL',
      strikeRule: 2, // strikes required for elimination; commissioner can set 1 or 2
      minPicks: 50, // graded picks needed to qualify for the season leaderboard
      currentWeek: null, // the week the commissioner is editing
    },
    participants: DEFAULT_PARTICIPANTS.map(makeParticipant),
    weeks: {},
    picks: {},
    survivorPicks: {},
    audit: [],
  };
}

function pickKey(week, participantId, gameId) {
  return `${week}|${participantId}|${gameId}`;
}

function survivorKey(week, participantId) {
  return `${week}|${participantId}`;
}

function getWeek(doc, number) {
  return doc.weeks[String(number)] || null;
}

function weekNumbers(doc) {
  return Object.keys(doc.weeks)
    .map(Number)
    .sort((a, b) => a - b);
}

/** Weeks that participants can see (anything the commissioner has published). */
function publishedWeekNumbers(doc) {
  return weekNumbers(doc).filter((n) => doc.weeks[String(n)].status !== 'draft');
}

/** The week the public site shows by default: the newest published week. */
function activePublicWeek(doc) {
  const published = publishedWeekNumbers(doc);
  return published.length ? published[published.length - 1] : null;
}

function participantById(doc, id) {
  return doc.participants.find((p) => p.id === id) || null;
}

function participantByToken(doc, token) {
  return doc.participants.find((p) => p.token === token) || null;
}

function logAudit(doc, actor, action, detail) {
  doc.audit.unshift({
    at: new Date().toISOString(),
    actor,
    action,
    detail: detail === undefined ? null : detail,
  });
  if (doc.audit.length > 500) doc.audit.length = 500;
}

function newWeek(number, sundayDate, saturdayDate) {
  return {
    number,
    status: 'draft',
    sundayDate,
    saturdayDate,
    linesLockedAt: null,
    lineSource: null,
    survivorLockAt: null,
    games: [],
    collegeCandidates: [],
  };
}

module.exports = {
  DEFAULT_PARTICIPANTS,
  defaultDoc,
  makeParticipant,
  randomId,
  randomPin,
  pickKey,
  survivorKey,
  getWeek,
  weekNumbers,
  publishedWeekNumbers,
  activePublicWeek,
  participantById,
  participantByToken,
  logAudit,
  newWeek,
};
