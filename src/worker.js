const E621_API = 'https://e621.net/posts.json';
const USER_AGENT = 'e621reels/0.1.0 (Cloudflare Worker demo; contact: admin@example.com)';
const PAGE_SIZE = 24;
const BASE_TAGS = ['animated'];
const SUPPORTED_MEDIA = new Set(['webm', 'mp4', 'gif']);
const UPSTREAM_ERROR_PREVIEW_LIMIT = 400;

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/api/posts') {
      return handlePosts(request, url);
    }

    if (url.pathname === '/' || url.pathname === '/index.html') {
      return new Response(renderApp(), {
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
  const apiTags = [
    mode === 'score' ? 'order:score' : 'order:rank',
    ...BASE_TAGS,
    ...rawTags,
    ...(requestedRating ? [`rating:${requestedRating}`] : []),
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

function trimForLog(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, UPSTREAM_ERROR_PREVIEW_LIMIT);
}

function mapPost(post) {
  const ext = String(post.file.ext || '').toLowerCase();
  const width = post.sample?.width || post.file?.width || 0;
  const height = post.sample?.height || post.file?.height || 0;
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
    sourceUrl: `https://e621.net/posts/${post.id}`,
    description: [
      artist.length ? `Artist: ${artist.join(', ')}` : 'Artist unknown',
      species.length ? `Species: ${species.slice(0, 3).join(', ')}` : null,
    ]
      .filter(Boolean)
      .join(' • '),
    tags: [...artist.map((tag) => `artist:${tag}`), ...general],
  };
}

function renderApp() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>e621 Reels</title>
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
        min-height: 100vh;
        display: grid;
        place-items: center;
        padding: 20px;
      }
      .app {
        width: min(430px, 100%);
        height: min(920px, calc(100vh - 40px));
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
      .swipe-hint {
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
        background: linear-gradient(90deg, #ff2f78, #ffa34d);
        transition: width 120ms linear;
      }
      .settings-toggle {
        position: absolute;
        right: 14px;
        top: calc(var(--safe-top) + 54px);
        z-index: 5;
      }
      .filter-panel {
        position: absolute;
        inset: auto 14px 16px 14px;
        z-index: 6;
        padding: 16px;
        border-radius: 24px;
        border: 1px solid var(--outline);
        background: var(--panel-strong);
        backdrop-filter: blur(20px);
        display: none;
        gap: 12px;
        max-height: min(70vh, 620px);
        overflow: auto;
      }
      .filter-panel.open { display: grid; }
      .filter-panel h3 {
        margin: 0;
        font-size: 1rem;
      }
      .filter-panel label,
      .settings-option {
        display: grid;
        gap: 6px;
      }
      .filter-panel input,
      .filter-panel select {
        border-radius: 14px;
        border: 1px solid var(--outline);
        background: rgba(255,255,255,0.06);
        color: var(--text);
        padding: 12px 14px;
        outline: none;
      }
      .settings-option {
        grid-template-columns: auto 1fr;
        align-items: center;
        gap: 10px;
      }
      .settings-option input {
        inline-size: 18px;
        block-size: 18px;
        margin: 0;
      }
      .filter-actions {
        display: flex;
        gap: 10px;
      }
      .filter-actions button,
      .jump button {
        flex: 1;
        border: none;
        border-radius: 14px;
        padding: 12px 14px;
        cursor: pointer;
      }
      .primary {
        background: linear-gradient(135deg, #ff2f78, #ff7b54);
        color: white;
      }
      .secondary {
        background: rgba(255,255,255,0.08);
        color: var(--text);
      }
      .jump {
        display: flex;
        gap: 10px;
      }
      .meta.hidden-tags #tagList {
        display: none;
      }
      .sr-only {
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
      a.source-link {
        color: #fff;
        text-decoration: none;
      }
      @media (max-width: 520px) {
        .shell { padding: 0; }
        .app {
          width: 100%;
          height: 100vh;
          border-radius: 0;
          border: none;
        }
      }
    </style>
  </head>
  <body>
    <div class="shell">
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
            <input id="tagsInput" name="tags" type="text" placeholder="wolf animated" autocomplete="off" />
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
          <label class="settings-option">
            <input id="fitMediaToggle" name="fitMedia" type="checkbox" />
            <span>Fit media inside the frame instead of filling/cropping it.</span>
          </label>
          <label class="settings-option">
            <input id="hideTagsToggle" name="hideTags" type="checkbox" />
            <span>Hide the tag pills overlay for a cleaner full-screen view.</span>
          </label>
          <div class="filter-actions">
            <button class="primary" type="submit">Apply</button>
            <button class="secondary" id="resetButton" type="button">Reset</button>
          </div>
          <p class="hint">Tap the current reel to pause or resume. The feed auto-swipes with animation when an image timer ends or a video finishes.</p>
        </form>
      </main>
    </div>

    <script>
      const CLIENT_E621_API = 'https://e621.net/posts.json';
      const CLIENT_SUPPORTED_MEDIA = new Set(['webm', 'mp4', 'gif']);
      const SWIPE_THRESHOLD = 90;
      const PRELOAD_DISTANCE = 2;
      const IMAGE_COUNTDOWN_MS = 10000;

      const state = {
        posts: [],
        currentIndex: 0,
        nextPage: 1,
        loading: false,
        mode: 'trending',
        tags: '',
        rating: '',
        muted: true,
        timer: null,
        progressTimer: null,
        animationLock: false,
        fitMedia: false,
        hideTags: false,
        touchActive: false,
        pointerStartY: 0,
        pointerDeltaY: 0,
        currentMedia: null,
        currentSlide: null,
        preloaded: new Map(),
        lastFeedSource: 'worker',
      };

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
      const fitMediaToggle = document.getElementById('fitMediaToggle');
      const hideTagsToggle = document.getElementById('hideTagsToggle');

      toggleFiltersButton.addEventListener('click', () => {
        filterPanel.classList.toggle('open');
        toggleFiltersButton.classList.toggle('active', filterPanel.classList.contains('open'));
      });

      filterPanel.addEventListener('submit', async (event) => {
        event.preventDefault();
        state.mode = modeSelect.value;
        state.tags = tagsInput.value.trim();
        state.rating = ratingSelect.value;
        state.fitMedia = fitMediaToggle.checked;
        state.hideTags = hideTagsToggle.checked;
        syncDisplaySettings();
        closeSettings();
        await restartFeed();
      });

      resetButton.addEventListener('click', async () => {
        modeSelect.value = 'trending';
        tagsInput.value = '';
        ratingSelect.value = '';
        fitMediaToggle.checked = false;
        hideTagsToggle.checked = false;
        state.mode = 'trending';
        state.tags = '';
        state.rating = '';
        state.fitMedia = false;
        state.hideTags = false;
        syncDisplaySettings();
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

      document.addEventListener('keydown', (event) => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
          goToRelativePost(1);
        } else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
          goToRelativePost(-1);
        } else if (event.key.toLowerCase() === 'f') {
          state.fitMedia = !state.fitMedia;
          fitMediaToggle.checked = state.fitMedia;
          syncDisplaySettings();
          rerenderCurrentSlide();
        } else if (event.key.toLowerCase() === 't') {
          state.hideTags = !state.hideTags;
          hideTagsToggle.checked = state.hideTags;
          syncDisplaySettings();
        } else if (event.key === 'Escape') {
          closeSettings();
        }
      });

      viewport.addEventListener('pointerdown', handlePointerDown);
      viewport.addEventListener('pointermove', handlePointerMove);
      viewport.addEventListener('pointerup', handlePointerUp);
      viewport.addEventListener('pointercancel', cancelPointerGesture);
      viewport.addEventListener('wheel', handleWheel, { passive: false });

      function closeSettings() {
        filterPanel.classList.remove('open');
        toggleFiltersButton.classList.remove('active');
      }

      function syncDisplaySettings() {
        metaBlock.classList.toggle('hidden-tags', state.hideTags);
      }

      function handlePointerDown(event) {
        if (state.animationLock) return;
        if (filterPanel.contains(event.target) || toggleFiltersButton.contains(event.target)) return;
        state.touchActive = true;
        state.pointerStartY = event.clientY;
        state.pointerDeltaY = 0;
        reelTrack.classList.remove('animating');
        viewport.setPointerCapture(event.pointerId);
      }

      function handlePointerMove(event) {
        if (!state.touchActive || state.animationLock) return;
        state.pointerDeltaY = event.clientY - state.pointerStartY;
        updateTrackForDrag(state.pointerDeltaY);
      }

      function handlePointerUp(event) {
        if (!state.touchActive) return;
        viewport.releasePointerCapture(event.pointerId);
        finalizeSwipe(state.pointerDeltaY);
      }

      function cancelPointerGesture() {
        if (!state.touchActive) return;
        finalizeSwipe(0);
      }

      function handleWheel(event) {
        if (filterPanel.classList.contains('open') || state.animationLock) return;
        if (Math.abs(event.deltaY) < 8) return;
        event.preventDefault();
        goToRelativePost(event.deltaY > 0 ? 1 : -1);
      }

      function updateTrackForDrag(deltaY) {
        refreshTrackSlides();
        reelTrack.style.transform = 'translate3d(0, ' + deltaY + 'px, 0)';
        ensureAdjacentSlides();
      }

      function finalizeSwipe(deltaY) {
        state.touchActive = false;
        const direction = deltaY <= -SWIPE_THRESHOLD ? 1 : deltaY >= SWIPE_THRESHOLD ? -1 : 0;
        if (direction === 0) {
          animateTrackTo(0);
          return;
        }
        goToRelativePost(direction, { animated: true });
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

          console.info('[feed] requesting posts', {
            sourcePreference: 'worker-first',
            page: state.nextPage,
            mode: state.mode,
            tags: state.tags,
            rating: state.rating || null,
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
        if (rating) tags.push('rating:' + rating);
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
          width: (post.sample && post.sample.width) || (post.file && post.file.width) || 0,
          height: (post.sample && post.sample.height) || (post.file && post.file.height) || 0,
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
          if (!video.duration || !Number.isFinite(video.duration)) {
            setProgressValue(0);
            return;
          }
          setProgressValue((video.currentTime / video.duration) * 100);
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

        statusCard.hidden = true;
        const direction = index > state.currentIndex ? 1 : index < state.currentIndex ? -1 : 0;
        const movement = options.immediate || direction === 0 ? 0 : direction;

        if (!state.currentSlide || options.immediate) {
          const entry = await ensureSlide(index);
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

        const currentSlide = state.currentSlide;
        const currentMedia = state.currentMedia;
        const targetEntry = await ensureSlide(index);

        if (currentMedia && currentMedia.tagName === 'VIDEO') {
          currentMedia.pause();
        }

        state.currentIndex = index;
        setCurrentSlide(targetEntry.slide, targetEntry.media);
        refreshTrackSlides();
        updateMeta(post);
        ensureAdjacentSlides();
        schedulePreloadAroundIndex(index);

        const trackTarget = movement > 0 ? -viewport.clientHeight : viewport.clientHeight;
        await animateTrackTo(trackTarget, true);
        reelTrack.classList.remove('animating');
        reelTrack.style.transform = 'translate3d(0, 0, 0)';
        refreshTrackSlides();
        startPlaybackForPost(post, targetEntry.media, targetEntry.slide);
        state.animationLock = false;

        if (state.posts.length - index <= 4) {
          loadPosts(false);
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
          media.preload = 'auto';
          media.playsInline = true;
          media.loop = false;
          media.muted = state.muted;
          media.controls = false;
          media.autoplay = false;
          media.className = 'reel-media' + (state.fitMedia ? ' fit' : '');
          media.addEventListener('loadeddata', () => slide.classList.remove('loading'), { once: true });
          media.addEventListener('ended', () => {
            if (state.currentMedia === media) {
              goToRelativePost(1, { animated: true });
            }
          });
          media.addEventListener('play', () => {
            if (state.currentMedia === media) watchVideoProgress(media);
            slide.classList.remove('awaiting-play');
          });
          media.addEventListener('pause', () => {
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

        media.addEventListener('click', () => {
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
        slide.classList.remove('loading');
        if (post.type === 'video') {
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
          const span = document.createElement('span');
          span.className = 'pill';
          span.textContent = tag.replaceAll('_', ' ');
          tagList.appendChild(span);
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
            const done = () => {
              reelTrack.removeEventListener('transitionend', done);
              resolve();
            };
            reelTrack.addEventListener('transitionend', done, { once: true });
          });
        }
        reelTrack.classList.remove('animating');
        reelTrack.style.transform = 'translate3d(0, ' + targetY + 'px, 0)';
        return Promise.resolve();
      }

      syncDisplaySettings();
      restartFeed();
    </script>
  </body>
</html>`;
}

function normalizePage(value) {
  const page = Number.parseInt(value || '1', 10);
  if (Number.isNaN(page) || page < 1) return 1;
  return Math.min(page, 750);
}

function sanitizeTags(raw) {
  return raw
    .split(/\s+/)
    .map((tag) => tag.trim())
    .filter(Boolean)
    .slice(0, 12);
}

function sanitizeRating(raw) {
  return ['s', 'q', 'e'].includes(raw) ? raw : '';
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
