# Golden Football Pool — project context

Internal office pool for five people at Golden (Golden Home Management).
Two separate competitions: **NFL Survivor** and a **weekly NFL + college
pick'em against the spread**.

## Ground rules of the pool

These are product requirements, not implementation details. Do not "simplify"
them away.

- **No Thursday or Monday NFL games**, in either competition. Ever.
- Pick'em = every **Sunday** NFL game + exactly **3 featured Saturday college**
  games, all against the spread. Win 1, push 0.5, loss 0.
- **An individual week is won on total points.**
- **The season leaderboard ranks on winning percentage**, not points.
  Percentage is `points / graded picks`, so a push counts as half a win.
  Qualification is `settings.minPicks` graded picks (default 50); qualified
  players always sort above unqualified ones.
- Survivor = one Sunday NFL team per week, straight up, **never reuse a team**.
  Loss = a strike. Elimination at `settings.strikeRule` strikes (1 or 2).
  A tie counts as survival.
- **One frozen line per game.** Never average sportsbooks. Capture order is
  DraftKings → FanDuel → BetMGM → Caesars → commissioner manual entry, storing
  the book, the number and the timestamp. Spreads must not move after a week is
  published.
- **Per-game locking.** Each pick closes at its own kickoff, so missing the
  noon game must not block the 3:25 games. Survivor closes at the first
  eligible Sunday kickoff.
- **Nothing revealed early.** Other players' picks and pick percentages are
  withheld *by the server* until a game locks (or has a final score), not
  merely hidden in the UI.
- Everything is **America/Chicago**. Times are stored as ISO UTC and converted
  for display only.

## Architecture

No build step, one runtime dependency (`pg`, and only for the Postgres
backend).

- `server.js` — Node http entry point for a long-running host
- `api/index.js` — the same handler as a serverless function (Vercel)
- `src/app.js` — router, API routes, view models, all request validation
- `src/scoring.js` — ATS + survivor grading, standings. Pure functions.
- `src/odds.js` — The Odds API client, book hierarchy, college ranking
- `src/store.js` — persistence: `file` (atomic write) or `postgres` (one jsonb row)
- `src/state.js` — document shape, defaults, audit log
- `src/time.js` — America/Chicago helpers, DST-correct
- `src/auth.js` — HMAC-signed cookies, constant-time PIN compare
- `src/ratelimit.js` — login throttling, state held in the document
- `public/` — vanilla JS front end (`index.html`/`app.js`, `admin.html`/`admin.js`)

The whole pool is **one JSON document**. `store.read()` is deliberately
uncached, and `store.mutate()` **rolls back if its callback throws** — so any
code that must persist a change on a failure path (login throttling, for
instance) has to *return* a verdict and throw outside the mutation.

## Testing

```bash
npm test                                             # file backend
TEST_DATABASE_URL=postgres://user@host:5432/db npm test   # Postgres backend
```

157 checks, no network calls (The Odds API is mocked in `test/mock-odds.js`).
**Both backends must pass** before anything ships. The suite covers the
ground rules above, so a failure there usually means a rule was broken.

`npm run seed:demo` writes a demo season for clicking through with no API key.
It overwrites everything — never run it against live data.

## Conventions

- The API key is server-side only and must never appear in a browser asset or
  an API response. There is a test that enforces this.
- Every commissioner action goes into the audit log with before/after values.
- No em dashes in user-facing copy (house style).
- Say "Golden", never "GHM" — the brand guide retires it.
