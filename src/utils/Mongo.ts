import { MongoClient } from "mongodb"
import pMemoize from "p-memoize";

export const useMongo = pMemoize(async (overrideUri?: string, overrideDBName?: string) => {
  const client = new MongoClient(overrideUri ?? process.env["MONGODB_URI"]);

  await client.connect();

  const db = client.db(overrideDBName ?? process.env["MONGODB_DATABASE_NAME"]);

  return db;
})
