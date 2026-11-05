# dj.

Proper shuffles and AI-briefed playlists for Spotify. Self-hosted, built for a couple of people.

- **Deal**: pick a playlist and dj rewrites its order so the same artist never plays twice in a row and big artists are spread as far apart as the length allows. Then play it *in order*, with shuffle off. Want a new order? Deal again.
- **Brief**: describe the moment ("running at 5:00/km, good rock", "deep focus, classical") and a curator (Claude) reads your Spotify listening history and builds a playlist for it.

## How the shuffle works

`server/shuffle.js` is pure and tested (`npm test`).

1. **Spread.** Each artist's tracks are placed at evenly spaced slots across the whole playlist (`length / count` apart), from a random starting point with a little jitter. Within an artist, albums are spread the same way.
2. **Repair.** A local search swaps tracks to clear anything still too close. Tracks that share *any* artist (features, collabs) count as the same artist. The penalty falls off steeply with distance, and same-album neighbours are penalised too.
3. **Best of several.** For playlists up to 500 tracks it deals 8 candidates and keeps the best, so "deal again" never comes out noticeably worse.

Each deal shows how well spread the result is: back-to-backs, repeats within 3 tracks, the tightest gap and a 0–100 spread score, next to the original order and what a plain random shuffle would typically get.

When you write the order to Spotify, the old order is saved first, and **Undo last write** puts it back.

## What Spotify allows (2026 rules)

Spotify tightened its API for apps in Development Mode (which is what a personal app is) in February 2026. This affects what dj can do:

| | |
|---|---|
| ✅ Playlists **you own or collaborate on** | Read, deal, write back |
| ✅ **Liked Songs** | Dealt into a playlist called *"Liked Songs, dealt"*, reused each time (apps can't reorder Liked Songs itself) |
| ❌ Other people's / Spotify's playlists | Apps can't read their contents any more. Copy the songs into your own playlist in Spotify and deal that. |
| ⚠️ Local files | Can't be written back by apps. dj offers "save as new playlist" instead, without them. |
| ⚠️ "Date added" | Rewriting a playlist resets each song's added date (that's how Spotify reorders through the API). |
| ✅ Listening history | Top artists and tracks (4 weeks / 6 months / all time) and the last 50 plays. That's what the curator reads. |
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

### Two users

Each person opens dj and taps **Connect Spotify**. Sessions are per browser, so on your own phones you'll each just stay logged in. On a shared computer, use the avatar menu → **Switch account**; Spotify will ask which account to use.

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
  curator.js   taste profile → Claude (structured output) → Spotify search matching
  store.js     JSON file store in DATA_DIR
public/        no-build frontend: index.html, styles.css, app.js
```

Briefs use `claude-opus-5-5` by default (override with `ANTHROPIC_MODEL`), with server-side fallbacks enabled so a declined request is retried on another model. One brief costs a few cents.
