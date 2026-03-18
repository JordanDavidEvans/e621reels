const E621_API = 'https://e621.net/posts.json';
const USER_AGENT = 'e621reels/0.1.0 (Cloudflare Worker demo; contact: admin@example.com)';
const PAGE_SIZE = 24;
const BASE_TAGS = ['animated'];
const SUPPORTED_MEDIA = new Set(['webm', 'mp4', 'gif']);

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
    return json(
      {
        error: 'Failed to fetch from e621',
        status: response.status,
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
  });
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
      }
      * { box-sizing: border-box; }
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
      }
      .media-stage {
        position: absolute;
        inset: 0;
        background: #000;
      }
      .media-stage img,
      .media-stage video {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        object-fit: cover;
        background: #000;
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
        padding: 18px 16px 24px;
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
      .counter {
        color: var(--muted);
      }
      .badge-row {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
        justify-content: flex-end;
      }
      .badge,
      .pill,
      .counter {
        border: 1px solid var(--outline);
        background: rgba(8, 8, 12, 0.6);
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
      }
      .progress > div {
        height: 100%;
        width: 0;
        background: linear-gradient(90deg, #ff2f78, #ffa34d);
        transition: width 180ms linear;
      }
      .filters-toggle {
        position: absolute;
        left: 16px;
        bottom: 140px;
        z-index: 3;
      }
      .filters-toggle button {
        border: 1px solid var(--outline);
        border-radius: 999px;
        padding: 10px 14px;
        color: var(--text);
        background: var(--panel);
        backdrop-filter: blur(18px);
        cursor: pointer;
      }
      .filter-panel {
        position: absolute;
        inset: auto 14px 16px 14px;
        z-index: 4;
        padding: 16px;
        border-radius: 24px;
        border: 1px solid var(--outline);
        background: var(--panel-strong);
        backdrop-filter: blur(20px);
        display: none;
        gap: 12px;
      }
      .filter-panel.open { display: grid; }
      .filter-panel h3 {
        margin: 0;
        font-size: 1rem;
      }
      .filter-panel label {
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
      <main class="app">
        <div class="progress"><div id="progressBar"></div></div>
        <div class="media-stage" id="mediaStage"></div>
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
            <div class="meta">
              <div>
                <h2 id="postTitle">Waiting for posts</h2>
                <p id="postDescription">Use the filter panel to swap between trending and score-sorted posts or add tags.</p>
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

        <div class="filters-toggle">
          <button id="toggleFiltersButton" type="button">Filters & sort</button>
        </div>

        <form class="filter-panel" id="filterPanel">
          <div>
            <h3>Feed controls</h3>
            <p class="field-help">Default opens the ranking feed. Add tags like <code>dragon animated</code> or switch to score sorting.</p>
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
          <div class="filter-actions">
            <button class="primary" type="submit">Apply</button>
            <button class="secondary" id="resetButton" type="button">Reset</button>
          </div>
          <p class="hint">Posts advance after ~10 seconds or when the current video ends. Click anywhere on the media to pause or play.</p>
        </form>
      </main>
    </div>

    <script>
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
        countdownMs: 10000,
      };

      const mediaStage = document.getElementById('mediaStage');
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

      toggleFiltersButton.addEventListener('click', () => {
        filterPanel.classList.toggle('open');
      });

      filterPanel.addEventListener('submit', async (event) => {
        event.preventDefault();
        state.mode = modeSelect.value;
        state.tags = tagsInput.value.trim();
        state.rating = ratingSelect.value;
        filterPanel.classList.remove('open');
        await restartFeed();
      });

      resetButton.addEventListener('click', async () => {
        modeSelect.value = 'trending';
        tagsInput.value = '';
        ratingSelect.value = '';
        state.mode = 'trending';
        state.tags = '';
        state.rating = '';
        filterPanel.classList.remove('open');
        await restartFeed();
      });

      nextButton.addEventListener('click', () => goToRelativePost(1));
      previousButton.addEventListener('click', () => goToRelativePost(-1));
      toggleMuteButton.addEventListener('click', () => {
        state.muted = !state.muted;
        const video = mediaStage.querySelector('video');
        if (video) {
          video.muted = state.muted;
        }
        toggleMuteButton.textContent = state.muted ? '🔇' : '🔊';
      });

      document.addEventListener('keydown', (event) => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
          goToRelativePost(1);
        } else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
          goToRelativePost(-1);
        }
      });

      async function restartFeed() {
        clearTimers();
        state.posts = [];
        state.currentIndex = 0;
        state.nextPage = 1;
        mediaStage.innerHTML = '';
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
          const response = await fetch('/api/posts?' + params.toString());
          if (!response.ok) throw new Error('Upstream request failed');
          const data = await response.json();
          const incoming = Array.isArray(data.posts) ? data.posts : [];

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

          if (replace || !mediaStage.firstChild) {
            renderCurrentPost();
          }
        } catch (error) {
          renderEmpty('Could not load posts', 'The feed request failed. Please try again in a moment.');
        } finally {
          state.loading = false;
        }
      }

      function renderStatus(title, body) {
        statusCard.hidden = false;
        statusTitle.textContent = title;
        statusText.textContent = body;
      }

      function renderEmpty(title, body) {
        mediaStage.innerHTML = '';
        clearTimers();
        renderStatus(title, body);
        postTitle.textContent = title;
        postDescription.textContent = body;
        tagList.innerHTML = '';
        counterBadge.textContent = '0 / 0';
        progressBar.style.width = '0%';
      }

      function renderCurrentPost() {
        const post = state.posts[state.currentIndex];
        if (!post) return;

        statusCard.hidden = true;
        mediaStage.innerHTML = '';
        clearTimers();

        let media;
        if (post.type === 'video') {
          media = document.createElement('video');
          media.src = post.mediaUrl;
          media.poster = post.previewUrl;
          media.autoplay = true;
          media.playsInline = true;
          media.loop = false;
          media.muted = state.muted;
          media.controls = false;
          media.addEventListener('ended', () => goToRelativePost(1));
          media.addEventListener('canplay', () => media.play().catch(() => {}), { once: true });
        } else {
          media = document.createElement('img');
          media.src = post.mediaUrl;
          media.alt = post.description || 'e621 media post';
          media.loading = 'eager';
        }

        media.addEventListener('click', () => {
          if (media.tagName === 'VIDEO') {
            if (media.paused) {
              media.play().catch(() => {});
              restartCountdown();
            } else {
              media.pause();
              clearTimers(false);
            }
          } else {
            goToRelativePost(1);
          }
        });

        mediaStage.appendChild(media);
        postTitle.textContent = '#' + post.id;
        postDescription.textContent = post.description + ' • Rating: ' + post.rating.toUpperCase() + ' • Score: ' + post.score;
        sortBadge.textContent = state.mode === 'score' ? 'Top score' : 'Trending';
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

        restartCountdown();

        if (state.posts.length - state.currentIndex <= 4) {
          loadPosts(false);
        }
      }

      async function goToRelativePost(offset) {
        if (!state.posts.length) return;
        const nextIndex = state.currentIndex + offset;
        if (nextIndex < 0) {
          state.currentIndex = 0;
          renderCurrentPost();
          return;
        }

        if (nextIndex >= state.posts.length) {
          if (!state.loading) {
            await loadPosts(false);
          }
          if (nextIndex >= state.posts.length) {
            state.currentIndex = state.posts.length - 1;
          } else {
            state.currentIndex = nextIndex;
          }
          renderCurrentPost();
          return;
        }

        state.currentIndex = nextIndex;
        renderCurrentPost();
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
          progressBar.style.width = '0%';
        }
      }

      function restartCountdown() {
        clearTimers();
        const startedAt = Date.now();
        progressBar.style.width = '0%';
        state.timer = setTimeout(() => goToRelativePost(1), state.countdownMs);
        state.progressTimer = setInterval(() => {
          const elapsed = Date.now() - startedAt;
          const progress = Math.min((elapsed / state.countdownMs) * 100, 100);
          progressBar.style.width = progress + '%';
          if (progress >= 100) {
            clearInterval(state.progressTimer);
            state.progressTimer = null;
          }
        }, 100);
      }

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
