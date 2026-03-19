const E621_API = 'https://e621.net/posts.json';
const E621_TAG_AUTOCOMPLETE_API = 'https://e621.net/tags/autocomplete.json';
const USER_AGENT = 'e621reels/0.1.0 (Cloudflare Worker demo; contact: admin@example.com)';
const PAGE_SIZE = 24;
const BASE_TAGS = ['animated'];
const SUPPORTED_MEDIA = new Set(['webm', 'mp4', 'gif']);
const UPSTREAM_ERROR_PREVIEW_LIMIT = 400;
const TAG_AUTOCOMPLETE_LIMIT = 8;
const RATIO_FILTER_TAGS = {
  vertical: 'ratio:<1',
  landscape: 'ratio:>1',
};

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/api/posts') {
      return handlePosts(request, url);
    }

    if (url.pathname === '/api/tags/autocomplete') {
      return handleTagAutocomplete(request, url);
    }

    if (url.pathname === '/robots.txt') {
      return new Response(renderRobotsTxt(), {
        headers: {
          'content-type': 'text/plain; charset=UTF-8',
          'cache-control': 'public, max-age=3600',
        },
      });
    }

    if (url.pathname === '/sitemap.xml') {
      return new Response(renderSitemapXml(), {
        headers: {
          'content-type': 'application/xml; charset=UTF-8',
          'cache-control': 'public, max-age=3600',
        },
      });
    }

    if (url.pathname === '/' || url.pathname === '/index.html') {
      return new Response(renderApp(url), {
        headers: {
          'content-type': 'text/html; charset=UTF-8',
          'cache-control': 'no-store',
        },
      });
    }

    return new Response('Not found', { status: 404 });
  },
};

async function handlePosts(request, url) {
  if (request.method !== 'GET') {
    return json({ error: 'Method not allowed' }, 405);
  }

  const mode = url.searchParams.get('mode') === 'score' ? 'score' : 'trending';
  const page = normalizePage(url.searchParams.get('page'));
  const rawTags = sanitizeTags(url.searchParams.get('tags') || '');
  const requestedRating = sanitizeRating(url.searchParams.get('rating'));
  const requestedRatio = sanitizeRatioFilter(url.searchParams.get('ratio'));
  const apiTags = [
    mode === 'score' ? 'order:score' : 'order:rank',
    ...BASE_TAGS,
    ...rawTags,
    ...(requestedRating ? ['rating:' + requestedRating] : []),
    ...(requestedRatio ? [RATIO_FILTER_TAGS[requestedRatio]] : []),
  ].join(' ');

  const upstream = new URL(E621_API);
  upstream.searchParams.set('limit', String(PAGE_SIZE));
  upstream.searchParams.set('page', String(page));
  upstream.searchParams.set('tags', apiTags);

  const requestMeta = {
    mode,
    page,
    tags: rawTags,
    rating: requestedRating,
    ratio: requestedRatio,
    upstream: upstream.toString(),
    ray: request.headers.get('cf-ray') || null,
    colo: request.cf?.colo || null,
  };

  try {
    const response = await fetch(upstream, {
      headers: {
        Accept: 'application/json',
        'User-Agent': USER_AGENT,
      },
      cf: {
        cacheTtl: 120,
        cacheEverything: false,
      },
    });

    if (!response.ok) {
      const upstreamBody = trimForLog(await response.text());
      console.error('e621 upstream returned a non-OK response', {
        ...requestMeta,
        upstreamStatus: response.status,
        upstreamStatusText: response.statusText,
        upstreamBody,
      });

      return json(
        {
          error: 'Failed to fetch from e621',
          status: response.status,
          upstreamStatusText: response.statusText,
          details: upstreamBody,
          requestMeta,
        },
        502,
      );
    }

    const data = await response.json();
    const posts = Array.isArray(data.posts)
      ? data.posts
          .filter((post) => post?.file?.url && SUPPORTED_MEDIA.has(String(post.file.ext || '').toLowerCase()))
          .map((post) => mapPost(post))
      : [];

    return json({
      mode,
      page,
      tags: rawTags,
      rating: requestedRating,
      ratio: requestedRatio,
      posts,
      source: 'worker',
    });
  } catch (error) {
    console.error('e621 upstream fetch threw an exception', {
      ...requestMeta,
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : null,
    });

    return json(
      {
        error: 'Failed to fetch from e621',
        status: 0,
        details: error instanceof Error ? error.message : String(error),
        requestMeta,
      },
      502,
    );
  }
}

async function handleTagAutocomplete(request, url) {
  if (request.method !== 'GET') {
    return json({ error: 'Method not allowed' }, 405);
  }

  const rawQuery = String(url.searchParams.get('q') || '');
  const query = sanitizeAutocompleteQuery(rawQuery);

  if (!query) {
    return json({ query: '', tags: [] });
  }

  const upstream = new URL(E621_TAG_AUTOCOMPLETE_API);
  upstream.searchParams.set('search[name_matches]', query + '*');

  const requestMeta = {
    query,
    upstream: upstream.toString(),
    ray: request.headers.get('cf-ray') || null,
    colo: request.cf?.colo || null,
  };

  try {
    const response = await fetch(upstream, {
      headers: {
        Accept: 'application/json',
        'User-Agent': USER_AGENT,
      },
      cf: {
        cacheTtl: 180,
        cacheEverything: false,
      },
    });

    if (!response.ok) {
      const upstreamBody = trimForLog(await response.text());
      console.error('e621 tag autocomplete returned a non-OK response', {
        ...requestMeta,
        upstreamStatus: response.status,
        upstreamStatusText: response.statusText,
        upstreamBody,
      });

      return json(
        {
          error: 'Failed to fetch tag autocomplete',
          status: response.status,
          upstreamStatusText: response.statusText,
          details: upstreamBody,
          requestMeta,
        },
        502,
      );
    }

    const data = await response.json();
    const tags = Array.isArray(data)
      ? data
          .filter((tag) => tag && typeof tag.name === 'string')
          .slice(0, TAG_AUTOCOMPLETE_LIMIT)
          .map((tag) => ({
            id: tag.id || null,
            name: tag.name,
            category: Number.isFinite(tag.category) ? tag.category : null,
            postCount: Number.isFinite(tag.post_count) ? tag.post_count : 0,
            antecedentName: tag.antecedent_name || null,
          }))
      : [];

    return json({ query, tags, source: 'worker' });
  } catch (error) {
    console.error('e621 tag autocomplete threw an exception', {
      ...requestMeta,
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : null,
    });

    return json(
      {
        error: 'Failed to fetch tag autocomplete',
        status: 0,
        details: error instanceof Error ? error.message : String(error),
        requestMeta,
      },
      502,
    );
  }
}

function trimForLog(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, UPSTREAM_ERROR_PREVIEW_LIMIT);
}

function mapPost(post) {
  const ext = String(post.file.ext || '').toLowerCase();
  const width = post.file?.width || post.sample?.width || 0;
  const height = post.file?.height || post.sample?.height || 0;
  const artist = Array.isArray(post.tags?.artist) ? post.tags.artist.filter(Boolean) : [];
  const species = Array.isArray(post.tags?.species) ? post.tags.species.filter(Boolean) : [];
  const general = Array.isArray(post.tags?.general) ? post.tags.general.filter(Boolean).slice(0, 12) : [];

  return {
    id: post.id,
    ext,
    type: ['webm', 'mp4'].includes(ext) ? 'video' : 'image',
    score: post.score?.total || 0,
    rating: post.rating || 'u',
    width,
    height,
    createdAt: post.created_at,
    mediaUrl: post.file.url,
    previewUrl: post.preview?.url || post.sample?.url || post.file.url,
    sourceUrl: 'https://e621.net/posts/' + post.id,
    description: [
      artist.length ? 'Artist: ' + artist.join(', ') : 'Artist unknown',
      species.length ? 'Species: ' + species.slice(0, 3).join(', ') : null,
    ]
      .filter(Boolean)
      .join(' • '),
    tags: [...artist.map((tag) => 'artist:' + tag), ...general],
  };
}

function renderApp(url) {
  const seo = buildSeo(url);
  const landingLinks = buildLandingLinks();

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(seo.title)}</title>
    <meta name="description" content="${escapeHtml(seo.description)}" />
    <meta name="robots" content="index,follow,max-image-preview:large,max-snippet:-1,max-video-preview:-1" />
    <link rel="canonical" href="${escapeHtml(seo.canonicalUrl)}" />
    <meta property="og:type" content="website" />
    <meta property="og:site_name" content="FurryReel" />
    <meta property="og:title" content="${escapeHtml(seo.title)}" />
    <meta property="og:description" content="${escapeHtml(seo.description)}" />
    <meta property="og:url" content="${escapeHtml(seo.canonicalUrl)}" />
    <meta property="og:image" content="https://furryreel.com/og-image.png" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${escapeHtml(seo.title)}" />
    <meta name="twitter:description" content="${escapeHtml(seo.description)}" />
    <meta name="theme-color" content="#080808" />
    <script type="application/ld+json">${serializeJsonLd(seo.structuredData)}</script>
    <style>
      :root {
        color-scheme: dark;
        --bg: #080808;
        --panel: rgba(20, 20, 24, 0.82);
        --panel-strong: rgba(15, 15, 20, 0.94);
        --text: #f6f6f6;
        --muted: #b6b6c2;
        --accent: #ff2f78;
        --accent-soft: rgba(255, 47, 120, 0.18);
        --outline: rgba(255,255,255,0.12);
        --safe-top: max(18px, env(safe-area-inset-top));
        --safe-bottom: max(24px, env(safe-area-inset-bottom));
        --app-height: 100dvh;
      }
      @supports not (height: 100dvh) {
        :root {
          --app-height: 100vh;
        }
      }
      * { box-sizing: border-box; }
      html, body {
        overscroll-behavior: none;
      }
      body {
        margin: 0;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
        background: radial-gradient(circle at top, #171727 0%, var(--bg) 48%);
        color: var(--text);
        min-height: 100vh;
      }
      button, input, select {
        font: inherit;
      }
      .shell {
        min-height: var(--app-height);
        display: grid;
        place-items: center;
        padding: 20px;
      }
      .app {
        width: min(100%, 1240px);
        height: min(calc(var(--app-height) - 40px), 960px);
        border: 1px solid var(--outline);
        border-radius: 32px;
        overflow: hidden;
        position: relative;
        background: #000;
        box-shadow: 0 30px 90px rgba(0, 0, 0, 0.45);
        touch-action: none;
      }
      .viewport {
        position: absolute;
        inset: 0;
        overflow: hidden;
        background: #000;
      }
      .reel-track {
        position: absolute;
        inset: 0;
        transform: translate3d(0, 0, 0);
        will-change: transform;
      }
      .reel-track.animating {
        transition: transform 320ms cubic-bezier(.22, .61, .36, 1);
      }
      .reel-slide {
        position: absolute;
        inset: 0;
        background: #000;
        overflow: hidden;
      }
      .reel-slide.placeholder {
        display: grid;
        place-items: center;
        color: var(--muted);
        font-size: 0.95rem;
      }
      .reel-slide::before {
        content: '';
        position: absolute;
        inset: 0;
        background-image: var(--preview-image, none);
        background-size: cover;
        background-position: center;
        filter: blur(28px) saturate(0.9);
        transform: scale(1.08);
        opacity: 0.55;
      }
      .reel-media,
      .reel-media-fallback {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        background: #000;
      }
      .reel-media {
        object-fit: cover;
      }
      .reel-media.fit {
        object-fit: contain;
      }
      .reel-media-fallback {
        background-size: cover;
        background-position: center;
        opacity: 0;
        transition: opacity 180ms ease;
      }
      .reel-slide.loading .reel-media-fallback,
      .reel-slide.awaiting-play .reel-media-fallback {
        opacity: 0.92;
      }
      .gradient {
        position: absolute;
        inset: 0;
        background: linear-gradient(180deg, rgba(0, 0, 0, 0.68) 0%, rgba(0, 0, 0, 0.08) 24%, rgba(0, 0, 0, 0.1) 60%, rgba(0, 0, 0, 0.86) 100%);
        pointer-events: none;
      }
      .overlay {
        position: absolute;
        inset: 0;
        display: grid;
        grid-template-rows: auto 1fr auto;
        padding: var(--safe-top) 16px var(--safe-bottom);
        z-index: 2;
        pointer-events: none;
      }
      .overlay > * {
        pointer-events: auto;
      }
      .topbar {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        align-items: flex-start;
      }
      .brand h1 {
        margin: 0;
        font-size: 1.2rem;
      }
      .brand p,
      .status,
      .empty,
      .meta p,
      .hint,
      .side-label,
      .filter-panel label span,
      .field-help,
      .tagline,
      .counter,
      .swipe-hint,
      .autocomplete-meta,
      .autocomplete-empty {
        color: var(--muted);
      }
      .badge-row {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
        justify-content: flex-end;
        padding-left: 8px;
      }
      .badge,
      .pill,
      .counter,
      .swipe-hint {
        border: 1px solid var(--outline);
        background: rgba(8, 8, 12, 0.5);
        backdrop-filter: blur(18px);
        border-radius: 999px;
        padding: 8px 12px;
      }
      .status-card {
        align-self: center;
        justify-self: center;
        max-width: 80%;
        text-align: center;
        background: var(--panel);
        border: 1px solid var(--outline);
        border-radius: 24px;
        padding: 18px 20px;
        backdrop-filter: blur(18px);
        z-index: 3;
      }
      .bottom {
        display: grid;
        grid-template-columns: 1fr auto;
        gap: 14px;
        align-items: end;
      }
      .meta {
        display: grid;
        gap: 10px;
        min-width: 0;
      }
      .meta h2 {
        margin: 0;
        font-size: 1.2rem;
      }
      .meta p {
        margin: 0;
        line-height: 1.4;
      }
      .pill-row {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }
      .pill {
        max-width: 100%;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .side-actions {
        display: grid;
        gap: 12px;
        justify-items: center;
      }
      .action-button {
        width: 54px;
        height: 54px;
        border-radius: 999px;
        border: 1px solid var(--outline);
        background: var(--panel);
        color: var(--text);
        display: grid;
        place-items: center;
        backdrop-filter: blur(20px);
        cursor: pointer;
      }
      .settings-button {
        width: 38px;
        height: 38px;
        background: rgba(10, 10, 14, 0.18);
        border-color: rgba(255,255,255,0.18);
        opacity: 0.42;
        transition: opacity 140ms ease, background 140ms ease;
      }
      .settings-button:hover,
      .settings-button:focus-visible,
      .settings-button.active {
        opacity: 1;
        background: rgba(14, 14, 18, 0.62);
      }
      .side-label {
        font-size: 0.74rem;
      }
      .progress {
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        height: 4px;
        background: rgba(255,255,255,0.08);
        z-index: 4;
      }
      .progress > div {
        height: 100%;
        width: 0;
        background: linear-gradient(90deg, #ff59a0 0%, #ffd36b 100%);
        transition: width 100ms linear;
      }
      .settings-toggle {
        position: absolute;
        right: 16px;
        top: calc(var(--safe-top) + 58px);
        z-index: 5;
      }
      .filter-panel {
        position: absolute;
        top: 74px;
        right: 12px;
        left: 12px;
        z-index: 6;
        border: 1px solid var(--outline);
        background: var(--panel-strong);
        backdrop-filter: blur(24px);
        border-radius: 24px;
        padding: 18px;
        display: grid;
        gap: 14px;
        transform: translateY(-12px) scale(0.98);
        opacity: 0;
        pointer-events: none;
        transition: opacity 140ms ease, transform 180ms ease;
      }
      .filter-panel.open {
        transform: translateY(0) scale(1);
        opacity: 1;
        pointer-events: auto;
      }
      .filter-panel h3 {
        margin: 0 0 4px;
      }
      .filter-panel label {
        display: grid;
        gap: 8px;
      }
      .filter-panel input,
      .filter-panel select,
      .filter-panel button {
        border: 1px solid rgba(255,255,255,0.14);
        background: rgba(255,255,255,0.06);
        color: var(--text);
        border-radius: 14px;
        padding: 12px 14px;
      }
      .filter-panel input::placeholder {
        color: rgba(255,255,255,0.42);
      }
      .settings-option {
        grid-template-columns: auto 1fr;
        align-items: center;
        gap: 12px;
      }
      .settings-option input {
        width: 20px;
        height: 20px;
        padding: 0;
      }
      .filter-actions,
      .jump {
        display: flex;
        gap: 10px;
      }
      .filter-actions > *,
      .jump > * {
        flex: 1;
      }
      .primary,
      .secondary {
        cursor: pointer;
      }
      .primary {
        background: linear-gradient(135deg, #ff4d98 0%, #ff7b4d 100%);
        border: none;
      }
      .secondary {
        background: rgba(255,255,255,0.08);
      }
      .meta.hidden-tags #tagList {
        display: none;
      }
      .field-help,
      .hint {
        font-size: 0.87rem;
        line-height: 1.45;
      }
      .input-with-autocomplete {
        position: relative;
      }
      .autocomplete {
        position: absolute;
        left: 0;
        right: 0;
        top: calc(100% + 8px);
        z-index: 7;
        border: 1px solid var(--outline);
        border-radius: 16px;
        background: rgba(10, 10, 14, 0.96);
        backdrop-filter: blur(18px);
        box-shadow: 0 18px 48px rgba(0, 0, 0, 0.42);
        overflow: hidden;
      }
      .autocomplete[hidden] {
        display: none;
      }
      .autocomplete-list {
        display: grid;
      }
      .autocomplete-option,
      .autocomplete-empty {
        display: grid;
        grid-template-columns: auto 1fr auto;
        gap: 10px;
        align-items: center;
        width: 100%;
        padding: 12px 14px;
        border: 0;
        border-top: 1px solid rgba(255,255,255,0.06);
        background: transparent;
        color: var(--text);
        text-align: left;
      }
      .autocomplete-option:first-child,
      .autocomplete-empty:first-child {
        border-top: 0;
      }
      .autocomplete-option.active,
      .autocomplete-option:hover,
      .autocomplete-option:focus-visible {
        background: rgba(255,255,255,0.08);
        outline: none;
      }
      .autocomplete-tag {
        overflow: hidden;
      }
      .autocomplete-name {
        font-weight: 600;
      }
      .autocomplete-meta {
        font-size: 0.78rem;
        margin-top: 2px;
      }
      .autocomplete-empty {
        grid-template-columns: 1fr;
      }
      .autocomplete-category {
        width: 10px;
        height: 10px;
        border-radius: 999px;
        background: #666;
      }
      .autocomplete-category[data-category="0"] { background: #b9b9b9; }
      .autocomplete-category[data-category="1"] { background: #e7c94e; }
      .autocomplete-category[data-category="3"] { background: #53b45e; }
      .autocomplete-category[data-category="4"] { background: #f28b51; }
      .autocomplete-category[data-category="5"] { background: #5f9bff; }
      .autocomplete-category[data-category="6"] { background: #b36df6; }
      .autocomplete-count {
        font-size: 0.78rem;
        color: var(--muted);
        white-space: nowrap;
      }
      .pill-button {
        cursor: pointer;
      }
      .pill-button:hover,
      .pill-button:focus-visible {
        border-color: rgba(255,255,255,0.28);
        background: rgba(255,255,255,0.12);
        outline: none;
      }
      .pill-button.active {
        background: var(--accent-soft);
        border-color: rgba(255, 47, 120, 0.48);
      }
      .seo-content {
        position: absolute;
        width: 1px;
        height: 1px;
        padding: 0;
        margin: -1px;
        overflow: hidden;
        clip: rect(0, 0, 0, 0);
        white-space: nowrap;
        border: 0;
      }
      @media (orientation: landscape) and (max-width: 960px) {
        .shell {
          padding: 0;
        }
        .app {
          width: 100vw;
          height: var(--app-height);
          border-radius: 0;
          border: none;
        }
        .overlay {
          padding-left: max(14px, env(safe-area-inset-left));
          padding-right: max(14px, env(safe-area-inset-right));
        }
      }
      @media (max-width: 640px) {
        .shell {
          padding: 0;
        }
        .app {
          width: 100%;
          height: var(--app-height);
          border-radius: 0;
          border: none;
        }
      }
    </style>
  </head>
  <body>
    <div class="shell">
      <section class="seo-content" aria-hidden="true">
        <h1>${escapeHtml(seo.heading)}</h1>
        <p>${escapeHtml(seo.description)}</p>
        <p>${escapeHtml(seo.indexingText)}</p>
        <ul>${landingLinks}</ul>
      </section>
      <main class="app" id="appRoot">
        <div class="progress"><div id="progressBar"></div></div>
        <div class="viewport" id="viewport">
          <div class="reel-track" id="reelTrack"></div>
        </div>
        <div class="gradient"></div>
        <section class="overlay">
          <div class="topbar">
            <div class="brand">
              <p class="tagline">Trending animated posts from e621</p>
              <h1>e621 Reels</h1>
            </div>
            <div class="badge-row">
              <div class="badge" id="sortBadge">Trending</div>
              <div class="badge" id="ratioBadge">Any aspect</div>
              <div class="counter" id="counterBadge">0 / 0</div>
            </div>
          </div>

          <div class="status-card" id="statusCard">
            <strong id="statusTitle">Loading feed…</strong>
            <p class="status" id="statusText">Fetching top posts from e621.</p>
          </div>

          <div class="bottom">
            <div class="meta" id="metaBlock">
              <div>
                <h2 id="postTitle">Waiting for posts</h2>
                <p id="postDescription">Use the settings cog to change feed filters or display options, then swipe up and down through posts.</p>
              </div>
              <div class="pill-row" id="tagList"></div>
              <div class="jump">
                <button class="secondary" id="previousButton" type="button">Previous</button>
                <button class="primary" id="nextButton" type="button">Next</button>
              </div>
            </div>
            <div class="side-actions">
              <button class="action-button" id="toggleMuteButton" type="button" aria-label="Toggle mute">🔇</button>
              <div class="side-label">Sound</div>
              <a class="action-button source-link" id="openPostLink" href="https://e621.net" target="_blank" rel="noreferrer" aria-label="Open post on e621">↗</a>
              <div class="side-label">Source</div>
            </div>
          </div>
        </section>

        <div class="settings-toggle">
          <button class="action-button settings-button" id="toggleFiltersButton" type="button" aria-label="Open feed settings">⚙</button>
        </div>

        <form class="filter-panel" id="filterPanel">
          <div>
            <h3>Feed controls</h3>
            <p class="field-help">Swipe vertically like Reels. Videos now play through before auto-advancing, while still preloading the next item to keep transitions smooth.</p>
          </div>
          <label>
            <span>Sort mode</span>
            <select id="modeSelect" name="mode">
              <option value="trending">Trending / popular</option>
              <option value="score">Top score</option>
            </select>
          </label>
          <label>
            <span>Tags</span>
            <div class="input-with-autocomplete">
              <input id="tagsInput" name="tags" type="text" placeholder="wolf animated" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" aria-autocomplete="list" aria-controls="tagAutocomplete" aria-expanded="false" />
              <div class="autocomplete" id="tagAutocomplete" hidden>
                <div class="autocomplete-list" id="tagAutocompleteList"></div>
              </div>
            </div>
          </label>
          <label>
            <span>Rating</span>
            <select id="ratingSelect" name="rating">
              <option value="">Any rating</option>
              <option value="s">Safe</option>
              <option value="q">Questionable</option>
              <option value="e">Explicit</option>
            </select>
          </label>
          <label>
            <span>Display mode</span>
            <select id="mediaDisplaySelect" name="displayMode">
              <option value="contain">Show full aspect ratio</option>
              <option value="fullscreen">Fill screen / crop</option>
            </select>
          </label>
          <label>
            <span>Aspect ratio filter</span>
            <select id="ratioSelect" name="ratio">
              <option value="">Any aspect ratio</option>
              <option value="vertical">Portrait / vertical only</option>
              <option value="landscape">Landscape only</option>
            </select>
          </label>
          <label class="settings-option">
            <input id="hideTagsToggle" name="hideTags" type="checkbox" />
            <span>Hide the tag pills overlay by default for a cleaner viewing area.</span>
          </label>
          <div class="filter-actions">
            <button class="primary" type="submit">Apply</button>
            <button class="secondary" id="resetButton" type="button">Reset</button>
          </div>
          <p class="hint">Tap the current reel to pause or resume. Images advance after 10 seconds, and short videos loop until they have been on screen for at least 10 seconds before the feed advances.</p>
        </form>
      </main>
    </div>

    <noscript>
      <section style="padding:24px;max-width:960px;margin:0 auto;color:#f6f6f6">
        <h2>Browse FurryReel without JavaScript</h2>
        <p>${escapeHtml(seo.description)}</p>
        <ul>${landingLinks}</ul>
      </section>
    </noscript>

    <script>
      const CLIENT_E621_API = 'https://e621.net/posts.json';
      const CLIENT_E621_TAG_AUTOCOMPLETE_API = 'https://e621.net/tags/autocomplete.json';
      const CLIENT_SUPPORTED_MEDIA = new Set(['webm', 'mp4', 'gif']);
      const SWIPE_THRESHOLD = 90;
      const DRAG_LOCK_THRESHOLD = 12;
      const TAP_DISTANCE_THRESHOLD = 10;
      const WHEEL_THRESHOLD = 8;
      const PRELOAD_DISTANCE = 2;
      const IMAGE_COUNTDOWN_MS = 10000;
      const MIN_VIDEO_PLAYBACK_MS = 10000;
      const TRACK_TRANSITION_MS = 320;
      const TRACK_TRANSITION_FALLBACK_MS = TRACK_TRANSITION_MS + 120;
      const TAG_AUTOCOMPLETE_LIMIT = 8;
      const AUTOCOMPLETE_DEBOUNCE_MS = 160;
      const INITIAL_MODE = ${JSON.stringify(seo.initialModeForClient)};
      const INITIAL_TAGS = ${JSON.stringify(seo.initialTagsForClient)};
      const INITIAL_RATING = ${JSON.stringify(seo.initialRatingForClient)};
      const INITIAL_RATIO = ${JSON.stringify(seo.initialRatioForClient)};

      const state = {
        posts: [],
        currentIndex: 0,
        nextPage: 1,
        loading: false,
        mode: INITIAL_MODE,
        tags: INITIAL_TAGS,
        rating: INITIAL_RATING,
        ratio: INITIAL_RATIO,
        muted: true,
        timer: null,
        progressTimer: null,
        animationLock: false,
        fitMedia: true,
        hideTags: true,
        touchActive: false,
        gesturePointerId: null,
        gestureSource: null,
        dragLocked: false,
        pointerStartY: 0,
        pointerStartX: 0,
        pointerDeltaY: 0,
        pointerDeltaX: 0,
        currentMedia: null,
        currentSlide: null,
        navigationToken: 0,
        preloaded: new Map(),
        lastFeedSource: 'worker',
        suppressClickUntil: 0,
        videoPlayback: new WeakMap(),
        tagAutocomplete: {
          items: [],
          activeIndex: -1,
          open: false,
          requestId: 0,
          debounceTimer: null,
          query: '',
        },
      };

      const appRoot = document.getElementById('appRoot');
      const viewport = document.getElementById('viewport');
      const reelTrack = document.getElementById('reelTrack');
      const metaBlock = document.getElementById('metaBlock');
      const postTitle = document.getElementById('postTitle');
      const postDescription = document.getElementById('postDescription');
      const statusCard = document.getElementById('statusCard');
      const statusTitle = document.getElementById('statusTitle');
      const statusText = document.getElementById('statusText');
      const tagList = document.getElementById('tagList');
      const nextButton = document.getElementById('nextButton');
      const previousButton = document.getElementById('previousButton');
      const sortBadge = document.getElementById('sortBadge');
      const ratioBadge = document.getElementById('ratioBadge');
      const counterBadge = document.getElementById('counterBadge');
      const progressBar = document.getElementById('progressBar');
      const openPostLink = document.getElementById('openPostLink');
      const modeSelect = document.getElementById('modeSelect');
      const tagsInput = document.getElementById('tagsInput');
      const ratingSelect = document.getElementById('ratingSelect');
      const filterPanel = document.getElementById('filterPanel');
      const toggleFiltersButton = document.getElementById('toggleFiltersButton');
      const resetButton = document.getElementById('resetButton');
      const toggleMuteButton = document.getElementById('toggleMuteButton');
      const mediaDisplaySelect = document.getElementById('mediaDisplaySelect');
      const ratioSelect = document.getElementById('ratioSelect');
      const hideTagsToggle = document.getElementById('hideTagsToggle');
      const tagAutocomplete = document.getElementById('tagAutocomplete');
      const tagAutocompleteList = document.getElementById('tagAutocompleteList');

      modeSelect.value = state.mode;
      tagsInput.value = state.tags;
      ratingSelect.value = state.rating;
      mediaDisplaySelect.value = state.fitMedia ? 'contain' : 'fullscreen';
      ratioSelect.value = state.ratio;
      hideTagsToggle.checked = state.hideTags;

      toggleFiltersButton.addEventListener('click', () => {
        const nextOpen = !filterPanel.classList.contains('open');
        filterPanel.classList.toggle('open', nextOpen);
        toggleFiltersButton.classList.toggle('active', nextOpen);
        if (!nextOpen) {
          closeTagAutocomplete();
        }
      });

      filterPanel.addEventListener('submit', async (event) => {
        event.preventDefault();
        closeTagAutocomplete();
        state.mode = modeSelect.value;
        state.tags = tagsInput.value.trim();
        state.rating = ratingSelect.value;
        state.ratio = ratioSelect.value;
        state.fitMedia = mediaDisplaySelect.value !== 'fullscreen';
        state.hideTags = hideTagsToggle.checked;
        syncDisplaySettings();
        syncUrlState();
        closeSettings();
        await restartFeed();
      });

      resetButton.addEventListener('click', async () => {
        modeSelect.value = 'trending';
        tagsInput.value = '';
        ratingSelect.value = '';
        mediaDisplaySelect.value = 'contain';
        ratioSelect.value = '';
        hideTagsToggle.checked = true;
        state.mode = 'trending';
        state.tags = '';
        state.rating = '';
        state.ratio = '';
        state.fitMedia = true;
        state.hideTags = true;
        closeTagAutocomplete();
        syncDisplaySettings();
        syncUrlState();
        closeSettings();
        await restartFeed();
      });

      nextButton.addEventListener('click', () => goToRelativePost(1));
      previousButton.addEventListener('click', () => goToRelativePost(-1));
      toggleMuteButton.addEventListener('click', () => {
        state.muted = !state.muted;
        state.preloaded.forEach((entry) => {
          if (entry.media && entry.media.tagName === 'VIDEO') {
            entry.media.muted = state.muted;
          }
        });
        if (state.currentMedia && state.currentMedia.tagName === 'VIDEO') {
          state.currentMedia.muted = state.muted;
        }
        toggleMuteButton.textContent = state.muted ? '🔇' : '🔊';
      });

      tagsInput.addEventListener('input', () => scheduleTagAutocomplete());
      tagsInput.addEventListener('focus', () => scheduleTagAutocomplete(true));
      tagsInput.addEventListener('blur', () => {
        window.setTimeout(() => {
          if (!tagAutocomplete.contains(document.activeElement)) {
            closeTagAutocomplete();
          }
        }, 120);
      });
      tagsInput.addEventListener('keydown', handleAutocompleteKeydown);
      tagAutocomplete.addEventListener('mousedown', (event) => {
        event.preventDefault();
      });
      tagAutocomplete.addEventListener('click', (event) => {
        const option = event.target.closest('[data-tag-name]');
        if (!option) return;
        applyAutocompleteTag(option.getAttribute('data-tag-name'));
      });
      tagList.addEventListener('click', async (event) => {
        const button = event.target.closest('[data-tag-filter]');
        if (!button) return;
        const nextTag = button.getAttribute('data-tag-filter') || '';
        if (!nextTag || nextTag === state.tags) return;
        tagsInput.value = nextTag;
        state.tags = nextTag;
        closeTagAutocomplete();
        syncUrlState();
        renderStatus('Loading tag…', 'Switching the reel feed to ' + nextTag.replaceAll('_', ' ') + '.');
        await restartFeed();
      });

      document.addEventListener('click', (event) => {
        if (!filterPanel.contains(event.target) && !toggleFiltersButton.contains(event.target)) {
          closeSettings();
        }
        if (!filterPanel.contains(event.target)) {
          closeTagAutocomplete();
        }
      });

      document.addEventListener('keydown', (event) => {
        if (event.target === tagsInput) return;
        if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
          goToRelativePost(1);
        } else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
          goToRelativePost(-1);
        } else if (event.key.toLowerCase() === 'f') {
          state.fitMedia = !state.fitMedia;
          mediaDisplaySelect.value = state.fitMedia ? 'contain' : 'fullscreen';
          syncDisplaySettings();
          rerenderCurrentSlide();
        } else if (event.key.toLowerCase() === 't') {
          state.hideTags = !state.hideTags;
          hideTagsToggle.checked = state.hideTags;
          syncDisplaySettings();
        } else if (event.key === 'Escape') {
          closeSettings();
          closeTagAutocomplete();
        }
      });

      appRoot.addEventListener('pointerdown', handlePointerDown, { capture: true });
      appRoot.addEventListener('pointermove', handlePointerMove, { capture: true });
      appRoot.addEventListener('pointerup', handlePointerUp, { capture: true });
      appRoot.addEventListener('pointercancel', cancelPointerGesture, { capture: true });
      appRoot.addEventListener('touchstart', handleTouchStart, { passive: false, capture: true });
      appRoot.addEventListener('touchmove', handleTouchMove, { passive: false, capture: true });
      appRoot.addEventListener('touchend', handleTouchEnd, { passive: false, capture: true });
      appRoot.addEventListener('touchcancel', cancelPointerGesture, { passive: false, capture: true });
      appRoot.addEventListener('wheel', handleWheel, { passive: false });

      function closeSettings() {
        filterPanel.classList.remove('open');
        toggleFiltersButton.classList.remove('active');
      }

      function syncDisplaySettings() {
        metaBlock.classList.toggle('hidden-tags', state.hideTags);
        ratioBadge.textContent = formatRatioBadge(state.ratio);
      }

      function syncUrlState() {
        const nextUrl = new URL(window.location.href);
        nextUrl.search = '';
        if (state.mode !== 'trending') nextUrl.searchParams.set('mode', state.mode);
        if (state.tags) nextUrl.searchParams.set('tags', state.tags);
        if (state.rating) nextUrl.searchParams.set('rating', state.rating);
        if (state.ratio) nextUrl.searchParams.set('ratio', state.ratio);
        window.history.replaceState({}, '', nextUrl.toString());
      }

      function shouldIgnoreGestureTarget(target) {
        if (!target) return false;
        if (filterPanel.classList.contains('open') && filterPanel.contains(target)) return true;
        return Boolean(target.closest('button, a, input, select, option, label, textarea, [data-tag-name]'));
      }

      function beginGesture(point, source, event) {
        if (state.animationLock) return false;
        if (filterPanel.contains(event.target) || toggleFiltersButton.contains(event.target)) return false;
        if (shouldIgnoreGestureTarget(event.target)) return false;
        state.touchActive = true;
        state.gesturePointerId = point.identifier ?? event.pointerId ?? null;
        state.gestureSource = source;
        state.pointerStartY = point.clientY;
        state.pointerStartX = point.clientX;
        state.pointerDeltaY = 0;
        state.pointerDeltaX = 0;
        state.dragLocked = false;
        reelTrack.classList.remove('animating');
        return true;
      }

      function updateGesture(point) {
        if (!state.touchActive || state.animationLock) return false;
        state.pointerDeltaY = point.clientY - state.pointerStartY;
        state.pointerDeltaX = point.clientX - state.pointerStartX;
        if (!state.dragLocked) {
          if (Math.abs(state.pointerDeltaY) < DRAG_LOCK_THRESHOLD) return false;
          if (Math.abs(state.pointerDeltaX) > Math.abs(state.pointerDeltaY)) {
            cancelPointerGesture();
            return false;
          }
          state.dragLocked = true;
        }
        updateTrackForDrag(state.pointerDeltaY);
        return true;
      }

      function endGesture() {
        if (!state.touchActive) return;
        finalizeSwipe(state.pointerDeltaY, state.dragLocked);
      }

      function handlePointerDown(event) {
        if (event.pointerType === 'mouse' && event.button !== 0) return;
        if (!beginGesture(event, 'pointer', event)) return;
        if (typeof appRoot.setPointerCapture === 'function') {
          try {
            appRoot.setPointerCapture(event.pointerId);
          } catch (error) {
            console.warn('Pointer capture failed', error);
          }
        }
      }

      function handlePointerMove(event) {
        if (!state.touchActive || state.gestureSource !== 'pointer') return;
        if (state.gesturePointerId !== null && event.pointerId !== state.gesturePointerId) return;
        if (updateGesture(event)) {
          event.preventDefault();
        }
      }

      function handlePointerUp(event) {
        if (!state.touchActive || state.gestureSource !== 'pointer') return;
        if (state.gesturePointerId !== null && event.pointerId !== state.gesturePointerId) return;
        if (typeof appRoot.releasePointerCapture === 'function') {
          try {
            appRoot.releasePointerCapture(event.pointerId);
          } catch (error) {
            console.warn('Pointer release failed', error);
          }
        }
        endGesture();
      }

      function handleTouchStart(event) {
        if (!event.changedTouches.length) return;
        beginGesture(event.changedTouches[0], 'touch', event);
      }

      function handleTouchMove(event) {
        if (!state.touchActive || state.gestureSource !== 'touch') return;
        const touch = findActiveTouch(event.changedTouches);
        if (!touch) return;
        if (updateGesture(touch)) {
          event.preventDefault();
        }
      }

      function handleTouchEnd(event) {
        if (!state.touchActive || state.gestureSource !== 'touch') return;
        const touch = findActiveTouch(event.changedTouches);
        if (!touch) return;
        event.preventDefault();
        endGesture();
      }

      function findActiveTouch(touchList) {
        for (const touch of touchList) {
          if (state.gesturePointerId === null || touch.identifier === state.gesturePointerId) {
            return touch;
          }
        }
        return null;
      }

      function cancelPointerGesture() {
        if (!state.touchActive) return;
        finalizeSwipe(0, false);
      }

      function handleWheel(event) {
        if (filterPanel.classList.contains('open') || state.animationLock) return;
        if (Math.abs(event.deltaY) < WHEEL_THRESHOLD) return;
        event.preventDefault();
        goToRelativePost(event.deltaY > 0 ? 1 : -1);
      }

      function updateTrackForDrag(deltaY) {
        refreshTrackSlides();
        reelTrack.style.transform = 'translate3d(0, ' + deltaY + 'px, 0)';
        ensureAdjacentSlides();
      }

      function finalizeSwipe(deltaY, hasDragged = true) {
        const wasDragging = hasDragged && Math.abs(deltaY) >= DRAG_LOCK_THRESHOLD;
        state.touchActive = false;
        state.dragLocked = false;
        state.gesturePointerId = null;
        state.gestureSource = null;
        const direction = wasDragging && deltaY <= -SWIPE_THRESHOLD ? 1 : wasDragging && deltaY >= SWIPE_THRESHOLD ? -1 : 0;
        if (wasDragging) {
          state.suppressClickUntil = Date.now() + 400;
        }
        if (direction === 0) {
          animateTrackTo(0);
          return;
        }
        goToRelativePost(direction, { animated: true });
      }

      function scheduleTagAutocomplete(runImmediately = false) {
        if (state.tagAutocomplete.debounceTimer) {
          clearTimeout(state.tagAutocomplete.debounceTimer);
          state.tagAutocomplete.debounceTimer = null;
        }
        if (runImmediately) {
          updateTagAutocomplete();
          return;
        }
        state.tagAutocomplete.debounceTimer = setTimeout(updateTagAutocomplete, AUTOCOMPLETE_DEBOUNCE_MS);
      }

      async function updateTagAutocomplete() {
        const token = getActiveTagToken(tagsInput.value);
        state.tagAutocomplete.query = token;
        if (!token) {
          closeTagAutocomplete();
          return;
        }
        const requestId = ++state.tagAutocomplete.requestId;
        try {
          const items = await fetchTagAutocomplete(token);
          if (requestId !== state.tagAutocomplete.requestId) return;
          state.tagAutocomplete.items = items;
          state.tagAutocomplete.activeIndex = items.length ? 0 : -1;
          renderTagAutocomplete();
        } catch (error) {
          console.warn('Tag autocomplete failed', error);
          if (requestId !== state.tagAutocomplete.requestId) return;
          state.tagAutocomplete.items = [];
          state.tagAutocomplete.activeIndex = -1;
          renderTagAutocomplete('Could not load tag suggestions right now.');
        }
      }

      async function fetchTagAutocomplete(query) {
        const workerUrl = '/api/tags/autocomplete?q=' + encodeURIComponent(query);
        try {
          const workerResponse = await fetch(workerUrl);
          const workerPayload = await parseJsonSafely(workerResponse);
          if (workerResponse.ok && workerPayload && Array.isArray(workerPayload.tags)) {
            return workerPayload.tags;
          }
        } catch (error) {
          console.warn('Worker tag autocomplete failed', error);
        }

        const upstreamUrl = new URL(CLIENT_E621_TAG_AUTOCOMPLETE_API);
        upstreamUrl.searchParams.set('search[name_matches]', query + '*');
        const response = await fetch(upstreamUrl.toString(), {
          headers: { Accept: 'application/json' },
        });
        const payload = await parseJsonSafely(response);
        if (!response.ok) {
          throw createFetchError('Direct tag autocomplete failed', {
            url: upstreamUrl.toString(),
            status: response.status,
            payload,
          });
        }
        return Array.isArray(payload)
          ? payload
              .filter((tag) => tag && typeof tag.name === 'string')
              .slice(0, TAG_AUTOCOMPLETE_LIMIT)
              .map((tag) => ({
                id: tag.id || null,
                name: tag.name,
                category: Number.isFinite(tag.category) ? tag.category : null,
                postCount: Number.isFinite(tag.post_count) ? tag.post_count : 0,
                antecedentName: tag.antecedent_name || null,
              }))
          : [];
      }

      function handleAutocompleteKeydown(event) {
        if (!state.tagAutocomplete.open && event.key !== 'Tab') return;
        if (event.key === 'ArrowDown') {
          event.preventDefault();
          moveAutocompleteSelection(1);
        } else if (event.key === 'ArrowUp') {
          event.preventDefault();
          moveAutocompleteSelection(-1);
        } else if (event.key === 'Enter' || event.key === 'Tab') {
          if (state.tagAutocomplete.open && state.tagAutocomplete.activeIndex >= 0) {
            event.preventDefault();
            const active = state.tagAutocomplete.items[state.tagAutocomplete.activeIndex];
            if (active) applyAutocompleteTag(active.name);
          }
        } else if (event.key === 'Escape') {
          closeTagAutocomplete();
        }
      }

      function moveAutocompleteSelection(direction) {
        if (!state.tagAutocomplete.items.length) return;
        const count = state.tagAutocomplete.items.length;
        state.tagAutocomplete.activeIndex = (state.tagAutocomplete.activeIndex + direction + count) % count;
        renderTagAutocomplete();
      }

      function renderTagAutocomplete(emptyMessage) {
        tagAutocompleteList.innerHTML = '';
        const hasItems = state.tagAutocomplete.items.length > 0;
        if (!hasItems) {
          if (!emptyMessage) {
            closeTagAutocomplete();
            return;
          }
          const empty = document.createElement('div');
          empty.className = 'autocomplete-empty';
          empty.textContent = emptyMessage;
          tagAutocompleteList.appendChild(empty);
        } else {
          state.tagAutocomplete.items.forEach((item, index) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'autocomplete-option' + (index === state.tagAutocomplete.activeIndex ? ' active' : '');
            button.setAttribute('data-tag-name', item.name);
            button.setAttribute('role', 'option');
            button.setAttribute('aria-selected', index === state.tagAutocomplete.activeIndex ? 'true' : 'false');

            const category = document.createElement('span');
            category.className = 'autocomplete-category';
            if (item.category !== null && item.category !== undefined) {
              category.setAttribute('data-category', String(item.category));
            }

            const tag = document.createElement('span');
            tag.className = 'autocomplete-tag';
            const name = document.createElement('div');
            name.className = 'autocomplete-name';
            name.textContent = item.name.replaceAll('_', ' ');
            const meta = document.createElement('div');
            meta.className = 'autocomplete-meta';
            meta.textContent = item.antecedentName ? 'Alias of ' + item.antecedentName.replaceAll('_', ' ') : categoryLabel(item.category);
            tag.appendChild(name);
            tag.appendChild(meta);

            const count = document.createElement('span');
            count.className = 'autocomplete-count';
            count.textContent = formatPostCount(item.postCount);

            button.appendChild(category);
            button.appendChild(tag);
            button.appendChild(count);
            tagAutocompleteList.appendChild(button);
          });
        }
        state.tagAutocomplete.open = true;
        tagAutocomplete.hidden = false;
        tagsInput.setAttribute('aria-expanded', 'true');
      }

      function closeTagAutocomplete() {
        state.tagAutocomplete.items = [];
        state.tagAutocomplete.activeIndex = -1;
        state.tagAutocomplete.open = false;
        tagAutocomplete.hidden = true;
        tagsInput.setAttribute('aria-expanded', 'false');
        tagAutocompleteList.innerHTML = '';
      }

      function applyAutocompleteTag(tagName) {
        tagsInput.value = replaceActiveTagToken(tagsInput.value, tagName);
        tagsInput.focus();
        closeTagAutocomplete();
      }

      function getActiveTagToken(value) {
        const normalized = String(value || '');
        const endsWithSpace = /\s$/.test(normalized);
        if (endsWithSpace) return '';
        const parts = normalized.split(/\s+/);
        return sanitizeAutocompleteQuery(parts[parts.length - 1] || '');
      }

      function replaceActiveTagToken(value, tagName) {
        const normalized = String(value || '');
        const parts = normalized.split(/\s+/).filter((part, index, array) => part || index < array.length - 1);
        if (!parts.length || /\s$/.test(normalized)) {
          return (normalized.trim() ? normalized.trim() + ' ' : '') + tagName + ' ';
        }
        parts[parts.length - 1] = tagName;
        return parts.join(' ') + ' ';
      }

      function categoryLabel(category) {
        const labels = {
          0: 'General',
          1: 'Artist',
          3: 'Copyright',
          4: 'Character',
          5: 'Species',
          6: 'Invalid',
        };
        return labels[category] || 'Tag';
      }

      function formatPostCount(count) {
        return Number(count || 0).toLocaleString();
      }

      async function restartFeed() {
        clearTimers();
        state.posts = [];
        state.currentIndex = 0;
        state.nextPage = 1;
        state.currentMedia = null;
        state.currentSlide = null;
        state.preloaded.clear();
        reelTrack.innerHTML = '';
        reelTrack.style.transform = 'translate3d(0, 0, 0)';
        renderStatus('Loading feed…', 'Pulling fresh posts from e621.');
        await loadPosts(true);
      }

      async function loadPosts(replace = false) {
        if (state.loading) return;
        state.loading = true;
        try {
          const params = new URLSearchParams({
            mode: state.mode,
            page: String(state.nextPage),
          });
          if (state.tags) params.set('tags', state.tags);
          if (state.rating) params.set('rating', state.rating);
          if (state.ratio) params.set('ratio', state.ratio);

          console.info('[feed] requesting posts', {
            sourcePreference: 'worker-first',
            page: state.nextPage,
            mode: state.mode,
            tags: state.tags,
            rating: state.rating || null,
            ratio: state.ratio || null,
          });

          const { data, source } = await fetchPostsWithFallback(params);
          const incoming = Array.isArray(data.posts) ? data.posts : [];
          state.lastFeedSource = source;

          console.info('[feed] received posts', {
            source,
            page: state.nextPage,
            count: incoming.length,
          });

          if (replace) {
            state.posts = incoming;
            state.currentIndex = 0;
          } else {
            state.posts.push(...incoming);
          }
          state.nextPage += 1;

          if (!state.posts.length) {
            renderEmpty('No posts found', 'Try different tags or remove the rating filter.');
            return;
          }

          if (replace || !state.currentSlide) {
            await showPost(state.currentIndex, { immediate: true });
          } else {
            schedulePreloadAroundIndex(state.currentIndex);
          }
        } catch (error) {
          console.error('[feed] request failed', error);
          renderEmpty('Could not load posts', 'The feed request failed. Please try again in a moment. Open the console for worker and fallback details.');
        } finally {
          state.loading = false;
        }
      }

      async function fetchPostsWithFallback(params) {
        const workerUrl = '/api/posts?' + params.toString();
        let workerError = null;

        try {
          const workerResponse = await fetch(workerUrl);
          const workerPayload = await parseJsonSafely(workerResponse);

          if (!workerResponse.ok) {
            workerError = createFetchError('Worker feed request failed', {
              url: workerUrl,
              status: workerResponse.status,
              payload: workerPayload,
            });
            console.warn('[feed] worker request failed', workerError.context);
          } else {
            return { data: workerPayload || {}, source: 'worker' };
          }
        } catch (error) {
          workerError = createFetchError('Worker feed request threw', {
            url: workerUrl,
            cause: error instanceof Error ? error.message : String(error),
          });
          console.warn('[feed] worker request threw', workerError.context);
        }

        const directData = await fetchPostsDirectly(params, workerError);
        return { data: directData, source: 'client-direct' };
      }

      async function fetchPostsDirectly(params, workerError) {
        const upstreamUrl = new URL(CLIENT_E621_API);
        upstreamUrl.searchParams.set('limit', '24');
        upstreamUrl.searchParams.set('page', params.get('page'));
        upstreamUrl.searchParams.set('tags', buildApiTags(params));

        console.warn('[feed] falling back to direct browser request', {
          upstreamUrl: upstreamUrl.toString(),
          workerError: workerError ? workerError.context : null,
        });

        const upstreamResponse = await fetch(upstreamUrl.toString(), {
          headers: { Accept: 'application/json' },
        });
        const upstreamPayload = await parseJsonSafely(upstreamResponse);

        if (!upstreamResponse.ok) {
          const directError = createFetchError('Direct e621 request failed', {
            url: upstreamUrl.toString(),
            status: upstreamResponse.status,
            payload: upstreamPayload,
            workerError: workerError ? workerError.context : null,
          });
          console.error('[feed] direct request failed', directError.context);
          throw directError;
        }

        const posts = Array.isArray(upstreamPayload && upstreamPayload.posts)
          ? upstreamPayload.posts
              .filter((post) => post && post.file && post.file.url && CLIENT_SUPPORTED_MEDIA.has(String(post.file.ext || '').toLowerCase()))
              .map((post) => mapApiPost(post))
          : [];

        return {
          mode: params.get('mode') === 'score' ? 'score' : 'trending',
          page: Number(params.get('page') || '1'),
          tags: sanitizeClientTags(params.get('tags') || ''),
          rating: sanitizeClientRating(params.get('rating')),
          ratio: sanitizeRatioFilter(params.get('ratio')),
          posts,
          source: 'client-direct',
        };
      }

      function buildApiTags(params) {
        const tags = [
          params.get('mode') === 'score' ? 'order:score' : 'order:rank',
          'animated',
          ...sanitizeClientTags(params.get('tags') || ''),
        ];
        const rating = sanitizeClientRating(params.get('rating'));
        const ratio = sanitizeRatioFilter(params.get('ratio'));
        if (rating) tags.push('rating:' + rating);
        if (ratio) tags.push(ratio === 'vertical' ? 'ratio:<1' : 'ratio:>1');
        return tags.join(' ');
      }

      function sanitizeClientTags(raw) {
        return String(raw || '')
          .split(/\s+/)
          .map((tag) => tag.trim())
          .filter(Boolean)
          .slice(0, 12);
      }

      function sanitizeClientRating(value) {
        return ['s', 'q', 'e'].includes(value) ? value : '';
      }

      function sanitizeRatioFilter(value) {
        return ['vertical', 'landscape'].includes(value) ? value : '';
      }

      function sanitizeAutocompleteQuery(value) {
        return String(value || '')
          .trim()
          .toLowerCase()
          .replace(/\s+/g, '_')
          .replace(/[^a-z0-9_:()'-]/g, '')
          .slice(0, 64);
      }

      function mapApiPost(post) {
        const ext = String((post.file && post.file.ext) || '').toLowerCase();
        const artist = Array.isArray(post.tags && post.tags.artist) ? post.tags.artist.filter(Boolean) : [];
        const species = Array.isArray(post.tags && post.tags.species) ? post.tags.species.filter(Boolean) : [];
        const general = Array.isArray(post.tags && post.tags.general) ? post.tags.general.filter(Boolean).slice(0, 12) : [];

        return {
          id: post.id,
          ext,
          type: ['webm', 'mp4'].includes(ext) ? 'video' : 'image',
          score: (post.score && post.score.total) || 0,
          rating: post.rating || 'u',
          width: (post.file && post.file.width) || (post.sample && post.sample.width) || 0,
          height: (post.file && post.file.height) || (post.sample && post.sample.height) || 0,
          createdAt: post.created_at,
          mediaUrl: post.file.url,
          previewUrl: (post.preview && post.preview.url) || (post.sample && post.sample.url) || post.file.url,
          sourceUrl: 'https://e621.net/posts/' + post.id,
          description: [
            artist.length ? 'Artist: ' + artist.join(', ') : 'Artist unknown',
            species.length ? 'Species: ' + species.slice(0, 3).join(', ') : null,
          ].filter(Boolean).join(' • '),
          tags: artist.map((tag) => 'artist:' + tag).concat(general),
        };
      }

      async function parseJsonSafely(response) {
        const text = await response.text();
        if (!text) return null;
        try {
          return JSON.parse(text);
        } catch (error) {
          return { rawText: text };
        }
      }

      function createFetchError(message, context) {
        const error = new Error(message);
        error.context = context;
        return error;
      }

      function renderStatus(title, body) {
        statusCard.hidden = false;
        statusTitle.textContent = title;
        statusText.textContent = body;
      }

      function renderEmpty(title, body) {
        reelTrack.innerHTML = '';
        clearTimers();
        renderStatus(title, body);
        postTitle.textContent = title;
        postDescription.textContent = body;
        tagList.innerHTML = '';
        counterBadge.textContent = '0 / 0';
        progressBar.style.width = '0%';
      }

      function setProgressValue(value) {
        progressBar.style.width = Math.max(0, Math.min(100, value)) + '%';
      }

      function clearTimers(resetProgress = true) {
        if (state.timer) {
          clearTimeout(state.timer);
          state.timer = null;
        }
        if (state.progressTimer) {
          clearInterval(state.progressTimer);
          state.progressTimer = null;
        }
        if (resetProgress) {
          setProgressValue(0);
        }
      }

      function scheduleImageAdvance() {
        clearTimers();
        const startedAt = Date.now();
        state.timer = setTimeout(() => goToRelativePost(1), IMAGE_COUNTDOWN_MS);
        state.progressTimer = setInterval(() => {
          const elapsed = Date.now() - startedAt;
          setProgressValue((elapsed / IMAGE_COUNTDOWN_MS) * 100);
          if (elapsed >= IMAGE_COUNTDOWN_MS) {
            clearTimers(false);
          }
        }, 100);
      }

      function watchVideoProgress(video) {
        clearTimers();
        const update = () => {
          setProgressValue(getVideoPlaybackProgress(video) * 100);
        };
        update();
        state.progressTimer = setInterval(update, 120);
      }

      async function goToRelativePost(offset, options = {}) {
        if (!state.posts.length || state.animationLock) return;
        const nextIndex = state.currentIndex + offset;
        if (nextIndex < 0) {
          animateTrackTo(0);
          return;
        }

        if (nextIndex >= state.posts.length) {
          if (!state.loading) {
            await loadPosts(false);
          }
          if (nextIndex >= state.posts.length) {
            animateTrackTo(0);
            return;
          }
        }

        await showPost(nextIndex, { immediate: options.immediate === true, direction: Math.sign(offset) || 1 });
      }

      function rerenderCurrentSlide() {
        if (!state.posts.length) return;
        const currentEntry = state.preloaded.get(state.currentIndex);
        if (currentEntry) {
          currentEntry.media.classList.toggle('fit', state.fitMedia);
        }
        if (state.currentSlide) {
          const media = state.currentSlide.querySelector('.reel-media');
          if (media) {
            media.classList.toggle('fit', state.fitMedia);
          }
        }
      }

      async function showPost(index, options = {}) {
        const post = state.posts[index];
        if (!post) return;

        const navigationToken = ++state.navigationToken;
        statusCard.hidden = true;
        const previousIndex = state.currentIndex;
        const direction = index > previousIndex ? 1 : index < previousIndex ? -1 : 0;
        const movement = options.immediate || direction === 0 ? 0 : direction;

        if (!state.currentSlide || options.immediate) {
          const entry = await ensureSlide(index);
          if (navigationToken !== state.navigationToken) return;
          state.currentIndex = index;
          setCurrentSlide(entry.slide, entry.media);
          refreshTrackSlides();
          updateMeta(post);
          startPlaybackForPost(post, entry.media, entry.slide);
          ensureAdjacentSlides();
          schedulePreloadAroundIndex(index);
          if (state.posts.length - index <= 4) {
            loadPosts(false);
          }
          animateTrackTo(0, false);
          return;
        }

        state.animationLock = true;
        clearTimers(direction === 0);

        try {
          const currentMedia = state.currentMedia;
          const targetEntry = await ensureSlide(index);
          if (navigationToken !== state.navigationToken) return;

          if (currentMedia && currentMedia.tagName === 'VIDEO') {
            currentMedia.pause();
          }

          refreshTrackSlides();
          ensureAdjacentSlides();
          schedulePreloadAroundIndex(index);

          const trackTarget = movement > 0 ? -viewport.clientHeight : viewport.clientHeight;
          await animateTrackTo(trackTarget, true);
          if (navigationToken !== state.navigationToken) return;
          reelTrack.classList.remove('animating');
          reelTrack.style.transform = 'translate3d(0, 0, 0)';

          state.currentIndex = index;
          setCurrentSlide(targetEntry.slide, targetEntry.media);
          refreshTrackSlides();
          updateMeta(post);
          ensureAdjacentSlides();
          startPlaybackForPost(post, targetEntry.media, targetEntry.slide);

          if (state.posts.length - index <= 4) {
            loadPosts(false);
          }
        } finally {
          if (navigationToken === state.navigationToken) {
            state.animationLock = false;
          }
        }
      }

      function positionSlide(slide, offsetPercent) {
        slide.style.transform = 'translate3d(0, ' + offsetPercent + '%, 0)';
      }

      function setCurrentSlide(slide, media) {
        state.currentSlide = slide;
        state.currentMedia = media;
      }

      async function ensureSlide(index) {
        if (state.preloaded.has(index)) {
          return state.preloaded.get(index);
        }
        const entry = await createSlide(state.posts[index]);
        state.preloaded.set(index, entry);
        prunePreloaded(index);
        return entry;
      }

      function refreshTrackSlides() {
        reelTrack.innerHTML = '';
        if (!state.posts.length) return;

        const indexes = [state.currentIndex - 1, state.currentIndex, state.currentIndex + 1].filter((index) => index >= 0 && index < state.posts.length);
        indexes.forEach((index) => {
          const entry = state.preloaded.get(index);
          if (!entry) return;
          positionSlide(entry.slide, (index - state.currentIndex) * 100);
          reelTrack.appendChild(entry.slide);
        });
      }

      function prunePreloaded(centerIndex) {
        const allowed = new Set();
        for (let offset = -PRELOAD_DISTANCE; offset <= PRELOAD_DISTANCE; offset += 1) {
          allowed.add(centerIndex + offset);
        }
        Array.from(state.preloaded.keys()).forEach((key) => {
          if (key === state.currentIndex || allowed.has(key)) return;
          const entry = state.preloaded.get(key);
          if (entry && entry.media && entry.media.tagName === 'VIDEO') {
            entry.media.pause();
            entry.media.removeAttribute('src');
            entry.media.load();
          }
          state.preloaded.delete(key);
        });
      }

      async function createSlide(post) {
        const slide = document.createElement('article');
        slide.className = 'reel-slide loading';
        slide.style.setProperty('--preview-image', post.previewUrl ? 'url("' + post.previewUrl.replace(/"/g, '\\"') + '")' : 'none');

        const fallback = document.createElement('div');
        fallback.className = 'reel-media-fallback';
        fallback.style.backgroundImage = post.previewUrl ? 'url("' + post.previewUrl.replace(/"/g, '\\"') + '")' : 'none';
        slide.appendChild(fallback);

        let media;
        if (post.type === 'video') {
          media = document.createElement('video');
          media.src = post.mediaUrl;
          media.poster = post.previewUrl;
          media.preload = 'metadata';
          media.playsInline = true;
          media.loop = false;
          media.muted = state.muted;
          media.controls = false;
          media.autoplay = false;
          media.className = 'reel-media' + (state.fitMedia ? ' fit' : '');
          media.addEventListener('loadeddata', () => slide.classList.remove('loading'), { once: true });
          media.addEventListener('loadedmetadata', () => initializeVideoPlayback(media));
          media.addEventListener('ended', () => {
            handleVideoEnded(media);
          });
          media.addEventListener('play', () => {
            markVideoPlaybackStarted(media);
            if (state.currentMedia === media) watchVideoProgress(media);
            slide.classList.remove('awaiting-play');
          });
          media.addEventListener('pause', () => {
            finalizeVideoPlaybackChunk(media);
            if (state.currentMedia === media && !media.ended) {
              clearTimers(false);
            }
          });
          media.addEventListener('waiting', () => slide.classList.add('awaiting-play'));
          media.addEventListener('playing', () => slide.classList.remove('awaiting-play'));
        } else {
          media = document.createElement('img');
          media.src = post.mediaUrl;
          media.alt = post.description || 'e621 media post';
          media.loading = 'eager';
          media.decoding = 'async';
          media.className = 'reel-media' + (state.fitMedia ? ' fit' : '');
          media.addEventListener('load', () => slide.classList.remove('loading'), { once: true });
        }

        media.addEventListener('click', (event) => {
          if (Date.now() < state.suppressClickUntil) {
            event.preventDefault();
            return;
          }
          if (state.touchActive) return;
          if (Math.abs(state.pointerDeltaY) > TAP_DISTANCE_THRESHOLD) return;
          if (media.tagName === 'VIDEO') {
            if (media.paused) {
              media.play().catch(() => {});
            } else {
              media.pause();
            }
          } else {
            goToRelativePost(1, { animated: true });
          }
        });

        slide.appendChild(media);
        return { slide, media, post };
      }

      function startPlaybackForPost(post, media, slide) {
        if (post.type === 'video') {
          resetVideoPlayback(media);
          media.currentTime = 0;
          media.muted = state.muted;
          slide.classList.add('awaiting-play');
          media.play().then(() => {
            watchVideoProgress(media);
          }).catch(() => {
            slide.classList.add('awaiting-play');
            clearTimers();
          });
        } else {
          slide.classList.remove('loading');
          scheduleImageAdvance();
        }
      }

      function updateMeta(post) {
        postTitle.textContent = '#' + post.id;
        postDescription.textContent = post.description + ' • Rating: ' + post.rating.toUpperCase() + ' • Score: ' + post.score;
        sortBadge.textContent = (state.mode === 'score' ? 'Top score' : 'Trending') + (state.lastFeedSource === 'client-direct' ? ' • Direct' : '');
        counterBadge.textContent = (state.currentIndex + 1) + ' / ' + state.posts.length;
        openPostLink.href = post.sourceUrl;
        tagList.innerHTML = '';

        const tags = post.tags.length ? post.tags : ['No tags'];
        tags.slice(0, 8).forEach((tag) => {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'pill pill-button' + (tag === state.tags ? ' active' : '');
          button.textContent = tag.replaceAll('_', ' ');
          button.setAttribute('data-tag-filter', tag);
          button.setAttribute('aria-label', 'Filter feed by ' + tag.replaceAll('_', ' '));
          tagList.appendChild(button);
        });
      }

      function ensureAdjacentSlides() {
        if (!state.posts.length) return;
        const beforeIndex = state.currentIndex - 1;
        const afterIndex = state.currentIndex + 1;
        Promise.resolve().then(async () => {
          if (beforeIndex >= 0) await ensureSlide(beforeIndex);
          if (afterIndex < state.posts.length) await ensureSlide(afterIndex);
          refreshTrackSlides();
        }).catch((error) => console.warn('Adjacent preload failed', error));
      }

      function schedulePreloadAroundIndex(index) {
        for (let offset = 1; offset <= PRELOAD_DISTANCE; offset += 1) {
          const nextIndex = index + offset;
          const previousIndex = index - offset;
          if (nextIndex < state.posts.length) {
            ensureSlide(nextIndex).catch((error) => console.warn('Preload failed', error));
          }
          if (previousIndex >= 0) {
            ensureSlide(previousIndex).catch((error) => console.warn('Preload failed', error));
          }
        }
      }

      function animateTrackTo(targetY, withTransition = true) {
        if (withTransition) {
          reelTrack.classList.add('animating');
          reelTrack.style.transform = 'translate3d(0, ' + targetY + 'px, 0)';
          return new Promise((resolve) => {
            let settled = false;
            const cleanup = () => {
              if (settled) return;
              settled = true;
              clearTimeout(fallbackTimer);
              reelTrack.removeEventListener('transitionend', done);
              resolve();
            };
            const done = (event) => {
              if (event && event.target !== reelTrack) return;
              cleanup();
            };
            const fallbackTimer = setTimeout(cleanup, TRACK_TRANSITION_FALLBACK_MS);
            reelTrack.addEventListener('transitionend', done, { once: true });
          });
        }
        reelTrack.classList.remove('animating');
        reelTrack.style.transform = 'translate3d(0, ' + targetY + 'px, 0)';
        return Promise.resolve();
      }

      function initializeVideoPlayback(video) {
        const existing = state.videoPlayback.get(video) || {};
        state.videoPlayback.set(video, {
          totalMs: existing.totalMs || 0,
          startedAt: existing.startedAt ?? null,
          targetMs: Math.max((Number.isFinite(video.duration) ? video.duration : 0) * 1000, existing.targetMs || 0, MIN_VIDEO_PLAYBACK_MS),
        });
      }

      function resetVideoPlayback(video) {
        initializeVideoPlayback(video);
        const playback = state.videoPlayback.get(video);
        if (!playback) return;
        playback.totalMs = 0;
        playback.startedAt = null;
      }

      function markVideoPlaybackStarted(video) {
        initializeVideoPlayback(video);
        const playback = state.videoPlayback.get(video);
        if (playback && playback.startedAt === null) {
          playback.startedAt = Date.now();
        }
      }

      function finalizeVideoPlaybackChunk(video) {
        const playback = state.videoPlayback.get(video);
        if (!playback || playback.startedAt === null) return;
        playback.totalMs += Math.max(0, Date.now() - playback.startedAt);
        playback.startedAt = null;
      }

      function getVideoPlaybackProgress(video) {
        initializeVideoPlayback(video);
        const playback = state.videoPlayback.get(video);
        if (!playback) return 0;
        const activeMs = playback.startedAt === null ? 0 : Math.max(0, Date.now() - playback.startedAt);
        return Math.max(0, Math.min(1, (playback.totalMs + activeMs) / playback.targetMs));
      }

      function handleVideoEnded(video) {
        finalizeVideoPlaybackChunk(video);
        const playback = state.videoPlayback.get(video);
        if (!playback) return;
        if (playback.totalMs + 50 < playback.targetMs) {
          video.currentTime = 0;
          video.play().catch(() => {
            if (state.currentMedia === video) {
              clearTimers(false);
            }
          });
          return;
        }
        if (state.currentMedia === video) {
          goToRelativePost(1, { animated: true });
        }
      }

      function formatRatioBadge(ratio) {
        if (ratio === 'vertical') return 'Vertical only';
        if (ratio === 'landscape') return 'Landscape only';
        return 'Any aspect';
      }

      function handleViewportResize() {
        const height = window.visualViewport ? window.visualViewport.height : window.innerHeight;
        document.documentElement.style.setProperty('--app-height', height + 'px');
        if (state.currentSlide) {
          animateTrackTo(0, false);
          refreshTrackSlides();
        }
      }

      window.addEventListener('resize', handleViewportResize);
      window.addEventListener('orientationchange', handleViewportResize);
      if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', handleViewportResize);
      }

      handleViewportResize();
      syncDisplaySettings();
      restartFeed();
    </script>
  </body>
</html>`;
}


function buildSeo(url) {
  const mode = url.searchParams.get('mode') === 'score' ? 'score' : 'trending';
  const tags = sanitizeTags(url.searchParams.get('tags') || '');
  const rating = sanitizeRating(url.searchParams.get('rating'));
  const ratio = sanitizeRatioFilter(url.searchParams.get('ratio'));
  const canonical = new URL(url.toString());
  canonical.protocol = 'https:';
  canonical.host = 'furryreel.com';
  canonical.port = '';
  canonical.pathname = '/';
  canonical.search = '';
  canonical.hash = '';
  if (mode !== 'trending') canonical.searchParams.set('mode', mode);
  if (tags.length) canonical.searchParams.set('tags', tags.join(' '));
  if (rating) canonical.searchParams.set('rating', rating);
  if (ratio) canonical.searchParams.set('ratio', ratio);

  const humanTags = tags.map(formatTagLabel);
  const modeLabel = mode === 'score' ? 'top scored' : 'trending';
  const ratingLabel = rating ? `Rated ${rating.toUpperCase()}` : 'All ratings';
  const ratioLabel = ratio === 'vertical' ? 'portrait / vertical only' : ratio === 'landscape' ? 'landscape only' : 'any aspect ratio';
  const titleParts = [];
  if (humanTags.length) titleParts.push(humanTags.join(', '));
  titleParts.push(mode === 'score' ? 'Top scored furry reels' : 'Trending furry reels');
  const title = titleParts.join(' • ') + ' | FurryReel';
  const description = humanTags.length
    ? `Browse ${modeLabel} animated furry reels for ${humanTags.join(', ')} on FurryReel. Swipe through indexed video posts, GIFs, and image previews with ${ratingLabel.toLowerCase()} and ${ratioLabel}.`
    : `Browse ${modeLabel} animated furry reels on FurryReel. Explore indexable e621-powered video posts, GIFs, and image previews built for fast swiping on furryreel.com with ${ratioLabel}.`;
  const heading = humanTags.length
    ? `${humanTags.join(', ')} furry reels`
    : 'FurryReel animated furry feed';
  const indexingText = `FurryReel serves a crawlable landing page, canonical URLs, sitemap.xml, robots.txt, and structured metadata so search engines can index this app experience.`;

  return {
    title,
    description,
    heading,
    indexingText,
    canonicalUrl: canonical.toString(),
    initialModeForClient: mode,
    initialTagsForClient: tags.join(' '),
    initialRatingForClient: rating,
    initialRatioForClient: ratio,
    structuredData: {
      '@context': 'https://schema.org',
      '@type': 'CollectionPage',
      name: title,
      description,
      url: canonical.toString(),
      isPartOf: {
        '@type': 'WebSite',
        name: 'FurryReel',
        url: 'https://furryreel.com/',
      },
      potentialAction: {
        '@type': 'SearchAction',
        target: 'https://furryreel.com/?tags={search_term_string}',
        'query-input': 'required name=search_term_string',
      },
      about: tags.length ? humanTags : ['animated', 'furry'],
      genre: ['animation', 'short-form video'],
    },
  };
}

function buildLandingLinks() {
  const links = [
    { href: '/', label: 'Trending animated furry reels' },
    { href: '/?mode=score', label: 'Top scored furry reels' },
    { href: '/?tags=wolf', label: 'Wolf furry reels' },
    { href: '/?tags=fox', label: 'Fox furry reels' },
    { href: '/?tags=dragon', label: 'Dragon furry reels' },
    { href: '/?tags=canine', label: 'Canine furry reels' },
  ];

  return links
    .map((link) => `<li><a href="${escapeHtml(link.href)}">${escapeHtml(link.label)}</a></li>`)
    .join('');
}

function renderRobotsTxt() {
  return ['User-agent: *', 'Allow: /', 'Sitemap: https://furryreel.com/sitemap.xml'].join('\n');
}

function renderSitemapXml() {
  const urls = [
    'https://furryreel.com/',
    'https://furryreel.com/?mode=score',
    'https://furryreel.com/?tags=wolf',
    'https://furryreel.com/?tags=fox',
    'https://furryreel.com/?tags=dragon',
    'https://furryreel.com/?tags=canine',
  ];

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls
    .map((entry) => `  <url><loc>${escapeHtml(entry)}</loc></url>`)
    .join('\n')}
</urlset>`;
}

function formatTagLabel(tag) {
  return String(tag || '').replaceAll('_', ' ');
}

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function serializeJsonLd(value) {
  return JSON.stringify(value).replaceAll('</script', '<\\/script');
}

function normalizePage(value) {
  const page = Number.parseInt(value || '1', 10);
  if (Number.isNaN(page) || page < 1) return 1;
  return Math.min(page, 750);
}

function sanitizeTags(raw) {
  return String(raw || '')
    .split(/\s+/)
    .map((tag) => tag.trim())
    .filter(Boolean)
    .slice(0, 12);
}

function sanitizeRating(raw) {
  return ['s', 'q', 'e'].includes(raw) ? raw : '';
}

function sanitizeRatioFilter(raw) {
  return ['vertical', 'landscape'].includes(raw) ? raw : '';
}

function sanitizeAutocompleteQuery(raw) {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_:()'-]/g, '')
    .slice(0, 64);
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=UTF-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
    },
  });
}
