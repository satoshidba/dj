# dj.

Proper shuffles and AI-briefed playlists for Spotify. Self-hosted, built for a couple of people.

- **Deal**: pick a playlist and dj rewrites its order so the same artist never plays twice in a row and big artists are spread as far apart as the length allows. Then play it *in order*, with shuffle off. Want a new order? Deal again.
- **Fresh deals & auto-deal**: deals push songs you've hammered lately towards the end, and any playlist can re-deal itself every morning or every Monday.
- **Rediscover, Together, Wrapped**: playlists from your own past, one balanced playlist for the two of you, and a Wrapped for any month or year.
- **Plays**: dj logs every play for both of you, every 10 minutes, so you get a complete history rather than Spotify's last 50. Older years can be imported from Spotify's data export.
- **Kids**: a locked-down screen of big picture buttons for the car or the living room, with AI-made clean playlists and the kids' plays kept out of your own stats.
- **Brief**: describe the moment ("running at 5:00/km, good rock", "deep focus, classical") and a curator (Claude) reads your Spotify listening history and builds a playlist for it.

## How the shuffle works

`server/shuffle.js` is pure and tested (`npm test`).

1. **Spread.** Each artist's tracks are placed at evenly spaced slots across the whole playlist (`length / count` apart), from a random starting point with a little jitter. Within an artist, albums are spread the same way.
2. **Repair.** A local search swaps tracks to clear anything still too close. Tracks that share *any* artist (features, collabs) count as the same artist. The penalty falls off steeply with distance, and same-album neighbours are penalised too.
3. **Best of several.** For playlists up to 500 tracks it deals 8 candidates and keeps the best, so "deal again" never comes out noticeably worse.

Each deal shows how well spread the result is: back-to-backs, repeats within 3 tracks, the tightest gap and a 0–100 spread score, next to the original order and what a plain random shuffle would typically get.

When you write the order to Spotify, the old order is saved first, and **Undo last write** puts it back.

## Plays: your full listening history

Spotify only shows apps your **last 50 plays**. So dj asks each signed-in person's account every 10 minutes (`PLAY_POLL_MINUTES`) for anything new and writes it to `DATA_DIR/plays/<user>.ndjson`. As long as the container is running, nothing is missed. If more than 50 songs play between two checks, the page says so.

To fill in everything **before** dj was running, request your data from Spotify:

1. spotify.com → Account → **Privacy** → tick **Extended streaming history** → request.
2. Spotify emails a link, usually within a few days (they say up to 30).
3. Plays tab → *Fill in the years before* → pick the `Streaming_History_Audio_*.json` files.

Streams under 30 seconds (skips) and podcasts are left out, matching how Spotify counts a play. Anything that overlaps with dj's own log is skipped.

The Plays tab shows play and hour totals, your best run of days in a row, plays over time, top artists and tracks, a weekday × hour heatmap (in your browser's time zone), and the latest plays. **Both of us** pools the two accounts and lists the artists you both play. **Kids** shows only Kids mode plays.

The Brief curator now reads this log too, with play counts over the last 90 days and the whole log, so its picks reflect what you really play, not just Spotify's top-50 lists.

## Kids mode

**Set up (Kids tab):**
- Add each kid's name, age, what they love and what to avoid. Profiles are shared by both grown-ups.
- Make playlists from presets (car singalong, bedtime, kitchen disco…) or your own words. A slider sets "just for them" to "fun for everyone". **Explicit tracks are filtered out** when matching, and the curator is told to keep everything age-appropriate. Give new ones a listen-through anyway.
- Or add any playlist you already own.
- Tap a button's picture to change it. "Re-deal each play" gives a fresh, properly spread order every time it's started.

**Use (Start Kids mode):** the device becomes a full-screen grid of big, coloured buttons with a now-playing bar (pause / next). Tapping a button deals that playlist and starts it on whichever Spotify device is awake, like the phone on CarPlay or the speaker at home. The screen stays on, and the device **stays in Kids mode across reloads**. Only a **2-second press-and-hold** on the corner button gets out.

**Keeping your taste yours:** plays from Kids mode playlists are tagged by playlist and kept out of your Plays stats and AI picks. Spotify's own recommendations are separate. In the Spotify app, use *⋯ → Exclude from your Taste Profile* on the kids playlists for that.

Starting music needs **Spotify Premium** on the account, and the playback permission. If you logged in before Kids mode existed, the Kids tab asks you to log in again once to grant it.


## Fresh deals and auto-deal

Once dj has some play history, **Fresh deal** (on by default, on the Deal screen) uses it. Songs you've played a lot in the last few weeks drift towards the end of the order, and ones you haven't heard in a while come up early. Spacing always wins: an artist's songs stay evenly spread, so freshness only moves songs where that doesn't put an artist closer together. Songs on heavy rotation are tagged *on repeat* in the list, and after a deal dj tells you how much of the opening quarter is songs you haven't played lately.

**Auto-deal** (same screen): *Every morning* or *Mondays* re-deals the playlist at 05:00 in your time zone (`AUTODEAL_HOUR` to change). It saves the previous order first, so *Undo last write* still works. Playlists on auto-deal show a ↻ in the list. A playlist that's deleted or no longer yours drops off the schedule.

## Rediscover, Together, Wrapped (Plays tab)

All three come from the play log. They're much richer once you've imported your Spotify history.

- **Rediscover**: *Forgotten favourites* (songs you played 5+ times, then not for six months), *This week, years ago* (what you played around today's date in earlier years) and *Your YYYY* for each full year. One tap makes a dealt playlist, and tapping again refreshes the same playlist rather than making a new one.
- **Together**: one playlist for both of you. Songs you both play come first, then each person's favourites alternately, weighted towards recent listening. The bar shows the balance. It's saved to whoever taps the button; share it from Spotify.
- **Wrapped**: pick any month or year. You get minutes, your artist and song, top fives, artists new to you, your listening hour and biggest day, the change on the period before, and a one-line listening personality. The cards are sized for screenshots.

Kids mode plays are left out of all three.

## Exact-length playlists

On **Brief** (and Kids → *Make a new one*), switch Length from *Songs* to *Time* and set anything from 15 minutes to 4 hours. The curator suggests songs with spares, and dj trims, tops up or swaps songs **in the middle** (never the opening or closing tracks) until the running time is within about 45 seconds of the target. The result shows the actual time next to what you asked for.

## Bedtime fade (Kids mode)

On a Kids button (Kids tab), set the 🌙 sleep timer to 20, 30, 45 or 60 minutes. When that button is tapped, the music plays as normal, then the volume eases down over the last 10 minutes and pauses, and the volume goes back to where it was for next time. The kids screen shows the time left. It runs on the server, so it keeps working with the phone screen locked. A few devices don't let apps change volume; on those it just pauses at the end. Restarting the container cancels a running timer.

## What Spotify allows (2026 rules)

Spotify tightened its API for apps in Development Mode (which is what a personal app is) in February 2026. This affects what dj can do:

| | |
|---|---|
| ✅ Playlists **you own or collaborate on** | Read, deal, write back |
| ✅ **Liked Songs** | Dealt into a playlist called *"Liked Songs, dealt"*, reused each time (apps can't reorder Liked Songs itself) |
| ❌ Other people's / Spotify's playlists | Apps can't read their contents any more. Copy the songs into your own playlist in Spotify and deal that. |
| ⚠️ Local files | Can't be written back by apps. dj offers "save as new playlist" instead, without them. |
| ⚠️ "Date added" | Rewriting a playlist resets each song's added date (that's how Spotify reorders through the API). |
| ✅ Listening history | Top artists and tracks (4 weeks / 6 months / all time) and the last 50 plays, plus dj's own continuous log and anything you import. |
| ❌ Tempo / energy data | Spotify withdrew audio features in 2024, so BPMs in Briefs are the curator's estimates and are labelled that way. |

Development Mode also needs the **app owner to have Spotify Premium** and allows **up to 5 users**, which is plenty for two people.

## Setup

### 1. Create the Spotify app

1. Go to <https://developer.spotify.com/dashboard> → **Create app**.
2. **Redirect URI**: `<APP_URL>/callback`, e.g. `https://dj.yourdomain.com/callback` or `http://127.0.0.1:8080/callback`.
   Spotify only accepts `https://` URLs or loopback IPs (`127.0.0.1`), **not** `localhost` and not plain-http LAN IPs like `http://192.168.1.20`.
3. Tick **Web API**.
4. In **User Management**, add both people's Spotify accounts (name + email). Without this, the second person gets an error at login.
5. Copy the **Client ID** and **Client secret**.

### 2. Configure

```bash
cp .env.example .env
```

Then fill in `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `APP_URL` and, for Briefs, `ANTHROPIC_API_KEY` (from <https://console.anthropic.com>). Dealing works without the Anthropic key.

### 3. Run with Docker

```bash
docker compose up -d --build
```

Logins, sessions and undo backups live in the `dj-data` volume.

### Reaching it from your phone

Because Spotify requires HTTPS for anything other than `127.0.0.1`, put dj behind something that gives it an HTTPS URL, and set `APP_URL` (plus the dashboard Redirect URI) to that URL:

- **Tailscale**: `tailscale serve --bg 8080` gives you `https://<machine>.<tailnet>.ts.net`, private to your tailnet. This is the easiest option for two people.
- **Cloudflare Tunnel**, **Caddy**, or **Traefik** with a real domain.

### Two users, and passkeys

**The first time**, each person taps **Connect Spotify** and signs in with their own Spotify account. This links the account and is the only time you see Spotify's login.

Straight after, dj offers to **add a passkey**. From then on, any device signs in with **Sign in with passkey** using Face ID, Touch ID or a fingerprint. No username, no Spotify page. Passkeys sync through iCloud Keychain or Google Password Manager, so your other devices work too. Each person's passkey signs into their own account.

Manage passkeys from the avatar menu → **Passkeys**: see where each one was added and last used, add one on the current device, or remove one so it stops working. To switch person on a shared device, use **Switch account** and sign in with the other passkey.

Passkeys need `APP_URL` to be **HTTPS with a hostname**, such as your Tailscale `https://<machine>.<tailnet>.ts.net`. They don't work on `http://127.0.0.1` or a bare IP, so the app just shows Connect Spotify there. A passkey is tied to that exact hostname: if you rename the machine or tailnet, add new passkeys. Set `PASSKEY_RP_ID` only if you serve dj on a subdomain and want passkeys to work across the parent domain.

dj stores only each passkey's public key. Nothing secret is kept for them.

To lock the app to only your two accounts, set `ALLOWED_SPOTIFY_IDS=id1,id2` (the "Username" on your Spotify account page).

## Development

```bash
npm install
npm test            # shuffle tests
npm run dev         # needs the env vars above
```

`test/mock-services.js` is a fake Spotify + Anthropic API for driving the whole UI without real accounts:

```bash
node test/mock-services.js &
SPOTIFY_CLIENT_ID=x SPOTIFY_CLIENT_SECRET=y APP_URL=http://127.0.0.1:8080 \
SPOTIFY_API_BASE=http://127.0.0.1:9099/v1 SPOTIFY_ACCOUNTS_BASE=http://127.0.0.1:9099/accounts \
ANTHROPIC_API_KEY=test ANTHROPIC_BASE_URL=http://127.0.0.1:9099/anthropic \
npm run dev
```

### Layout

```
server/
  index.js     routes, OAuth, sessions
  spotify.js   Web API client (token refresh, 429 back-off, pagination)
  shuffle.js   the deal algorithm + spread stats (also served to the browser for the landing demo)
  curator.js   taste profile → Claude (structured output) → Spotify search matching; kids variant
  plays.js     play log: polling, export import, stats, staleness
  deal.js      deal + write back (shared by the Deal button and auto-deal)
  autodeal.js  overnight re-deals
  insights.js  Rediscover, Together blend, Wrapped
  sleep.js     Kids bedtime fade
  passkeys.js  WebAuthn sign-in
  store.js     JSON file store in DATA_DIR
public/        no-build frontend: index.html, styles.css, app.js
```

Briefs use `claude-opus-5-5` by default (override with `ANTHROPIC_MODEL`), with server-side fallbacks enabled so a declined request is retried on another model. One brief costs a few cents.
