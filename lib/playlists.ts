// Reads public playlists straight from Spotify's embed player and Apple Music's
// web page. Spotify's API stopped returning songs for playlists you don't own
// in Feb 2026, so the embed page is the only way in. Both cap out around 100.

export type PlaylistTrack = {
  title: string;
  artists: string[];
  durationMs?: number;
  url?: string;
  preview?: string;
};

export type Playlist = {
  source: "spotify" | "apple";
  name: string;
  owner?: string;
  cover?: string;
  url: string;
  tracks: PlaylistTrack[];
};

type Parsed =
  | { source: "spotify"; id: string }
  | { source: "apple"; storefront: string; id: string; slug?: string };

export function parsePlaylistUrl(raw: string): Parsed | null {
  const input = raw.trim();
  const uri = input.match(/^spotify:playlist:([A-Za-z0-9]+)$/);
  if (uri) return { source: "spotify", id: uri[1] };

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (url.hostname === "open.spotify.com") {
    const m = url.pathname.match(/\/playlist\/([A-Za-z0-9]+)/);
    return m ? { source: "spotify", id: m[1] } : null;
  }
  if (url.hostname === "music.apple.com" || url.hostname === "embed.music.apple.com") {
    const m = url.pathname.match(/^\/([a-z]{2})\/playlist\/(?:([^/]+)\/)?(pl\.[A-Za-z0-9-]+)/);
    return m ? { source: "apple", storefront: m[1], slug: m[2], id: m[3] } : null;
  }
  return null;
}

const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";

async function getHtml(url: string) {
  const res = await fetch(url, { headers: { "User-Agent": BROWSER_UA, "Accept-Language": "en" } });
  if (res.status === 404) throw Object.assign(new Error("Couldn't find that playlist. Is it public?"), { status: 404 });
  if (!res.ok) throw Object.assign(new Error(`The playlist page answered ${res.status}. Try again in a bit.`), { status: 502 });
  return res.text();
}

function jsonScript(html: string, id: string) {
  const m = html.match(new RegExp(`<script[^>]*id="${id}"[^>]*>([\\s\\S]*?)</script>`));
  if (!m) throw Object.assign(new Error("The playlist page changed shape and we can't read it anymore."), { status: 502 });
  return JSON.parse(m[1]);
}

export async function readSpotifyPlaylist(id: string): Promise<Playlist> {
  const html = await getHtml(`https://open.spotify.com/embed/playlist/${id}`);
  const entity = jsonScript(html, "__NEXT_DATA__")?.props?.pageProps?.state?.data?.entity;
  if (!entity?.trackList) throw Object.assign(new Error("Couldn't find that playlist. Is it public?"), { status: 404 });
  return {
    source: "spotify",
    name: entity.name ?? entity.title,
    owner: entity.subtitle,
    cover: entity.coverArt?.sources?.[0]?.url,
    url: `https://open.spotify.com/playlist/${id}`,
    tracks: entity.trackList
      .filter((t: any) => t.entityType === "track" || t.uri?.startsWith("spotify:track:"))
      .map((t: any) => ({
        title: t.title,
        artists: String(t.subtitle ?? "").split(/,\s+/).filter(Boolean),
        durationMs: t.duration,
        url: `https://open.spotify.com/track/${t.uri.split(":").pop()}`,
        preview: t.audioPreview?.url,
      })),
  };
}

export async function readApplePlaylist(storefront: string, id: string, slug = "playlist"): Promise<Playlist> {
  const pageUrl = `https://music.apple.com/${storefront}/playlist/${slug}/${id}`;
  const html = await getHtml(pageUrl);
  const page = jsonScript(html, "serialized-server-data")?.data?.[0]?.data;
  const sections: any[] = page?.sections ?? [];
  const header = sections.find((s) => s.itemKind === "containerDetailHeaderLockup")?.items?.[0];
  const list = sections.find((s) => s.itemKind === "trackLockup")?.items ?? [];
  if (!header) throw Object.assign(new Error("Couldn't find that playlist. Is it public?"), { status: 404 });
  const art = header.artwork?.dictionary?.url;
  return {
    source: "apple",
    name: header.title,
    owner: header.subtitleLinks?.[0]?.title,
    cover: art?.replace("{w}", "600").replace("{h}", "600").replace("{f}", "jpg"),
    url: pageUrl,
    tracks: list
      .filter((t: any) => t.contentDescriptor?.kind === "song")
      .map((t: any) => ({
        title: t.title,
        artists: String(t.artistName ?? "").split(/\s*(?:,|&)\s*/).filter(Boolean),
        durationMs: t.duration,
        url: t.contentDescriptor?.url,
      })),
  };
}
