import * as cheerio from "cheerio";

// ============================================================================
// TYPES
// ============================================================================

export interface FeedDiscoveryResult {
  feedUrl: string;
  feedType: "rss" | "atom" | "json_feed";
  discoveryMethod: "well-known-path" | "html-link-tag" | "manual";
  feedTitle?: string;
  feedDescription?: string;
  siteUrl: string; // Resolved/canonical site URL
}

interface FeedCheckResult {
  success: boolean;
  feedUrl?: string;
  feedType?: "rss" | "atom" | "json_feed";
  feedTitle?: string;
  feedDescription?: string;
  etag?: string;
  lastModified?: string;
}

// ============================================================================
// WELL-KNOWN FEED PATHS
// ============================================================================

const WELL_KNOWN_PATHS = [
  "/feed.xml", // Jekyll, Hugo default
  "/rss.xml", // Older blogs
  "/atom.xml", // Hexo, some Hugo
  "/feed/", // WordPress, some others
  "/index.xml", // Hugo alternative
  "/feed.json", // JSON Feed
  "/rss/", // Alternative RSS path
  "/feeds/rss.xml", // Some blog systems
];

// ============================================================================
// FEED DISCOVERY
// ============================================================================

/**
 * Discovers RSS/Atom/JSON feeds for a given site URL
 * Tries well-known paths first, then HTML parsing
 */
export async function discoverFeed(
  siteUrl: string,
  timeout: number = 10000
): Promise<FeedDiscoveryResult> {
  // Normalize URL
  const normalizedUrl = normalizeSiteUrl(siteUrl);

  console.log(`[Feed Discovery] Starting discovery for: ${normalizedUrl}`);

  // Step 1: Try well-known paths
  for (const path of WELL_KNOWN_PATHS) {
    const feedUrl = new URL(path, normalizedUrl).toString();
    console.log(`[Feed Discovery] Trying well-known path: ${feedUrl}`);

    const result = await checkFeedUrl(feedUrl, timeout);
    if (result.success && result.feedUrl && result.feedType) {
      console.log(
        `✅ [Feed Discovery] Found feed via well-known path: ${feedUrl} (${result.feedType})`
      );
      return {
        feedUrl: result.feedUrl,
        feedType: result.feedType,
        discoveryMethod: "well-known-path",
        feedTitle: result.feedTitle,
        feedDescription: result.feedDescription,
        siteUrl: normalizedUrl,
      };
    }
  }

  console.log(`[Feed Discovery] No well-known paths found, trying HTML parsing...`);

  // Step 2: Parse HTML for <link rel="alternate"> tags
  try {
    const htmlResult = await discoverFeedFromHtml(normalizedUrl, timeout);
    if (htmlResult) {
      console.log(
        `✅ [Feed Discovery] Found feed via HTML parsing: ${htmlResult.feedUrl} (${htmlResult.feedType})`
      );
      return {
        ...htmlResult,
        siteUrl: normalizedUrl,
      };
    }
  } catch (error) {
    console.error(`[Feed Discovery] HTML parsing failed:`, error);
  }

  // Step 3: No feed found
  throw new Error(
    `No feed found for ${siteUrl}. Please provide the feed URL manually.`
  );
}

/**
 * Normalizes a site URL (add https://, remove trailing slash)
 */
function normalizeSiteUrl(url: string): string {
  let normalized = url.trim();

  // Add protocol if missing
  if (!normalized.startsWith("http://") && !normalized.startsWith("https://")) {
    normalized = `https://${normalized}`;
  }

  // Remove trailing slash
  normalized = normalized.replace(/\/$/, "");

  return normalized;
}

/**
 * Checks if a URL is a valid feed
 */
async function checkFeedUrl(
  feedUrl: string,
  timeout: number
): Promise<FeedCheckResult> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    // Do a GET request to actually verify the feed exists and is parseable
    const response = await fetch(feedUrl, {
      method: "GET",
      signal: controller.signal,
      headers: {
        "User-Agent": "Curators-Desk-Feed-Reader/1.0",
      },
      redirect: "follow",
    });

    clearTimeout(timeoutId);

    // Must be 200 OK
    if (!response.ok) {
      return { success: false };
    }

    const text = await response.text();

    // Check content type and content to detect feed type
    const contentType = response.headers.get("content-type") || "";
    let feedType = detectFeedType(contentType, feedUrl);

    // If content-type didn't help, try to detect from content
    if (!feedType) {
      feedType = detectFeedTypeFromContent(text);
    }

    if (!feedType) {
      return { success: false };
    }

    // Extract metadata from the feed
    const metadata = extractFeedMetadata(text, feedType);

    return {
      success: true,
      feedUrl,
      feedType,
      feedTitle: metadata.title,
      feedDescription: metadata.description,
      etag: response.headers.get("etag") || undefined,
      lastModified: response.headers.get("last-modified") || undefined,
    };
  } catch (error) {
    clearTimeout(timeoutId);
    return { success: false };
  }
}

/**
 * Detects feed type from content-type header or URL
 */
function detectFeedType(
  contentType: string,
  url: string
): "rss" | "atom" | "json_feed" | null {
  const ct = contentType.toLowerCase();

  // Check content-type
  if (ct.includes("application/rss+xml") || ct.includes("application/xml")) {
    return "rss";
  }
  if (ct.includes("application/atom+xml")) {
    return "atom";
  }
  if (ct.includes("application/json") || ct.includes("application/feed+json")) {
    return "json_feed";
  }

  // Fallback: check URL
  if (url.includes("atom")) return "atom";
  if (url.includes("json")) return "json_feed";
  if (url.includes("rss") || url.includes("feed")) return "rss";

  return null;
}

/**
 * Detects feed type from actual content (for when headers don't help)
 */
function detectFeedTypeFromContent(content: string): "rss" | "atom" | "json_feed" | null {
  // Check for JSON Feed
  if (content.trim().startsWith("{")) {
    try {
      const json = JSON.parse(content);
      if (json.version && json.version.includes("https://jsonfeed.org")) {
        return "json_feed";
      }
    } catch (e) {
      // Not valid JSON
    }
  }

  // Check for Atom
  if (content.includes("<feed") && content.includes("xmlns=\"http://www.w3.org/2005/Atom\"")) {
    return "atom";
  }

  // Check for RSS
  if (content.includes("<rss") || content.includes("<channel>")) {
    return "rss";
  }

  return null;
}

/**
 * Extracts title and description from feed XML/JSON
 */
function extractFeedMetadata(
  content: string,
  feedType: "rss" | "atom" | "json_feed"
): { title?: string; description?: string } {
  try {
    if (feedType === "json_feed") {
      const feed = JSON.parse(content);
      return {
        title: feed.title,
        description: feed.description,
      };
    }

    // For RSS/Atom, use cheerio to parse XML
    const $ = cheerio.load(content, { xmlMode: true });

    if (feedType === "atom") {
      return {
        title: $("feed > title").first().text(),
        description: $("feed > subtitle").first().text(),
      };
    }

    // RSS
    return {
      title: $("channel > title").first().text(),
      description: $("channel > description").first().text(),
    };
  } catch (error) {
    return {};
  }
}

/**
 * Discovers feed from HTML <link rel="alternate"> tags
 */
async function discoverFeedFromHtml(
  siteUrl: string,
  timeout: number
): Promise<Omit<FeedDiscoveryResult, "siteUrl"> | null> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(siteUrl, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Curators-Desk-Feed-Reader/1.0",
      },
      redirect: "follow",
    });

    clearTimeout(timeoutId);

    const html = await response.text();
    const $ = cheerio.load(html);

    // Look for <link rel="alternate"> tags
    const feedLinks = $('link[rel="alternate"]')
      .map((i, el) => {
        const $el = $(el);
        const type = $el.attr("type")?.toLowerCase() || "";
        const href = $el.attr("href");

        if (!href) return null;

        // Resolve relative URLs
        const absoluteUrl = new URL(href, siteUrl).toString();

        return {
          url: absoluteUrl,
          type,
        };
      })
      .get()
      .filter((link) => link !== null);

    // Find the first RSS/Atom/JSON feed
    for (const link of feedLinks) {
      if (!link) continue;

      let feedType: "rss" | "atom" | "json_feed" | null = null;

      if (
        link.type.includes("application/rss+xml") ||
        link.type.includes("application/xml")
      ) {
        feedType = "rss";
      } else if (link.type.includes("application/atom+xml")) {
        feedType = "atom";
      } else if (
        link.type.includes("application/json") ||
        link.type.includes("application/feed+json")
      ) {
        feedType = "json_feed";
      }

      if (feedType) {
        // Verify the feed URL is valid
        const result = await checkFeedUrl(link.url, timeout);
        if (result.success) {
          return {
            feedUrl: link.url,
            feedType,
            discoveryMethod: "html-link-tag",
            feedTitle: result.feedTitle,
            feedDescription: result.feedDescription,
          };
        }
      }
    }

    return null;
  } catch (error) {
    clearTimeout(timeoutId);
    return null;
  }
}
