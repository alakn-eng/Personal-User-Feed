import "dotenv/config";
import { drizzle } from "drizzle-orm/libsql";
import { createClient } from "@libsql/client";
import { createRssRepository, RssIngestionService } from "../src/rss";

async function main() {
  const client = createClient({
    url: process.env.TURSO_DATABASE_URL!,
    authToken: process.env.TURSO_AUTH_TOKEN!,
  });

  const db = drizzle(client);
  const repo = createRssRepository(db);
  const service = new RssIngestionService(repo, "temp-user");

  // Introspect sources
  const sources = await repo.getUserSources("temp-user");
  console.log("Sources:", sources);

  console.log("Fetching posts...");
  const posts = await repo.getLatestPosts("temp-user", 10);
  console.log("Repo posts:", posts);
  const servicePosts = await service.getLatestPosts(10);
  console.log("Service posts:", servicePosts);
  if (Array.isArray(posts)) {
    console.log("Posts length:", posts.length);
    console.log("First post:", posts[0]);
  } else {
    console.log("Posts is not an array!");
  }

  console.log("Done");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
