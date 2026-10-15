'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const mysql = require('mysql2/promise');
const { AsyncLocalStorage } = require('node:async_hooks');

const scrypt = promisify(crypto.scrypt);
const ROOT = __dirname;
const APP_URL = (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '');
const PORT = Number(process.env.PORT || 3000);
const SESSION_DAYS = 30;
const bodyLimit = 2 * 1024 * 1024;
const loginAttempts = new Map();
const mime = { '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.json':'application/json; charset=utf-8', '.svg':'image/svg+xml', '.png':'image/png', '.jpg':'image/jpeg', '.webp':'image/webp' };
const pool = mysql.createPool({host:process.env.DB_HOST||'127.0.0.1',port:Number(process.env.DB_PORT||3306),database:process.env.DB_NAME||'youfind',user:process.env.DB_USER||'root',password:process.env.DB_PASSWORD||'',waitForConnections:true,connectionLimit:10,charset:'utf8mb4',decimalNumbers:true});
const transactionContext = new AsyncLocalStorage();
const db = {
  prepare(sql) {
    return {
      async get(...params) { const [rows] = await (transactionContext.getStore()?.connection || pool).execute(sql, params); return rows[0]; },
      async all(...params) { const [rows] = await (transactionContext.getStore()?.connection || pool).execute(sql, params); return rows; },
      async run(...params) { const [result] = await (transactionContext.getStore()?.connection || pool).execute(sql, params); return {changes:result.affectedRows,lastInsertRowid:result.insertId}; }
    };
  },
  async transaction(work) {
    const connection = await pool.getConnection();
    try { await connection.beginTransaction(); const result = await transactionContext.run({connection}, work); await connection.commit(); return result; }
    catch (error) { await connection.rollback(); throw error; }
    finally { connection.release(); }
  },
  get isTransaction() { return Boolean(transactionContext.getStore()?.connection); },
  async exec(command) {
    const action = command.trim().toUpperCase();
    const context = transactionContext.getStore();
    if (!context) throw new Error('Database transaction commands require an active request.');
    if (action.startsWith('BEGIN')) {
      if (context.connection) throw new Error('A database transaction is already active.');
      const connection = await pool.getConnection();
      try { await connection.beginTransaction(); context.connection=connection; }
      catch (error) { connection.release(); throw error; }
      return;
    }
    const connection = context.connection;
    if (!connection) throw new Error('No active MySQL transaction.');
    try {
      if (action === 'COMMIT') await connection.commit();
      else if (action === 'ROLLBACK') await connection.rollback();
      else throw new Error('Unsupported MySQL command.');
    } finally {
      context.connection=undefined;
      connection.release();
    }
  }
};

const categoryChoices = ['Home & living','Art & prints','Tech','Gaming','Photography','Accessories','Digital art','Templates','Music','Other'];
async function ensureCategory(name, description='') {
  await db.prepare('INSERT INTO categories(category_name,description) VALUES(?,?) ON DUPLICATE KEY UPDATE category_name=VALUES(category_name)').run(name,description);
  return (await db.prepare('SELECT category_id FROM categories WHERE category_name=?').get(name)).category_id;
}
async function initializeDatabase() {
  try { await db.prepare('SELECT 1 FROM users LIMIT 1').get(); }
  catch (error) { throw new Error(`YouFind could not open the MySQL database. Check that MySQL is running, the DB_* values in .env are correct, and database/schema.sql has been imported into ${process.env.DB_NAME||'youfind'}. ${error.message}`); }
  if (process.env.ADMIN_EMAIL) await db.prepare("UPDATE users SET role=CASE WHEN email=? THEN 'admin' WHEN role='admin' THEN 'buyer' ELSE role END").run(process.env.ADMIN_EMAIL.trim().toLowerCase());
  for (const name of categoryChoices) await ensureCategory(name);
  const photoColumn = await db.prepare("SELECT COUNT(*) AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='listings' AND COLUMN_NAME='photo_data'").get();
  if (!Number(photoColumn.n)) await db.prepare('ALTER TABLE listings ADD COLUMN photo_data MEDIUMTEXT NULL').run();
}
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
function send(res, status, payload, headers = {}) {
  res.writeHead(status, { 'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff', ...headers });
  res.end(JSON.stringify(payload));
}
function fail(status, message) { throw new HttpError(status, message); }
function nowIso() { return new Date().toISOString(); }
function safeUser(row) { return row ? { id:row.id, schoolId:row.school_id, displayName:row.full_name || row.display_name, contactNo:row.contact_no, email:row.email, role:row.role || 'buyer', payoutsConnected:Boolean(row.stripe_charges_enabled&&row.stripe_payouts_enabled), createdAt:row.created_at } : null; }
function publicListing(row) {
  return { id:row.id, sellerId:row.seller_id, title:row.title, seller:row.seller_name,
    initial:row.initial, verified:Boolean(row.verified), price:row.price_cents / 100,
    kind:row.kind, category:row.category_name || row.category, categoryId:row.category_id, condition:row.condition, place:row.place,
    emoji:row.emoji, art:row.art, photoData:row.photo_data || null, note:row.note, trade:Boolean(row.open_to_trade),
    description:row.description, status:row.status, createdAt:row.created_at };
}
function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('='); if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
async function currentUser(req) {
  const token = parseCookies(req).goodfind_session;
  if (!token) return null;
  const row = await db.prepare(`SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id
    WHERE s.token_hash=? AND s.expires_at>?`).get(crypto.createHash('sha256').update(token).digest('hex'), Date.now());
  return row || null;
}
async function requireUser(req) { const user = await currentUser(req); if (!user) fail(401, 'Sign in to continue.'); return user; }
async function requireAdmin(req) { const user = await requireUser(req); if (user.role !== 'admin') fail(403, 'Admin access is required.'); return user; }
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return;
  const expected = new URL(APP_URL).origin;
  if (origin !== expected) fail(403, 'This request origin is not allowed.');
}
async function readBody(req, raw = false) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length; if (size > bodyLimit) fail(413, 'Request body is too large.'); chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  if (raw) return bytes;
  if (!bytes.length) return {};
  if (!(req.headers['content-type'] || '').toLowerCase().includes('application/json')) fail(415, 'Use application/json for API requests.');
  try { return JSON.parse(bytes.toString('utf8')); } catch { fail(400, 'Request body must be valid JSON.'); }
}
function text(value, max, label, min = 1) {
  if (typeof value !== 'string') fail(400, `${label} is required.`);
  const s = value.trim(); if (s.length < min || s.length > max) fail(400, `${label} must be ${min}–${max} characters.`);
  return s;
}
function stripeReady() {
  if (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_WEBHOOK_SECRET) fail(503, 'Payments are not configured yet. Add Stripe test keys and restart the server.');
  if (!/^\d+$/.test(process.env.PLATFORM_FEE_BPS || '')) fail(503, 'Set PLATFORM_FEE_BPS to your approved platform fee before enabling checkout.');
  const bps = Number(process.env.PLATFORM_FEE_BPS);
  if (bps < 0 || bps > 10000) fail(503, 'PLATFORM_FEE_BPS must be between 0 and 10000.');
  return bps;
}
async function stripePost(endpoint, params) {
  const response = await fetch(`https://api.stripe.com/v1/${endpoint}`, {
    method:'POST', headers:{ Authorization:`Bearer ${process.env.STRIPE_SECRET_KEY}`, 'Content-Type':'application/x-www-form-urlencoded' },
    body:new URLSearchParams(params), signal:AbortSignal.timeout(20_000)
  });
  const body = await response.json();
  if (!response.ok) throw new HttpError(502, body?.error?.message || 'The payment provider could not complete the request.');
  return body;
}
async function stripeGet(endpoint) {
  const response=await fetch(`https://api.stripe.com/v1/${endpoint}`,{headers:{Authorization:`Bearer ${process.env.STRIPE_SECRET_KEY}`},signal:AbortSignal.timeout(20_000)});
  const body=await response.json();
  if(!response.ok)throw new HttpError(502,body?.error?.message||'The payment provider could not complete the request.');
  return body;
}
function rateLimitLogin(req) {
  const key = req.socket.remoteAddress || 'unknown'; const now = Date.now();
  const entry = loginAttempts.get(key) || { count:0, start:now };
  if (now - entry.start > 15 * 60_000) { entry.count = 0; entry.start = now; }
  entry.count++; loginAttempts.set(key, entry);
  if (entry.count > 20) fail(429, 'Too many sign-in attempts. Try again in 15 minutes.');
}
async function createSession(user, res) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expiry = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
  await db.prepare('DELETE FROM sessions WHERE expires_at<?').run(Date.now());
  await db.prepare('INSERT INTO sessions (token_hash,user_id,expires_at,created_at) VALUES (?,?,?,?)')
    .run(crypto.createHash('sha256').update(token).digest('hex'), user.id, expiry, nowIso());
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `goodfind_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}${secure}`);
}
async function clearSession(req, res) {
  const token = parseCookies(req).goodfind_session;
  if (token) await db.prepare('DELETE FROM sessions WHERE token_hash=?').run(crypto.createHash('sha256').update(token).digest('hex'));
  res.setHeader('Set-Cookie', 'goodfind_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0' + (process.env.NODE_ENV === 'production' ? '; Secure' : ''));
}
function validStripeSignature(raw, header) {
  const fields = Object.fromEntries((header || '').split(',').map(x => x.split('=', 2)));
  const timestamp = Number(fields.t); const signature = fields.v1;
  if (!timestamp || !signature || Math.abs(Date.now() / 1000 - timestamp) > 300) return false;
  const expected = crypto.createHmac('sha256', process.env.STRIPE_WEBHOOK_SECRET).update(`${timestamp}.${raw}`).digest();
  let supplied; try { supplied = Buffer.from(signature, 'hex'); } catch { return false; }
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

async function api(req, res, url) {
  const method = req.method;
  const route = url.pathname;
  if (method !== 'GET' && route !== '/api/payments/stripe-webhook') sameOrigin(req);

  if (method === 'GET' && route === '/api/health') return send(res, 200, { ok:true, paymentsConfigured:Boolean(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_WEBHOOK_SECRET), storage:'mysql' });
  if (method === 'GET' && route === '/api/admin/overview') {
    await requireAdmin(req);
    const counts = {
      members:Number((await db.prepare('SELECT COUNT(*) AS n FROM users').get()).n),
      activeListings:Number((await db.prepare("SELECT COUNT(*) AS n FROM listings WHERE status='active'").get()).n),
      hiddenListings:Number((await db.prepare("SELECT COUNT(*) AS n FROM listings WHERE status='hidden'").get()).n),
      orders:Number((await db.prepare('SELECT COUNT(*) AS n FROM orders').get()).n)
    };
    const rows = await db.prepare("SELECT l.*,c.category_name FROM listings l LEFT JOIN categories c USING(category_id) WHERE l.status IN ('active','hidden') ORDER BY l.created_at DESC LIMIT 100").all();
    return send(res, 200, { counts, listings:rows.map(publicListing) });
  }
  if (method === 'PATCH' && /^\/api\/admin\/listings\/\d+$/.test(route)) {
    await requireAdmin(req);
    const id = Number(route.split('/').pop()); const body = await readBody(req);
    if (!['active','hidden'].includes(body.status)) fail(400, 'Choose active or hidden.');
    const result = await db.prepare("UPDATE listings SET status=? WHERE id=? AND status IN ('active','hidden')").run(body.status,id);
    if (!result.changes) fail(404, 'Moderatable listing not found.');
    return send(res, 200, { id,status:body.status });
  }
  if (method === 'GET' && route === '/api/listings') {
    const rows = await db.prepare("SELECT l.*,c.category_name FROM listings l LEFT JOIN categories c USING(category_id) WHERE l.status='active' ORDER BY l.created_at DESC").all();
    return send(res, 200, { listings:rows.map(publicListing) });
  }
  if (method === 'GET' && route === '/api/auth/me') return send(res, 200, { user:safeUser(await currentUser(req)) });
  if (method === 'POST' && route === '/api/auth/register') {
    const body = await readBody(req); const email = text(body.email, 254, 'Email').toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, 'Enter a valid email address.');
    const displayName = text(body.displayName, 60, 'Full name');
    const schoolId = text(body.schoolId, 40, 'School ID').toUpperCase();
    const contactNo = text(body.contactNo, 25, 'Contact number', 7);
    const password = text(body.password, 200, 'Password', 12);
    if (!/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/[0-9]/.test(password)) fail(400, 'Password must include lowercase, uppercase, and a number.');
    if (await db.prepare('SELECT 1 FROM users WHERE email=?').get(email)) fail(409, 'An account with that email already exists.');
    if (await db.prepare("SELECT 1 FROM users WHERE school_id=? AND school_id<>''").get(schoolId)) fail(409, 'An account with that school ID already exists.');
    const salt = crypto.randomBytes(16); const derived = await scrypt(password, salt, 64, { N:1 << 15, r:8, p:1, maxmem:64 * 1024 * 1024 });
    const result = await db.prepare('INSERT INTO users(school_id,display_name,full_name,contact_no,role,email,password_hash,created_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(schoolId,displayName,displayName,contactNo,'buyer',email,`scrypt$32768$8$1$${salt.toString('hex')}$${Buffer.from(derived).toString('hex')}`,nowIso());
    const user = await db.prepare('SELECT * FROM users WHERE id=?').get(Number(result.lastInsertRowid)); await createSession(user, res);
    return send(res, 201, { user:safeUser(user) });
  }
  if (method === 'POST' && route === '/api/auth/login') {
    rateLimitLogin(req); const body = await readBody(req); const email = text(body.email, 254, 'Email').toLowerCase(); const password = text(body.password, 200, 'Password');
    const user = await db.prepare('SELECT * FROM users WHERE email=?').get(email); const parts = user?.password_hash.split('$') || [];
    let matches = false;
    if (parts.length === 6 && parts[0] === 'scrypt') {
      const derived = await scrypt(password, Buffer.from(parts[4], 'hex'), 64, { N:Number(parts[1]), r:Number(parts[2]), p:Number(parts[3]), maxmem:64 * 1024 * 1024 });
      matches = crypto.timingSafeEqual(Buffer.from(parts[5], 'hex'), Buffer.from(derived));
    }
    if (!matches) fail(401, 'Email or password is incorrect.');
    await createSession(user, res); return send(res, 200, { user:safeUser(user) });
  }
  if (method === 'POST' && route === '/api/auth/logout') { await clearSession(req, res); return send(res, 200, { ok:true }); }

  if (method === 'POST' && route === '/api/listings') {
    const user = await requireUser(req); const body = await readBody(req);
    const title = text(body.title, 100, 'Title'); const description = text(body.description, 2000, 'Description', 5);
    const price = Number(body.price); if (!Number.isFinite(price) || price < 1 || price > 1000000) fail(400, 'Price must be between PHP 1 and PHP 1,000,000.');
    let photoData = null;
    if (body.photoData !== undefined && body.photoData !== null && body.photoData !== '') {
      if (typeof body.photoData !== 'string' || body.photoData.length > 1500000) fail(400, 'Photo must be a JPG image no larger than 1 MB after processing.');
      const match = body.photoData.match(/^data:image\/jpeg;base64,([A-Za-z0-9+/]+={0,2})$/);
      if (!match) fail(400, 'Upload a JPG, PNG, or WebP image.');
      const bytes = Buffer.from(match[1], 'base64');
      if (bytes.length > 1024*1024 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[bytes.length-2] !== 0xff || bytes[bytes.length-1] !== 0xd9) fail(400, 'The photo is invalid or too large.');
      photoData = body.photoData;
    }
    const kind = body.kind === 'digital' ? 'digital' : body.kind === 'physical' ? 'physical' : fail(400, 'Choose physical or digital goods.');
    const category = text(body.category, 60, 'Category');
    const categoryId = await ensureCategory(category);
    const condition = kind === 'digital' ? text(body.condition || 'Instant download', 40, 'Delivery type') : text(body.condition || 'Good', 40, 'Condition');
    const place = kind === 'digital' ? 'Digital delivery' : text(body.place || 'Local pickup or shipping', 80, 'Location');
    const palette = kind === 'digital' ? 'linear-gradient(140deg,#d6d0f1,#a9a0dc)' : 'linear-gradient(140deg,#d4e4ce,#a8c6a4)';
    const result = await db.prepare(`INSERT INTO listings(seller_id,title,seller_name,initial,price_cents,kind,category_id,category,\`condition\`,place,emoji,art,photo_data,note,open_to_trade,description,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(user.id,title,user.display_name,user.display_name.slice(0,1).toUpperCase(),Math.round(price*100),kind,categoryId,category,condition,place,kind==='digital'?'💾':'✨',palette,photoData,'JUST LISTED',body.trade?1:0,description,nowIso());
    return send(res, 201, { listing:publicListing(await db.prepare('SELECT * FROM listings WHERE id=?').get(Number(result.lastInsertRowid))) });
  }

  if (method === 'POST' && route === '/api/trades') {
    const user = await requireUser(req); const body = await readBody(req); const listingId = Number(body.listingId); const offeredId = Number(body.offeredListingId);
    const wanted = await db.prepare("SELECT * FROM listings WHERE id=? AND status='active'").get(listingId);
    const offered = await db.prepare("SELECT * FROM listings WHERE id=? AND status='active'").get(offeredId);
    if (!wanted || !offered) fail(404, 'One of those listings is no longer available.');
    if (!wanted.open_to_trade) fail(400, 'This seller is not accepting trade offers.');
    if (wanted.seller_id === user.id || offered.seller_id !== user.id || offered.id === wanted.id) fail(403, 'Choose your own listing for the offer and another member’s listing to receive.');
    const note = typeof body.note === 'string' ? body.note.trim().slice(0, 500) : '';
    const now = nowIso(); const result = await db.prepare(`INSERT INTO trade_offers(listing_id,offered_listing_id,sender_id,receiver_id,note,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?)`).run(wanted.id,offered.id,user.id,wanted.seller_id,note,now,now);
    return send(res, 201, { offerId:Number(result.lastInsertRowid), status:'pending' });
  }
  if (method === 'GET' && route === '/api/trades') {
    const user = await requireUser(req); const rows = await db.prepare(`SELECT t.*, a.title AS requested_title, a.price_cents AS requested_price,
      b.title AS offered_title, b.price_cents AS offered_price, u.display_name AS sender_name, v.display_name AS receiver_name
      FROM trade_offers t JOIN listings a ON a.id=t.listing_id JOIN listings b ON b.id=t.offered_listing_id
      JOIN users u ON u.id=t.sender_id JOIN users v ON v.id=t.receiver_id
      WHERE t.sender_id=? OR t.receiver_id=? ORDER BY t.created_at DESC`).all(user.id,user.id);
    return send(res, 200, { offers:rows.map(o=>({id:o.id,requestedTitle:o.requested_title,requestedPrice:o.requested_price/100,
      offeredTitle:o.offered_title,offeredPrice:o.offered_price/100,sender:o.sender_name,receiver:o.receiver_name,
      isIncoming:o.receiver_id===user.id,note:o.note,status:o.status,createdAt:o.created_at})) });
  }
  const tradeMatch = route.match(/^\/api\/trades\/(\d+)$/);
  if (method === 'PATCH' && tradeMatch) {
    const user = await requireUser(req); const body = await readBody(req); const status = body.status;
    if (!['accepted','declined','withdrawn'].includes(status)) fail(400, 'Choose accepted, declined, or withdrawn.');
    const offer = await db.prepare('SELECT * FROM trade_offers WHERE id=?').get(Number(tradeMatch[1]));
    if (!offer) fail(404, 'Trade offer not found.');
    const canUpdate = status === 'withdrawn' ? offer.sender_id === user.id : offer.receiver_id === user.id;
    if (!canUpdate) fail(403, 'You cannot update this trade offer.');
    await db.exec('BEGIN IMMEDIATE');
    try {
      const update = await db.prepare("UPDATE trade_offers SET status=?, updated_at=? WHERE id=? AND status='pending'").run(status,nowIso(),offer.id);
      if (!update.changes) { await db.exec('ROLLBACK'); fail(409, 'This trade offer has already been answered.'); }
      if (status === 'accepted') {
        const wanted = await db.prepare("SELECT status FROM listings WHERE id=?").get(offer.listing_id);
        const offered = await db.prepare("SELECT status,seller_id FROM listings WHERE id=?").get(offer.offered_listing_id);
        if (wanted?.status !== 'active' || offered?.status !== 'active' || offered?.seller_id !== offer.sender_id) throw new HttpError(409,'One of the items is no longer available.');
        await db.prepare("UPDATE listings SET status='traded' WHERE id IN (?,?)").run(offer.listing_id,offer.offered_listing_id);
        await db.prepare("UPDATE trade_offers SET status='declined',updated_at=? WHERE status='pending' AND id<>? AND (listing_id IN (?,?) OR offered_listing_id IN (?,?))")
          .run(nowIso(),offer.id,offer.listing_id,offer.offered_listing_id,offer.listing_id,offer.offered_listing_id);
      }
      await db.exec('COMMIT');
    } catch (error) { if (db.isTransaction) await db.exec('ROLLBACK'); throw error; }
    return send(res, 200, { id:offer.id,status });
  }

  if (method === 'GET' && route === '/api/messages') {
    const user = await requireUser(req);
    const rows = await db.prepare(`SELECT m.listing_id,l.title,l.emoji,l.art,
      CASE WHEN m.sender_id=? THEN m.receiver_id ELSE m.sender_id END AS other_id,
      MAX(CASE WHEN m.sender_id=? THEN b.display_name ELSE a.display_name END) AS other_name,
      MAX(m.id) AS last_id, MAX(m.created_at) AS last_at,
      SUBSTRING_INDEX(GROUP_CONCAT(m.sender_id ORDER BY m.id DESC), ',', 1) AS last_sender_id
      FROM messages m JOIN listings l ON l.id=m.listing_id
      JOIN users a ON a.id=m.sender_id JOIN users b ON b.id=m.receiver_id
      WHERE m.sender_id=? OR m.receiver_id=? GROUP BY m.listing_id,other_id,l.title,l.emoji,l.art ORDER BY last_id DESC`).all(user.id,user.id,user.id,user.id);
    return send(res,200,{conversations:rows.map(r=>({listingId:r.listing_id,title:r.title,emoji:r.emoji,art:r.art,otherId:r.other_id,otherName:r.other_name,lastId:Number(r.last_id),lastSenderId:Number(r.last_sender_id),lastAt:r.last_at}))});
  }
  const messageMatch = route.match(/^\/api\/listings\/(\d+)\/messages$/);
  if (messageMatch && method === 'GET') {
    const user = await requireUser(req); const listingId = Number(messageMatch[1]);
    const listing = await db.prepare('SELECT * FROM listings WHERE id=?').get(listingId); if (!listing) fail(404, 'Listing not found.');
    const sellerId = listing.seller_id; if (!sellerId) fail(400, 'Messages are available for member listings.');
    const isSeller = Number(user.id) === Number(sellerId);
    const otherId = isSeller ? Number(url.searchParams.get('with')) : sellerId;
    if (!otherId || otherId === user.id) fail(400, 'Choose a conversation member.');
    if (isSeller && !await db.prepare('SELECT 1 FROM messages WHERE listing_id=? AND ((sender_id=? AND receiver_id=?) OR (sender_id=? AND receiver_id=?))').get(listingId,user.id,otherId,otherId,user.id)) fail(403, 'That conversation has not been started.');
    const rows = await db.prepare(`SELECT m.id,m.body,m.created_at,m.sender_id,u.display_name AS sender_name
      FROM messages m JOIN users u ON u.id=m.sender_id WHERE m.listing_id=? AND
      ((m.sender_id=? AND m.receiver_id=?) OR (m.sender_id=? AND m.receiver_id=?)) ORDER BY m.id`).all(listingId,user.id,otherId,otherId,user.id);
    return send(res, 200, { messages:rows.map(m=>({id:m.id,body:m.body,createdAt:m.created_at,senderId:m.sender_id,sender:m.sender_name,mine:Number(m.sender_id)===Number(user.id)})) });
  }
  if (messageMatch && method === 'POST') {
    const user = await requireUser(req); const body = await readBody(req); const listingId = Number(messageMatch[1]);
    const listing = await db.prepare("SELECT * FROM listings WHERE id=? AND status='active'").get(listingId); if (!listing) fail(404, 'Listing not found.');
    if (!listing.seller_id) fail(400, 'Messages are available for member listings.');
    const isSeller = Number(user.id) === Number(listing.seller_id);
    const receiverId = isSeller ? Number(body.recipientId) : listing.seller_id;
    if (!receiverId || receiverId === user.id) fail(400, 'Choose the other member in this conversation.');
    if (isSeller && !await db.prepare('SELECT 1 FROM messages WHERE listing_id=? AND ((sender_id=? AND receiver_id=?) OR (sender_id=? AND receiver_id=?))').get(listingId,user.id,receiverId,receiverId,user.id)) fail(403, 'The buyer must start this conversation.');
    const content = text(body.body, 2000, 'Message');
    const result = await db.prepare('INSERT INTO messages(listing_id,sender_id,receiver_id,body,created_at) VALUES(?,?,?,?,?)').run(listing.id,user.id,receiverId,content,nowIso());
    return send(res, 201, { id:Number(result.lastInsertRowid) });
  }

  if (method === 'POST' && route === '/api/payments/connect/onboard') {
    const user = await requireUser(req); stripeReady(); const body = await readBody(req);
    const country = text(body.country,2,'Country code').toUpperCase(); if (!/^[A-Z]{2}$/.test(country)) fail(400,'Use a two-letter country code.');
    let accountId = user.stripe_account_id;
    if (!accountId) {
      const account = await stripePost('accounts',{type:'express',country,
        'capabilities[card_payments][requested]':'true','capabilities[transfers][requested]':'true',
        'metadata[goodfind_user_id]':String(user.id)});
      accountId = account.id; await db.prepare('UPDATE users SET stripe_account_id=? WHERE id=?').run(accountId,user.id);
    }
    const link = await stripePost('account_links',{account:accountId,refresh_url:`${APP_URL}/?payout_setup=refresh`,return_url:`${APP_URL}/?payout_setup=return`,type:'account_onboarding'});
    return send(res,200,{url:link.url});
  }
  if (method === 'GET' && route === '/api/payments/connect/status') {
    const user=await requireUser(req); if(!user.stripe_account_id)return send(res,200,{connected:false});
    if(!process.env.STRIPE_SECRET_KEY)return send(res,200,{connected:false});
    const account=await stripeGet(`accounts/${encodeURIComponent(user.stripe_account_id)}`);
    await db.prepare('UPDATE users SET stripe_charges_enabled=?,stripe_payouts_enabled=? WHERE id=?').run(account.charges_enabled?1:0,account.payouts_enabled?1:0,user.id);
    return send(res,200,{connected:Boolean(account.charges_enabled&&account.payouts_enabled)});
  }
  if (method === 'POST' && route === '/api/payments/checkout') {
    const user = await requireUser(req); const feeBps = stripeReady(); const body = await readBody(req); const listing = await db.prepare("SELECT * FROM listings WHERE id=? AND status='active'").get(Number(body.listingId));
    if (!listing) fail(404,'This listing is no longer available.');
    if (!listing.seller_id || listing.seller_id===user.id) fail(400,'You can only buy another member’s listing.');
    const seller = await db.prepare('SELECT * FROM users WHERE id=?').get(listing.seller_id);
    if (!seller?.stripe_account_id || !seller.stripe_charges_enabled || !seller.stripe_payouts_enabled) fail(409,'The seller has not finished setting up payouts yet.');
    await db.exec('BEGIN IMMEDIATE'); let orderId;
    try {
      const reserve = await db.prepare("UPDATE listings SET status='reserved' WHERE id=? AND status='active'").run(listing.id);
      if (!reserve.changes) fail(409,'This item is being checked out by someone else.');
      const orderDate=nowIso();
      const order = await db.prepare(`INSERT INTO orders(listing_id,buyer_id,seller_id,amount_cents,currency,created_at,order_date,queue_status)
        VALUES(?,?,?,?,?,?,?,'queued')`).run(listing.id,user.id,seller.id,listing.price_cents,(process.env.PLATFORM_CURRENCY||'php').toLowerCase(),orderDate,orderDate);
      orderId = Number(order.lastInsertRowid); await db.exec('COMMIT');
    } catch (error) { if (db.isTransaction) await db.exec('ROLLBACK'); throw error; }
    const fee = Math.floor(listing.price_cents*feeBps/10000);
    try {
      const session = await stripePost('checkout/sessions',{
        mode:'payment',success_url:`${APP_URL}/?payment=success&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url:`${APP_URL}/?payment=cancel&order_id=${orderId}`,client_reference_id:String(orderId),
        'line_items[0][quantity]':'1','line_items[0][price_data][currency]':(process.env.PLATFORM_CURRENCY||'php').toLowerCase(),
        'line_items[0][price_data][unit_amount]':String(listing.price_cents),
        'line_items[0][price_data][product_data][name]':listing.title,
        'payment_intent_data[application_fee_amount]':String(fee),
        'payment_intent_data[transfer_data][destination]':seller.stripe_account_id,
        'metadata[order_id]':String(orderId),'metadata[listing_id]':String(listing.id)
      });
      await db.prepare('UPDATE orders SET stripe_session_id=? WHERE id=?').run(session.id,orderId);
      return send(res,201,{url:session.url});
    } catch (error) {
      await db.prepare("UPDATE orders SET status='failed',queue_status='cancelled' WHERE id=?").run(orderId);
      await db.prepare("UPDATE listings SET status='active' WHERE id=? AND status='reserved'").run(listing.id);
      throw error;
    }
  }
  if (method === 'POST' && route === '/api/payments/cancel') {
    const user = await requireUser(req); const body=await readBody(req); const orderId=Number(body.orderId);
    const order=await db.prepare("SELECT * FROM orders WHERE id=? AND buyer_id=? AND status='pending'").get(orderId,user.id);
    if (!order) return send(res,200,{ok:true});
    if (order.stripe_session_id) await stripePost(`checkout/sessions/${encodeURIComponent(order.stripe_session_id)}/expire`,{});
    await db.exec('BEGIN IMMEDIATE');
    try {
      await db.prepare("UPDATE orders SET status='expired',queue_status='cancelled' WHERE id=? AND status='pending'").run(order.id);
      await db.prepare("UPDATE listings SET status='active' WHERE id=? AND status='reserved'").run(order.listing_id);
      await db.exec('COMMIT');
    } catch(error) { if(db.isTransaction) await db.exec('ROLLBACK'); throw error; }
    return send(res,200,{ok:true});
  }
  if (method === 'POST' && route === '/api/payments/stripe-webhook') {
    if (!process.env.STRIPE_WEBHOOK_SECRET) fail(503,'Stripe webhook is not configured.');
    const raw = await readBody(req,true); if (!validStripeSignature(raw,req.headers['stripe-signature'])) fail(400,'Invalid webhook signature.');
    const event = JSON.parse(raw.toString('utf8'));
    if (event.type === 'checkout.session.completed' && event.data?.object?.payment_status === 'paid') {
      const session = event.data.object; const orderId = Number(session.client_reference_id || session.metadata?.order_id);
      if (orderId) {
        const order = await db.prepare("SELECT * FROM orders WHERE id=? AND status='pending'").get(orderId);
        if (order) {
          await db.exec('BEGIN IMMEDIATE');
          try {
            await db.prepare("UPDATE orders SET status='paid',queue_status='completed',paid_at=? WHERE id=? AND status='pending'").run(nowIso(),order.id);
            await db.prepare("UPDATE listings SET status='sold' WHERE id=? AND seller_id=? AND status='active'").run(order.listing_id,order.seller_id);
            await db.exec('COMMIT');
          } catch (e) { await db.exec('ROLLBACK'); throw e; }
        }
      }
    }
    if (event.type === 'checkout.session.expired') {
      const session = event.data?.object; if (session?.client_reference_id) {
        const orderId=Number(session.client_reference_id); const order=await db.prepare("SELECT * FROM orders WHERE id=? AND status='pending'").get(orderId);
        if(order){await db.exec('BEGIN IMMEDIATE');try{await db.prepare("UPDATE orders SET status='expired',queue_status='cancelled' WHERE id=? AND status='pending'").run(order.id);await db.prepare("UPDATE listings SET status='active' WHERE id=? AND status='reserved'").run(order.listing_id);await db.exec('COMMIT');}catch(error){if(db.isTransaction)await db.exec('ROLLBACK');throw error;}}
      }
    }
    if (event.type === 'account.updated' && event.account && event.data?.object?.object === 'account') {
      const account=event.data.object;
      await db.prepare('UPDATE users SET stripe_charges_enabled=?,stripe_payouts_enabled=? WHERE stripe_account_id=?')
        .run(account.charges_enabled?1:0,account.payouts_enabled?1:0,event.account);
    }
    return send(res,200,{received:true});
  }
  return send(res,404,{error:'API route not found.'});
}

async function handler(req,res) {
  try {
    const url = new URL(req.url,'http://localhost');
    if (url.pathname.startsWith('/api/')) return await transactionContext.run({connection:undefined},()=>api(req,res,url));
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res,405,{error:'Method not allowed.'});
    if (url.pathname === '/auth' || url.pathname === '/admin') {
      res.writeHead(301,{ Location:`${url.pathname}/${url.search}`, 'Cache-Control':'no-store' });
      return res.end();
    }
    const publicFiles = new Map([
      ['/','index.html'],['/index.html','index.html'],['/styles.css','styles.css'],['/data.js','data.js'],['/app.js','app.js'],
      ['/auth/','auth/index.html'],['/auth/index.html','auth/index.html'],['/auth/auth.css','auth/auth.css'],['/auth/auth.js','auth/auth.js'],
      ['/admin/','admin/live.html'],['/admin/index.html','admin/live.html'],['/admin/admin.css','admin/live.css'],['/admin/admin.js','admin/live.js']
    ]);
    const asset = publicFiles.get(decodeURIComponent(url.pathname));
    if (!asset) return send(res,404,{error:'Not found.'});
    const filePath = path.join(ROOT,asset);
    let stat; try { stat = fs.statSync(filePath); } catch { return send(res,404,{error:'Not found.'}); }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200,{ 'Content-Type':mime[ext]||'application/octet-stream', 'X-Content-Type-Options':'nosniff', 'Referrer-Policy':'same-origin', 'X-Frame-Options':'DENY', 'Content-Security-Policy':"default-src 'self' https://fonts.googleapis.com https://fonts.gstatic.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'" });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(filePath).pipe(res);
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    if (status === 500) console.error(error);
    if (!res.headersSent) send(res,status,{error:status===500?'Internal server error.':error.message}); else res.destroy();
  }
}

initializeDatabase().then(()=>http.createServer(handler).listen(PORT,'127.0.0.1',()=>console.log(`YouFind connected to MySQL and listening at ${APP_URL}`))).catch(async error=>{console.error(error.message);await pool.end();process.exitCode=1;});
