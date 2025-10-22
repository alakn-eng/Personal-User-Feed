const AUTH_ENDPOINT = "/auth/youtube";
const VIDEOS_ENDPOINT = "/api/youtube/videos?limit=5";

const watchingFeed = document.querySelector("#watching-feed");
const connectButton = document.querySelector("#youtube-auth");
init();

async function init() {
  if (!watchingFeed || !connectButton) return;

  connectButton.addEventListener("click", () => {
    window.location.href = AUTH_ENDPOINT;
  });

  await hydrateWatchingFeed();
}

async function hydrateWatchingFeed() {
  try {
    const response = await fetch(VIDEOS_ENDPOINT, {
      credentials: "include",
    });

    if (!response.ok) {
      throw new Error(`Request failed: ${response.status}`);
    }

    const payload = await response.json();
    const videos = Array.isArray(payload?.videos) ? payload.videos : [];

    if (!videos.length) {
      setPlaceholder("Connect YouTube to see your latest videos.");
      connectButton.classList.remove("is-connected");
      return;
    }

    connectButton.textContent = "YouTube connected";
    connectButton.classList.add("is-connected");
    renderVideos(videos);
  } catch (error) {
    console.error("Failed to load YouTube feed", error);
    setPlaceholder("We couldn’t reach YouTube right now. Try again in a minute.");
  }
}

function setPlaceholder(message) {
  if (!watchingFeed) return;
  watchingFeed.innerHTML = "";
  const placeholder = document.createElement("div");
  placeholder.className = "feed-placeholder";
  placeholder.textContent = message;
  watchingFeed.appendChild(placeholder);
}

function renderVideos(videos) {
  if (!watchingFeed) return;
  watchingFeed.innerHTML = "";

  videos
    .slice(0, 5)
    .map(mapVideoToCard)
    .forEach((card) => watchingFeed.appendChild(card));
}

function mapVideoToCard(video) {
  const card = document.createElement("article");
  card.className = "card card--video";
  card.dataset.category = "watching";
  card.dataset.videoId = video.videoId;

  if (isArchived(video?.publishedAt)) {
    card.classList.add("is-sweeping");
  }

  const media = document.createElement("div");
  media.className = "card__media";
  media.setAttribute("aria-hidden", "true");
  media.innerHTML = `<img src="${escapeHtml(video.thumbnailUrl ?? "")}" alt="">`;

  const sourceRow = document.createElement("div");
  sourceRow.className = "card__source-row";
  sourceRow.innerHTML = `<span class="source-pill">${escapeHtml(
    video.channelTitle ?? "YouTube"
  )}</span>`;

  const title = document.createElement("h3");
  title.className = "card__title";
  title.textContent = video.title ?? "Untitled video";

  const snippet = document.createElement("p");
  snippet.className = "card__snippet";
  snippet.textContent = video.description ?? "";

  const meta = document.createElement("p");
  meta.className = "card__meta";
  const publishedAt = formatDate(video.publishedAt);
  const duration = video.duration ? formatDuration(video.duration) : null;
  const metaBits = [video.channelTitle, duration, publishedAt].filter(Boolean);
  meta.textContent = metaBits.join(" • ");

  const actions = document.createElement("div");
  actions.className = "card__actions";
  actions.innerHTML = `
    <a class="card__link" href="https://www.youtube.com/watch?v=${encodeURIComponent(
      video.videoId
    )}" target="_blank" rel="noopener noreferrer">Open ↗</a>
    <button class="pin-button" type="button" data-pin>${video.isPinned ? "Pinned 📌" : "Pin 📌"}</button>
  `;

  const playButton = document.createElement("button");
  playButton.className = "play-button";
  playButton.type = "button";
  playButton.textContent = "Play ▶︎";
  playButton.addEventListener("click", () => {
    window.open(`https://www.youtube.com/watch?v=${video.videoId}`, "_blank", "noopener");
  });

  actions.insertBefore(playButton, actions.firstChild);

  const pinButton = actions.querySelector("[data-pin]");
  pinButton?.addEventListener("click", () => togglePin(video.videoId, pinButton));

  card.append(media, sourceRow, title, snippet, meta, actions);
  return card;
}

async function togglePin(videoId, button) {
  try {
    const response = await fetch(`/api/youtube/pins/${videoId}`, {
      method: "POST",
      credentials: "include",
    });

    if (!response.ok) {
      throw new Error("Failed to pin video");
    }

    button.classList.toggle("is-pinned");
    const pinned = button.classList.contains("is-pinned");
    button.textContent = pinned ? "Pinned 📌" : "Pin 📌";
  } catch (error) {
    console.error("Error toggling pin", error);
  }
}

function formatDate(iso) {
  if (!iso) return "Added recently";
  const date = new Date(iso);
  return `Added ${date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  })}`;
}

function formatDuration(isoDuration) {
  if (!isoDuration) return null;
  // Expect ISO 8601 duration (e.g. PT1H3M12S)
  const match = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(isoDuration);
  if (!match) return null;
  const [, h, m, s] = match.map((part) => (part ? Number(part) : 0));
  const parts = [];
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (!h && s) parts.push(`${s}s`);
  return parts.join(" ");
}

function isArchived(publishedAt) {
  if (!publishedAt) return false;
  const date = new Date(publishedAt);
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const sevenDays = 7 * 24 * 60 * 60 * 1000;
  return diff > sevenDays;
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

export {}; // treat as module for bundlers
