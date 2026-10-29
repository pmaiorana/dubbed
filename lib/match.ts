// Fuzzy song matching. Scores a candidate from the other service against the
// source track on title, artist and length. 1 = same song, 0 = not even close.

export type Track = {
  title: string;
  artists: string[];
  durationMs?: number;
};

export type Candidate = Track & {
  id: string;
  uri?: string;
  url?: string;
  art?: string;
};

const NOISE = /\b(feat|ft|featuring|with|remaster(ed)?|version|edit|mono|stereo|deluxe|bonus|explicit|clean|single|radio)\b/;

export function normalizeTitle(title: string) {
  let t = fold(title);
  // Drop bracketed bits that are just packaging: "(Remastered 2011)", "[feat. X]".
  t = t.replace(/\s*[\(\[]([^\)\]]*)[\)\]]/g, (whole, inner) => (NOISE.test(inner) ? "" : whole));
  // Drop " - 2011 Remaster" style suffixes.
  t = t.replace(/\s+-\s+(.*)$/, (whole, tail) => (NOISE.test(tail) || /\d{4}|^from\b/.test(tail) ? "" : whole));
  t = t.replace(/\b(feat|ft)\.?\s.*$/, "");
  return clean(t);
}

export function normalizeArtist(artist: string) {
  return clean(fold(artist).replace(/^the\s+/, ""));
}

function fold(s: string) {
  return s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/&/g, " and ");
}

function clean(s: string) {
  return s.replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
}

// Dice coefficient over character bigrams.
export function similarity(a: string, b: string) {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const grams = new Map<string, number>();
  for (let i = 0; i < a.length - 1; i++) {
    const g = a.slice(i, i + 2);
    grams.set(g, (grams.get(g) ?? 0) + 1);
  }
  let overlap = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const g = b.slice(i, i + 2);
    const n = grams.get(g) ?? 0;
    if (n > 0) {
      grams.set(g, n - 1);
      overlap++;
    }
  }
  return (2 * overlap) / (a.length + b.length - 2);
}

export function scoreMatch(source: Track, candidate: Track) {
  const title = similarity(normalizeTitle(source.title), normalizeTitle(candidate.title));

  const sourceArtists = source.artists.map(normalizeArtist);
  const candidateArtists = candidate.artists.map(normalizeArtist);
  const lead = sourceArtists[0] ?? "";
  let artist = 0;
  for (const c of candidateArtists) artist = Math.max(artist, similarity(lead, c));
  // Some services glue every artist into one string, so also compare the whole lot.
  artist = Math.max(artist, similarity(sourceArtists.join(" "), candidateArtists.join(" ")));

  let length = 0.5;
  if (source.durationMs && candidate.durationMs) {
    const diff = Math.abs(source.durationMs - candidate.durationMs) / 1000;
    length = diff <= 3 ? 1 : Math.max(0, 1 - (diff - 3) / 27);
  }

  const score = 0.55 * title + 0.3 * artist + 0.15 * length;
  // Same title by somebody else is a cover or a different song. Never call it a match.
  return artist < 0.5 ? Math.min(score, 0.5) : score;
}
