• Mockup Overview

  - Single-column feed centered in a 1200 px max-width layout with generous 48 px top/bottom padding and pastel gradient background (#F6F7FB → #F0F5FF) to keep focus on
    cards.
  - Sticky header (72 px) carrying brand mark “YourFeed”, search, and profile pill; on scroll it compresses to 56 px.
  - Left edge hosts slim “Sources” rail (fixed width 220 px) with grouped icons for YouTube, Substack, and a “+ Add source” CTA; mobile collapses it into an off-canvas
    drawer.

  Feed Structure

  - Each post card uses a 16:9 media preview up top, 24 px padding, soft shadow, and rounded corners (18 px).
  - Metadata row (avatar, source icon, channel/author, publish time) sits above title; description uses a two-line clamp with “Read more” or “Watch on YouTube” CTA.
  - Actions row keeps everything personal: Mark as read, Save, and Open original, plus a subtle progress bar for videos showing watch completion.

  User Flow & States

  - Empty state: friendly illustration and “Connect your first source” button; once sources sync, show skeleton loaders that match card structure.
  - Filtering: top of feed hosts segmented control (All, Videos, Articles, Saved) and a compact dropdown for ordering (Newest, Oldest, Longest, Shortest).
  - Notifications tray in header surfaces sync issues (e.g., “Substack auth expired”).