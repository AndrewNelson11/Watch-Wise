# Watchwise

Find what to watch, and where to stream it. Search any movie or show by title, or browse by genre, and see each title's year, rating, runtime, description and the US streaming services that carry it.

**Live demo:** [https://watch-wise-gamma.vercel.app/](https://watch-wise-gamma.vercel.app)

![Watchwise screenshot](screenshot.png)

## Features
- Search movies and shows by title
- Browse by genre: trending, well-known titles that are streamable in the US, with Load more pagination
- Direct links into each streaming service for every way to watch (subscription and free first, rent/buy last)
- Responsive layout, keyboard-accessible tabs, loading and error states

## Tech stack
- HTML, CSS and vanilla JavaScript (no framework, no build step)
- Vercel serverless function (Node.js) as an API proxy
- [TMDB API](https://www.themoviedb.org/documentation/api) for search, popularity ranking, details and US availability
- [Streaming Availability API](https://rapidapi.com/movie-of-the-night-movie-of-the-night-default/api/streaming-availability/details) (RapidAPI) for direct deep links into each service
- Deployed on Vercel from GitHub

## How it works
The browser never talks to the external APIs directly. `script.js` calls `/api/movies`, a serverless function that adds the API credentials from environment variables, queries TMDB and returns clean, ready-to-render results. This keeps the keys out of front-end code and out of the repo.

Two APIs split the work: TMDB handles search and popularity, and the Streaming Availability API supplies direct links into Netflix, Max and so on. Cards first show TMDB's list of services, then each card is upgraded in the background with direct links (loaded a few at a time, cached in the browser and at the edge). If the direct-link lookup fails or the free daily limit is hit, the card keeps TMDB's general where-to-watch link.

Other details worth noting:
- Title search scores each match by how well known it is (vote count and popularity) plus a boost for exact title matches and for titles streamable in the US
- Genre browse uses TMDB's discover endpoint sorted by popularity, with a minimum vote count so only well-known titles appear, and filtered to titles available in the US
- The function fetches details and streaming providers for each result in parallel, so the browser makes a single request
- Results are HTML-escaped and links are validated before rendering
- Handles rate limiting (429), rejected keys, empty results and network failures with friendly messages

## Project structure
```
index.html        page structure
style.css         all styling
script.js         search, rendering and pagination
api/movies.js     serverless API proxy (must stay in api/)
logo.svg          logo and favicon
tmdb-logo.svg     TMDB attribution logo (downloaded from TMDB's logos page)
```

## Run locally
The app needs the serverless function, so opening `index.html` directly won't fetch data. Use the Vercel CLI instead:

```
npm i -g vercel
printf "TMDB_ACCESS_TOKEN=your_token_here\nRAPIDAPI_KEY=your_key_here\n" > .env
vercel dev
```

## Deploy
1. Push the repo to GitHub.
2. Import it in Vercel with the framework preset set to Other and no build command.
3. Add `TMDB_ACCESS_TOKEN` (your TMDB API Read Access Token) and `RAPIDAPI_KEY` (your RapidAPI key) under Project Settings > Environment Variables, then redeploy.

## Attribution
This product uses the TMDB API but is not endorsed or certified by TMDB. Streaming availability data is provided by JustWatch, with direct links from the Streaming Availability API.
