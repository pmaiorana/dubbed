# Dubbed

Paste a friend's Spotify playlist, get it rebuilt in Apple Music. Or the other way round.

## How it works

- **Reading playlists:** from Spotify's public embed page and Apple Music's public web page. No keys needed. Spotify's API no longer returns songs for playlists you don't own (Feb 2026), so the embed page is the only way in. Both cap at about 100 songs.
- **Matching:** `/api/match` searches the other service and scores each result on title, artist and length. If the artist doesn't match, it's never counted as a match.
- **Saving to Apple Music:** MusicKit JS in the browser, with a developer token signed by the server.
- **Saving to Spotify:** the visitor logs in to Spotify (PKCE, so no secret in the browser). Spotify's dev mode only allows 5 approved accounts, so everyone else gets "Copy song links" to paste into the Spotify desktop app.

## Keys (Spacefast env vars)

| Var | From |
| --- | --- |
| `APPLE_TEAM_ID` | Apple Developer account, Membership page |
| `APPLE_KEY_ID` | Certificates, IDs & Profiles → Keys → new key with MusicKit enabled |
| `APPLE_PRIVATE_KEY` | contents of that key's `.p8` file |
| `SPOTIFY_CLIENT_ID` | developer.spotify.com dashboard → your app |
| `SPOTIFY_CLIENT_SECRET` | same app |

In the Spotify app settings, add the site URL with a trailing slash (e.g. `https://dubbed.example/`) as a Redirect URI, and add each person who should be able to save as a user.

Without Apple keys, matching to Apple still works (it falls back to the free iTunes search), but saving is off. Without Spotify keys, the Apple → Spotify direction is off.

## Run locally

```
node --experimental-strip-types scripts/dev.mjs
```

Put keys in `.env.local` (same names as above). Open http://localhost:8787.

## Deploy

```
sf publish
```
