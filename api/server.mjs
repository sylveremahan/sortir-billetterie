import crypto from 'node:crypto';
import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import pg from 'pg';

const { Pool } = pg;
const app = express();
const port = Number(process.env.PORT || 8787);
const origin = process.env.APP_ORIGIN;
const secret = process.env.PAYSTACK_SECRET_KEY;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'disable' ? false : { rejectUnauthorized: process.env.PGSSL_REJECT_UNAUTHORIZED !== 'false' },
  max: 10,
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 30000,
});

app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false }));
app.use((req, res, next) => {
  if (req.headers.origin && req.headers.origin !== origin) return res.sendStatus(403);
  res.setHeader('Access-Control-Allow-Origin', origin || 'null');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/health', async (_req, res) => {
  try { await pool.query('SELECT 1'); res.json({ ok: true }); }
  catch { res.status(503).json({ ok: false }); }
});

// Keep raw bytes so webhook signatures are checked against the exact request body.
app.post('/api/payments/webhook', express.raw({ type: 'application/json', limit: '256kb' }), handleWebhook);
app.use(express.json({ limit: '16kb' }));

app.post('/api/payments/initialize', rateLimit({ windowMs: 60_000, limit: 12 }), async (req, res) => {
  if (!secret || !process.env.DATABASE_URL || !origin) return res.status(503).json({ error: 'Payment service is not configured.' });
  const { eventId, items, buyer } = req.body ?? {};
  const cleanBuyer = validateBuyer(buyer);
  const cleanItems = validateItems(items);
  if (!eventId || typeof eventId !== 'string' || eventId.length > 100 || !cleanBuyer || !cleanItems) {
    return res.status(400).json({ error: 'Check the event, ticket quantities, and buyer details.' });
  }

  let order;
  try {
    order = await reserveOrder(eventId, cleanItems, cleanBuyer);
    const amountMinor = (BigInt(order.amount_xof) * 100n).toString();
    const response = await paystack('/transaction/initialize', {
      method: 'POST',
      body: JSON.stringify({
        email: cleanBuyer.email,
        amount: amountMinor,
        currency: 'XOF',
        reference: order.reference,
        channels: ['mobile_money', 'card'],
        callback_url: origin + '/?payment=return',
        metadata: { order_reference: order.reference, event_id: eventId },
      }),
    });
    if (!response.status || !response.data?.authorization_url ||
        new URL(response.data.authorization_url).protocol !== 'https:' || new URL(response.data.authorization_url).hostname !== 'checkout.paystack.com') {
      throw new Error('Payment provider returned an invalid checkout URL.');
    }
    res.status(201).json({
      reference: order.reference,
      authorizationUrl: response.data.authorization_url,
      expiresAt: order.expires_at,
    });
  } catch (error) {
    if (order?.id) await releaseOrder(order.id, 'failed').catch(() => {});
    const status = error.code === 'NO_STOCK' ? 409 : 502;
    res.status(status).json({ error: status === 409 ? 'Some selected tickets are no longer available.' : 'Could not start the payment. Please retry.' });
  }
});

app.get('/api/payments/verify', async (req, res) => {
  const reference = typeof req.query.reference === 'string' ? req.query.reference : '';
  if (!/^[A-Za-z0-9.=\-]{8,80}$/.test(reference)) return res.status(400).json({ error: 'Invalid payment reference.' });
  try {
    const result = await verifyWithPaystack(reference);
    const state = await settle(reference, result);
    res.json({ reference, status: state });
  } catch {
    res.status(502).json({ error: 'Payment status is not available yet. Please refresh shortly.' });
  }
});

app.use((_req, res) => res.status(404).json({ error: 'Not found.' }));

function validateBuyer(b) {
  if (!b || typeof b !== 'object') return null;
  const firstName = text(b.firstName, 1, 80), lastName = text(b.lastName, 1, 80);
  const email = text(b.email, 3, 254).toLowerCase(), phone = text(b.phone, 7, 24);
  if (!firstName || !lastName || !email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !phone || !/^\+?[0-9 ()-]+$/.test(phone)) return null;
  return { firstName, lastName, email, phone };
}
function text(value, min, max) {
  return typeof value === 'string' && value.trim().length >= min && value.trim().length <= max
    ? value.trim().replace(/[\u0000-\u001f\u007f]/g, '') : null;
}
function validateItems(items) {
  if (!Array.isArray(items) || !items.length || items.length > 4) return null;
  const seen = new Set(); let total = 0;
  const result = [];
  for (const item of items) {
    if (!item || typeof item.ticketTypeId !== 'string' || item.ticketTypeId.length > 100 ||
        !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 8 ||
        seen.has(item.ticketTypeId)) return null;
    seen.add(item.ticketTypeId); total += item.quantity;
    if (total > 8) return null;
    result.push({ ticketTypeId: item.ticketTypeId, quantity: item.quantity });
  }
  return result;
}

async function reserveOrder(eventId, items, buyer) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await expireReservations(client);
    const ids = items.map(x => x.ticketTypeId).sort();
    const { rows } = await client.query(
      'SELECT t.*, e.active AS event_active FROM ticket_types t JOIN events e ON e.id=t.event_id WHERE t.id = ANY($1::text[]) ORDER BY t.id FOR UPDATE OF t',
      [ids],
    );
    if (rows.length !== items.length || rows.some(t => t.event_id !== eventId || !t.active || !t.event_active ||
      (t.sale_starts_at && new Date(t.sale_starts_at) > new Date()) ||
      (t.sale_ends_at && new Date(t.sale_ends_at) <= new Date()))) {
      const err = new Error('Unavailable ticket type'); err.code = 'NO_STOCK'; throw err;
    }
    const byId = new Map(rows.map(t => [t.id, t]));
    let amount = 0n;
    for (const item of items) {
      const type = byId.get(item.ticketTypeId);
      if (type.sold_count + type.reserved_count + item.quantity > type.capacity) {
        const err = new Error('Sold out'); err.code = 'NO_STOCK'; throw err;
      }
      amount += BigInt(type.price_xof) * BigInt(item.quantity);
    }
    const id = crypto.randomUUID();
    const reference = 'sortir-' + crypto.randomBytes(16).toString('hex');
    const { rows: inserted } = await client.query(
      `INSERT INTO payment_orders (id,reference,event_id,buyer_first_name,buyer_last_name,buyer_email,buyer_phone,amount_xof,expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now()+interval '10 minutes') RETURNING id,reference,amount_xof,expires_at`,
      [id, reference, eventId, buyer.firstName, buyer.lastName, buyer.email, buyer.phone, amount.toString()],
    );
    for (const item of items) {
      const type = byId.get(item.ticketTypeId);
      await client.query('INSERT INTO payment_order_items (order_id,ticket_type_id,quantity,unit_price_xof) VALUES ($1,$2,$3,$4)',
        [id, type.id, item.quantity, type.price_xof]);
      await client.query('UPDATE ticket_types SET reserved_count=reserved_count+$2 WHERE id=$1', [type.id, item.quantity]);
    }
    await client.query('COMMIT');
    return inserted[0];
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

async function expireReservations(client) {
  const { rows } = await client.query(
    `SELECT id FROM payment_orders WHERE status='pending' AND reservation_released_at IS NULL AND expires_at<=now()
     ORDER BY expires_at LIMIT 100 FOR UPDATE SKIP LOCKED`,
  );
  for (const row of rows) {
    const items = await client.query('SELECT ticket_type_id,quantity FROM payment_order_items WHERE order_id=$1 ORDER BY ticket_type_id', [row.id]);
    for (const item of items.rows) await client.query(
      'UPDATE ticket_types SET reserved_count=GREATEST(0,reserved_count-$2) WHERE id=$1',
      [item.ticket_type_id, item.quantity],
    );
    await client.query("UPDATE payment_orders SET status='expired',reservation_released_at=now() WHERE id=$1", [row.id]);
  }
}

async function releaseOrder(id, status) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT id,status,reservation_released_at FROM payment_orders WHERE id=$1 FOR UPDATE', [id]);
    const order = rows[0];
    if (order?.status === 'pending' && !order.reservation_released_at) {
      const items = await client.query('SELECT ticket_type_id,quantity FROM payment_order_items WHERE order_id=$1', [id]);
      for (const item of items.rows) await client.query('UPDATE ticket_types SET reserved_count=GREATEST(0,reserved_count-$2) WHERE id=$1', [item.ticket_type_id, item.quantity]);
      await client.query('UPDATE payment_orders SET status=$2,reservation_released_at=now() WHERE id=$1', [id, status]);
    }
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
  finally { client.release(); }
}

async function handleWebhook(req, res) {
  const signature = req.get('x-paystack-signature');
  if (!Buffer.isBuffer(req.body) || !signature || !validSignature(req.body, signature)) return res.sendStatus(401);
  let event;
  try { event = JSON.parse(req.body.toString('utf8')); } catch { return res.sendStatus(400); }
  if (event.event !== 'charge.success') return res.sendStatus(200);
  try {
    const verified = await verifyWithPaystack(event.data?.reference);
    await settle(event.data.reference, verified);
    return res.sendStatus(200);
  } catch {
    return res.sendStatus(500);
  }
}

function validSignature(raw, provided) {
  if (!secret || !/^[a-f0-9]{128}$/i.test(provided)) return false;
  const expected = crypto.createHmac('sha512', secret).update(raw).digest();
  const actual = Buffer.from(provided, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

async function verifyWithPaystack(reference) {
  if (!secret) throw new Error('Payment service not configured');
  const response = await fetch('https://api.paystack.co/transaction/verify/' + encodeURIComponent(reference), {
    headers: { Authorization: 'Bearer ' + secret, Accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error('Verification unavailable');
  const result = await response.json();
  if (!result.status || !result.data) throw new Error('Verification unavailable');
  return result.data;
}

async function settle(reference, payment) {
  if (!payment || payment.reference !== reference) throw new Error('Reference mismatch');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT * FROM payment_orders WHERE reference=$1 FOR UPDATE', [reference]);
    const order = rows[0];
    if (!order) throw new Error('Unknown order');
    if (order.status === 'paid' || order.status === 'paid_review') {
      await client.query('COMMIT'); return order.status;
    }
    if (payment.status !== 'success') {
      if (!['failed','abandoned','reversed'].includes(payment.status)) { await client.query('COMMIT'); return order.status; }
      if (order.status === 'pending' && !order.reservation_released_at) {
        const items = await client.query('SELECT ticket_type_id,quantity FROM payment_order_items WHERE order_id=$1', [order.id]);
        for (const item of items.rows) await client.query('UPDATE ticket_types SET reserved_count=GREATEST(0,reserved_count-$2) WHERE id=$1', [item.ticket_type_id,item.quantity]);
        await client.query("UPDATE payment_orders SET status='failed',reservation_released_at=now() WHERE id=$1", [order.id]);
      }
      await client.query('COMMIT'); return 'failed';
    }
    if (BigInt(payment.amount) !== BigInt(order.amount_xof) * 100n || payment.currency !== 'XOF') throw new Error('Payment amount or currency mismatch');
    if (order.status !== 'pending' || order.reservation_released_at) {
      await client.query("UPDATE payment_orders SET status='paid_review',provider_transaction_id=$2,paid_at=now() WHERE id=$1", [order.id, String(payment.id)]);
      await client.query('COMMIT'); return 'paid_review';
    }
    const items = await client.query('SELECT ticket_type_id,quantity FROM payment_order_items WHERE order_id=$1 ORDER BY ticket_type_id', [order.id]);
    for (const item of items.rows) {
      await client.query('UPDATE ticket_types SET reserved_count=reserved_count-$2,sold_count=sold_count+$2 WHERE id=$1', [item.ticket_type_id,item.quantity]);
      for (let i=0;i<item.quantity;i++) {
        let created = false;
        for (let attempt=0;attempt<5&&!created;attempt++) {
          try {
            const code=String(crypto.randomInt(0,100_000_000)).padStart(8,'0');
            const token=crypto.randomBytes(32).toString('base64url');
            const inserted = await client.query('INSERT INTO tickets (order_id,ticket_type_id,code8,qr_token) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING id',[order.id,item.ticket_type_id,code,token]);
            created=inserted.rowCount === 1;
          } catch (error) { if (error.code !== '23505') throw error; }
        }
        if (!created) throw new Error('Could not allocate a unique ticket identifier');
      }
    }
    await client.query("UPDATE payment_orders SET status='paid',provider_transaction_id=$2,paid_at=now() WHERE id=$1", [order.id, String(payment.id)]);
    await client.query('COMMIT');
    return 'paid';
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
  finally { client.release(); }
}

async function paystack(path, options = {}) {
  const response = await fetch('https://api.paystack.co' + path, {
    ...options,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + secret, Accept: 'application/json', ...options.headers },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error('Payment provider request failed');
  return response.json();
}

app.listen(port, () => console.log('Sortir payment API listening on ' + port));
