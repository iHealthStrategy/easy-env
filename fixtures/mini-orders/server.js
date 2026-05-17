// Clean reference implementation of an asynchronous order pipeline.
// One Node process plays three roles: Express API, in-process worker, and a
// trivial in-process mock of a payment provider. Mongo stores orders /
// outbox_events / inventory / audit_log. Redis stores idempotency keys.
const express = require('express');
const { MongoClient } = require('mongodb');
const Redis = require('ioredis');
const crypto = require('crypto');

const MONGO_URL = process.env.MONGO_URL || 'mongodb://localhost:27018';
const DB_NAME = process.env.DB_NAME || 'mini';
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6380';
const PORT = process.env.PORT || 4100;
const WORKER_INTERVAL_MS = Number(process.env.WORKER_INTERVAL_MS || 100);
const IDEMP_TTL_S = Number(process.env.IDEMP_TTL_S || 60);

const freshId = () => crypto.randomBytes(8).toString('hex');

async function mockPayment({ orderId }) {
  return { ok: true, paymentRef: `pay_${orderId.slice(0, 8)}` };
}

async function main() {
  const client = await MongoClient.connect(MONGO_URL);
  const db = client.db(DB_NAME);
  const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 1 });
  const app = express();
  app.use(express.json());

  app.post('/inventory/init', async (req, res) => {
    const { sku, stock } = req.body;
    await db.collection('inventory').updateOne(
      { _id: sku },
      { $set: { sku, stock, updatedAt: new Date() } },
      { upsert: true }
    );
    res.json({ ok: true });
  });

  app.post('/orders', async (req, res) => {
    const { idempotencyKey, userId, items } = req.body;
    if (!idempotencyKey) return res.status(400).json({ error: 'missing idempotencyKey' });

    const existing = await redis.get(`idemp:${idempotencyKey}`);
    if (existing) return res.json({ orderId: existing, replayed: true });

    const totalAmount = items.reduce((acc, it) => acc + it.qty * (it.unitPrice || 10), 0);
    const orderId = freshId();
    const now = new Date();

    await db.collection('orders').insertOne({
      _id: orderId,
      userId,
      items,
      totalAmount,
      status: 'pending',
      idempotencyKey,
      paymentRef: null,
      createdAt: now,
      updatedAt: now,
    });

    await db.collection('outbox_events').insertOne({
      _id: freshId(),
      orderId,
      type: 'OrderCreated',
      payload: { items, userId, totalAmount },
      processedAt: null,
      createdAt: now,
    });

    await redis.set(`idemp:${idempotencyKey}`, orderId, 'EX', IDEMP_TTL_S);

    res.json({ orderId, replayed: false });
  });

  app.get('/health', (_, res) => res.json({ ok: true }));
  app.get('/_debug/outbox-pending', async (_, res) => {
    const n = await db.collection('outbox_events').countDocuments({ processedAt: null });
    res.json({ pending: n });
  });

  async function processOnce() {
    const evt = await db
      .collection('outbox_events')
      .findOneAndUpdate(
        { processedAt: null },
        { $set: { processedAt: new Date() } },
        { returnDocument: 'before' }
      );
    if (!evt) return;
    const order = await db.collection('orders').findOne({ _id: evt.orderId });
    if (!order) return;

    const payment = await mockPayment({ orderId: order._id });

    for (const it of order.items) {
      await db
        .collection('inventory')
        .updateOne(
          { _id: it.sku },
          { $inc: { stock: -it.qty }, $set: { updatedAt: new Date() } }
        );
    }

    await db.collection('audit_log').insertOne({
      _id: freshId(),
      orderId: order._id,
      action: 'order_paid',
      details: { paymentRef: payment.paymentRef, totalAmount: order.totalAmount },
      createdAt: new Date(),
    });

    await db.collection('orders').updateOne(
      { _id: order._id },
      { $set: { status: 'paid', paymentRef: payment.paymentRef, updatedAt: new Date() } }
    );
  }

  setInterval(() => {
    processOnce().catch((e) => console.error('worker error:', e.message));
  }, WORKER_INTERVAL_MS);

  return app;
}

main().then((app) => {
  app.listen(PORT, () => console.log(`[mini-orders clean] listening on :${PORT}`));
});
