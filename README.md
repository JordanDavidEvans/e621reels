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

- The Worker proxies feed requests to `https://e621.net/posts.json` by default, but the browser now falls back to a direct request if `/api/posts` returns an error such as a 502 from blocked Worker egress traffic.
- Browser JavaScript cannot set a custom `User-Agent` header, so the direct fallback uses the visitor's normal browser user agent while the Worker path continues to send the descriptive `User-Agent` configured in `src/worker.js`.
- e621 requires a descriptive `User-Agent` for server-side API usage. Update the placeholder contact in `src/worker.js` before production deployment.
