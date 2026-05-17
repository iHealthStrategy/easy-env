const express = require('express');
const { MongoClient } = require('mongodb');
const crypto = require('crypto');

const MONGO_URL = process.env.MONGO_URL || 'mongodb://localhost:27018';
const DB_NAME = process.env.DB_NAME || 'mini';
const PORT = process.env.PORT || 4000;

const freshId = () => crypto.randomBytes(8).toString('hex');

async function main() {
  const client = await MongoClient.connect(MONGO_URL);
  const db = client.db(DB_NAME);
  const app = express();
  app.use(express.json());

  // POST /posts — create a new post (+ audit_log)
  app.post('/posts', async (req, res) => {
    const { title, content, state = 'DRAFT', author } = req.body;
    const now = new Date();
    const post = {
      _id: freshId(),
      title,
      content,
      state,
      author,
      createdAt: now,
      updatedAt: now,
      publishedAt: state === 'AVAILABLE' ? now : null,
    };
    await db.collection('posts').insertOne(post);
    await db.collection('audit_log').insertOne({
      _id: freshId(),
      postId: post._id,
      origin: 'insertPost',
      state: post.state,
      createdAt: now,
    });
    res.json({ post });
  });

  // PATCH /posts/:id/publish — change state (conditionally update publishedAt)
  app.patch('/posts/:id/publish', async (req, res) => {
    const { id } = req.params;
    const { state } = req.body;
    const now = new Date();
    const update = { $set: { state, updatedAt: now } };
    if (state === 'AVAILABLE') update.$set.publishedAt = now;
    await db.collection('posts').updateOne({ _id: id }, update);
    await db.collection('audit_log').insertOne({
      _id: freshId(),
      postId: id,
      origin: 'updatePost',
      state,
      createdAt: now,
    });
    res.json({ ok: true });
  });

  // POST /follows — saveFollow upsert (handles first follow + toggle)
  app.post('/follows', async (req, res) => {
    const { selfId, otherId, status } = req.body;
    const now = new Date();
    const existing = await db
      .collection('follows')
      .findOne({ selfId, otherId });
    if (!existing) {
      await db.collection('follows').insertOne({
        _id: freshId(),
        selfId,
        otherId,
        status,
        createdAt: now,
        updatedAt: now,
      });
    } else {
      await db
        .collection('follows')
        .updateOne(
          { selfId, otherId },
          { $set: { status, updatedAt: now } }
        );
    }
    res.json({ ok: true });
  });

  // GET /health
  app.get('/health', (req, res) => res.json({ ok: true }));

  app.listen(PORT, () => {
    console.log(`[mini-app clean] listening on :${PORT}`);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
