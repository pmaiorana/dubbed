// Dubbed: browser half. Loads a playlist, matches it on the other service,
// then saves it with the visitor's own login. Apple searches run from here,
// not the server, because Apple rejects many requests from our shared host.

import { bestMatch, splitArtists } from "./match.js";

const $ = (id) => document.getElementById(id);

const SERVICE = { spotify: "Spotify", apple: "Apple Music" };
const BATCH = 10;
const PARALLEL = 1;
const RETRY_WAITS = [3000, 8000, 15000];
const STASH_KEY = "dubbed:pending";

const state = {
  config: { apple: false, spotify: false, spotifyClientId: null },
  playlist: null,
  target: null,
  matches: [],
  // Rows going into the new playlist. Sure and likely matches start in; the
  // visitor can add a closest match or drop any song.
  included: new Set(),
};

init();

async function init() {
  $("paste").addEventListener("submit", onPaste);
  $("save-btn").addEventListener("click", onSave);
  $("copy-btn").addEventListener("click", onCopy);
  $("again-btn").addEventListener("click", reset);

  state.config = await fetch("/api/config").then((r) => r.json()).catch(() => state.config);

  const params = new URLSearchParams(location.search);
  if (params.has("code") || params.has("error")) await finishSpotifyLogin(params);
}

// ---------- load ----------

async function onPaste(event) {
  event.preventDefault();
  hideError("paste-error");
  const url = $("playlist-url").value.trim();
  const btn = $("load-btn");
  if (/music\.apple\.com/.test(url)) {
    showError("paste-error", "Spotify playlists only for now. Apple Music to Spotify isn't switched on.");
    return;
  }
  btn.disabled = true;
  btn.textContent = "Rewinding…";
  try {
    const res = await fetch(`/api/playlist?url=${encodeURIComponent(url)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? "Couldn't read that playlist.");
    if (!data.tracks.length) throw new Error("That playlist is empty. Nothing to dub.");
    state.playlist = data;
    state.target = data.source === "spotify" ? "apple" : "spotify";
    state.matches = [];
    state.included = new Set();
    renderDeck();
    $("deck").scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    await matchAll();
  } catch (err) {
    showError("paste-error", err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "Dub it";
  }
}

function renderDeck() {
  const { playlist, target } = state;
  $("deck").hidden = false;
  $("save").hidden = true;
  $("done").hidden = true;
  $("tape-title").textContent = playlist.name;
  $("tape-side").textContent = `${SERVICE[playlist.source]} to ${SERVICE[target]}`;
  $("deck-name").textContent = playlist.name;
  $("deck-meta").textContent = [playlist.owner && `by ${playlist.owner}`, `${playlist.tracks.length} songs from ${SERVICE[playlist.source]}`]
    .filter(Boolean).join(", ");

  const list = $("tracks");
  list.replaceChildren(...playlist.tracks.map((track, i) => {
    const li = document.createElement("li");
    li.className = "track";
    li.dataset.state = "pending";
    li.dataset.index = i;

    const text = document.createElement("div");
    text.className = "track-text";
    const title = document.createElement("span");
    title.className = "track-title";
    title.textContent = track.title;
    const artist = document.createElement("span");
    artist.className = "track-artist";
    artist.textContent = track.artists.join(", ");
    const match = document.createElement("span");
    match.className = "track-match";
    text.append(title, artist, match);

    const mark = document.createElement("button");
    mark.type = "button";
    mark.className = "mark";
    mark.disabled = true;
    mark.textContent = "·";
    mark.setAttribute("aria-label", "Waiting");
    mark.addEventListener("click", () => toggleIncluded(i));

    li.append(text, mark);
    return li;
  }));
}

// ---------- match ----------

function guessStorefront() {
  const region = (navigator.language || "en-US").split("-")[1];
  return region && region.length === 2 ? region.toLowerCase() : "us";
}

async function matchAll() {
  const tracks = state.playlist.tracks;
  const batches = [];
  for (let i = 0; i < tracks.length; i += BATCH) batches.push(i);
  let done = 0;

  document.querySelector(".tape").classList.add("is-dubbing");
  setProgress(`dubbing… 0 of ${tracks.length}`);

  const worker = async () => {
    while (batches.length) {
      const start = batches.shift();
      const slice = tracks.slice(start, start + BATCH);
      slice.forEach((_, j) => setRow(start + j, "working"));
      let results;
      try {
        results = await matchBatch(slice, done, tracks.length);
      } catch (err) {
        batches.length = 0;
        throw err;
      }
      results.forEach((m, j) => {
        state.matches[start + j] = m;
        if (verdict(m) !== "missing") state.included.add(start + j);
        setRow(start + j);
      });
      done += slice.length;
      setProgress(`dubbing… ${done} of ${tracks.length}`);
    }
  };

  try {
    await Promise.all(Array.from({ length: PARALLEL }, worker));
    setProgress("");
    showSave();
  } catch (err) {
    setProgress("");
    tracks.forEach((_, i) => { if (!state.matches[i]) setRow(i, "pending"); });
    showSave(err.message);
  } finally {
    document.querySelector(".tape").classList.remove("is-dubbing");
  }
}

// Apple with a key: search Apple straight from the browser. Otherwise go
// through the server's /api/search.
async function matchBatch(slice, done, total) {
  const storefront = guessStorefront();
  const search = state.target === "apple" && state.config.apple
    ? (q) => searchAppleCatalog(storefront, q, done, total)
    : (q) => searchViaServer(storefront, q, done, total);
  const results = [];
  for (const track of slice) results.push(await bestMatch(track, search));
  return results;
}

// When a search service is busy the server says 503. Wait and try again.
async function searchViaServer(storefront, q, done, total) {
  const url = `/api/search?${new URLSearchParams({ target: state.target, storefront, q })}`;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url);
    const data = await res.json().catch(() => ({}));
    if (res.ok) return data.candidates;
    if (res.status !== 503 || attempt >= RETRY_WAITS.length || /switched on/.test(data.error ?? "")) {
      throw new Error(data.error ?? "Search failed.");
    }
    setProgress(`tape jammed. rewinding… ${done} of ${total}`);
    await new Promise((r) => setTimeout(r, RETRY_WAITS[attempt]));
  }
}

function verdict(match) {
  if (!match) return "missing";
  if (match.score >= 0.8) return "found";
  if (match.score >= 0.6) return "maybe";
  return "missing";
}

function setRow(i, forced) {
  const li = $("tracks").children[i];
  const mark = li.querySelector(".mark");
  const matchEl = li.querySelector(".track-match");
  const match = state.matches[i];
  const status = forced ?? verdict(match);
  const included = state.included.has(i);
  li.dataset.state = status;
  li.dataset.skip = String(!forced && !included);

  const labels = {
    pending: ["·", "Waiting"],
    working: ["~", "Looking"],
    found: [included ? "✓" : "✗", included ? "Found. Click to skip" : "Skipped. Click to include"],
    maybe: [included ? "✓" : "?", included ? "Using the closest match" : "Not sure. Pick the closest match below"],
    missing: [included ? "✓" : "✗", included ? "Using the closest match" : `Not on ${SERVICE[state.target]}`],
  };
  const [glyph, label] = labels[status];
  mark.textContent = glyph;
  mark.setAttribute("aria-label", label);
  mark.title = label;
  mark.disabled = status !== "found";

  matchEl.replaceChildren();
  if ((status === "maybe" || status === "missing") && match) {
    matchEl.append("closest: ");
    const a = document.createElement("a");
    a.href = match.url;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = `${match.title} by ${match.artists.join(", ")}`;
    const pick = document.createElement("button");
    pick.type = "button";
    pick.className = "pick";
    pick.setAttribute("aria-pressed", String(included));
    pick.textContent = included ? "Using this song" : "Use this song";
    pick.addEventListener("click", () => toggleIncluded(i));
    matchEl.append(a, pick);
  } else if (status === "missing" && !forced) {
    matchEl.textContent = `not on ${SERVICE[state.target]}`;
  }
}

function toggleIncluded(i) {
  state.included.has(i) ? state.included.delete(i) : state.included.add(i);
  setRow(i);
  updateSummary();
}

function keepers() {
  return state.matches.filter((m, i) => m && state.included.has(i));
}

function setProgress(text) { $("progress").textContent = text; }

// ---------- save ----------

function updateSummary() {
  const n = keepers().length;
  $("save-summary").textContent = `${n} of ${state.playlist.tracks.length} songs found on ${SERVICE[state.target]}.`;
  $("save-btn").disabled = n === 0;
}

function showSave(errorMessage) {
  const { target, config } = state;
  $("save").hidden = false;
  hideError("save-error");
  updateSummary();

  const saveBtn = $("save-btn");
  const copyBtn = $("copy-btn");
  const note = $("save-note");

  if (target === "apple") {
    saveBtn.textContent = "Save to Apple Music";
    saveBtn.hidden = !config.apple;
    copyBtn.hidden = true;
    note.textContent = config.apple
      ? "Apple will ask you to sign in. The playlist goes straight into your library."
      : "Saving to Apple Music isn't switched on yet. The site owner needs to add an Apple MusicKit key.";
  } else {
    saveBtn.textContent = "Log in to Spotify and save";
    saveBtn.hidden = !config.spotifyClientId;
    copyBtn.hidden = false;
    note.textContent = "Spotify only lets this site save for a handful of approved accounts. Everyone else: copy the song links, make an empty playlist in the Spotify desktop app, click into it and paste. Spotify adds them all.";
  }

  if (errorMessage) {
    showError("save-error", errorMessage);
    if (!keepers().length) {
      saveBtn.hidden = true;
      copyBtn.hidden = true;
      note.textContent = "";
    }
  }
}

async function onSave() {
  hideError("save-error");
  const btn = $("save-btn");
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Saving…";
  try {
    if (state.target === "apple") await saveToApple();
    else await startSpotifyLogin();
  } catch (err) {
    showError("save-error", err.message);
    btn.disabled = false;
    btn.textContent = label;
  }
}

async function onCopy() {
  const links = keepers().map((m) => m.url).join("\n");
  try {
    await navigator.clipboard.writeText(links);
    $("copy-btn").textContent = "Copied. Now paste in Spotify";
  } catch {
    showError("save-error", "Your browser blocked copying. Select the links in the list and copy them by hand.");
  }
}

function description() {
  return `Dubbed from ${SERVICE[state.playlist.source]}: ${state.playlist.url}`;
}

function showDone(link) {
  $("save").hidden = true;
  $("done").hidden = false;
  $("done-copy").textContent = `${keepers().length} songs are now in "${state.playlist.name}" on ${SERVICE[state.target]}.`;
  const a = $("done-link");
  a.href = link;
  a.textContent = `Open in ${SERVICE[state.target]}`;
  a.focus();
}

function reset() {
  $("deck").hidden = true;
  $("playlist-url").value = "";
  $("playlist-url").focus();
  state.playlist = null;
}

// ---------- Apple Music ----------

let developerToken = null;

async function getDeveloperToken() {
  if (developerToken) return developerToken;
  const res = await fetch("/api/apple/token");
  const data = await res.json();
  if (!res.ok) throw new Error(data.error);
  developerToken = data.token;
  return developerToken;
}

async function searchAppleCatalog(storefront, q, done, total) {
  const token = await getDeveloperToken();
  const url = `https://api.music.apple.com/v1/catalog/${storefront}/search?${new URLSearchParams({ term: q, types: "songs", limit: "6" })}`;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (res.ok) {
      const data = await res.json();
      return (data.results?.songs?.data ?? []).map((s) => ({
        id: s.id,
        title: s.attributes.name,
        artists: splitArtists(s.attributes.artistName),
        durationMs: s.attributes.durationInMillis,
        url: s.attributes.url,
      }));
    }
    // 429 = slow down. 401 = Apple sometimes rejects a valid token at random; a quick retry usually works.
    const waits = res.status === 401 ? [300, 600, 1000, 1500, 2500] : RETRY_WAITS;
    if ((res.status !== 429 && res.status !== 401) || attempt >= waits.length) {
      throw new Error(`Apple Music search failed (${res.status}). Try again in a minute.`);
    }
    if (res.status === 429) setProgress(`tape jammed. rewinding… ${done} of ${total}`);
    await new Promise((r) => setTimeout(r, waits[attempt]));
  }
}

function loadMusicKit() {
  if (window.MusicKit) return Promise.resolve();
  return new Promise((resolve, reject) => {
    document.addEventListener("musickitloaded", resolve, { once: true });
    const s = document.createElement("script");
    s.src = "https://js-cdn.music.apple.com/musickit/v3/musickit.js";
    s.async = true;
    s.onerror = () => reject(new Error("Couldn't load Apple's sign-in. Check your ad blocker."));
    document.head.append(s);
  });
}

async function saveToApple() {
  const token = await getDeveloperToken();

  await loadMusicKit();
  await MusicKit.configure({ developerToken: token, app: { name: "Dubbed", build: "1.0.0" } });
  const music = MusicKit.getInstance();
  const userToken = await music.authorize();
  if (!userToken) throw new Error("Apple sign-in was cancelled.");

  const res = await fetch("https://api.music.apple.com/v1/me/library/playlists", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Music-User-Token": userToken,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      attributes: { name: state.playlist.name, description: description() },
      relationships: { tracks: { data: keepers().map((m) => ({ id: m.id, type: "songs" })) } },
    }),
  });
  if (res.status === 403) throw new Error("Apple says your account can't make playlists. You need an active Apple Music subscription.");
  if (!res.ok) throw new Error(`Apple Music said no (${res.status}). Try again.`);
  const data = await res.json();
  const id = data.data?.[0]?.id;
  showDone(id ? `https://music.apple.com/library/playlist/${id}` : "https://music.apple.com/library/playlists");
}

// ---------- Spotify (PKCE login, so no secret in the browser) ----------

function redirectUri() { return `${location.origin}/`; }

function randomString(bytes = 48) {
  const a = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...a)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function startSpotifyLogin() {
  const verifier = randomString();
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const challenge = btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const nonce = randomString(16);

  sessionStorage.setItem(STASH_KEY, JSON.stringify({
    verifier, nonce,
    playlist: state.playlist,
    matches: state.matches,
    included: [...state.included],
  }));

  const params = new URLSearchParams({
    client_id: state.config.spotifyClientId,
    response_type: "code",
    redirect_uri: redirectUri(),
    code_challenge_method: "S256",
    code_challenge: challenge,
    scope: "playlist-modify-private playlist-modify-public",
    state: nonce,
  });
  location.assign(`https://accounts.spotify.com/authorize?${params}`);
}

async function finishSpotifyLogin(params) {
  history.replaceState(null, "", "/");
  let stash;
  try { stash = JSON.parse(sessionStorage.getItem(STASH_KEY)); } catch { stash = null; }
  sessionStorage.removeItem(STASH_KEY);
  if (!stash) return;

  state.playlist = stash.playlist;
  state.target = "spotify";
  state.matches = stash.matches;
  state.included = new Set(stash.included);
  renderDeck();
  state.matches.forEach((_, i) => setRow(i));
  showSave();
  $("deck").scrollIntoView();

  if (params.get("error") || params.get("state") !== stash.nonce) {
    showError("save-error", "Spotify login was cancelled. Try again, or copy the song links instead.");
    return;
  }

  const btn = $("save-btn");
  btn.disabled = true;
  btn.textContent = "Saving…";
  try {
    const tokenRes = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: state.config.spotifyClientId,
        grant_type: "authorization_code",
        code: params.get("code"),
        redirect_uri: redirectUri(),
        code_verifier: stash.verifier,
      }),
    });
    if (!tokenRes.ok) throw new Error("Spotify login didn't go through. Try again.");
    const { access_token } = await tokenRes.json();
    const auth = { Authorization: `Bearer ${access_token}`, "Content-Type": "application/json" };

    const created = await fetch("https://api.spotify.com/v1/me/playlists", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: state.playlist.name, description: description(), public: false }),
    });
    if (created.status === 403) {
      throw new Error("Spotify won't let this site save to your account yet. It only allows a few approved accounts. Copy the song links and paste them into a Spotify playlist instead.");
    }
    if (!created.ok) throw new Error(`Spotify said no (${created.status}). Try again.`);
    const playlist = await created.json();

    const uris = keepers().map((m) => m.uri);
    for (let i = 0; i < uris.length; i += 100) {
      const add = await fetch(`https://api.spotify.com/v1/playlists/${playlist.id}/items`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ uris: uris.slice(i, i + 100) }),
      });
      if (!add.ok) throw new Error(`Made the playlist, but Spotify wouldn't take the songs (${add.status}).`);
    }
    showDone(playlist.external_urls?.spotify ?? `https://open.spotify.com/playlist/${playlist.id}`);
  } catch (err) {
    showError("save-error", err.message);
    btn.disabled = false;
    btn.textContent = "Log in to Spotify and save";
  }
}

// ---------- errors ----------

function showError(id, message) {
  const el = $(id);
  el.textContent = message;
  el.hidden = false;
}

function hideError(id) {
  $(id).hidden = true;
}
