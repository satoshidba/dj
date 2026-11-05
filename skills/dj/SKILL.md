---
name: dj
description: Control the user's Spotify through their self-hosted dj server. Properly shuffle ("deal") playlists so they play in order without same-artist repeats, schedule automatic re-deals, read their full listening history and stats, make Wrapped-style recaps, build playlists from a brief or from their past (forgotten favourites, a year, a two-person blend), and start Kids mode buttons or control playback. Use when the user asks about their music, Spotify playlists, what they've been listening to, or wants a playlist made or shuffled.
---

# dj

dj is the user's own Spotify helper, reached with the `dj` command. Every command prints JSON.

## Check it's set up

```bash
dj whoami
```

If it says "not set up", ask the user for their dj address and an access token (made in dj under the avatar menu → **Agents & API**), then:

```bash
dj login https://<their-dj-address> <token>
```

If `dj` itself isn't installed, it can be downloaded from their dj server:

```bash
curl -fsSL https://<their-dj-address>/cli/dj -o ~/.local/bin/dj && chmod +x ~/.local/bin/dj
```

## Find your way around

```bash
dj actions                 # everything available (a read-only token shows fewer)
dj help <action>           # what it does and its options
```

Options are `--name value` (dashes or underscores both work). A bare value fills the main option, so `dj deal_playlist "Gym Rock"` is the same as `dj deal_playlist --playlist "Gym Rock"`. For lists or nested data use `--json '{...}'`.

## Common jobs

| The user wants… | Run |
|---|---|
| their playlists | `dj list_playlists` |
| a playlist shuffled properly | `dj deal_playlist "<name>"` (written to Spotify; tell them to play it in order with shuffle **off**) |
| to undo that | `dj undo_deal "<name>"` |
| it re-shuffled every morning | `dj set_auto_deal "<name>" --schedule daily` (`weekly` = Mondays, `off` to stop) |
| what they've been listening to | `dj listening_stats --range 30d` (`7d`, `90d`, `365d`, `all`) |
| what played just now | `dj recent_plays --limit 10` or `dj now_playing` |
| a recap | `dj wrapped` (last month) or `dj wrapped --period 2025` / `--period 2026-10` |
| a playlist you pick | `dj create_playlist --json '{"name":"…","songs":[{"artist":"…","title":"…"}]}'` |
| a playlist from a mood or activity | `dj brief_playlist "<brief>"` (add `--minutes 45` to make it last that long; takes up to a minute) |
| songs from their past | `dj rediscover_list`, then `dj save_rediscover --set forgotten` (or `thisweek`, `year-2024`, …) |
| one playlist for both people | `dj together_preview`, then `dj save_together` |
| the kids' music on | `dj kids_buttons`, then `dj kids_play "<button>"` |
| pause / resume / skip | `dj player --action pause` |

## Good to know

- **Choosing songs yourself vs dj's curator.** `create_playlist` uses your own judgement: you pick the songs, dj finds them on Spotify and reports any it couldn't find. `brief_playlist` hands the job to dj's built-in curator, which knows the user's history but uses the server's AI credits. Prefer `create_playlist` when you already know what to pick.
- **Ground picks in their taste.** Before choosing songs, `dj listening_stats --range 90d` gives their real top artists and tracks.
- **Which playlists can change.** Spotify only lets apps change playlists the user owns or collaborates on (`can_deal: true` in `list_playlists`). Liked Songs is dealt into a separate "Liked Songs, dealt" playlist.
- **Playback** (`kids_play`, `player`) needs Spotify Premium and a device that's awake; if none is, ask the user to open Spotify somewhere.
- **Read-only tokens** can look but not change anything; actions that change things fail with a clear message.
- Pass back the `url` from results so the user can open the playlist.
