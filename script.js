// script.js
document.addEventListener('DOMContentLoaded', () => {
  // ---------- Elements ----------
  const tabs = document.querySelectorAll('.tab');
  const panels = document.querySelectorAll('[data-panel]');
  const titleForm = document.getElementById('titleForm');
  const titleInput = document.getElementById('titleInput');
  const titleType = document.getElementById('titleType');
  const titleResults = document.getElementById('titleResults');
  const genreForm = document.getElementById('genreForm');
  const genreSelect = document.getElementById('genreSelect');
  const genreType = document.getElementById('genreType');
  const genreResults = document.getElementById('genreResults');
  const loadMoreBtn = document.getElementById('loadMoreBtn');

  // ---------- Helpers ----------
  async function apiGet(params) {
    // All requests go to our own serverless function, which holds the TMDB token.
    const url = new URL('/api/movies', window.location.origin);
    Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));

    let response;
    try {
      response = await fetch(url);
    } catch {
      throw new Error('Could not reach the server. Check your internet connection and try again.');
    }

    if (response.status === 429) {
      throw new Error('Too many requests right now. Wait a minute and try again.');
    }
    if (response.status === 401 || response.status === 403) {
      throw new Error('The movie service rejected the server token. Check the TMDB_ACCESS_TOKEN setting.');
    }
    if (!response.ok) {
      throw new Error('The movie service had a problem. Try again in a moment.');
    }
    return response.json();
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function safeUrl(value) {
    return typeof value === 'string' && /^https?:\/\//i.test(value) ? value : '';
  }

  function formatRuntime(minutes) {
    if (!minutes) return '';
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    if (h === 0) return `${m} min`;
    return m ? `${h}h ${m}m` : `${h}h`;
  }

  const TYPE_LABEL = { free: 'Free', ads: 'Free with ads', addon: 'Add-on', rent: 'Rent', buy: 'Buy' };

  const showsById = new Map(); // remembered so a card can fall back to general links
  const linkCache = new Map(); // direct links already fetched this visit

  function chipsHtml(options, fallbackLink) {
    const html = options.map(opt => {
      const link = safeUrl(opt.link) || safeUrl(fallbackLink);
      if (!link) return '';
      const label = TYPE_LABEL[opt.type];
      return `<a class="chip" href="${escapeHtml(link)}" target="_blank" rel="noopener">${escapeHtml(opt.name)}${label ? ` <small>${label}</small>` : ''}</a>`;
    }).join('');
    return html ? `<div class="chips">${html}</div>` : '';
  }

  const NOT_STREAMING = '<p class="not-streaming">Not streaming in the US right now.</p>';

  // TMDB tells us up front whether a title streams anywhere in the US. Direct links into each
  // service come from the Streaming Availability API and are fetched when the button is clicked,
  // which keeps us well inside that API's daily request limit.
  function whereToWatchHtml(show) {
    const options = Array.isArray(show.streaming) ? show.streaming : [];
    if (options.length === 0) return NOT_STREAMING;
    if (show.imdbId) {
      return `<button type="button" class="btn-links" data-show-id="${escapeHtml(show.id)}">Show streaming links</button>`;
    }
    return chipsHtml(options, show.watchLink) || NOT_STREAMING;
  }

  async function loadLinks(btn) {
    const show = showsById.get(btn.dataset.showId);
    const body = btn.closest('.where-body');
    if (!show || !body) return;

    btn.disabled = true;
    btn.textContent = 'Loading…';

    let html = linkCache.get(show.imdbId);
    if (!html) {
      try {
        const data = await apiGet({ action: 'streaming', imdb: show.imdbId });
        html = chipsHtml(Array.isArray(data.streaming) ? data.streaming : [], '');
        if (html) linkCache.set(show.imdbId, html);
      } catch {
        html = '';
      }
      if (!html) {
        html = chipsHtml(show.streaming, show.watchLink) +
          '<p class="links-note">Direct links aren\'t available for this title right now, so these open a general where-to-watch page.</p>';
      }
    }
    body.innerHTML = html;
  }

  function cardHtml(show) {
    showsById.set(show.id, show);
    const title = show.title || 'Untitled';
    const year = show.year || '';
    const rating = typeof show.rating === 'number' ? `★ ${show.rating.toFixed(1)}` : 'No rating';
    const isSeries = show.mediaType === 'tv';

    let length = '';
    if (isSeries && show.seasons) {
      length = `${show.seasons} season${show.seasons === 1 ? '' : 's'}`;
    } else {
      length = formatRuntime(show.runtime);
    }

    const poster = safeUrl(show.poster);
    const posterHtml = poster
      ? `<img src="${escapeHtml(poster)}" alt="Poster for ${escapeHtml(title)}" loading="lazy" onerror="this.outerHTML='<div class=&quot;poster-fallback&quot;>No poster</div>'" />`
      : '<div class="poster-fallback">No poster</div>';

    return `
      <article class="card">
        <div class="poster">${posterHtml}</div>
        <div class="card-body">
          <h3 class="card-title">${escapeHtml(title)}${year ? ` <span class="year">(${escapeHtml(year)})</span>` : ''}</h3>
          <p class="meta">
            <span class="rating">${rating}</span>
            ${length ? `<span>${escapeHtml(length)}</span>` : ''}
            <span>${isSeries ? 'Show' : 'Movie'}</span>
          </p>
          <p class="overview" title="Click to read more">${escapeHtml(show.overview || 'No description available.')}</p>
          <div class="where">
            <span class="where-label">Where to watch</span>
            <div class="where-body">${whereToWatchHtml(show)}</div>
          </div>
        </div>
      </article>`;
  }

  function showLoading(container) {
    container.hidden = false;
    container.innerHTML = '<div class="status"><span class="spinner"></span><span>Searching…</span></div>';
  }

  function showMessage(container, heading, body, isError = false) {
    container.hidden = false;
    container.innerHTML = `<div class="message${isError ? ' error' : ''}"><h3>${escapeHtml(heading)}</h3><p>${escapeHtml(body)}</p></div>`;
  }

  document.addEventListener('click', e => {
    const linksBtn = e.target.closest('.btn-links');
    if (linksBtn) {
      loadLinks(linksBtn);
      return;
    }
    const overview = e.target.closest('.overview');
    if (overview) overview.classList.toggle('expanded');
  });

  // ---------- Tabs ----------
  function selectTab(name) {
    tabs.forEach(tab => {
      const active = tab.dataset.tab === name;
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
    });
    panels.forEach(panel => { panel.hidden = panel.dataset.panel !== name; });
    document.querySelectorAll('[data-results]').forEach(section => {
      const hasContent = section.innerHTML.trim() !== '';
      section.hidden = section.dataset.results !== name || !hasContent;
    });
    loadMoreBtn.hidden = !(name === 'genre' && genreState.hasMore);
  }

  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => selectTab(tab.dataset.tab));
    tab.addEventListener('keydown', e => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const next = tabs[(index + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
      next.focus();
      selectTab(next.dataset.tab);
    });
  });

  // ---------- Title search ----------
  titleForm.addEventListener('submit', async e => {
    e.preventDefault();
    const query = titleInput.value.trim();
    if (!query) return;

    showLoading(titleResults);
    try {
      const data = await apiGet({ action: 'search', query, type: titleType.value });
      if (!Array.isArray(data) || data.length === 0) {
        showMessage(titleResults, `No results for "${query}"`, 'Check the spelling, or switch the type to "Movies and shows" to search both.');
        return;
      }

      titleResults.innerHTML =
        `<p class="results-summary">${data.length} result${data.length === 1 ? '' : 's'} for "${escapeHtml(query)}"</p>` +
        `<div class="grid">${data.map(cardHtml).join('')}</div>`;
    } catch (err) {
      showMessage(titleResults, 'Something went wrong', err.message, true);
    }
  });

  // ---------- Genre browse ----------
  const genreState = {
    genre: '',
    type: '',
    label: '',
    page: 0,
    hasMore: false,
    seen: new Set(),
    count: 0
  };

  // Movie and show genres have different ids in TMDB, so reload the list when the type changes.
  async function loadGenres() {
    genreSelect.innerHTML = '<option value="">Choose a genre</option>';
    let genres;
    try {
      genres = await apiGet({ action: 'genres', type: genreType.value });
    } catch {
      genreSelect.innerHTML = '<option value="">Genres unavailable</option>';
      return;
    }
    genres.forEach(genre => {
      const option = document.createElement('option');
      option.value = genre.id;
      option.textContent = genre.name;
      genreSelect.appendChild(option);
    });
  }

  async function loadGenreResults(reset) {
    if (reset) {
      genreState.genre = genreSelect.value;
      genreState.type = genreType.value;
      genreState.label = genreSelect.options[genreSelect.selectedIndex].textContent;
      genreState.page = 0;
      genreState.hasMore = false;
      genreState.seen = new Set();
      genreState.count = 0;
      loadMoreBtn.hidden = true;
      showLoading(genreResults);
    } else {
      loadMoreBtn.disabled = true;
      loadMoreBtn.textContent = 'Loading…';
    }

    try {
      const data = await apiGet({
        action: 'browse',
        type: genreState.type,
        genre: genreState.genre,
        page: genreState.page + 1
      });
      genreState.page = data.page || genreState.page + 1;
      genreState.hasMore = Boolean(data.hasMore);

      const shows = Array.isArray(data.results) ? data.results : [];
      const newShows = shows.filter(show => {
        if (genreState.seen.has(show.id)) return false;
        genreState.seen.add(show.id);
        return true;
      });
      genreState.count += newShows.length;

      const summary = `<p class="results-summary">${genreState.count} result${genreState.count === 1 ? '' : 's'} for ${escapeHtml(genreState.label)}, most popular first</p>`;
      const grid = newShows.map(cardHtml).join('');
      if (reset) {
        genreResults.innerHTML = summary + (grid ? `<div class="grid">${grid}</div>` : '<p class="message">No results found.</p>');
      } else if (grid) {
        genreResults.querySelector('.results-summary').outerHTML = summary;
        genreResults.querySelector('.grid').insertAdjacentHTML('beforeend', grid);
      }
      loadMoreBtn.hidden = !genreState.hasMore;
    } catch (err) {
      showMessage(genreResults, 'Something went wrong', err.message, true);
    } finally {
      loadMoreBtn.disabled = false;
      loadMoreBtn.textContent = 'Load more';
    }
  }

  genreForm.addEventListener('submit', e => {
    e.preventDefault();
    loadGenreResults(true);
  });

  genreType.addEventListener('change', loadGenres);
  loadMoreBtn.addEventListener('click', () => loadGenreResults(false));
  loadGenres();
});
