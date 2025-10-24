# Gmail Integration Feature

This document explains the Gmail integration feature that ingests Substack newsletter emails.

## Overview

The Gmail integration allows users to:
1. Connect their Gmail account (read-only access)
2. Automatically scan for Substack newsletter emails
3. Extract and save Substack posts to the unified content feed
4. Run daily syncs to fetch new posts

## Architecture

### File Structure
```
src/gmail/
├── auth-google.ts      # Gmail OAuth authentication
├── gmail-ingest.ts     # Email parsing and ingestion logic
├── crypto.ts           # Token encryption utilities
└── index.ts            # Module exports

scripts/
└── dailySync.ts        # Standalone cron job script

dev-fixtures/
└── substack-sample.json # Mock Gmail data for testing

tests/
└── gmail-ingest.spec.ts # Unit tests
```

### Database Tables
- `gmail_connections`: Stores encrypted Gmail OAuth tokens
- `gmail_processed_messages`: Tracks processed emails (prevents duplicates)

### How It Works
1. User clicks "Connect Gmail" button (feature-flagged)
2. OAuth flow grants read-only access to Gmail
3. Tokens are encrypted and stored in database
4. Daily cron job runs `scripts/dailySync.ts`
5. Script fetches Substack emails, parses posts, saves to `content_items`

## Setup

### 1. Environment Variables

Add to your `.env` file:

```bash
# Enable Gmail feature
FEATURE_GMAIL_INGEST=on

# Gmail OAuth (uses same Google credentials as YouTube)
GOOGLE_GMAIL_REDIRECT_URI=http://localhost:3000/integrations/gmail/callback

# Encryption key (REQUIRED - generate a new one!)
# Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
ENCRYPTION_KEY=your-64-character-hex-key-here

# Optional: Use mock data for testing
MOCK_GMAIL=off
```

### 2. Google Cloud Console Setup

Add Gmail API scope and redirect URI:

1. Go to https://console.cloud.google.com/apis/credentials
2. Click on your OAuth 2.0 Client ID
3. Under "Authorized redirect URIs", add:
   - `http://localhost:3000/integrations/gmail/callback` (development)
   - `https://yourdomain.com/integrations/gmail/callback` (production)
4. Save changes

### 3. Database Migration

Run migration to create Gmail tables:

```bash
bun run db:init
```

This creates:
- `gmail_connections` table
- `gmail_processed_messages` table

### 4. Start Server

```bash
bun run dev
```

The Gmail button will appear next to the YouTube button if `FEATURE_GMAIL_INGEST=on`.

## Usage

### Manual Testing with Mock Data

Test without connecting real Gmail:

```bash
MOCK_GMAIL=on FEATURE_GMAIL_INGEST=on bun run scripts/dailySync.ts
```

This uses `dev-fixtures/substack-sample.json` instead of real Gmail API.

### Connect Real Gmail

1. Start server with `FEATURE_GMAIL_INGEST=on`
2. Click "Connect Gmail" button on homepage
3. Authorize read-only Gmail access
4. Run manual sync:

```bash
FEATURE_GMAIL_INGEST=on bun run scripts/dailySync.ts
```

### Daily Cron Job

Add to crontab for daily 9am sync:

```bash
0 9 * * * cd /path/to/project && FEATURE_GMAIL_INGEST=on bun run scripts/dailySync.ts >> logs/sync.log 2>&1
```

Or use node-cron in your server (future enhancement).

## Testing

Run unit tests:

```bash
bun test tests/gmail-ingest.spec.ts
```

Tests use in-memory SQLite and mock fixture data.

## API Endpoints

When `FEATURE_GMAIL_INGEST=on`:

- `GET /integrations/gmail/auth` - Initiate Gmail OAuth
- `GET /integrations/gmail/callback` - OAuth callback
- `GET /api/gmail/status` - Check if user connected Gmail

## How Substack Emails Are Parsed

1. **Email Filter**: Searches Gmail for `from:substack.com newer_than:7d`
2. **HTML Extraction**: Decodes base64 email body
3. **URL Parsing**: Extracts Substack post URL with regex: `https?://[^/]+\.substack\.com\/p\/[^\s"'<>]+`
4. **Author Extraction**: Parses "From" header for author name/email
5. **Deduplication**: Uses SHA-256 hash of `postUrl:title:author`

## Feature Flag Behavior

### When `FEATURE_GMAIL_INGEST=off` (default):
- Gmail button does NOT appear
- Gmail routes NOT registered
- `/api/config` returns `gmail: false`
- Daily sync script exits immediately
- **Existing YouTube functionality unchanged**

### When `FEATURE_GMAIL_INGEST=on`:
- Gmail button appears dynamically
- Gmail OAuth routes active
- Substack posts appear in feed
- Daily sync processes all users

## Security

- **OAuth tokens encrypted at rest** using AES-256-GCM
- **Read-only Gmail access** (cannot send/delete emails)
- **ENCRYPTION_KEY must be 64 hex characters** (32 bytes)
- Generate unique key per environment (dev/prod)

## Troubleshooting

### Gmail button doesn't appear
- Check `FEATURE_GMAIL_INGEST=on` in .env
- Check `ENCRYPTION_KEY` is set
- Check browser console for errors
- Verify `/api/config` returns `gmail: true`

### OAuth fails
- Add callback URL to Google Cloud Console
- Check `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`
- Ensure redirect URI matches exactly

### No posts ingested
- Check daily sync logs
- Verify Gmail connection: `GET /api/gmail/status`
- Check for Substack emails in last 7 days
- Try with `MOCK_GMAIL=on` first

### Duplicate posts
- System uses content hash to prevent duplicates
- Re-running sync should skip existing posts
- Check `gmail_processed_messages` table

## Future Enhancements

- [ ] Support other newsletter providers (Beehiiv, ConvertKit)
- [ ] Configurable sync frequency per user
- [ ] Web UI for manual sync trigger
- [ ] Email preview/snippet extraction
- [ ] Author avatar fetching from Substack profiles
