// Vercel serverless function: keeps the API credentials out of the browser.
// - TMDB_ACCESS_TOKEN (TMDB "API Read Access Token"): search, popularity, details
// - RAPIDAPI_KEY (Streaming Availability API): direct links into each streaming service

const TMDB = 'https://api.themoviedb.org/3';
const IMG = 'https://image.tmdb.org/t/p/w342';
const COUNTRY = 'US';
const SEARCH_LIMIT = 12;

const SA_HOST = 'streaming-availability.p.rapidapi.com';
// Genres shown in the site's dropdown. TMDB uses different genre ids for movies and TV shows, so
// each entry maps to the matching id for each (a pipe means "either of these"). Some genres only
// exist for movies in TMDB (Horror, Thriller and so on) even though TV shows of that kind exist,
// so those use tvKeyword: the TV side is matched on TMDB's keyword of that name instead.
const GENRES = [
  { slug: 'action-adventure', name: 'Action & Adventure', movie: '28|12', tv: '10759' },
  { slug: 'animation', name: 'Animation', movie: '16', tv: '16' },
  { slug: 'comedy', name: 'Comedy', movie: '35', tv: '35' },
  { slug: 'crime', name: 'Crime', movie: '80', tv: '80' },
  { slug: 'documentary', name: 'Documentary', movie: '99', tv: '99' },
  { slug: 'drama', name: 'Drama', movie: '18', tv: '18' },
  { slug: 'family', name: 'Family', movie: '10751', tv: '10751' },
  { slug: 'history', name: 'History', movie: '36', tvKeyword: 'history' },
  { slug: 'horror', name: 'Horror', movie: '27', tvKeyword: 'horror' },
  { slug: 'kids', name: 'Kids', movie: '10751', tv: '10762' },
  { slug: 'music', name: 'Music', movie: '10402', tvKeyword: 'music' },
  { slug: 'mystery', name: 'Mystery', movie: '9648', tv: '9648' },
  { slug: 'reality', name: 'Reality', tv: '10764' },
  { slug: 'romance', name: 'Romance', movie: '10749', tvKeyword: 'romance' },
  { slug: 'sci-fi-fantasy', name: 'Sci-Fi & Fantasy', movie: '878|14', tv: '10765' },
  { slug: 'thriller', name: 'Thriller', movie: '53', tvKeyword: 'thriller' },
  { slug: 'war', name: 'War', movie: '10752', tv: '10768' },
  { slug: 'western', name: 'Western', movie: '37', tv: '37' }
];

const keywordCache = new Map(); // keyword name -> { at, ids }

// Looks up TMDB's id for a keyword such as "horror" (exact name matches only).
async function keywordIds(name) {
  const cached = keywordCache.get(name);
  if (cached && Date.now() - cached.at < LINK_CACHE_MS) return cached.ids;
  let ids = [];
  try {
    const data = await tmdb('/search/keyword', { query: name, page: '1' });
    ids = (data.results || [])
      .filter(k => String(k.name).toLowerCase() === name)
      .slice(0, 3)
      .map(k => String(k.id));
  } catch {
    return []; // not cached, so the next request tries again
  }
  keywordCache.set(name, { at: Date.now(), ids });
  return ids;
}

// The discover filter for one genre and type, or null when that type has no match for it.
async function genreFilter(entry, kind) {
  if (entry[kind]) return { with_genres: entry[kind] };
  if (kind === 'tv' && entry.tvKeyword) {
    const ids = await keywordIds(entry.tvKeyword);
    return ids.length ? { with_keywords: ids.join('|') } : null;
  }
  return null;
}

const LINK_CACHE_MS = 24 * 60 * 60 * 1000;
const linkCache = new Map(); // imdbId -> { at, streaming } (reused while the function instance stays warm)
const SA_TYPE_ORDER = { subscription: 0, free: 1, addon: 2, rent: 3, buy: 4 };

async function tmdb(path, params = {}) {
  const url = new URL(TMDB + path);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${process.env.TMDB_ACCESS_TOKEN}`,
      accept: 'application/json'
    }
  });
  if (!res.ok) {
    const err = new Error(`TMDB responded with ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// Direct streaming links for one title (looked up by IMDb id), best options first.
async function streamingLinks(imdbId) {
  const cached = linkCache.get(imdbId);
  if (cached && Date.now() - cached.at < LINK_CACHE_MS) return cached.streaming;

  const url = new URL(`https://${SA_HOST}/shows/${imdbId}`);
  url.searchParams.set('country', 'us');
  url.searchParams.set('output_language', 'en');
  const res = await fetch(url, {
    headers: { 'x-rapidapi-key': process.env.RAPIDAPI_KEY, 'x-rapidapi-host': SA_HOST }
  });
  if (!res.ok) {
    const err = new Error(`Streaming Availability responded with ${res.status}`);
    err.status = res.status;
    throw err;
  }
  const show = await res.json();
  const options = Array.isArray(show.streamingOptions?.us) ? show.streamingOptions.us : [];
  const sorted = [...options].sort((a, b) => (SA_TYPE_ORDER[a.type] ?? 9) - (SA_TYPE_ORDER[b.type] ?? 9));
  const seen = new Set();
  const streaming = [];
  sorted.forEach(opt => {
    const name = typeof opt.service === 'string' ? opt.service : opt.service?.name;
    if (!name || !opt.link || seen.has(name)) return;
    seen.add(name);
    streaming.push({ name, type: opt.type, link: opt.link });
  });
  if (linkCache.size > 500) linkCache.clear();
  linkCache.set(imdbId, { at: Date.now(), streaming });
  return streaming;
}

// Turn a TMDB details response (with watch/providers appended) into the shape the front end uses.
function normalize(d, mediaType) {
  const isTv = mediaType === 'tv';
  const date = isTv ? d.first_air_date : d.release_date;
  const providers = d['watch/providers']?.results?.[COUNTRY] || {};

  const streaming = [];
  const seen = new Set();
  [
    ['flatrate', 'subscription'],
    ['free', 'free'],
    ['ads', 'ads'],
    ['rent', 'rent'],
    ['buy', 'buy']
  ].forEach(([key, type]) => {
    (providers[key] || []).forEach(p => {
      if (seen.has(p.provider_name)) return;
      seen.add(p.provider_name);
      streaming.push({ name: p.provider_name, type });
    });
  });

  return {
    id: `${mediaType}-${d.id}`,
    imdbId: d.imdb_id || d.external_ids?.imdb_id || '',
    mediaType,
    title: (isTv ? d.name : d.title) || '',
    year: date ? date.slice(0, 4) : '',
    rating: d.vote_count > 0 ? d.vote_average : null,
    runtime: isTv ? null : d.runtime || null,
    seasons: isTv ? d.number_of_seasons || null : null,
    overview: d.overview || '',
    poster: d.poster_path ? IMG + d.poster_path : '',
    streaming,
    watchLink: providers.link || ''
  };
}

async function detailsFor(item) {
  try {
    const d = await tmdb(`/${item.mediaType}/${item.id}`, {
      append_to_response: 'watch/providers,external_ids',
      language: 'en-US'
    });
    return normalize(d, item.mediaType);
  } catch {
    return null;
  }
}

async function withDetails(items) {
  const shows = await Promise.all(items.map(detailsFor));
  return shows.filter(Boolean);
}

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(the|a|an) /, '');
}

// Google-style ranking: well-known titles first. Fame comes from how many people have voted on a
// title (stable and hard to game), nudged by TMDB's popularity score. An exact or starting-with
// title match gets a boost so "Batman" still puts Batman first, but an obscure title with the
// same name can't beat a famous one.
function relevanceScore(item, query) {
  const q = normalizeText(query);
  const t = normalizeText(item.title || item.name);
  const match = t === q ? 15 : t.startsWith(q) ? 8 : 0;
  const fame = Math.log10((item.vote_count || 0) + 1) * 10;
  const trend = Math.log10((item.popularity || 0) + 1) * 3;
  return match + fame + trend;
}

export default async function handler(request, response) {
  const { action, query = '', type = 'movie', genre = '', page = '1', imdb = '' } = request.query;
  const mediaType = type === 'series' ? 'tv' : 'movie';

  try {
    if (action === 'streaming') {
      if (!process.env.RAPIDAPI_KEY) return response.status(503).json({ error: 'Direct links not configured' });
      if (!/^tt\d+$/.test(String(imdb))) return response.status(400).json({ error: 'Invalid id' });
      const streaming = await streamingLinks(imdb);
      response.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate');
      return response.status(200).json({ streaming });
    }

    if (action !== 'genres' && !process.env.TMDB_ACCESS_TOKEN) {
      return response.status(500).json({ error: 'Server is missing TMDB_ACCESS_TOKEN' });
    }

    if (action === 'genres') {
      const list = GENRES.map(g => ({
        slug: g.slug,
        name: g.name,
        types: ['movie', 'tv'].filter(t => g[t] || (t === 'tv' && g.tvKeyword))
      }));
      response.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate');
      return response.status(200).json(list);
    }

    if (action === 'search') {
      const q = String(query).trim().slice(0, 100);
      if (!q) return response.status(400).json({ error: 'Missing query' });

      const params = { query: q, include_adult: 'false', language: 'en-US', page: '1' };
      let items;
      if (type === 'both') {
        const data = await tmdb('/search/multi', params);
        items = (data.results || [])
          .filter(r => r.media_type === 'movie' || r.media_type === 'tv')
          .map(r => ({ ...r, mediaType: r.media_type }));
      } else {
        const data = await tmdb(`/search/${mediaType}`, params);
        items = (data.results || []).map(r => ({ ...r, mediaType }));
      }

      // Score every match, look up details for the 20 best candidates, then give titles that can
      // actually be streamed in the US a bonus before picking the final list.
      const candidates = items
        .map(item => ({ item, score: relevanceScore(item, q) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 20);
      const detailed = await Promise.all(
        candidates.map(async ({ item, score }) => {
          const show = await detailsFor(item);
          return show ? { show, score: score + (show.streaming.length ? 8 : 0) } : null;
        })
      );
      const shows = detailed
        .filter(Boolean)
        .sort((a, b) => b.score - a.score)
        .slice(0, SEARCH_LIMIT)
        .map(x => x.show);
      response.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate');
      return response.status(200).json(shows);
    }

    if (action === 'browse') {
      const entry = GENRES.find(g => g.slug === genre);
      if (!entry) return response.status(400).json({ error: 'Unknown genre' });

      const wanted = type === 'both' ? ['movie', 'tv'] : [mediaType];
      const filters = await Promise.all(wanted.map(kind => genreFilter(entry, kind)));
      const kinds = wanted.filter((kind, i) => filters[i]);
      const kindFilters = filters.filter(Boolean);
      const pageNum = Math.max(1, Math.min(500, parseInt(page, 10) || 1));
      if (kinds.length === 0) {
        return response.status(200).json({ results: [], page: pageNum, hasMore: false, types: [] });
      }

      // With both types selected, each TMDB page is split in two halves (10 movies + 10 shows per
      // page here) so a page of results stays the same size and uses the same number of lookups.
      const split = kinds.length > 1;
      const tmdbPage = split ? Math.ceil(pageNum / 2) : pageNum;
      const secondHalf = split && pageNum % 2 === 0;

      // Trending and well known: sort by TMDB's popularity (what people are watching now) but only
      // include titles with plenty of votes, so obscure titles can't sneak in. Only titles with a US
      // way to watch (subscription, free, ads, rent or buy) are listed. To lean more trending, lower
      // the vote minimums; to lean more well known, raise them.
      const pages = await Promise.all(
        kinds.map((kind, i) =>
          tmdb(`/discover/${kind}`, {
            ...kindFilters[i],
            sort_by: 'popularity.desc',
            'vote_count.gte': kind === 'movie' ? '500' : '250',
            watch_region: COUNTRY,
            with_watch_monetization_types: 'flatrate|free|ads|rent|buy',
            include_adult: 'false',
            language: 'en-US',
            page: String(tmdbPage)
          })
        )
      );

      let hasMore = false;
      const items = [];
      pages.forEach((data, i) => {
        const kind = kinds[i];
        const list = data.results || [];
        const totalPages = Math.min(data.total_pages || 1, 500);
        const shown = split ? (secondHalf ? list.slice(10) : list.slice(0, 10)) : list;
        if (split ? (!secondHalf && list.length > 10) || tmdbPage < totalPages : tmdbPage < totalPages) {
          hasMore = true;
        }
        shown.forEach(r => items.push({ ...r, mediaType: kind }));
      });
      items.sort((a, b) => (b.popularity || 0) - (a.popularity || 0));

      const results = await withDetails(items);
      response.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate');
      return response.status(200).json({ results, page: pageNum, hasMore, types: kinds });
    }

    return response.status(400).json({ error: 'Unknown action' });
  } catch (error) {
    if (error.status === 429) return response.status(429).json({ error: 'Too many requests' });
    if (error.status === 401 || error.status === 403) {
      return response.status(403).json({ error: 'Server authentication issue' });
    }
    return response.status(500).json({ error: 'Could not reach the movie service.' });
  }
}
