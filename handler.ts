// Dubbed: server half. Reads public playlists, matches songs across services,
// and hands out the Apple Music developer token. Static files in public/ are
// served by Spacefast; anything they don't answer lands here.

import { scoreMatch, type Track, type Candidate } from "./lib/match.ts";
import { readApplePlaylist, readSpotifyPlaylist, parsePlaylistUrl } from "./lib/playlists.ts";

type Env = {
  APPLE_TEAM_ID?: string;
  APPLE_KEY_ID?: string;
  APPLE_PRIVATE_KEY?: string;
  SPOTIFY_CLIENT_ID?: string;
  SPOTIFY_CLIENT_SECRET?: string;
};

const MAX_BATCH = 10;

export default {
  async fetch(request: Request, env: Env = {}): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/api/config") return config(env);
      if (url.pathname === "/api/playlist") return await playlist(url);
      if (url.pathname === "/api/match" && request.method === "POST") return await match(request, env);
      if (url.pathname === "/api/apple/token") return await appleToken(env, url);
    } catch (err) {
      const status = (err as { status?: number }).status ?? 500;
      const message = err instanceof Error ? err.message : "Something broke.";
      return Response.json({ error: message }, { status });
    }
    return new Response("Not found", { status: 404 });
  },
};

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function appleConfigured(env: Env) {
  return Boolean(env.APPLE_TEAM_ID && env.APPLE_KEY_ID && env.APPLE_PRIVATE_KEY);
}

function spotifyConfigured(env: Env) {
  return Boolean(env.SPOTIFY_CLIENT_ID && env.SPOTIFY_CLIENT_SECRET);
}

function config(env: Env) {
  return Response.json({
    apple: appleConfigured(env),
    spotify: spotifyConfigured(env),
    spotifyClientId: env.SPOTIFY_CLIENT_ID ?? null,
  });
}

async function playlist(url: URL) {
  const raw = url.searchParams.get("url") ?? "";
  const parsed = parsePlaylistUrl(raw);
  if (!parsed) throw new HttpError(400, "That doesn't look like a Spotify or Apple Music playlist link.");
  const result = parsed.source === "spotify"
    ? await readSpotifyPlaylist(parsed.id)
    : await readApplePlaylist(parsed.storefront, parsed.id, parsed.slug);
  return Response.json(result);
}

async function match(request: Request, env: Env) {
  const body = await request.json() as { target: "apple" | "spotify"; storefront?: string; tracks: Track[] };
  const tracks = (body.tracks ?? []).slice(0, MAX_BATCH);
  const storefront = /^[a-z]{2}$/.test(body.storefront ?? "") ? body.storefront! : "us";

  let search: (q: string) => Promise<Candidate[]>;
  if (body.target === "apple") {
    search = appleConfigured(env)
      ? (q) => searchAppleCatalog(env, storefront, q)
      : (q) => searchItunes(storefront, q);
  } else if (body.target === "spotify") {
    if (!spotifyConfigured(env)) throw new HttpError(503, "Spotify matching isn't switched on yet. The site owner needs to add Spotify keys.");
    search = (q) => searchSpotify(env, q);
  } else {
    throw new HttpError(400, "Unknown target.");
  }

  const results = await Promise.all(tracks.map((t) => bestMatch(t, search)));
  return Response.json({ results });
}

async function bestMatch(track: Track, search: (q: string) => Promise<Candidate[]>) {
  const primaryArtist = track.artists[0] ?? "";
  const queries = [`${track.title} ${primaryArtist}`, track.title];
  let best: { candidate: Candidate; score: number } | null = null;
  for (const q of queries) {
    const candidates = await search(q);
    for (const candidate of candidates) {
      const score = scoreMatch(track, candidate);
      if (!best || score > best.score) best = { candidate, score };
    }
    if (best && best.score >= 0.8) break;
  }
  return best ? { ...best.candidate, score: Math.round(best.score * 100) / 100 } : null;
}

// ---------- Apple ----------

async function searchItunes(storefront: string, q: string): Promise<Candidate[]> {
  const res = await fetch(`https://itunes.apple.com/search?${new URLSearchParams({ term: q, entity: "song", limit: "6", country: storefront })}`);
  if (!res.ok) {
    console.warn(`itunes search ${res.status}: ${(await res.text()).slice(0, 200)}`);
    // Shared server IPs hit this limit fast. Say so rather than report every song missing.
    if (res.status === 429 || res.status === 403) throw new HttpError(503, "Apple's song search is busy. Try again in a minute.");
    return [];
  }
  const data = await res.json() as { results: any[] };
  return data.results.map((r) => ({
    id: String(r.trackId),
    title: r.trackName,
    artists: splitArtists(r.artistName),
    durationMs: r.trackTimeMillis,
    url: r.trackViewUrl?.replace(/[?&]uo=\d+/, ""),
    art: r.artworkUrl100,
  }));
}

async function searchAppleCatalog(env: Env, storefront: string, q: string): Promise<Candidate[]> {
  const token = await getAppleDeveloperToken(env);
  const res = await fetch(`https://api.music.apple.com/v1/catalog/${storefront}/search?${new URLSearchParams({ term: q, types: "songs", limit: "6" })}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return searchItunes(storefront, q);
  const data = await res.json() as any;
  return (data.results?.songs?.data ?? []).map((s: any) => ({
    id: s.id,
    title: s.attributes.name,
    artists: splitArtists(s.attributes.artistName),
    durationMs: s.attributes.durationInMillis,
    url: s.attributes.url,
    art: s.attributes.artwork?.url?.replace("{w}", "100").replace("{h}", "100"),
  }));
}

let appleTokenCache: { token: string; exp: number } | null = null;

async function getAppleDeveloperToken(env: Env) {
  const now = Math.floor(Date.now() / 1000);
  if (appleTokenCache && appleTokenCache.exp - now > 3600) return appleTokenCache.token;
  const exp = now + 60 * 60 * 12;
  const header = { alg: "ES256", kid: env.APPLE_KEY_ID };
  const payload = { iss: env.APPLE_TEAM_ID, iat: now, exp };
  const enc = (o: object) => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const signingInput = `${enc(header)}.${enc(payload)}`;
  const pem = env.APPLE_PRIVATE_KEY!.replace(/\\n/g, "\n").replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(signingInput));
  const token = `${signingInput}.${b64url(new Uint8Array(sig))}`;
  appleTokenCache = { token, exp };
  return token;
}

async function appleToken(env: Env, url: URL) {
  if (!appleConfigured(env)) throw new HttpError(503, "Saving to Apple Music isn't switched on yet. The site owner needs to add an Apple MusicKit key.");
  return Response.json({ token: await getAppleDeveloperToken(env) }, { headers: { "Cache-Control": "no-store" } });
}

function b64url(bytes: Uint8Array) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ---------- Spotify ----------

let spotifyTokenCache: { token: string; exp: number } | null = null;

async function getSpotifyAppToken(env: Env) {
  if (spotifyTokenCache && spotifyTokenCache.exp - Date.now() > 60_000) return spotifyTokenCache.token;
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new HttpError(502, "Spotify wouldn't give us a token.");
  const data = await res.json() as { access_token: string; expires_in: number };
  spotifyTokenCache = { token: data.access_token, exp: Date.now() + data.expires_in * 1000 };
  return data.access_token;
}

async function searchSpotify(env: Env, q: string): Promise<Candidate[]> {
  const token = await getSpotifyAppToken(env);
  const res = await fetch(`https://api.spotify.com/v1/search?${new URLSearchParams({ q, type: "track", limit: "6" })}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 429) throw new HttpError(429, "Spotify says slow down. Try again in a minute.");
  if (!res.ok) return [];
  const data = await res.json() as any;
  return (data.tracks?.items ?? []).map((t: any) => ({
    id: t.id,
    uri: t.uri,
    title: t.name,
    artists: t.artists.map((a: any) => a.name),
    durationMs: t.duration_ms,
    url: t.external_urls?.spotify,
    art: t.album?.images?.at(-1)?.url,
  }));
}

function splitArtists(s: string = "") {
  return s.split(/\s*(?:,|&|\bfeat\.?|\bft\.)\s*/i).filter(Boolean);
}
