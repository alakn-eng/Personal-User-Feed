import "dotenv/config";
import { createClient } from "@libsql/client";

async function main() {
  const client = createClient({
    url: process.env.TURSO_DATABASE_URL!,
    authToken: process.env.TURSO_AUTH_TOKEN!,
  });

  const result = await client.execute(
    "SELECT ci.content_id, ci.creator_id, ci.title, ci.content_url, ci.published_at, c.name AS creator_name, c.external_id AS feed_url FROM content_items ci JOIN creators c ON ci.creator_id = c.creator_id WHERE ci.source_type = 'rss' ORDER BY ci.published_at DESC LIMIT 5"
  );

  console.log(result.rows);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
