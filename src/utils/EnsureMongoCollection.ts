import { Async } from "@ninjs/vef"
import { Db, IndexDescription, IndexDirection } from "mongodb";
import pMemoize from "p-memoize";
import { Logger } from "@ninjs/mklogger"

export class CollectionOptions<TEntity extends Object> {
  constructor(
    readonly name: string,
    readonly ownerIdField: keyof TEntity,
    readonly indexes = Array.of<IndexDescription & { key: Partial<{ [TProp in keyof TEntity]: IndexDirection }> }>(),
  ) { }
}

export const ensureMongoCollection = pMemoize(async <TEntity>(key: string, db: Db, options: CollectionOptions<TEntity>, logger?: Logger) => {

  const collection = db.collection(key);
  const collections = await db.listCollections().toArray();

  if (!collections.some(({ name }) => name === options.name)) {
    logger?.info(`100|CreateMongoCollection|key#${key}|name#${options.name}`)
    await db.createCollection(options.name, {});
  }

  const indexes = await collection.listIndexes().toArray();
  await Async.sequential(
    options.indexes.filter(next => indexes.every(({ name }) => name !== next.name)),
    async (next) => {
      logger?.info(`100|CreateMongoIndex|key#${key}|collection#${options.name}|index#${next.name}`)
      await collection.createIndex(next.key, {
        name: next.name
      });
    }
  );
})
