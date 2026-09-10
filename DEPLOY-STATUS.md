# Deployment status — read this first

Written for whoever picks this up next, including a Claude Code session in
Evan's terminal. **This repository is public: no secrets in this file.**

## Where things stand

The app is built, tested and pushed. It has **never been deployed**. Nothing
below is blocked on code.

Decisions already made, after some back and forth — don't re-litigate them
without asking:

| Decision | Why |
| --- | --- |
| **Vercel Hobby + Supabase**, not Render | Evan wants $0. Render needs ~$7/mo for a persistent disk. |
| **Repo is public** | Vercel Hobby refuses *private* repos owned by a GitHub org. Public org repos are allowed. Repo was audited: no secrets in any commit. |
| **Postgres backend** (`STORAGE=postgres`) | Vercel's filesystem is read-only, so the JSON-file backend cannot work there. |
| Domain `2026nflpool.goldenatx.com` | Verified: the apex 302-redirects to goldenhomemanagement.com but there is **no wildcard**, so a subdomain is unaffected. |
| PIN sign-in, no Google OAuth | Evan considered Google Sign-In and declined. Can be added later alongside PINs without migration. |

## What is left

1. **Node** on the Mac (needed for the Vercel CLI, not for Claude Code):
   https://nodejs.org/dist/v24.21.0/node-v24.21.0.pkg — or `brew install node`.
2. `npm i -g vercel`
3. `vercel login` — **only Evan can do this.** Browser OAuth.
4. `vercel --prod` from the repo root.
5. Set six env vars in the Vercel dashboard (values are Evan's, see below),
   then redeploy.
6. Add the custom domain in Vercel, then **one CNAME at GoDaddy** —
   `2026nflpool` → the project-specific target Vercel shows. Only Evan can do
   this; GoDaddy has no CLI we are set up for.
7. Wait for the certificate, then open `/admin`, rename the five participant
   slots, and copy the personal links **from the custom domain** so they carry
   the right hostname.
8. Start Next Week → review → Publish & Lock.

## Environment variables

Six, exactly. Ask Evan for the values — do not guess, and do not commit them.

| Key | Notes |
| --- | --- |
| `ODDS_API_KEY` | The Odds API. Evan has it. |
| `ADMIN_PIN` | Should be 8+ characters. It is compared as a string, so a passphrase is fine. |
| `SESSION_SECRET` | `openssl rand -hex 32` |
| `STORAGE` | `postgres` |
| `DATABASE_URL` | Supabase **transaction pooler** string, port 6543 |
| `SEASON` | `2026` (optional — defaults to the current year) |

`STORAGE=postgres` without `DATABASE_URL` **throws on module load**. Set both
or neither.

## Gotchas already discovered the hard way

- **Supabase's "Direct connection" string is IPv6-only.**
  `db.<ref>.supabase.co` publishes an AAAA record and no A record, and Vercel
  functions have no IPv6 egress. It fails as a bare connection timeout with
  nothing in the Supabase logs. Use a **pooler** hostname, which has IPv4.
- The Supabase connection strings live behind the green **Connect** button in
  the dashboard top bar, third tab ("Direct / Connection string"). They are
  *not* under Settings → Database, and there is no Database item in that
  sidebar any more.
- **Vercel's import screen auto-detects every key in `.env.example`** and
  pre-creates all nine. A key with an empty value silently disables the Deploy
  button. Delete the ones you are not using.
- **Both Golden domains send HSTS with `includeSubDomains`.** A browser that
  has visited `goldenatx.com` will refuse the subdomain without a valid
  certificate, with no http fallback and no click-through. Do not share the
  link until Vercel reports the certificate issued.
- Evan's Mac is a **MacBook Air**, so self-hosting on it was never viable —
  it sleeps in a bag exactly when someone wants to pick.
- Supabase pauses free projects after a stretch of inactivity. Weekly use
  keeps it awake in season; expect to restore it once in the offseason.

## Optional, after it is live

`CRON_SECRET` enables `POST /api/cron/prepare-week`, and
`.github/workflows/friday-lines.yml` calls it so Friday's lines are captured
before Evan opens the admin page. It deliberately does not publish — a person
still presses Publish & Lock.
