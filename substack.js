let POST_LIMIT = 5; // Default limit

const readingFeed = document.querySelector("#reading-feed");
init();

async function init() {
  if (!readingFeed) return;

  // Add limit selector
  createLimitSelector();

  await hydrateReadingFeed();
}

function createLimitSelector() {
  const readingSection = document.querySelector('[aria-labelledby="reading-heading"]');
  if (!readingSection) return;

  const header = readingSection.querySelector('.section-header');
  if (!header) return;

  const limitControl = document.createElement('div');
  limitControl.className = 'limit-control';
  limitControl.innerHTML = `
    <label for="post-limit">Show: </label>
    <select id="post-limit" class="limit-select">
      <option value="3">3 posts</option>
      <option value="5" selected>5 posts</option>
      <option value="10">10 posts</option>
    </select>
  `;

  header.appendChild(limitControl);

  const select = limitControl.querySelector('#post-limit');
  select.addEventListener('change', async (e) => {
    POST_LIMIT = parseInt(e.target.value);
    await hydrateReadingFeed();
  });
}

async function hydrateReadingFeed() {
  try {
    const response = await fetch(`/api/substack/posts?limit=${POST_LIMIT}`, {
      credentials: "include",
    });

    if (!response.ok) {
      throw new Error(`Request failed: ${response.status}`);
    }

    const payload = await response.json();
    const posts = Array.isArray(payload?.posts) ? payload.posts : [];

    if (!posts.length) {
      setPlaceholder("Connect Gmail to see your latest Substack posts.");
      return;
    }

    renderPosts(posts);
  } catch (error) {
    console.error("Failed to load Substack feed", error);
    setPlaceholder("We couldn't load your Substack posts. Try connecting Gmail.");
  }
}

function setPlaceholder(message) {
  if (!readingFeed) return;
  readingFeed.innerHTML = "";
  const placeholder = document.createElement("div");
  placeholder.className = "feed-placeholder";
  placeholder.textContent = message;
  readingFeed.appendChild(placeholder);
}

function renderPosts(posts) {
  if (!readingFeed) return;
  readingFeed.innerHTML = "";

  posts
    .map(mapPostToCard)
    .forEach((card) => readingFeed.appendChild(card));
}

function mapPostToCard(post) {
  const card = document.createElement("article");
  card.className = "card";
  card.dataset.category = "reading";
  card.dataset.postId = post.postId;

  if (post.isPinned) {
    card.classList.add("is-pinned");
  }

  const sourceRow = document.createElement("div");
  sourceRow.className = "card__source-row";
  sourceRow.innerHTML = `<span class="source-pill">Substack</span>`;

  const title = document.createElement("h3");
  title.className = "card__title";
  title.textContent = post.title || "Untitled post";

  const snippet = document.createElement("p");
  snippet.className = "card__snippet";
  snippet.textContent = post.snippet || "";

  const meta = document.createElement("p");
  meta.className = "card__meta";
  const publishedAt = formatDate(post.publishedAt);
  const metaBits = [post.author, publishedAt].filter(Boolean);
  meta.textContent = metaBits.join(" • ");

  const actions = document.createElement("div");
  actions.className = "card__actions";
  actions.innerHTML = `
    <a class="card__link" href="${escapeHtml(post.postUrl)}" target="_blank" rel="noopener noreferrer">Open ↗</a>
    <button class="pin-button" type="button" data-pin>${post.isPinned ? "Pinned 📌" : "Pin 📌"}</button>
  `;

  const pinButton = actions.querySelector("[data-pin]");
  pinButton?.addEventListener("click", () => togglePin(post.postId, pinButton));

  card.append(sourceRow, title, snippet, meta, actions);
  return card;
}

async function togglePin(postId, button) {
  try {
    const response = await fetch(`/api/substack/pins/${postId}`, {
      method: "POST",
      credentials: "include",
    });

    if (!response.ok) {
      throw new Error("Failed to pin post");
    }

    button.classList.toggle("is-pinned");
    const pinned = button.classList.contains("is-pinned");
    button.textContent = pinned ? "Pinned 📌" : "Pin 📌";
  } catch (error) {
    console.error("Error toggling pin", error);
  }
}

function formatDate(iso) {
  if (!iso) return "Recently";
  const date = new Date(iso);
  return `${date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  })}`;
}

function escapeHtml(value) {
  if (!value) return "";
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return char;
    }
  });
}

export {};
