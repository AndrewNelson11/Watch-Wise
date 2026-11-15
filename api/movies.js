// Vercel serverless function: keeps API credentials on the server.
// - TMDB_ACCESS_TOKEN (TMDB "API Read Access Token"): search, popularity, details
// - RAPIDAPI_KEY (Streaming Availability API): direct links into each streaming service

const TMDB = 'https://api.themoviedb.org/3';
const IMG = 'https://image.tmdb.org/t/p/w342';
const COUNTRY = 'US';
const SEARCH_LIMIT = 12;

const SA_HOST = 'streaming-availability.p.rapidapi.com';
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

    if (!process.env.TMDB_ACCESS_TOKEN) {
      return response.status(500).json({ error: 'Server is missing TMDB_ACCESS_TOKEN' });
    }

    if (action === 'genres') {
      const data = await tmdb(`/genre/${mediaType}/list`, { language: 'en' });
      response.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate');
      return response.status(200).json(data.genres || []);
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
      if (!/^\d+$/.test(String(genre))) return response.status(400).json({ error: 'Missing genre' });
      const pageNum = Math.max(1, Math.min(500, parseInt(page, 10) || 1));

      // Trending and well known: sort by TMDB's popularity (what people are watching now) but only
      // include titles with plenty of votes, so obscure titles can't sneak in. Only titles with a US
      // way to watch (subscription, free, ads, rent or buy) are listed. To lean more trending, lower
      // the vote minimums; to lean more well known, raise them.
      const data = await tmdb(`/discover/${mediaType}`, {
        with_genres: genre,
        sort_by: 'popularity.desc',
        'vote_count.gte': mediaType === 'movie' ? '500' : '250',
        watch_region: COUNTRY,
        with_watch_monetization_types: 'flatrate|free|ads|rent|buy',
        include_adult: 'false',
        language: 'en-US',
        page: String(pageNum)
      });

      const items = (data.results || []).map(r => ({ ...r, mediaType }));
      const results = await withDetails(items);
      response.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate');
      return response.status(200).json({
        results,
        page: data.page || pageNum,
        hasMore: (data.page || pageNum) < Math.min(data.total_pages || 1, 500)
      });
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
