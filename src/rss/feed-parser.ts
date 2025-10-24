import Parser from "rss-parser";
import crypto from "crypto";

// ============================================================================
// TYPES
// ============================================================================

export interface ParsedFeedItem {
  title: string;
  url: string; // Canonical URL for the post
  description?: string; // HTML or plain text excerpt
  contentHtml?: string; // Full HTML content if available
  publishedAt: string; // ISO 8601 timestamp
  author?: string;
  hash: string; // For deduplication
  guid?: string; // Original GUID/ID from feed
}

export interface ParsedFeed {
  title?: string;
  description?: string;
  link?: string;
  items: ParsedFeedItem[];
}

export interface FeedFetchResult {
  feed: ParsedFeed;
  etag?: string;
  lastModified?: string;
  feedType: "rss" | "atom" | "json_feed";
}

// ============================================================================
// FEED PARSER
// ============================================================================

const parser = new Parser({
  customFields: {
    feed: ["subtitle"],
    item: [
      ["content:encoded", "contentEncoded"],
      ["dc:creator", "creator"],
      ["author", "author"],
    ],
  },
});

/**
 * Fetches and parses a feed (RSS/Atom/JSON Feed)
 * Returns normalized feed data
 */
export async function fetchAndParseFeed(
  feedUrl: string,
  feedType: "rss" | "atom" | "json_feed",
  options?: {
    etag?: string;
    lastModified?: string;
  }
): Promise<FeedFetchResult | null> {
  const headers: Record<string, string> = {
    "User-Agent": "Curators-Desk-Feed-Reader/1.0",
  };

  // Add conditional headers for efficient polling
  if (options?.etag) {
    headers["If-None-Match"] = options.etag;
  }
  if (options?.lastModified) {
    headers["If-Modified-Since"] = options.lastModified;
  }

  try {
    const response = await fetch(feedUrl, { headers });

    // 304 Not Modified - no new content
    if (response.status === 304) {
      console.log(`[Feed Parser] Feed not modified (304): ${feedUrl}`);
      return null;
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const content = await response.text();
    const etag = response.headers.get("etag") || undefined;
    const lastModified = response.headers.get("last-modified") || undefined;

    // Parse based on feed type
    let parsedFeed: ParsedFeed;

    if (feedType === "json_feed") {
      parsedFeed = parseJsonFeed(content);
    } else {
      // RSS or Atom (rss-parser handles both)
      parsedFeed = await parseRssOrAtom(content);
    }

    return {
      feed: parsedFeed,
      etag,
      lastModified,
      feedType,
    };
  } catch (error) {
    console.error(`[Feed Parser] Error parsing feed ${feedUrl}:`, error);
    throw error;
  }
}

/**
 * Parses RSS or Atom feed using rss-parser
 */
async function parseRssOrAtom(content: string): Promise<ParsedFeed> {
  const feed = await parser.parseString(content);

  return {
    title: feed.title,
    description: feed.description,
    link: feed.link,
    items: (feed.items || []).map((item) => {
      // Extract content (prefer content:encoded, fallback to description)
      const contentHtml =
        (item as any).contentEncoded ||
        (item as any)["content:encoded"] ||
        item.content ||
        undefined;

      // Extract author
      const author =
        (item as any).creator ||
        (item as any)["dc:creator"] ||
        item.creator ||
        (item as any).author?.name ||
        undefined;

      // Use GUID or link as unique identifier
      const guid = item.guid || item.link || "";
      const url = item.link || guid;

      // Generate hash for deduplication
      const hash = generateContentHash(url, item.title || "", contentHtml || "");

      return {
        title: item.title || "Untitled",
        url,
        description: stripHtmlTags(item.contentSnippet || item.description || ""),
        contentHtml,
        publishedAt: item.pubDate
          ? new Date(item.pubDate).toISOString()
          : new Date().toISOString(),
        author,
        hash,
        guid,
      };
    }),
  };
}

/**
 * Parses JSON Feed
 */
function parseJsonFeed(content: string): ParsedFeed {
  const feed = JSON.parse(content);

  return {
    title: feed.title,
    description: feed.description,
    link: feed.home_page_url,
    items: (feed.items || []).map((item: any) => {
      const url = item.url || item.id;
      const contentHtml = item.content_html || undefined;
      const hash = generateContentHash(
        url,
        item.title || "",
        contentHtml || item.content_text || ""
      );

      return {
        title: item.title || "Untitled",
        url,
        description: item.summary || stripHtmlTags(item.content_text || ""),
        contentHtml,
        publishedAt: item.date_published
          ? new Date(item.date_published).toISOString()
          : new Date().toISOString(),
        author: item.author?.name,
        hash,
        guid: item.id,
      };
    }),
  };
}

/**
 * Generates a hash for content deduplication
 * Uses URL + title + content to create a unique hash
 */
function generateContentHash(url: string, title: string, content: string): string {
  const data = `${url}|${title}|${content}`;
  return crypto.createHash("sha256").update(data).digest("hex").substring(0, 16);
}

/**
 * Strips HTML tags from a string (basic sanitization)
 */
function stripHtmlTags(html: string): string {
  return html
    .replace(/<[^>]*>/g, "") // Remove HTML tags
    .replace(/&nbsp;/g, " ") // Replace &nbsp; with space
    .replace(/&amp;/g, "&") // Replace &amp; with &
    .replace(/&lt;/g, "<") // Replace &lt; with <
    .replace(/&gt;/g, ">") // Replace &gt; with >
    .replace(/&quot;/g, '"') // Replace &quot; with "
    .replace(/&#39;/g, "'") // Replace &#39; with '
    .trim();
}

/**
 * Truncates text to a maximum length
 */
export function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength - 3) + "...";
}
