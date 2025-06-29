import { Collection, Filter, FilterOperators, SortDirection } from "mongodb";
import { useMongo } from "./utils/Mongo";
import { CollectionOptions, ensureMongoCollection } from "./utils/EnsureMongoCollection";
import { assert } from "ts-essentials";
import { ServerEntity, ServerEntityStore, Injector, EntityOwner, PartialRecord, Cursor, EntityPatch } from "@ninjs/vef";

export class MongoServerEntityStore<TEntity extends ServerEntity> implements ServerEntityStore<TEntity> {

  readonly owners = Injector.bind("OwnerStore") as () => MongoServerEntityStore<EntityOwner>

  constructor(
    readonly key: InjectedServiceType,
    readonly options: CollectionOptions<TEntity>,
    readonly pageSize = 100,
    readonly enableContinueFromCursor = false,
  ) { }

  tryParseCursor(cursor = "") {

    const [start, count, continueFrom] = cursor.split("|", 3)
    return {
      skip: parseInt(start) || 0,
      take: Math.min(parseInt(count) || this.pageSize, this.pageSize),
      continueFrom: continueFrom
    }
  }
  mkCursor(lastSkip: number, take: number, lastId: string) {

    const cursor = `${lastSkip + take}|${take}`
    if (!this.enableContinueFromCursor) {
      return cursor
    }

    return `${cursor}|${lastId || ""}`
  }

  async useCollection() {
    const mongo = await useMongo();

    await ensureMongoCollection(this.options.name, mongo, this.options);

    const collection = mongo.collection<ServerEntity>(this.options.name);

    return collection
  }

  async useOwnerCollection() {
    return this.owners().useCollection()
  }
  async getOwnerUserIds(ownerId: string) {
    const collection = await this.useOwnerCollection() as any as Collection<EntityOwner>
    const query = collection.find({
      userIds: ownerId
    })

    const owners = await query.toArray()
    return owners.flatMap(owner => owner.userIds)
  }

  async findOne(id: string, pick?: PartialRecord<keyof TEntity, number>) {

    const collection = await this.useCollection();

    const one = await collection.findOne<TEntity>({
      _id: {
        $eq: id
      }
    }, { projection: pick });

    return one;
  }
  async findOneWithOwner(ownerId: string, id: string, pick?: PartialRecord<keyof TEntity, number>) {

    const query: Filter<TEntity> = {}
    if (this.options.ownerIdField !== "_id") {
      query._id = {
        $eq: id
      } as FilterOperators<any>
    }
    const { entities } = await this.searchWithOwner(ownerId, query, undefined, pick)

    return entities.at(0)
  }

  async findMany(ids: string[], pick?: PartialRecord<keyof TEntity, number>) {
    if (ids.length === 0) {
      return [];
    }

    ids = Array.from(new Set(ids))

    const collection = await this.useCollection();

    const many = await collection.find<TEntity>({
      _id: {
        $in: ids
      }
    }, { projection: pick }).toArray();

    const byId = many
      .reduce((agg, next) => agg.set(next._id, next), new Map<string, TEntity>());

    return ids.map(id => byId.get(id)).filter(Boolean)
  }
  async findManyWithOwner(ownerId: string, ids: string[], pick?: PartialRecord<keyof TEntity, number>) {
    if (ids.length === 0) {
      return [];
    }

    const { entities } = await this.searchWithOwner(ownerId, {
      _id: {
        $in: ids
      }
    } as any, undefined, pick, undefined)

    const byId = entities
      .reduce((agg, next) => agg.set(next._id, next), new Map<string, TEntity>());

    return ids.map(id => byId.get(id)).filter(Boolean)
  }

  async search(query: Filter<TEntity>, cursor?: string, pick?: PartialRecord<keyof TEntity, number>, sort?: PartialRecord<keyof TEntity, SortDirection>) {

    const hasSort = !!sort
    const collection = await this.useCollection();

    const { skip, take, continueFrom } = this.tryParseCursor(cursor);
    if (this.enableContinueFromCursor && continueFrom && !hasSort) {
      query = {
        $and: [
          query,
          {
            _id: {
              $gt: continueFrom
            }
          }
        ].filter(Boolean)
      } as Filter<TEntity>
    }

    if (this.enableContinueFromCursor && !hasSort) {
      sort = {
        _id: 1
      } as any
    }

    let builder = collection.find<TEntity>(query)

    if (sort) {
      builder = builder.sort(sort)
    }
    if (skip && !continueFrom) {
      builder = builder.skip(skip)
    }
    if (pick) {
      builder = builder.project(pick)
    }

    const entities = await builder.limit(take).toArray();

    const nextCursor = entities.length < take ? ""
      : hasSort ? this.mkCursor(skip, take, undefined)
        : this.mkCursor(skip, take, entities.at(-1)?._id)
    return new Cursor(entities, nextCursor);
  }
  async searchWithOwner(ownerId: string, query: Filter<TEntity>, cursor?: string, pick?: PartialRecord<keyof TEntity, number>, sort?: PartialRecord<keyof TEntity, SortDirection>) {

    const hasSort = !!sort

    const { skip, take, continueFrom } = this.tryParseCursor(cursor);
    if (this.enableContinueFromCursor && continueFrom && !hasSort) {
      query = {
        $and: [
          {
            _id: {
              $gt: continueFrom
            }
          },
          query
        ]
      } as Filter<TEntity>
    }

    if (this.enableContinueFromCursor && !hasSort) {
      sort = {
        _id: 1
      } as any
    }

    const userIds = await this.getOwnerUserIds(ownerId)
    query = {
      $and: [
        {
          [this.options.ownerIdField]: {
            $in: userIds
          }
        },
        query
      ]
    } as Filter<TEntity>

    const collection = await this.useCollection()
    let builder = collection.find<TEntity>(query)

    if (sort) {
      builder = builder.sort(sort)
    }
    if (skip && !continueFrom) {
      builder = builder.skip(skip)
    }
    if (pick) {
      builder = builder.project(pick)
    }
    const entities = await builder.limit(take).toArray();

    const ownedEntities = entities.map((entity) => {
      // instead of requiring a mutate on every document, we'll just override it
      (entity as any)[this.options.ownerIdField] = ownerId

      return entity
    })

    const nextCursor = entities.length < take ? ""
      : hasSort ? this.mkCursor(skip, take, undefined)
        : this.mkCursor(skip, take, entities.at(-1)?._id)
    return new Cursor<TEntity>(ownedEntities as TEntity[], nextCursor);
  }

  async allWithOwner(ownerId: string): Promise<TEntity[]> {

    const acc = Array.of<TEntity>()
    let continueFrom = undefined
    do {

      const { entities, next } = await this.searchWithOwner(ownerId, {}, continueFrom)

      acc.push(...entities)
      continueFrom = next
    } while (continueFrom)

    return acc
  }
  async firstWithOwner(ownerId: string, query: Filter<TEntity> = {}): Promise<TEntity> {

    const { entities } = await this.searchWithOwner(ownerId, query, "0|1")

    return entities.at(0)
  }

  async set(id: string, entity: TEntity, filter: Filter<TEntity> = {}) {

    const collection = await this.useCollection();
    const { modifiedCount, upsertedCount } = await collection.replaceOne({
      ...filter,
      _id: {
        $eq: id
      } as FilterOperators<string>
    }, entity, { upsert: true })

    return modifiedCount + upsertedCount;
  }

  async patch(id: string, patch: Partial<TEntity>, filter: Filter<TEntity> = {}) {
    assert(patch._id === undefined, `500|CannotPatchEntityId|entityType#${this.key}|entityId#${id}|patch#${JSON.stringify(patch)}`)

    const collection = await this.useCollection();
    try {
      const { modifiedCount, upsertedCount } = await collection.updateOne({
        ...filter,
        _id: {
          $eq: id
        } as FilterOperators<string>
      }, {
        $set: patch,
      }, { upsert: false })

      return modifiedCount + upsertedCount;
    } catch (err) {
      throw err
    }

  }

  async patchMany(patches: EntityPatch<TEntity>[]) {
    if (patches.length === 0) {
      return 0;
    }
    const invalidPatches = patches.filter(({ values }) => values._id !== undefined)
    assert(invalidPatches.length === 0, `500|CannotPatchEntityId|entityType#${this.key}|patches#${JSON.stringify(invalidPatches)}`)

    const collection = await this.useCollection();
    const results = await collection.bulkWrite(patches.map(({ _id, values, filter = {} }) => ({
      updateOne: {
        update: {
          $set: values
        },
        upsert: true,
        filter: {
          ...filter,
          _id: {
            $eq: _id
          }
        }
      }
    })))

    return results.insertedCount + results.upsertedCount;
  }

  async unset(id: string) {

    const collection = await this.useCollection();
    const { deletedCount } = await collection.deleteOne({
      _id: {
        $eq: id
      }
    })

    return deletedCount;
  }
}
