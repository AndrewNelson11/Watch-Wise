// Vercel serverless function: keeps API credentials on the server.
// - TMDB_ACCESS_TOKEN (TMDB "API Read Access Token"): search, popularity, details
// - RAPIDAPI_KEY (Streaming Availability API): direct links into each streaming service

const TMDB = 'https://api.themoviedb.org/3';
const IMG = 'https://image.tmdb.org/t/p/w342';
const COUNTRY = 'US';
const SEARCH_LIMIT = 12;

const SA_HOST = 'streaming-availability.p.rapidapi.com';
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

async function withDetails(items) {
  const settled = await Promise.all(
    items.map(async item => {
      try {
        const d = await tmdb(`/${item.mediaType}/${item.id}`, {
          append_to_response: 'watch/providers,external_ids',
          language: 'en-US'
        });
        return normalize(d, item.mediaType);
      } catch {
        return null;
      }
    })
  );
  return settled.filter(Boolean);
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

// Exact title match first, then titles starting with the search, then everything else by popularity.
function rank(items, query) {
  const q = normalizeText(query);
  const tier = item => {
    const t = normalizeText(item.title || item.name);
    if (t === q) return 0;
    if (t.startsWith(q)) return 1;
    return 2;
  };
  return items
    .map((item, index) => ({ item, index, tier: tier(item) }))
    .sort((a, b) => a.tier - b.tier || (b.item.popularity || 0) - (a.item.popularity || 0) || a.index - b.index)
    .map(x => x.item);
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

      const top = rank(items, q).slice(0, SEARCH_LIMIT);
      const shows = await withDetails(top);
      response.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate');
      return response.status(200).json(shows);
    }

    if (action === 'browse') {
      if (!/^\d+$/.test(String(genre))) return response.status(400).json({ error: 'Missing genre' });
      const pageNum = Math.max(1, Math.min(500, parseInt(page, 10) || 1));

      const data = await tmdb(`/discover/${mediaType}`, {
        with_genres: genre,
        sort_by: 'popularity.desc',
        'vote_count.gte': mediaType === 'movie' ? '200' : '100',
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
