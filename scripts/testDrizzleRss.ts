import "dotenv/config";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { contentItemsTable, creatorsTable } from "../schema";
import { desc, eq } from "drizzle-orm";

async function main() {
  const client = createClient({
    url: process.env.TURSO_DATABASE_URL!,
    authToken: process.env.TURSO_AUTH_TOKEN!,
  });

  const db = drizzle(client);

  const rows = await db
    .select({
      contentId: contentItemsTable.contentId,
      creatorId: contentItemsTable.creatorId,
      sourceType: contentItemsTable.sourceType,
      title: contentItemsTable.title,
      publishedAt: contentItemsTable.publishedAt,
      creatorName: creatorsTable.name,
    })
    .from(contentItemsTable)
    .innerJoin(
      creatorsTable,
      eq(creatorsTable.creatorId, contentItemsTable.creatorId)
    )
    .where(eq(contentItemsTable.sourceType, "rss"))
    .orderBy(desc(contentItemsTable.publishedAt))
    .limit(5);

  console.log(rows);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
