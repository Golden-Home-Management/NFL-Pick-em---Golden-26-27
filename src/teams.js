'use strict';
/**
 * NFL team reference. Names match the strings The Odds API returns for
 * sport key `americanfootball_nfl`, so a survivor pick can be matched to a
 * game by exact name.
 */
const NFL_TEAMS = [
  ['Arizona Cardinals', 'ARI'],
  ['Atlanta Falcons', 'ATL'],
  ['Baltimore Ravens', 'BAL'],
  ['Buffalo Bills', 'BUF'],
  ['Carolina Panthers', 'CAR'],
  ['Chicago Bears', 'CHI'],
  ['Cincinnati Bengals', 'CIN'],
  ['Cleveland Browns', 'CLE'],
  ['Dallas Cowboys', 'DAL'],
  ['Denver Broncos', 'DEN'],
  ['Detroit Lions', 'DET'],
  ['Green Bay Packers', 'GB'],
  ['Houston Texans', 'HOU'],
  ['Indianapolis Colts', 'IND'],
  ['Jacksonville Jaguars', 'JAX'],
  ['Kansas City Chiefs', 'KC'],
  ['Las Vegas Raiders', 'LV'],
  ['Los Angeles Chargers', 'LAC'],
  ['Los Angeles Rams', 'LAR'],
  ['Miami Dolphins', 'MIA'],
  ['Minnesota Vikings', 'MIN'],
  ['New England Patriots', 'NE'],
  ['New Orleans Saints', 'NO'],
  ['New York Giants', 'NYG'],
  ['New York Jets', 'NYJ'],
  ['Philadelphia Eagles', 'PHI'],
  ['Pittsburgh Steelers', 'PIT'],
  ['San Francisco 49ers', 'SF'],
  ['Seattle Seahawks', 'SEA'],
  ['Tampa Bay Buccaneers', 'TB'],
  ['Tennessee Titans', 'TEN'],
  ['Washington Commanders', 'WAS'],
].map(([name, abbr]) => ({ name, abbr, short: name.split(' ').slice(-1)[0] }));

const NFL_BY_NAME = new Map(NFL_TEAMS.map((t) => [t.name, t]));

function nflTeam(name) {
  return NFL_BY_NAME.get(name) || { name, abbr: abbreviate(name), short: name.split(' ').slice(-1)[0] };
}

function abbreviate(name) {
  return name
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .toUpperCase()
    .slice(0, 3);
}

/**
 * Rough "national relevance" weighting for the college top-3 suggestion.
 * The Odds API does not publish AP rankings, so instead of bolting on a second
 * data source (and a second thing that can break on a Friday morning) we score
 * candidates on brand prominence + market interest and let the commissioner
 * make the final call.
 */
const CFB_BLUE_CHIP = {
  4: ['Alabama', 'Georgia', 'Ohio State', 'Michigan', 'Texas', 'Notre Dame', 'Oklahoma',
      'USC', 'LSU', 'Penn State', 'Florida State', 'Clemson', 'Oregon', 'Tennessee', 'Florida'],
  3: ['Auburn', 'Texas A&M', 'Wisconsin', 'Nebraska', 'Miami', 'Washington', 'Utah',
      'Ole Miss', 'Oklahoma State', 'Michigan State', 'Iowa', 'UCLA', 'Missouri', 'Arkansas',
      'South Carolina', 'Kansas State', 'North Carolina', 'Colorado', 'Louisville', 'Baylor'],
  2: ['Virginia Tech', 'Pittsburgh', 'NC State', 'Arizona State', 'Arizona', 'TCU', 'BYU',
      'Cincinnati', 'Kentucky', 'Mississippi State', 'Minnesota', 'Illinois', 'Indiana',
      'Maryland', 'Rutgers', 'Purdue', 'Northwestern', 'Iowa State', 'Texas Tech',
      'West Virginia', 'Boise State', 'Memphis', 'SMU', 'Duke', 'Georgia Tech', 'Syracuse',
      'California', 'Oregon State', 'Washington State', 'Kansas', 'Vanderbilt', 'Wake Forest',
      'Boston College', 'Virginia', 'Houston', 'UCF', 'Tulane', 'Navy', 'Army', 'Air Force'],
};

// Schools whose names are a prefix of a bigger brand ("Texas State" vs "Texas").
// Listing them explicitly keeps longest-prefix matching from over-rating them.
CFB_BLUE_CHIP[1] = [
  'Texas State', 'Ohio', 'Georgia State', 'Georgia Southern', 'Miami (OH)',
  'San Diego State', 'San Jose State', 'Fresno State', 'Colorado State',
  'Utah State', 'Kent State', 'Ball State', 'Arkansas State', 'Appalachian State',
  'Jacksonville State', 'Coastal Carolina', 'Middle Tennessee', 'Florida Atlantic',
  'Florida International', 'North Texas', 'South Alabama', 'Louisiana Tech',
  'Washington State', 'Oregon State', 'Iowa State', 'Kansas State', 'Michigan State',
  'Mississippi State', 'Arizona State', 'Oklahoma State', 'Penn State', 'Florida State',
  'Boise State', 'NC State', 'Ohio State',
];

const CFB_SCORES = new Map();
for (const [score, names] of Object.entries(CFB_BLUE_CHIP)) {
  for (const n of names) {
    const key = n.toLowerCase();
    // Higher tiers win when a school is listed twice (e.g. Ohio State).
    if (!CFB_SCORES.has(key) || CFB_SCORES.get(key) < Number(score)) {
      CFB_SCORES.set(key, Number(score));
    }
  }
}

/**
 * 0-4 brand score for a college team name. The Odds API returns names like
 * "Ohio State Buckeyes", so we match on the longest school-name prefix - that
 * way "Texas State Bobcats" scores as Texas State, not as Texas.
 */
function cfbBrandScore(name) {
  const clean = String(name || '').replace(/^#\d+\s*/, '').trim().toLowerCase();
  let best = 0;
  let bestLen = -1;
  for (const [key, score] of CFB_SCORES) {
    if (clean === key || clean.startsWith(key + ' ')) {
      if (key.length > bestLen) {
        bestLen = key.length;
        best = score;
      }
    }
  }
  return best;
}

module.exports = { NFL_TEAMS, nflTeam, cfbBrandScore };
