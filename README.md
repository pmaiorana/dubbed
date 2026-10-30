# Dubbed

Paste a friend's Spotify playlist, get it rebuilt in Apple Music.

## How it works

- **Reading playlists:** from Spotify's public embed page. No keys needed. Spotify's API no longer returns songs for playlists you don't own (Feb 2026), so the embed page is the only way in. It caps at about 100 songs.
- **Matching:** runs in the browser (`public/match.js`). It searches Apple Music and scores each result on title, artist and length. If the artist doesn't match, it's never counted as a match. With an Apple key, the browser searches Apple directly. Otherwise it goes through `/api/search` on the server.
- **Don't import `public/match.js` from the server.** Spacefast leaves files the server imports out of the static site, so the browser would get a 404.
- **Saving to Apple Music:** MusicKit JS in the browser, with a developer token signed by the server.
- **Apple Music → Spotify:** the code is still here (reading Apple playlists, saving to Spotify), but it's switched off. Pasting an Apple Music link shows an error.

## Keys (Spacefast env vars)

| Var | From |
| --- | --- |
| `APPLE_TEAM_ID` | Apple Developer account, Membership page |
| `APPLE_KEY_ID` | Certificates, IDs & Profiles → Keys → new key with MusicKit enabled |
| `APPLE_PRIVATE_KEY` | contents of that key's `.p8` file |

Without Apple keys, matching still works (it falls back to the free iTunes search), but saving is off.

`SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET` are only used by the switched-off Apple Music → Spotify direction.

## Run locally

```
node --experimental-strip-types scripts/dev.mjs
```

Put keys in `.env.local` (same names as above). Open http://localhost:8787.

## Deploy

```
sf publish
```
