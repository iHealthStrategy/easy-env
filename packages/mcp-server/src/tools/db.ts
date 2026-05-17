// Data-access MCP tools. All operations are SCOPED to envIds easy-env owns
// in its registry. Calls referencing an unknown envId are rejected.
//
// This is the v1 mitigation for "AI has direct db.update/delete on prod" —
// we never operate against URLs the agent could craft; we only operate
// against per-session containers easy-env spawned.
import { z } from 'zod';
import { MongoClient, type Document, type Filter, type UpdateFilter } from 'mongodb';
import type { ToolContext } from '../core/context.js';

async function ensureManagedEnv(envId: string, ctx: ToolContext) {
  const env = await ctx.registry.get(envId);
  if (!env) {
    throw new Error(
      `db.* operations can only target environments owned by this easy-env server. envId "${envId}" is not in the registry. Call env.up first, or env.list to see available ones.`,
    );
  }
  if (env.status !== 'ready') {
    throw new Error(`env ${envId} is not ready (status=${env.status})`);
  }
  if (!env.resolved.mongoUrl) {
    throw new Error(`env ${envId} has no Mongo backend`);
  }
  return env;
}

async function withMongo<T>(
  envId: string,
  ctx: ToolContext,
  fn: (client: MongoClient, dbName: string) => Promise<T>,
): Promise<T> {
  const env = await ensureManagedEnv(envId, ctx);
  const client = await MongoClient.connect(env.resolved.mongoUrl!);
  try {
    return await fn(client, env.resolved.dbName);
  } finally {
    await client.close();
  }
}

// --- db.seed ---------------------------------------------------------------

export const DbSeedInput = z.object({
  envId: z.string(),
  // Inline seed: { collectionName: [docs...] }
  documents: z.record(z.string(), z.array(z.record(z.string(), z.unknown()))).optional(),
}).refine((i) => i.documents !== undefined, 'Provide documents for v1');

export async function runDbSeed(input: z.infer<typeof DbSeedInput>, ctx: ToolContext) {
  const summary: Record<string, number> = {};
  await withMongo(input.envId, ctx, async (client, dbName) => {
    const db = client.db(dbName);
    for (const [name, docs] of Object.entries(input.documents ?? {})) {
      if (docs.length === 0) {
        summary[name] = 0;
        continue;
      }
      const res = await db.collection(name).insertMany(docs as Document[]);
      summary[name] = res.insertedCount;
    }
  });
  return { envId: input.envId, inserted: summary };
}

export const dbSeedToolDescription = {
  name: 'db.seed',
  description:
    "Insert initial documents into a managed environment's Mongo. Pass { documents: { collection: [...] } } to inline-seed multiple collections in one call. Use this to set up the precondition state before scenario.replay.",
  inputSchema: DbSeedInput,
};

// --- db.find ---------------------------------------------------------------

export const DbFindInput = z.object({
  envId: z.string(),
  collection: z.string(),
  query: z.record(z.string(), z.unknown()).default({}),
  projection: z.record(z.string(), z.unknown()).optional(),
  limit: z.number().int().positive().max(1000).default(50),
  sort: z.record(z.string(), z.union([z.literal(1), z.literal(-1)])).optional(),
});

export async function runDbFind(input: z.infer<typeof DbFindInput>, ctx: ToolContext) {
  return withMongo(input.envId, ctx, async (client, dbName) => {
    const cursor = client
      .db(dbName)
      .collection(input.collection)
      .find(input.query as Filter<Document>, {
        projection: input.projection,
        limit: input.limit,
        sort: input.sort as Record<string, 1 | -1> | undefined,
      });
    const docs = await cursor.toArray();
    return {
      envId: input.envId,
      collection: input.collection,
      count: docs.length,
      docs,
    };
  });
}

export const dbFindToolDescription = {
  name: 'db.find',
  description:
    'Query a collection in a managed environment. Default limit 50, max 1000. Use this for targeted inspection; use state.capture when you want a full multi-collection snapshot for diffing.',
  inputSchema: DbFindInput,
};

// --- db.insert -------------------------------------------------------------

export const DbInsertInput = z.object({
  envId: z.string(),
  collection: z.string(),
  docs: z.array(z.record(z.string(), z.unknown())).min(1),
});

export async function runDbInsert(input: z.infer<typeof DbInsertInput>, ctx: ToolContext) {
  return withMongo(input.envId, ctx, async (client, dbName) => {
    const res = await client
      .db(dbName)
      .collection(input.collection)
      .insertMany(input.docs as Document[]);
    return {
      envId: input.envId,
      collection: input.collection,
      insertedCount: res.insertedCount,
      insertedIds: Object.values(res.insertedIds),
    };
  });
}

export const dbInsertToolDescription = {
  name: 'db.insert',
  description: 'Insert one or more documents into a collection of a managed environment.',
  inputSchema: DbInsertInput,
};

// --- db.update -------------------------------------------------------------

export const DbUpdateInput = z.object({
  envId: z.string(),
  collection: z.string(),
  filter: z.record(z.string(), z.unknown()),
  update: z.record(z.string(), z.unknown()),
  multi: z.boolean().default(false),
});

export async function runDbUpdate(input: z.infer<typeof DbUpdateInput>, ctx: ToolContext) {
  return withMongo(input.envId, ctx, async (client, dbName) => {
    const coll = client.db(dbName).collection(input.collection);
    const filter = input.filter as Filter<Document>;
    const update = input.update as UpdateFilter<Document>;
    const res = input.multi
      ? await coll.updateMany(filter, update)
      : await coll.updateOne(filter, update);
    return {
      envId: input.envId,
      collection: input.collection,
      matchedCount: res.matchedCount,
      modifiedCount: res.modifiedCount,
    };
  });
}

export const dbUpdateToolDescription = {
  name: 'db.update',
  description:
    'Update documents in a managed environment. `update` must be a Mongo update document (e.g. { $set: {...} }). Set multi:true to update all matches; otherwise only the first.',
  inputSchema: DbUpdateInput,
};

// --- db.delete -------------------------------------------------------------

export const DbDeleteInput = z.object({
  envId: z.string(),
  collection: z.string(),
  filter: z.record(z.string(), z.unknown()),
  multi: z.boolean().default(false),
});

export async function runDbDelete(input: z.infer<typeof DbDeleteInput>, ctx: ToolContext) {
  return withMongo(input.envId, ctx, async (client, dbName) => {
    const coll = client.db(dbName).collection(input.collection);
    const filter = input.filter as Filter<Document>;
    const res = input.multi
      ? await coll.deleteMany(filter)
      : await coll.deleteOne(filter);
    return {
      envId: input.envId,
      collection: input.collection,
      deletedCount: res.deletedCount,
    };
  });
}

export const dbDeleteToolDescription = {
  name: 'db.delete',
  description:
    'Delete documents in a managed environment. Set multi:true to delete all matches; otherwise only the first. Refuses to operate on envIds easy-env does not own.',
  inputSchema: DbDeleteInput,
};
