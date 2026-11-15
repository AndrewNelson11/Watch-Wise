// script.js
document.addEventListener('DOMContentLoaded', () => {
  // ---------- Elements ----------
  const tabs = document.querySelectorAll('.tab');
  const panels = document.querySelectorAll('[data-panel]');
  const titleForm = document.getElementById('titleForm');
  const titleInput = document.getElementById('titleInput');
  const titleResults = document.getElementById('titleResults');
  const genreForm = document.getElementById('genreForm');
  const genreSelect = document.getElementById('genreSelect');
  const genreResults = document.getElementById('genreResults');
  const loadMoreBtn = document.getElementById('loadMoreBtn');
  const toggles = document.querySelectorAll('.toggle');

  // ---------- Helpers ----------
  async function apiGet(params) {
    // Every request goes to the serverless function at /api/movies, which holds the API keys.
    const url = new URL('/api/movies', window.location.origin);
    Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));

    let response;
    try {
      response = await fetch(url);
    } catch {
      throw new Error('Could not reach the server. Check your internet connection and try again.');
    }

    if (!response.ok) {
      let message = 'The movie service had a problem. Try again in a moment.';
      if (response.status === 429) message = 'Too many requests right now. Wait a minute and try again.';
      if (response.status === 401 || response.status === 403) {
        message = 'The movie service rejected the server token. Check the TMDB_ACCESS_TOKEN setting.';
      }
      const err = new Error(message);
      err.status = response.status;
      throw err;
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

  const showsById = new Map(); // every card's data, so its streaming chips can be upgraded later
  const linkCache = new Map(); // direct-link chips already fetched this visit
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

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

  // Cards first show TMDB's list of services, which opens a general where-to-watch page. A moment
  // later each card is upgraded in the background with links straight to the title on each service.
  function whereToWatchHtml(show) {
    const options = Array.isArray(show.streaming) ? show.streaming : [];
    return chipsHtml(options, show.watchLink) || NOT_STREAMING;
  }

  // ---------- Direct links (loaded automatically) ----------
  const MAX_WORKERS = 3;
  const upgradeQueue = [];
  let activeWorkers = 0;
  let directLinksOff = false; // set when the daily limit is hit or the lookup isn't configured

  async function requestDirectLinks(imdbId) {
    const data = await apiGet({ action: 'streaming', imdb: imdbId });
    return chipsHtml(Array.isArray(data.streaming) ? data.streaming : [], '');
  }

  async function upgradeCard(item) {
    const { el, show } = item;
    let html = linkCache.get(show.imdbId);

    if (!html) {
      try {
        html = await requestDirectLinks(show.imdbId);
      } catch (err) {
        if (err.status === 429) {
          await sleep(1200); // might only be a per-second limit, so try once more
          try {
            html = await requestDirectLinks(show.imdbId);
          } catch (retryErr) {
            if (retryErr.status === 429 || retryErr.status === 503) {
              directLinksOff = true;
              upgradeQueue.length = 0;
            }
          }
        } else if (err.status === 503) {
          directLinksOff = true;
          upgradeQueue.length = 0;
        }
      }
      if (html) linkCache.set(show.imdbId, html);
    }

    // If anything went wrong the general links stay in place, so the card is never empty.
    if (html && el.isConnected) el.innerHTML = html;
  }

  async function runWorker() {
    while (upgradeQueue.length && !directLinksOff) {
      await upgradeCard(upgradeQueue.shift());
    }
    activeWorkers -= 1;
  }

  function queueDirectLinks(root) {
    if (directLinksOff) return;
    root.querySelectorAll('.where-body[data-show-id]:not([data-queued])').forEach(el => {
      if (el.closest('.card')?.hidden) return; // hidden cards are queued once they're shown again
      el.dataset.queued = '1';
      const show = showsById.get(el.dataset.showId);
      if (!show || !show.imdbId || !Array.isArray(show.streaming) || show.streaming.length === 0) return;
      upgradeQueue.push({ el, show });
    });
    while (activeWorkers < MAX_WORKERS && upgradeQueue.length) {
      activeWorkers += 1;
      runWorker();
    }
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
      <article class="card" data-type="${isSeries ? 'tv' : 'movie'}">
        <div class="poster">${posterHtml}</div>
        <div class="card-body">
          <h3 class="card-title">${escapeHtml(title)}${year ? ` <span class="year">(${escapeHtml(year)})</span>` : ''}</h3>
          <p class="meta">
            <span class="rating">${rating}</span>
            ${length ? `<span>${escapeHtml(length)}</span>` : ''}
            <span>${isSeries ? 'TV Show' : 'Movie'}</span>
          </p>
          <p class="overview" title="Click to read more">${escapeHtml(show.overview || 'No description available.')}</p>
          <div class="where">
            <span class="where-label">Where to watch</span>
            <div class="where-body" data-show-id="${escapeHtml(show.id)}">${whereToWatchHtml(show)}</div>
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
    const overview = e.target.closest('.overview');
    if (overview) overview.classList.toggle('expanded');
  });

  // ---------- Filtering results by Movies / TV Shows ----------
  function summaryText(count, forText, note) {
    return `${count} result${count === 1 ? '' : 's'} ${forText}${note}`;
  }

  function summaryHtml(count, forText, note = '') {
    return `<p class="results-summary" data-for="${escapeHtml(forText)}" data-note="${escapeHtml(note)}">${escapeHtml(summaryText(count, forText, note))}</p>`;
  }

  function refreshSummary(container) {
    const summary = container.querySelector('.results-summary');
    if (!summary) return;
    const total = container.querySelectorAll('.card').length;
    const visible = container.querySelectorAll('.card:not([hidden])').length;
    summary.textContent = total > 0 && visible === 0
      ? 'Nothing matches the selected filters. Turn Movies or TV Shows back on to see more.'
      : summaryText(visible, summary.dataset.for || '', summary.dataset.note || '');
  }

  // Cards that don't match the selected toggles are hidden right away, and brought back if the
  // toggle is switched on again.
  function applyTypeFilter() {
    document.querySelectorAll('.card[data-type]').forEach(card => {
      card.hidden = !selectedTypes[card.dataset.type];
    });
    [titleResults, genreResults].forEach(container => {
      refreshSummary(container);
      queueDirectLinks(container);
    });
  }

  // A fetch of 'both' covers any selection; a fetch of one type only covers that type.
  function covers(fetchedType, wantedType) {
    return fetchedType === 'both' || fetchedType === wantedType;
  }

  // Narrowing the selection just hides cards. Widening it to a type that was never fetched (for
  // example searching Movies only, then turning TV Shows on) fetches again so those titles appear.
  function onTypesChanged() {
    applyTypeFilter();
    const wanted = currentType();
    if (lastTitleQuery && titleFetchedType && !covers(titleFetchedType, wanted)) {
      runTitleSearch(lastTitleQuery);
    }
    if (genreState.genre && genreState.type && !covers(genreState.type, wanted)) {
      loadGenreResults(true, true);
    }
  }

  // ---------- Movies / TV Shows toggles ----------
  // Both are on by default. The Title and Genre tabs share one selection, and at least one
  // option always stays on.
  const selectedTypes = { movie: true, tv: true };

  function currentType() {
    if (selectedTypes.movie && selectedTypes.tv) return 'both';
    return selectedTypes.movie ? 'movie' : 'series';
  }

  function syncToggles() {
    toggles.forEach(btn => {
      btn.setAttribute('aria-pressed', String(selectedTypes[btn.dataset.type]));
    });
  }

  toggles.forEach(btn => {
    btn.addEventListener('click', () => {
      const type = btn.dataset.type;
      const others = Object.keys(selectedTypes).filter(t => t !== type);
      if (selectedTypes[type] && !others.some(t => selectedTypes[t])) return; // keep one on
      selectedTypes[type] = !selectedTypes[type];
      syncToggles();
      renderGenreOptions();
      onTypesChanged();
    });
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
  let lastTitleQuery = '';
  let titleFetchedType = null;

  async function runTitleSearch(query) {
    const type = currentType();
    lastTitleQuery = query;
    titleFetchedType = null;
    showLoading(titleResults);
    try {
      const data = await apiGet({ action: 'search', query, type });
      titleFetchedType = type;
      if (!Array.isArray(data) || data.length === 0) {
        const hint = type === 'both'
          ? 'Check the spelling and try again.'
          : 'Check the spelling, or turn on both Movies and TV Shows to search everything.';
        showMessage(titleResults, `No results for "${query}"`, hint);
        return;
      }

      titleResults.innerHTML =
        summaryHtml(data.length, `for "${query}"`) +
        `<div class="grid">${data.map(cardHtml).join('')}</div>`;
      applyTypeFilter();
    } catch (err) {
      showMessage(titleResults, 'Something went wrong', err.message, true);
    }
  }

  titleForm.addEventListener('submit', e => {
    e.preventDefault();
    const query = titleInput.value.trim();
    if (!query) return;
    runTitleSearch(query);
  });

  // ---------- Genre browse ----------
  const genreState = {
    genre: '',
    type: '',
    label: '',
    page: 0,
    hasMore: false,
    seen: new Set()
  };

  // The genre list comes from the API route once. It lists which of Movies / TV Shows each genre
  // exists for, so the dropdown only offers genres that fit the current toggles.
  let allGenres = [];

  function renderGenreOptions() {
    const previous = genreSelect.value;
    genreSelect.innerHTML = '<option value="">Choose a genre</option>';
    allGenres
      .filter(genre => genre.types.some(type => selectedTypes[type]))
      .forEach(genre => {
        const option = document.createElement('option');
        option.value = genre.slug;
        option.textContent = genre.name;
        genreSelect.appendChild(option);
      });
    genreSelect.value = previous;
    if (genreSelect.value !== previous) genreSelect.value = '';
  }

  async function loadGenres() {
    try {
      allGenres = await apiGet({ action: 'genres' });
    } catch {
      genreSelect.innerHTML = '<option value="">Genres unavailable</option>';
      return;
    }
    renderGenreOptions();
  }

  // reset starts a fresh list; refresh does the same for the genre already on screen (used when
  // a toggle is switched on for a type the last fetch didn't include).
  async function loadGenreResults(reset, refresh = false) {
    if (reset) {
      if (!refresh) {
        genreState.genre = genreSelect.value;
        genreState.label = genreSelect.options[genreSelect.selectedIndex].textContent;
      }
      genreState.type = currentType();
      genreState.page = 0;
      genreState.hasMore = false;
      genreState.seen = new Set();
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

      // Some genres only exist for one type (Horror is movies only, Reality is TV only), so say so.
      const used = Array.isArray(data.types) ? data.types : [];
      const wanted = genreState.type === 'both' ? 2 : 1;
      const only = used.length > 0 && used.length < wanted
        ? ` (${used[0] === 'movie' ? 'movies' : 'TV shows'} only)`
        : '';
      const summary = summaryHtml(newShows.length, `for ${genreState.label}`, only);
      const grid = newShows.map(cardHtml).join('');
      if (reset) {
        genreResults.innerHTML = summary + (grid ? `<div class="grid">${grid}</div>` : '<p class="message">No results found.</p>');
      } else if (grid) {
        genreResults.querySelector('.grid').insertAdjacentHTML('beforeend', grid);
      }
      loadMoreBtn.hidden = !genreState.hasMore;
      applyTypeFilter();
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

  loadMoreBtn.addEventListener('click', () => loadGenreResults(false));
  loadGenres();
});
