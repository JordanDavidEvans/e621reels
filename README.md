# e621reels

A Cloudflare Worker site that turns e621's public API into an Instagram Reels-style fullscreen viewer.

## Features

- Defaults to a trending/popular animated feed using `order:rank animated` on the e621 API.
- Instagram-inspired fullscreen UI with overlay controls.
- Advances automatically after roughly 10 seconds, or sooner when a video ends.
- Lets users switch to score-based sorting, add tags, and filter by rating.
- Ships as a single Worker with no extra Cloudflare bindings or dashboard changes required.

## Local development

```bash
npm install
npm run dev
```

## Deploy

```bash
npm run deploy
```

## Notes

- The Worker proxies requests to `https://e621.net/posts.json` so the browser never has to handle e621's API headers directly.
- e621 requires a descriptive `User-Agent` for API usage. Update the placeholder contact in `src/worker.js` before production deployment.
