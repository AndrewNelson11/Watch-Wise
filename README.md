# Watchwise

Find what to watch, and where to stream it. Search any movie or show by title, or browse by genre, and see the year, rating, runtime, a short description and the US streaming services that carry it.

## Features
- Search movies and shows by title
- Browse by genre, with Load more
- Streaming links for each result (subscription and free options listed first, rent/buy last)
- Responsive layout, keyboard-friendly tabs, no build step

## Files
- `index.html` – page structure
- `style.css` – all styling (no Tailwind or other CSS framework needed)
- `script.js` – search, rendering and pagination
- `api/movies.js` – Vercel serverless function that proxies the API (must stay in `api/`)
- `genres.json` – genre list (falls back to the API if missing)
- `logo.svg` – logo and favicon

## Run locally
Open `index.html` in a browser. Genres load from `genres.json`, which some browsers block on `file://`; in that case the app falls back to the API automatically.

## API key
The key lives in a Vercel environment variable named `RAPIDAPI_KEY` (Project Settings > Environment Variables), never in front-end code. `api/movies.js` reads it on the server.

## Deploy on Vercel
1. Push this folder to a GitHub repo.
2. In Vercel choose Add New > Project and import the repo.
3. Set the framework preset to Other, leave build settings empty, and deploy.

## Attribution
Uses the Streaming Availability API. See their [terms](https://rapidapi.com/movie-of-the-night-movie-of-the-night-default/api/streaming-availability/details) for attribution requirements.
