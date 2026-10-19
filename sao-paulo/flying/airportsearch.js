// São Paulo World · flight test bed: airport search for the destination box.
// Type part of a name, a city or a code — "cong", "CGH", "SBGL", "flor",
// "galeao", "rio", "foz iguacu", even with a typo ("florianoplis") — and get
// the best matches. Accents and case don't matter; every word typed must
// match a word of the airport (its codes, name, city, state or aliases) as a
// prefix, inside it, or within a typo; bigger airports with scheduled
// service and an ILS rank higher among equals.

// Lower case, accents off, punctuation to spaces.
export const fold = (s) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// Damerau–Levenshtein distance (optimal string alignment), stopping early past `max`.
function editDistance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev2 = null, prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; ++i) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; ++j) {
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      cur.push(v);
      best = Math.min(best, v);
    }
    if (best > max) return max + 1;
    prev2 = prev; prev = cur;
  }
  return prev[b.length];
}

// The search index: one entry per airport record (airports_br.json).
export function buildIndex(airports) {
  return airports.map((a) => {
    const words = new Set(fold([a.name, a.city, a.alias, a.state].join(' ')).split(' ').filter((w) => w.length > 1));
    return {
      a, icao: a.icao.toLowerCase(), iata: (a.iata || '').toLowerCase(), words: [...words],
      city: fold(a.city).split(' ').filter(Boolean),
      boost: { L: 30, M: 15, S: 0 }[a.kind] + (a.sched ? 15 : 0) + (a.ils?.length ? 10 : 0) + (a.iata ? 5 : 0),
    };
  });
}

// How well one typed word matches one airport word (0: not at all).
function wordScore(t, w) {
  if (w === t) return 120;
  if (w.startsWith(t)) return 90 + 10 * t.length / w.length;
  if (t.length >= 3 && w.includes(t)) return 40;
  if (t.length >= 4) {
    const allow = t.length >= 7 ? 2 : 1;
    // A typo in what has been typed so far: against the word's same-length start, or the whole word.
    const d = Math.min(editDistance(t, w.slice(0, t.length), allow), editDistance(t, w, allow));
    if (d <= allow) return d === 1 ? 60 : 35;
  }
  return 0;
}

// The best `limit` matches for a query, best first: [{ a, score }].
export function searchAirports(index, query, limit = 8) {
  const q = fold(query);
  if (!q) return [];
  const tokens = q.split(' ');
  const out = [];
  for (const e of index) {
    let score = 0;
    if (tokens.length === 1) {
      const t = tokens[0];
      if (t === e.icao || (e.iata && t === e.iata)) score += 1000;
      else if (t.length >= 2 && e.icao.startsWith(t)) score += 400;
      else if (t.length >= 2 && e.iata && e.iata.startsWith(t)) score += 350;
    }
    let all = true, words = 0;
    for (const t of tokens) {
      let best = 0;
      for (const w of e.words) best = Math.max(best, wordScore(t, w));
      if (e.city.some((w) => w.startsWith(t))) best += 20;  // the city typed
      if (!best) { all = false; break; }
      words += best;
    }
    if (all) score += words;
    else if (score < 350) continue;
    out.push({ a: e.a, score: score + e.boost });
  }
  return out.sort((x, y) => y.score - x.score).slice(0, limit);
}
