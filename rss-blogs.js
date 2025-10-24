// ============================================================================
// RSS/BLOG FUNCTIONALITY
// ============================================================================

const READING_FEED_CONTAINER = "#reading-feed";

// ============================================================================
// INITIALIZATION
// ============================================================================

async function init() {
  console.log("[RSS] Initializing RSS/Blog functionality...");

  // Check if RSS is enabled
  const config = await fetch("/api/config").then((r) => r.json());
  if (!config.features.rss) {
    console.log("[RSS] RSS feature is disabled");
    return;
  }

  // Set up "Add new source" button
  setupAddSourceButton();

  // Set up blog management dropdown
  setupBlogManagement();

  // Load RSS posts
  await loadRssPosts();

  console.log("[RSS] Initialization complete");
}

// ============================================================================
// ADD SOURCE FUNCTIONALITY
// ============================================================================

function setupAddSourceButton() {
  // Wire up the "Add Blog" button in the navbar
  const addBlogNavButton = document.getElementById("add-blog-nav");
  if (addBlogNavButton) {
    addBlogNavButton.addEventListener("click", showAddBlogModal);
  }
}

function showAddBlogModal() {
  // Create modal HTML
  const modalHtml = `
    <div class="modal-overlay" id="add-blog-modal">
      <div class="modal-content">
        <div class="modal-header">
          <h2>Add Blog or RSS Feed</h2>
          <button class="modal-close" type="button" aria-label="Close">&times;</button>
        </div>
        <div class="modal-body">
          <p class="modal-description">
            Enter the URL of a blog or website. We'll automatically discover the RSS/Atom feed.
          </p>
          <form id="add-blog-form">
            <div class="form-group">
              <label for="blog-url">Blog URL</label>
              <input
                type="url"
                id="blog-url"
                name="siteUrl"
                placeholder="https://example.com"
                required
                autocomplete="url"
              />
              <small>Examples: https://gwern.net, https://example.com/blog</small>
            </div>
            <div class="form-group">
              <label for="feed-url">Feed URL (optional)</label>
              <input
                type="url"
                id="feed-url"
                name="feedUrl"
                placeholder="https://example.com/feed.xml"
                autocomplete="url"
              />
              <small>If auto-discovery fails, provide the direct feed URL</small>
            </div>
            <div id="add-blog-status" class="form-status" aria-live="polite"></div>
            <div class="modal-actions">
              <button type="button" class="btn-secondary" id="cancel-add-blog">Cancel</button>
              <button type="submit" class="btn-primary">Add Blog</button>
            </div>
          </form>
        </div>
      </div>
    </div>
  `;

  // Inject modal into DOM
  document.body.insertAdjacentHTML("beforeend", modalHtml);

  // Add event listeners
  const modal = document.getElementById("add-blog-modal");
  const form = document.getElementById("add-blog-form");
  const closeBtn = modal.querySelector(".modal-close");
  const cancelBtn = document.getElementById("cancel-add-blog");

  closeBtn.addEventListener("click", () => removeModal(modal));
  cancelBtn.addEventListener("click", () => removeModal(modal));
  modal.addEventListener("click", (e) => {
    if (e.target === modal) removeModal(modal);
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    await handleAddBlog(form, modal);
  });
}

function removeModal(modal) {
  modal.remove();
}

async function handleAddBlog(form, modal) {
  const statusEl = document.getElementById("add-blog-status");
  const submitBtn = form.querySelector('button[type="submit"]');
  const formData = new FormData(form);

  const siteUrl = formData.get("siteUrl");
  const feedUrl = formData.get("feedUrl");

  if (!siteUrl) {
    showStatus(statusEl, "error", "Please enter a blog URL");
    return;
  }

  try {
    // Disable submit button
    submitBtn.disabled = true;
    submitBtn.textContent = "Discovering feed...";
    showStatus(statusEl, "info", "🔍 Discovering feed...");

    const response = await fetch("/api/rss/sources", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        siteUrl,
        feedUrl: feedUrl || undefined,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || data.message || "Failed to add blog");
    }

    // Success!
    showStatus(statusEl, "success", data.message);

    // Wait a moment, then close modal and reload posts
    setTimeout(async () => {
      removeModal(modal);
      await loadRssPosts();
    }, 1500);
  } catch (error) {
    console.error("[RSS] Error adding blog:", error);
    showStatus(statusEl, "error", error.message);
    submitBtn.disabled = false;
    submitBtn.textContent = "Add Blog";
  }
}

function showStatus(element, type, message) {
  element.className = `form-status form-status--${type}`;
  element.textContent = message;
}

// ============================================================================
// LOAD RSS POSTS
// ============================================================================

async function loadRssPosts() {
  const container = document.querySelector(READING_FEED_CONTAINER);
  if (!container) {
    console.warn("[RSS] Reading feed container not found");
    return;
  }

  try {
    const response = await fetch("/api/rss/posts?limit=10");
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Failed to fetch RSS posts");
    }

    const posts = data.posts || [];
    console.log(`[RSS] Loaded ${posts.length} RSS posts`);

    if (posts.length === 0) {
      // Keep existing Substack posts, just add a message
      const existingCards = container.querySelectorAll(".card");
      if (existingCards.length === 0) {
        container.innerHTML = `
          <div class="feed-placeholder">
            Add blogs to see posts here. Click "+ Add new source" below.
          </div>
        `;
      }
      return;
    }

    // Remove placeholder if it exists
    const placeholder = container.querySelector(".feed-placeholder");
    if (placeholder) {
      placeholder.remove();
    }

    // Render RSS posts (prepend to existing content)
    const rssPosts = posts.map(renderRssPost).join("");
    container.insertAdjacentHTML("afterbegin", rssPosts);
  } catch (error) {
    console.error("[RSS] Error loading posts:", error);
  }
}

function renderRssPost(post) {
  const publishedDate = new Date(post.publishedAt);
  const formattedDate = formatDate(publishedDate);

  return `
    <article class="card" data-category="reading" data-source="rss" data-source-id="${escapeHtml(post.sourceId || '')}" data-post-id="${escapeHtml(post.postId)}">
      <div class="card__source-row">
        <span class="favicon" aria-hidden="true">📡</span>
        <span class="source-pill">${escapeHtml(post.author || "Blog")}</span>
      </div>
      <h3 class="card__title">${escapeHtml(post.title)}</h3>
      <p class="card__snippet">${escapeHtml(post.snippet)}</p>
      <p class="card__meta">
        <span>${escapeHtml(post.author || "Unknown")}</span> •
        <time dateTime="${post.publishedAt}">${formattedDate}</time>
      </p>
      <div class="card__actions">
        <a class="card__link" href="${escapeHtml(post.postUrl)}" target="_blank" rel="noopener noreferrer">Open ↗</a>
        <button class="pin-button" type="button" aria-pressed="false" data-post-id="${escapeHtml(post.postId)}">
          Pin 📌
        </button>
      </div>
    </article>
  `;
}

// ============================================================================
// UTILITIES
// ============================================================================

function formatDate(date) {
  const now = new Date();
  const diffMs = now - date;
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return `${diffDays} days ago`;

  const options = { month: "short", day: "numeric" };
  if (date.getFullYear() !== now.getFullYear()) {
    options.year = "numeric";
  }

  return date.toLocaleDateString("en-US", options);
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

// ============================================================================
// BLOG MANAGEMENT DROPDOWN
// ============================================================================

function setupBlogManagement() {
  const manageBtn = document.getElementById("blog-manage-nav");
  const dropdown = document.getElementById("blog-dropdown");

  if (!manageBtn || !dropdown) return;

  // Toggle dropdown
  manageBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    const isHidden = dropdown.hasAttribute("hidden");

    if (isHidden) {
      dropdown.removeAttribute("hidden");
      await loadBlogList();
    } else {
      dropdown.setAttribute("hidden", "");
    }
  });

  // Close dropdown when clicking outside
  document.addEventListener("click", (e) => {
    if (!dropdown.contains(e.target) && e.target !== manageBtn) {
      dropdown.setAttribute("hidden", "");
    }
  });
}

async function loadBlogList() {
  const listContainer = document.getElementById("blog-list");
  if (!listContainer) return;

  try {
    listContainer.innerHTML = '<div class="blog-dropdown__loading">Loading...</div>';

    const response = await fetch("/api/rss/sources");
    const data = await response.json();
    const sources = data.sources || [];

    if (sources.length === 0) {
      listContainer.innerHTML = '<div class="blog-dropdown__empty">No blogs added yet</div>';
      return;
    }

    // Render blog list
    listContainer.innerHTML = sources
      .map((source) => renderBlogItem(source))
      .join("");

    // Attach remove handlers
    sources.forEach((source) => {
      const removeBtn = document.getElementById(`remove-blog-${source.sourceId}`);
      if (removeBtn) {
        removeBtn.addEventListener("click", () => removeBlog(source.sourceId, source.feedTitle || source.siteUrl));
      }
    });
  } catch (error) {
    console.error("[RSS] Error loading blog list:", error);
    listContainer.innerHTML = '<div class="blog-dropdown__empty">Error loading blogs</div>';
  }
}

function renderBlogItem(source) {
  const title = source.feedTitle || "Untitled Blog";
  const url = source.siteUrl;
  const status = source.lastSyncStatus === "error" ? "⚠️ " : "";

  return `
    <div class="blog-item" data-source-id="${escapeHtml(source.sourceId)}">
      <div class="blog-item__info">
        <p class="blog-item__title">${status}${escapeHtml(title)}</p>
        <p class="blog-item__url">${escapeHtml(url)}</p>
      </div>
      <button
        class="blog-item__remove"
        id="remove-blog-${escapeHtml(source.sourceId)}"
        aria-label="Remove ${escapeHtml(title)}"
      >
        ×
      </button>
    </div>
  `;
}

async function removeBlog(sourceId, blogName) {
  if (!confirm(`Remove "${blogName}"?\n\nPosts will disappear immediately.`)) {
    return;
  }

  try {
    const response = await fetch(`/api/rss/sources/${sourceId}`, {
      method: "DELETE",
    });

    if (!response.ok) {
      throw new Error("Failed to remove blog");
    }

    console.log(`[RSS] Removed blog: ${sourceId}`);

    // Remove from dropdown UI
    const blogItem = document.querySelector(`[data-source-id="${sourceId}"]`);
    if (blogItem) {
      blogItem.remove();
    }

    // Immediately hide posts from this blog in the feed
    hidePostsFromSource(sourceId);

    // Reload blog list to update count
    await loadBlogList();

  } catch (error) {
    console.error("[RSS] Error removing blog:", error);
    alert("Failed to remove blog. Please try again.");
  }
}

function hidePostsFromSource(sourceId) {
  // Find all post cards from this source
  const postsToRemove = document.querySelectorAll(`[data-source-id="${sourceId}"]`);

  console.log(`[RSS] Hiding ${postsToRemove.length} posts from source ${sourceId}`);

  postsToRemove.forEach((post) => {
    // Add fade-out animation class
    post.style.opacity = "0";
    post.style.transform = "scale(0.95)";
    post.style.transition = "opacity 0.3s ease, transform 0.3s ease";

    // Remove from DOM after animation
    setTimeout(() => {
      post.remove();
    }, 300);
  });

  // If no posts left, show placeholder
  setTimeout(() => {
    const container = document.querySelector(READING_FEED_CONTAINER);
    if (container) {
      const remainingPosts = container.querySelectorAll(".card");
      if (remainingPosts.length === 0) {
        container.innerHTML = `
          <div class="feed-placeholder">
            Add blogs to see posts here. Click "+ Add Blog" above.
          </div>
        `;
      }
    }
  }, 350);
}

// ============================================================================
// START
// ============================================================================

// Initialize when DOM is ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
