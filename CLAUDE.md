# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Curator's Desk** is a multi-source personal feed aggregator that consolidates content from YouTube, Substack, Twitter, blogs, and other sources into a single unified interface. The app emphasizes intentional content curation and thoughtful consumption.

## Architecture

This is an Express.js web application with a unified content model:

- **Frontend**: Static HTML/CSS/JS served by Express
  - `index.html` - Main application shell with semantic markup
  - `styles.css` - Design system with CSS custom properties for theming
  - `youtube.js` - Client-side feed integration

- **Backend** (Express + TypeScript + Turso):
  - `server.ts` - Express server with routes for OAuth, API endpoints, and static file serving
  - `schema.ts` - Unified database schema using Drizzle ORM (supports multiple content sources)
  - `youtube.ts` - YouTube-specific service implementation (API integration, OAuth flow, content ingestion)
  - `db-init.ts` - Database initialization script for Turso
  - Uses Drizzle ORM with Turso (libSQL/SQLite in the cloud) for data persistence
  - Implements repository pattern for data access

## Database Schema (Unified Multi-Source Model)

The database is designed to support multiple content sources (YouTube, Substack, Twitter, RSS, blogs, etc.) in a single unified structure:

### Core Tables

- **`users`** - User accounts (will be managed via Magic.link authentication)
- **`connected_sources`** - Tracks which external services each user has connected (YouTube account, Twitter, etc.)
- **`creators`** - Universal table for all content creators across platforms (YouTubers, Substack writers, Twitter accounts, blog authors)
- **`user_subscriptions`** - Which creators each user follows (regardless of platform)
- **`content_items`** - All content (videos, articles, tweets, blog posts) in one table

### Supporting Tables

- **`user_read_status`** - Tracks what content users have viewed/read
- **`user_pins`** - User-pinned content
- **`user_saves`** - Bookmarked/saved content
- **`user_preferences`** - Feed settings, sync frequency, notification preferences
- **`sync_jobs`** - Tracks background sync operations

### Design Benefits

- Single query to get all content across all sources
- Easy filtering by `source_type` (youtube, substack, twitter, rss, blog)
- Adding new sources requires NO schema changes - just add a new `source_type`
- Each creator/content has a `metadata` JSON field for platform-specific data

## Key Flows

### YouTube Authentication & Sync
1. User clicks "Connect YouTube" button → `/auth/youtube`
2. Backend generates OAuth URL via `createAuthUrl()`
3. User authorizes, Google redirects to `/auth/youtube/callback`
4. Backend exchanges code for tokens via `exchangeCodeForTokens()`
5. Tokens saved to `connected_sources` table
6. `YouTubeIngestionService.syncUserSubscriptions()` fetches all subscriptions from YouTube API
7. Channels stored as `creators` with `source_type: 'youtube'`
8. User subscriptions stored in `user_subscriptions` table
9. `syncUploads()` fetches recent videos from each channel
10. Videos stored as `content_items` with `source_type: 'youtube'` and `media_type: 'video'`

### Adding New Content Sources (Future: Substack, Twitter, Blogs)

To add a new source:
1. Create a new service file (e.g., `substack.ts`, `twitter.ts`, `rss.ts`)
2. Implement OAuth/auth flow specific to that platform
3. Save connection to `connected_sources` with appropriate `source_type`
4. Fetch creators → insert into `creators` with matching `source_type`
5. Fetch content → insert into `content_items` with matching `source_type`
6. Use `metadata` JSON field for platform-specific attributes
7. NO database schema changes needed

## Development Commands

### Initial Setup
```bash
# Install dependencies
npm install

# Copy environment template
cp .env.example .env

# Set up Turso database
# 1. Install Turso CLI: https://docs.turso.tech/cli/installation
# 2. Create database: turso db create curators-desk
# 3. Get credentials: turso db show curators-desk --url
# 4. Create token: turso db tokens create curators-desk
# 5. Add credentials to .env file

# Initialize database tables
npm run db:init
```

### Running the Application
```bash
# Development mode (auto-restarts on file changes)
npm run dev

# Production build
npm run build

# Production mode
npm start
```

The app will be available at `http://localhost:3000`

### Required Credentials

#### Turso Database
1. Go to [turso.tech](https://turso.tech) and sign up
2. Install Turso CLI
3. Create database and get connection credentials
4. Add to `.env` file

#### Google OAuth (YouTube)
1. Go to [Google Cloud Console](https://console.cloud.google.com/apis/credentials)
2. Create a new project or select existing one
3. Enable YouTube Data API v3
4. Create OAuth 2.0 credentials
5. Add `http://localhost:3000/auth/youtube/callback` as an authorized redirect URI
6. Copy Client ID and Client Secret to your `.env` file

#### Magic.link Authentication
1. Go to [magic.link/dashboard](https://magic.link/dashboard) and sign up
2. Create a new app
3. Copy Secret Key and Publishable Key to your `.env` file

## Design Philosophy

The UI follows a "curator's desk" metaphor:
- Content organized into sections: Reading, Watching, Miscellany
- Pinning system allows users to surface important content
- Filter bar for quick content type switching (All, Reading, Watching, Misc, Pinned)
- Warm color palette (#fdfcf9 background) with accent color #d66761
- Fixed navbar with search and profile controls
- Emphasis on intentional consumption over algorithmic recommendations

## Adding New Features

### Adding a new content source
1. Create service file following `youtube.ts` pattern
2. Implement OAuth/API integration
3. Map platform data to unified schema (`creators`, `content_items`)
4. Add routes in `server.ts`
5. Update frontend to display new content type

### Adding cron jobs for feed refresh
Use `node-cron` to schedule periodic sync operations:
```typescript
import cron from 'node-cron';

// Run every 6 hours
cron.schedule('0 */6 * * *', async () => {
  // Sync all users' content
});
```

## Important Notes

- Currently using temporary user ID (`temp-user`) - Magic.link auth integration pending
- Pin functionality placeholder exists but needs full implementation
- No real-time updates yet - relies on periodic syncs
- Video duration parsing from ISO 8601 format handled in `youtube.ts`
