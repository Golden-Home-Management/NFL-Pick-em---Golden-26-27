# GHM Football Pool

A small, mobile-first web app for a five-person office football pool. Two
separate competitions run side by side:

1. **NFL Survivor** — one Sunday NFL team per week, straight up, no repeats.
2. **Weekly Pick'em Against the Spread** — every Sunday NFL game plus three
   featured Saturday college games.

Thursday and Monday NFL games are excluded from both competitions. Everything
is displayed in **America/Chicago (Central)**.

Everyone bookmarks one permanent URL. Each Friday the commissioner publishes the
new week and the bookmark shows it automatically — nothing to re-send.

---

## Contents

- [What it does](#what-it-does)
- [Architecture](#architecture)
- [Run it locally](#run-it-locally)
- [Getting a The Odds API key](#getting-a-the-odds-api-key)
- [Where to configure the API key](#where-to-configure-the-api-key)
- [Deploying](#deploying)
- [The Friday weekly setup](#the-friday-weekly-setup)
- [How results work](#how-results-work)
- [How to change participants](#how-to-change-participants)
- [If the Odds API fails](#if-the-odds-api-fails)
- [Rules as implemented](#rules-as-implemented)
- [Security model](#security-model)
- [Tests](#tests)
- [Backups and data](#backups-and-data)
- [Project layout](#project-layout)

---

## What it does

**Participants** open the URL, choose their name, type a 4-digit PIN (or use
their personal link, which signs them in with no PIN), and get four tabs:

| Tab | Contents |
| --- | --- |
| **Make Picks** | Saturday college cards, then every Sunday NFL game in kickoff order, each with the frozen spread and Central kickoff time. |
| **Survivor** | Every Sunday team as a tappable card. Teams already used are visibly disabled. Your pick history and the field's status are below. |
| **Standings** | Weekly pick'em, season pick'em, and the survivor table (status, strikes, teams used). |
| **Results** | Week standings plus game-by-game finals, everyone's picks, and pick percentages. Any past week can be re-read from the week selector. |

**The commissioner** gets a PIN-protected `/admin` page: start the next week,
import games, get the suggested top 3 college games, refresh spreads, publish &
lock, enter or auto-fetch scores, override any pick or result, rename
participants, switch the strike rule, and read a full audit log.

### Deliberate design choices

- **One frozen line per game.** Multiple sportsbooks are never averaged. Each
  week captures a single book's spread (DraftKings first) and stores the book,
  the number, and the capture timestamp. Scoring stays deterministic and every
  employee picks the exact same line.
- **Per-game locking.** Missing the noon kickoff does not cost you the 3:25
  games. Each pick closes at its own game's kickoff. Survivor closes at the
  first eligible Sunday kickoff.
- **Nothing revealed early.** Other players' picks and the pick percentages for
  a game are withheld by the *server*, not just hidden in the UI, until that
  game locks.
- **No accounts.** Five people do not need a signup flow, password resets, or an
  email provider.

---

## Architecture

```
Browser  ──►  Node HTTP server  ──►  document store (JSON file or Postgres)
(no build)     - routes /api/*         all picks, weeks, lines, audit log
               - serves /public
               - holds the Odds API key
                      │
                      └──► api.the-odds-api.com  (server-side only)
```

- **Front end:** plain HTML, CSS and JavaScript in `public/`. No framework, no
  bundler, no build step. Deploy by copying files.
- **Back end:** Node's built-in `http` module with a small hand-written router
  (`src/app.js`). The exported handler is a plain `(req, res)` function, so the
  same code runs as a long-lived server *or* as a serverless function.
- **Storage:** the whole pool is one JSON document — with five players and a
  20-week season that is a few dozen kilobytes. Two interchangeable backends
  (`src/store.js`):

  | `STORAGE` | Where data lives | Use it for |
  | --- | --- | --- |
  | `file` (default) | a JSON file, written atomically (temp file + `fsync` + rename) | local dev, and any host with a persistent disk (Render, Fly, Railway, a VPS, Docker) |
  | `postgres` | one `jsonb` row in a `pool_state` table, created automatically | Supabase / Neon / any Postgres — required on read-only serverless hosts like Vercel |

  Writes are serialised through a promise queue, so two people submitting picks
  at the same second cannot clobber each other.

- **Dependencies:** exactly one (`pg`), and only the Postgres backend loads it.
  Nothing to audit, nothing to keep patched, no native compilation.

Why a document instead of a relational schema: for five users the entire dataset
fits in memory, there are no migrations to run mid-season, and the same code
path works on a file and on Postgres. Reliability and weekly ease were the
priorities, not schema elegance.

### Data model

```jsonc
{
  "season": 2026,
  "settings": { "poolName": "GHM FOOTBALL POOL", "strikeRule": 2, "currentWeek": 3 },
  "participants": [ { "id": "p_ab12", "name": "Evan", "pin": "4821", "token": "…", "active": true } ],
  "weeks": {
    "3": {
      "number": 3, "status": "published",        // draft | published | complete
      "sundayDate": "2026-09-27", "saturdayDate": "2026-09-26",
      "linesLockedAt": "2026-09-25T15:04:11Z", "lineSource": "DraftKings",
      "survivorLockAt": "2026-09-27T17:00:00Z",
      "games": [ {
        "id": "…", "sport": "nfl",               // nfl | ncaaf
        "commenceTime": "2026-09-27T17:00:00Z",  // always UTC on disk
        "homeTeam": "Dallas Cowboys", "awayTeam": "Philadelphia Eagles",
        "homeLabel": null, "awayLabel": null,    // e.g. "#4 Texas"
        "spread": -7.5,                          // ALWAYS the home number
        "spreadSource": "DraftKings",
        "spreadCapturedAt": "2026-09-25T15:04:09Z",
        "spreadManual": false,
        "final": { "homeScore": 31, "awayScore": 20, "at": "…", "source": "manual" }
      } ],
      "collegeCandidates": [ /* ranked Saturday games, for swapping */ ]
    }
  },
  "picks":         { "3|p_ab12|gameid": { "side": "home", "at": "…" } },
  "survivorPicks": { "3|p_ab12":        { "team": "Dallas Cowboys", "at": "…" } },
  "audit":         [ { "at": "…", "actor": "commissioner", "action": "week.publish", "detail": {} } ]
}
```

The spread is stored once, relative to the home team. The away number is always
its negation, so the two sides can never drift apart.

---

## Run it locally

Requires Node 18 or newer (Node 22 recommended).

```bash
git clone <this repo>
cd NFL-Pick-em---Golden-26-27
npm install

cp .env.example .env
# edit .env: set ADMIN_PIN and SESSION_SECRET at minimum

npm start
```

Open <http://localhost:3000>. The commissioner page is
<http://localhost:3000/admin>.

### Try it without an API key

```bash
npm run seed:demo
npm start
```

That loads a finished week 1 (with scores, standings and survivor strikes) and
an open week 2. Demo PINs are `1111`, `2222`, `3333`, `4444`, `5555`; the admin
PIN is whatever `ADMIN_PIN` is set to (`1234` by default).

`npm run seed:demo` **overwrites everything**. Never run it against a live pool.

---

## Getting a The Odds API key

1. Go to <https://the-odds-api.com/> and click **Get API Key**.
2. Enter an email address and pick the free tier (500 requests/month).
3. The key arrives by email and is shown in your dashboard.

The free tier is comfortable. A normal Friday costs **2 requests** (one NFL
odds call, one college odds call), and pulling final scores costs **2 more**.
That is roughly 16–20 requests per month for a 20-week season. Remaining quota
is reported by the API on every call.

The app uses:

| Purpose | Endpoint |
| --- | --- |
| NFL spreads | `/v4/sports/americanfootball_nfl/odds?regions=us&markets=spreads&oddsFormat=american` |
| College spreads | `/v4/sports/americanfootball_ncaaf/odds?regions=us&markets=spreads&oddsFormat=american` |
| Final scores | `/v4/sports/{sport}/scores?daysFrom=3` |

## Where to configure the API key

**Server-side only, as an environment variable named `ODDS_API_KEY`.** It is
never sent to the browser, never appears in the HTML or JavaScript, and never
appears in an API response. A test enforces this (`the Odds API key never
appears in any browser asset`).

| Where you run it | Where the key goes |
| --- | --- |
| Locally | the `ODDS_API_KEY=` line in `.env` (git-ignored) |
| Render | Dashboard → your service → **Environment** → Add `ODDS_API_KEY` |
| Fly.io | `fly secrets set ODDS_API_KEY=xxxxx` |
| Railway | Project → **Variables** |
| Vercel | Project → Settings → **Environment Variables** |
| Docker | `docker run -e ODDS_API_KEY=xxxxx …` |

Do **not** put the key in `vercel.json`, in any file under `public/`, or in a
committed `.env`.

### All environment variables

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `ODDS_API_KEY` | for automatic imports | — | The Odds API key. Without it the app still works fully in manual-entry mode. |
| `ADMIN_PIN` | yes | `1234` | Commissioner PIN. **Change this**, and make it 8+ characters - it is compared as a string, so it does not have to be four digits. |
| `SESSION_SECRET` | yes | dev fallback | Signs login cookies. Use a long random string; changing it signs everyone out. |
| `STORAGE` | no | `file`, or `postgres` if `DATABASE_URL` is set | Storage backend. |
| `DATA_FILE` | no | `./data/pool.json` | Where the JSON document lives when `STORAGE=file`. Point this at a persistent disk. |
| `DATABASE_URL` | for Postgres | — | Postgres/Supabase connection string. |
| `CRON_SECRET` | no | — | Enables `POST /api/cron/prepare-week`. Blank disables the endpoint entirely. |
| `SEASON` | no | current year | Season label in the header. |
| `PORT` | no | `3000` | Listen port. |

---

## Deploying

Any of these gives you one permanent URL. Pick the first one you already have
an account with.

### Option A — Render (disk-backed, no database at all)

`render.yaml` is included and needs no editing except the domain.

1. Render → **New** → **Blueprint** → pick this repo. It reads `render.yaml`:
   build `npm install --omit=dev`, start `node server.js`, a 1 GB disk mounted
   at `/var/data` with `DATA_FILE=/var/data/pool.json`, and the custom domain.
2. Enter `ODDS_API_KEY` and `ADMIN_PIN` when prompted. `SESSION_SECRET` is
   generated for you.
3. Deploy. The `https://<name>.onrender.com` URL works immediately.
4. For a custom domain, edit the `domains:` list in `render.yaml` (or add it
   under Settings → Custom Domains), then add the CNAME that Render shows you
   at your DNS provider.

This is the storage backend the whole test suite was written against, and it
needs no database.

**Free-tier instances will not work**: they cannot have a persistent disk, so
picks would be lost on every redeploy, and they spin down after 15 minutes of
inactivity with a ~1 minute cold start. A disk requires a paid instance
(Starter, a few dollars a month). If you need $0, use Option B.

**A note on HSTS.** If your parent domain sends
`Strict-Transport-Security` with `includeSubDomains` (many hosts do, including
Lovable-fronted sites), browsers that have visited the parent will refuse to
load the subdomain over plain HTTP and will require a valid certificate. There
is no grace period. Wait until Render reports the certificate issued before
sharing the link, or people get a TLS error page instead of the pool.

### Option B — Vercel + Supabase (recommended when the budget is $0)

1. **Supabase:** create a project. Then click the green **Connect** button in
   the top bar of the dashboard (next to the project/branch name). The modal
   opens on the **Framework** tab, which is not what you want — click the third
   tab, **Direct / Connection string**. Copy the **Transaction pooler** URI —
   it looks like:

   ```
   postgresql://postgres.<project-ref>:<password>@aws-N-<region>.pooler.supabase.com:6543/postgres
   ```

   Replace `[YOUR-PASSWORD]` with your database password. If the password has
   any of `@ : / ? # [ ] %` in it, URL-encode those characters (`@` becomes
   `%40`, and so on); plain letters and digits need nothing.

   The Session pooler string (port 5432) works too and is the better pick for a
   long-running server like Render. No SQL to run either way — the app creates
   its one table on the first request.

   **Do not use the string labelled "Direct connection" on a serverless host.**
   That hostname (`db.<project-ref>.supabase.co`) publishes an AAAA record only
   — it is reachable over IPv6 and nothing else — and serverless functions on
   Vercel have no IPv6 egress. The failure looks like a generic connection
   timeout with nothing in the Supabase logs, which is a miserable thing to
   debug. The pooler hostnames publish IPv4, which is why they are the right
   choice here. You can check any host yourself with:

   ```bash
   # A = IPv4, AAAA = IPv6. You want a host that answers for A.
   dig +short A    db.<project-ref>.supabase.co     # expect: nothing
   dig +short A    aws-N-<region>.pooler.supabase.com   # expect: addresses
   ```

   Note: connection strings are **not** under Settings → Database any more, and
   there is no Database item in the Settings sidebar. The **Connect** button is
   the only place they live.
2. **Vercel:** import the repo. `vercel.json` routes everything to
   `api/index.js`; there is no build step to configure. The app creates its
   `pool_state` table on first request, so there is nothing to migrate.
3. Environment variables: `DATABASE_URL` (the Supabase URI), `STORAGE=postgres`,
   `ODDS_API_KEY`, `ADMIN_PIN`, `SESSION_SECRET`.
4. Deploy and test on the `*.vercel.app` URL.
5. Custom domain (works on the free Hobby plan, 50 domains per project):
   Settings → Domains → Add, enter e.g. `pool.example.com`. Vercel shows a
   **project-specific** CNAME target like `d1d4fc829fe7bc7c.vercel-dns-017.com`
   — copy that exact value, do not reuse another project's. Add it as a CNAME
   at your DNS provider, then wait for Vercel to report the certificate issued.

Two things to know about the free tiers:

- Vercel's Hobby plan is documented as being for personal, non-commercial use.
- Supabase pauses free projects after a stretch of no activity. Weekly use
  during the season keeps it awake; in the offseason it will pause and you
  restore it with one click from the dashboard. No data is lost.

The Friday capture works the same here — the included GitHub Actions workflow
just calls the endpoint over HTTPS, so it does not depend on the host's own
cron (Hobby's built-in cron is limited to daily).

Firebase/Firestore would work the same way; the storage interface in
`src/store.js` is two methods (`load`, `save`).

### Option C — Fly.io / Railway / any VPS / Docker

```bash
docker build -t ghm-pool .
docker run -d --restart unless-stopped -p 3000:3000 \
  -v ghm-pool-data:/data \
  -e ODDS_API_KEY=xxxxx -e ADMIN_PIN=4821 -e SESSION_SECRET=$(openssl rand -hex 32) \
  --name ghm-pool ghm-pool
```

On Fly.io, attach a volume and set `DATA_FILE` to a path inside it.

### After deploying

1. Open `/admin`, sign in with `ADMIN_PIN`.
2. Rename the four `Player N` slots to real names.
3. Copy each person's **personal link** from the participants table and send it
   to them once (or give them their PIN). The personal link signs them in
   automatically, so they never type anything again.

---

## The Friday weekly setup

Target: under five minutes.

1. Open `/admin` and sign in.
2. **Start Next Week.** This creates the week, imports every Sunday NFL game
   (Thursday and Monday games are dropped), pulls all Saturday college games,
   ranks them, auto-selects the top 3, and captures each spread from DraftKings
   (falling back to FanDuel → BetMGM → Caesars).
3. Review the two tables. Swap a college game by ticking three boxes in
   **Suggested top 3 college games** and pressing *Save college selection*. Type
   over any spread to correct it. Add `#4` style rankings by editing the game
   labels if you want them on the cards.
4. Press **Refresh Lines** if you want a fresher capture before locking.
5. Press **Publish & Lock Week**.

That is it. Picks open immediately and everyone's bookmark shows the new week.
Publishing refuses to proceed while any game still has no spread, so a
half-configured week can never go live.

### Optional: skip steps 2–4 entirely

Set `CRON_SECRET` and point any scheduler at:

```
POST https://your-pool-url/api/cron/prepare-week?key=<CRON_SECRET>
```

The included `.github/workflows/friday-lines.yml` does this with GitHub Actions
(free). It fires at both 15:05 and 16:05 UTC on Fridays; the server only acts
during the 10 AM Central hour, so exactly one of them runs whether or not
daylight saving is in effect. It is idempotent — running it twice never creates
two weeks.

The scheduled capture deliberately **does not publish**. You still review and
press Publish & Lock, which is the whole point of a frozen line.

### What "frozen" means

Once a week is published, its spreads cannot change — not by a refresh, not by a
sportsbook moving its line. The stamp under the picks reads:

> Lines locked Friday, Sep 11 at 10:04 AM CT — source: DraftKings

If there is a genuine data error, press **Unlock (data error)**, fix the line,
and publish again. The unlock, the reason you type, and the before/after values
all go into the audit log.

### How the college top 3 is chosen

The Odds API does not publish AP rankings, so rather than depending on a second
data source that can break on a Friday morning, candidates are ranked from the
odds feed alone:

- brand prominence of both teams (a tiered list in `src/teams.js`, standing in
  for national relevance and TV appeal)
- how many sportsbooks posted a line (market interest)
- how close the line is (matchup quality)
- a small bump for the afternoon/prime-time window

It is a suggestion. **The commissioner always makes the final selection** and can
pick any Saturday FBS game in the candidate list, or add one by hand. Once the
week is published the three games are frozen.

---

## How results work

Two paths, and you can mix them freely.

**Automatic:** press **Auto-fetch final scores** on the admin page. It calls The
Odds API scores endpoint for both sports (`daysFrom=3`) and fills in every
completed game. Costs 2 requests.

**Manual:** type the away and home scores into the **Final scores** table and
press *Save*. Two numbers per game, about a minute for a full week.

A manually entered score is marked `manual` and **auto-fetch will never
overwrite it**. That makes the manual path a safe override rather than something
the next sync undoes.

Saving a score immediately recalculates everything — there is no separate
"process results" step:

- ATS grade per pick: **win = 1**, **push = 0.5**, **loss = 0**
- weekly pick'em standings and individual weekly results
- cumulative season standings
- survivor survival/strike, strikes total, teams used, eliminations

To correct a result, just retype it. To correct a pick, use the **Picks &
survivor (override)** grid. Both are recorded in the audit log with before and
after values.

Clearing a score (empty the home score field and save) puts the game back to
ungraded.

---

## How to change participants

`/admin` → **Participants**.

- **Rename:** type over the name and press *Save names & active flags*. All
  existing picks, points and survivor history follow the participant — the name
  is just a label on a stable ID.
- **Deactivate:** untick **Active**. They disappear from the pool and standings
  but their history is preserved, so you can tick them back on.
- **Add:** type a name in the box at the bottom and press *Add*. A PIN and a
  personal link are generated automatically.
- **New PIN / New link:** reissues either one. The old one stops working
  immediately.

Each participant has two ways in:

- **PIN** — pick your name from the dropdown, type 4 digits.
- **Personal link** — `https://your-pool-url/?p=<token>`. Opening it signs them
  in and remembers them; the token is then stripped from the address bar. This
  is the one to text people.

---

## If the Odds API fails

The app is built so a bad Friday morning is an inconvenience, not a blocker.

**Import failed / API down.** `Start Next Week` still creates the week and
reports what failed. Everything below works without the API:

- **Add a game manually** — sport, teams, Central kickoff, home spread.
- Type a spread into any game's **Home spread** box (negative means the home
  team is favoured). It is stored as source `Commissioner`, marked `MANUAL LINE`,
  and logged.
- Enter final scores by hand.

**A game has no spread.** If none of DraftKings / FanDuel / BetMGM / Caesars has
posted a line, the game arrives with an empty spread and publishing is blocked
until you fill it in or remove the game. It never silently defaults to zero.

**Out of API quota.** Same as "API down": everything is manual, nothing breaks.
The free tier resets monthly; the app reports remaining quota after each call.

**Scores never arrive automatically.** Use the manual score table. Some college
games in particular are not covered by the scores feed.

**Restoring a week.** Weeks are independent, so a botched import can be fixed by
unlocking, correcting, and republishing that week alone.

---

## Rules as implemented

### Pick'em (against the spread)

- Every Sunday NFL game, in kickoff order. **No Thursday or Monday games.**
- Exactly 3 featured Saturday college games.
- One side of every listed game, against the frozen spread.
- ATS win 1 point · push 0.5 · loss 0. Highest weekly total wins the week;
  season totals accumulate.
- A pick locks at its own game's kickoff. Earlier kickoffs never block later
  picks. Once a game kicks off that pick cannot be changed — enforced on the
  server, so a stale browser tab cannot get around it.
- No pick on a game simply scores 0 for that game.
- A half-point line can never push; a whole-number line can.

### Survivor

- Sunday NFL games only. **No Thursday or Monday games.**
- One team per week, to win straight up.
- A team can be used only once per season. Used teams are shown as disabled
  cards *and* rejected by the server.
- Winning team → you survive. Losing team → a strike. A tie counts as survival
  (the rule is "losing team receives a strike"), which matters roughly once a
  decade.
- Elimination at **2 strikes** by default. The commissioner can switch between
  1 and 2 at any time; standings recompute from the full pick history, so
  switching is reversible.
- The whole slate locks at the first eligible Sunday kickoff. The commissioner
  can override that deadline for a week.
- Everyone's survivor pick is hidden until the slate locks.

---

## Security model

Simple but not sloppy — this is an internal office game.

- **Admin PIN** required for every `/api/admin/*` route, checked on the server
  on every request.
- **Login throttling.** Five wrong PINs from one caller (or against one
  participant) locks that key out for 15 minutes, commissioner included. The
  counters live in the stored document, not process memory, so they work on
  serverless hosts where every request may run in a fresh instance. Admin
  lockouts are written to the audit log.
- **Use a long `ADMIN_PIN`.** It is compared as a string, so it can be any
  length - 8+ characters or a short passphrase, not four digits. The server
  warns at startup if it is short or a common default. This matters most if
  your repository is public, since the source then tells an attacker exactly
  what to aim at.
- **Sessions** are HMAC-SHA256 signed cookies (`HttpOnly`, `SameSite=Lax`,
  `Secure` behind HTTPS). Nothing is stored server-side; a forged or tampered
  cookie is rejected.
- **PINs** are compared in constant time.
- **Participants can only write their own picks.** Identity comes from the
  signed cookie, never from the request body — there is no `participantId` field
  a caller could change.
- **All pick validation is server-side:** week must be published, game must
  belong to the week, side must be `home`/`away`, kickoff must not have passed,
  survivor team must be in this week's slate and unused, and the player must not
  be eliminated.
- **Every submission is timestamped**, and commissioner overrides are marked as
  such.
- **The API key stays on the server.** No browser code ever contacts The Odds
  API.
- **Nothing is revealed early:** other players' picks and pick percentages are
  omitted from the API response until the game locks, so they are not merely
  hidden in the UI.
- **Audit log** records every commissioner action with before/after values:
  publishes, unlocks, line overrides, score changes, pick and survivor
  overrides, participant edits and rule changes.
- Static file serving cannot escape `public/`.

Not in scope, deliberately: 2FA, rate limiting, per-user encryption. Five
colleagues sharing a football pool do not need them, and each would be one more
thing to break on a Sunday morning.

---

## Tests

```bash
npm test                                        # against the JSON file backend

# and against the Postgres backend - the same code path Supabase uses:
TEST_DATABASE_URL=postgres://user@host:5432/postgres npm test
```

146 checks against the real HTTP app and a mocked Odds API — no network calls,
no API quota spent. The full suite passes on **both** storage backends, and was
run against a live Postgres including the serverless case (one process writes,
a cold second process reads it back). Covering:

- ATS grading: cover, no-cover, exact push, half-point line, pick-em line,
  underdog mirror, ungraded games, and the 1 / 0.5 / 0 scale
- straight-up survivor grading including a tie
- the sportsbook hierarchy DraftKings → FanDuel → BetMGM → Caesars, and the
  null result that forces manual entry
- Central-time handling across DST, late Sunday-night games, Monday night
- the Friday import: Thursday and Monday games excluded, chronological order,
  source and timestamp captured, exactly 3 ranked college games, Friday college
  games never candidates, swapping a college game
- draft weeks invisible to participants; publishing blocked while a spread is
  missing
- spreads not moving after publish even when the book moves; refresh refused on
  a published week; unlock → refresh working
- the scheduled Friday capture: disabled without a secret, wrong key rejected,
  the 10 AM Central window, idempotency, audit attribution
- two participants signing in (PIN and personal link), submitting different
  picks, changing a pick before lock, being refused after lock, and a mixed
  submission that saves the open game and rejects only the locked one
- other players' picks and percentages hidden before lock, visible after
- survivor: duplicate-team prevention, kicked-off teams unavailable, college
  teams excluded, elimination, an eliminated player refused
- weekly and season standings, ranking with ties, players who made no picks,
  pick percentages, commissioner result override flowing through
- starting a new week: same URL shows it, old weeks still readable, season
  totals accumulating, no duplicate weeks
- commissioner controls: strike rule 1 ⇄ 2 (including reviving a player),
  rename keeping history, PIN reissue, adding and deactivating participants
- auto score fetch, and a manual score never being overwritten by it
- login throttling: a 40-attempt brute force on the admin PIN is stopped after
  5 tries, the correct PIN is refused while locked, one caller's lockout does
  not affect another, participant PINs are throttled too, an unknown
  participant is indistinguishable from a wrong PIN, and lockouts are audited
- security: forged cookies, every admin route gated, cross-participant writes,
  the API key absent from every browser asset and response, PINs and personal
  tokens absent from the participant API, and path traversal

The mobile layout, the pick/survivor/standings/results flows and the admin
console were also walked through in a real Chromium browser at 320 px, 390 px
and 768 px: no horizontal overflow, no console errors, no tap target under
30 px.

---

## Backups and data

**`STORAGE=file`:** everything is one JSON file. To back it up, copy it.

```bash
cp /var/data/pool.json ~/pool-backup-$(date +%F).json
```

**`STORAGE=postgres`:** Supabase takes daily backups on the free tier. Or:

```sql
SELECT doc FROM pool_state WHERE id = 1;
```

A file backup restores by copying it back and restarting. The document format is
plain, readable JSON, so a mistake can be fixed in a text editor if it ever
comes to that.

---

## Project layout

```
server.js                  Node HTTP server entry point
api/index.js               serverless entry point (Vercel/Netlify)
src/
  app.js                   router, API routes, view models, validation
  scoring.js               ATS + survivor grading, standings (pure functions)
  odds.js                  The Odds API client, book hierarchy, college ranking
  store.js                 persistence: file (atomic) and Postgres backends
  state.js                 document shape, defaults, audit log
  time.js                  America/Chicago helpers (DST-correct)
  auth.js                  signed cookies, constant-time PIN comparison
  teams.js                 NFL team reference, college brand tiers
  config.js                environment loading
public/
  index.html  app.js       participant app
  admin.html  admin.js     commissioner console
  styles.css               mobile-first styling
scripts/seed-demo.js       demo season for clicking through with no API key
test/
  run-tests.js             the suite
  harness.js               boots the real app with a cookie jar
  mock-odds.js             stand-in for The Odds API
.github/workflows/friday-lines.yml   optional Friday capture
render.yaml  vercel.json  Dockerfile  .env.example
```

### Design notes

The look is a clean sports scoreboard on Golden's brand palette: Ink and Linen
grounds, Navy for structure and interactive state, Gold reserved for the single
primary action on a screen. Large tap targets, tabular figures for every number,
one subtle roofline mark in the header. No odds-boost banners, no green felt, no
countdown pressure — it reads like a scoreboard, not a sportsbook.

The header text is set from **Pool name** in admin settings if you would rather
it read something other than "GHM FOOTBALL POOL".
