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
const ADMIN_ROOT_CANDIDATE = path.resolve(ROOT, '..', 'goodfind-admin');
const ADMIN_ROOT = fs.existsSync(ADMIN_ROOT_CANDIDATE) ? ADMIN_ROOT_CANDIDATE : path.join(ROOT, 'admin');
const APP_URL = (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '');
const PORT = Number(process.env.PORT || 3000);
const ADMIN_PORT = Number(process.env.ADMIN_PORT || 3001);
const ADMIN_ORIGIN = (process.env.ADMIN_ORIGIN || `http://localhost:${ADMIN_PORT}`).replace(/\/$/, '');
const SESSION_DAYS = 30;
const bodyLimit = 16 * 1024 * 1024;
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
  const profilePhotoColumn = await db.prepare("SELECT COUNT(*) AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='users' AND COLUMN_NAME='profile_photo'").get();
  if (!Number(profilePhotoColumn.n)) await db.prepare('ALTER TABLE users ADD COLUMN profile_photo MEDIUMTEXT NULL').run();
  const idPhotoColumn = await db.prepare("SELECT COUNT(*) AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='users' AND COLUMN_NAME='id_photo_data'").get();
  if (!Number(idPhotoColumn.n)) await db.prepare('ALTER TABLE users ADD COLUMN id_photo_data MEDIUMTEXT NULL').run();
  const idStatusColumn = await db.prepare("SELECT COUNT(*) AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='users' AND COLUMN_NAME='id_verification_status'").get();
  if (!Number(idStatusColumn.n)) await db.prepare("ALTER TABLE users ADD COLUMN id_verification_status ENUM('unsubmitted','pending','verified','rejected') NOT NULL DEFAULT 'unsubmitted'").run();
  const idStatusIndex = await db.prepare("SELECT COUNT(*) AS n FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='users' AND INDEX_NAME='idx_users_id_verification_status'").get();
  if (!Number(idStatusIndex.n)) await db.prepare('CREATE INDEX idx_users_id_verification_status ON users(id_verification_status)').run();
  await pool.query(`CREATE TABLE IF NOT EXISTS listing_photos (
    listing_id BIGINT UNSIGNED NOT NULL,
    photo_order TINYINT UNSIGNED NOT NULL,
    photo_data MEDIUMTEXT NOT NULL,
    PRIMARY KEY (listing_id,photo_order),
    CONSTRAINT fk_listing_photos_listing FOREIGN KEY (listing_id) REFERENCES listings(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  const reviewIndex=await db.prepare("SELECT COUNT(*) AS n FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='reviews' AND INDEX_NAME='uq_reviews_order_reviewer'").get();
  if(!Number(reviewIndex.n))await db.prepare('CREATE UNIQUE INDEX uq_reviews_order_reviewer ON reviews(order_id,reviewer_id)').run();
  const oldReviewIndex=await db.prepare("SELECT COUNT(*) AS n FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='reviews' AND INDEX_NAME='uq_reviews_order'").get();
  if(Number(oldReviewIndex.n))await db.prepare('ALTER TABLE reviews DROP INDEX uq_reviews_order').run();
  for(const [name,columns] of [['idx_orders_seller_queue','seller_id,queue_status,order_date'],['idx_orders_buyer_queue','buyer_id,queue_status,order_date'],['idx_orders_listing_queue','listing_id,queue_status,order_date']]){
    const index=await db.prepare("SELECT COUNT(*) AS n FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='orders' AND INDEX_NAME=?").get(name);
    if(!Number(index.n))await db.prepare(`CREATE INDEX ${name} ON orders(${columns})`).run();
  }
}
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
function send(res, status, payload, headers = {}) {
  res.writeHead(status, { 'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff', ...headers });
  res.end(JSON.stringify(payload));
}
function fail(status, message) { throw new HttpError(status, message); }
function nowIso() { return new Date().toISOString(); }
function safeUser(row) { return row ? { id:row.id, schoolId:row.school_id, displayName:row.full_name || row.display_name, contactNo:row.contact_no, profilePhoto:row.profile_photo || null, idVerificationStatus:row.id_verification_status || 'unsubmitted', email:row.email, role:row.role || 'buyer', payoutsConnected:Boolean(row.stripe_charges_enabled&&row.stripe_payouts_enabled), createdAt:row.created_at } : null; }
function validateIdPhoto(value) {
  if (typeof value !== 'string' || value.length > 1500000) fail(400, 'School ID photo must be a JPG image no larger than 1 MB after processing.');
  const match = value.match(/^data:image\/jpeg;base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match) fail(400, 'Upload a JPG, PNG, or WebP image of your school ID.');
  const bytes=Buffer.from(match[1],'base64');
  if (bytes.length>1024*1024 || bytes[0]!==0xff || bytes[1]!==0xd8 || bytes[bytes.length-2]!==0xff || bytes[bytes.length-1]!==0xd9) fail(400, 'The school ID photo is invalid or too large.');
  return value;
}
function publicListing(row, includePhotos = false, photos = null) {
  const gallery=photos || (row.photo_data ? [row.photo_data] : []);
  return { id:row.id, sellerId:row.seller_id, title:row.title, seller:row.seller_name,
    initial:row.initial, verified:Boolean(row.verified), price:row.price_cents / 100,
    kind:row.kind, category:row.category_name || row.category, categoryId:row.category_id, condition:row.condition, place:row.place,
    emoji:row.emoji, art:row.art, photoData:row.photo_data || null, photoCount:Number(row.photo_count ?? gallery.length), ...(includePhotos ? {photosData:gallery} : {}), note:row.note, trade:Boolean(row.open_to_trade),
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
  const pathName=new URL(req.url,'http://localhost').pathname;
  const cookies=parseCookies(req);
  const token=pathName.startsWith('/api/admin/')?cookies.goodfind_admin_session:cookies.goodfind_session;
  if (!token) return null;
  const row = await db.prepare(`SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id
    WHERE s.token_hash=? AND s.expires_at>?`).get(crypto.createHash('sha256').update(token).digest('hex'), Date.now());
  return row || null;
}
async function requireUser(req) { const user = await currentUser(req); if (!user) fail(401, 'Sign in to continue.'); return user; }
async function requireVerifiedUser(req) { const user=await requireUser(req); if(user.role!=='admin'&&user.id_verification_status!=='verified')fail(403,'Verify your school ID before listing, ordering, or trading.'); return user; }
async function requireAdmin(req) { const user = await requireUser(req); if (user.role !== 'admin') fail(403, 'Admin access is required.'); return user; }
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return;
  const expected = new URL(APP_URL);
  const allowed = new Set([expected.origin]);
  // XAMPP development commonly serves the page on Apache (port 80) while
  // the Node API runs on PORT. Treat the usual loopback names as the same
  // local app, while keeping public hosts restricted to APP_URL exactly.
  if (expected.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(expected.hostname)) {
    for (const hostname of ['localhost','127.0.0.1','[::1]']) {
      for (const port of new Set([80, PORT])) {
        const candidate = new URL(`http://${hostname}`);
        if (port !== 80) candidate.port = String(port);
        allowed.add(candidate.origin);
      }
    }
  }
  allowed.add(ADMIN_ORIGIN);
  if (!allowed.has(origin)) fail(403, 'This request origin is not allowed.');
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
async function createSession(user, res, adminSession=false) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expiry = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
  await db.prepare('DELETE FROM sessions WHERE expires_at<?').run(Date.now());
  await db.prepare('INSERT INTO sessions (token_hash,user_id,expires_at,created_at) VALUES (?,?,?,?)')
    .run(crypto.createHash('sha256').update(token).digest('hex'), user.id, expiry, nowIso());
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  const cookieName=adminSession?'goodfind_admin_session':'goodfind_session';
  res.setHeader('Set-Cookie', `${cookieName}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}${secure}`);
}
async function clearSession(req, res) {
  const pathName=new URL(req.url,'http://localhost').pathname;
  const cookieName=pathName.startsWith('/api/admin/')?'goodfind_admin_session':'goodfind_session';
  const token=parseCookies(req)[cookieName];
  if (token) await db.prepare('DELETE FROM sessions WHERE token_hash=?').run(crypto.createHash('sha256').update(token).digest('hex'));
  res.setHeader('Set-Cookie', `${cookieName}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0` + (process.env.NODE_ENV === 'production' ? '; Secure' : ''));
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
  const origin=req.headers.origin;
  if(origin===ADMIN_ORIGIN){
    res.setHeader('Access-Control-Allow-Origin',ADMIN_ORIGIN);
    res.setHeader('Access-Control-Allow-Credentials','true');
    res.setHeader('Access-Control-Allow-Methods','GET, POST, PATCH, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers','Content-Type');
    res.setHeader('Vary','Origin');
  }
  if(method==='OPTIONS'){
    if(origin!==ADMIN_ORIGIN)fail(403,'This request origin is not allowed.');
    res.writeHead(204);return res.end();
  }
  if (method !== 'GET' && route !== '/api/payments/stripe-webhook') sameOrigin(req);

  if (method === 'GET' && route === '/api/health') return send(res, 200, { ok:true, paymentsConfigured:Boolean(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_WEBHOOK_SECRET), storage:'mysql' });
  if (method === 'GET' && route === '/api/admin/me') {
    const user=await currentUser(req);
    return send(res,200,{user:user?.role==='admin'?safeUser(user):null});
  }
  if (method === 'GET' && route === '/api/admin/overview') {
    await requireAdmin(req);
    const counts = {
      members:Number((await db.prepare('SELECT COUNT(*) AS n FROM users').get()).n),
      activeListings:Number((await db.prepare("SELECT COUNT(*) AS n FROM listings WHERE status='active'").get()).n),
      hiddenListings:Number((await db.prepare("SELECT COUNT(*) AS n FROM listings WHERE status='hidden'").get()).n),
      pendingListings:Number((await db.prepare("SELECT COUNT(*) AS n FROM listings WHERE status='pending'").get()).n),
      orders:Number((await db.prepare('SELECT COUNT(*) AS n FROM orders').get()).n)
    };
    counts.pendingVerifications=Number((await db.prepare("SELECT COUNT(*) AS n FROM users WHERE id_verification_status='pending'").get()).n);
    const rows = await db.prepare("SELECT l.*,c.category_name FROM listings l LEFT JOIN categories c USING(category_id) WHERE l.status IN ('pending','active','hidden','rejected','reserved','sold','traded') ORDER BY CASE WHEN l.status='pending' THEN 0 ELSE 1 END,l.created_at DESC LIMIT 200").all();
    return send(res, 200, { counts, listings:rows.map(publicListing) });
  }
  if (method === 'GET' && route === '/api/admin/verifications') {
    await requireAdmin(req);
    const rows=await db.prepare("SELECT id,full_name,email,school_id,id_photo_data,created_at FROM users WHERE id_verification_status='pending' ORDER BY created_at").all();
    return send(res,200,{verifications:rows.map(row=>({id:row.id,fullName:row.full_name,email:row.email,schoolId:row.school_id,idPhoto:row.id_photo_data,submittedAt:row.created_at}))});
  }
  if (method === 'PATCH' && /^\/api\/admin\/verifications\/\d+$/.test(route)) {
    await requireAdmin(req);
    const id=Number(route.split('/').pop());const body=await readBody(req);
    if(!['verified','rejected'].includes(body.status))fail(400,'Choose verified or rejected.');
    await db.transaction(async()=>{
      const result=await db.prepare("UPDATE users SET id_verification_status=?,id_photo_data=NULL WHERE id=? AND id_verification_status='pending'").run(body.status,id);
      if(!result.changes)fail(404,'Pending ID verification not found.');
      await db.prepare('UPDATE listings SET verified=? WHERE seller_id=?').run(body.status==='verified'?1:0,id);
    });
    return send(res,200,{id,status:body.status});
  }
  if (method === 'PATCH' && /^\/api\/admin\/listings\/\d+$/.test(route)) {
    await requireAdmin(req);
    const id = Number(route.split('/').pop()); const body = await readBody(req);
    const transitions={active:['pending','hidden'],hidden:['active'],rejected:['pending']};
    if (!Object.hasOwn(transitions,body.status)) fail(400, 'Choose approve, reject, hide, or restore.');
    const allowedFrom=transitions[body.status];
    const result = await db.prepare(`UPDATE listings SET status=? WHERE id=? AND status IN (${allowedFrom.map(()=>'?').join(',')})`).run(body.status,id,...allowedFrom);
    if (!result.changes) fail(404, 'Listing review action is no longer available.');
    return send(res, 200, { id,status:body.status });
  }
  if (method === 'GET' && route === '/api/listings') {
    const rows = await db.prepare("SELECT l.*,c.category_name,(IF(l.photo_data IS NULL,0,1)+(SELECT COUNT(*) FROM listing_photos p WHERE p.listing_id=l.id)) AS photo_count FROM listings l LEFT JOIN categories c USING(category_id) WHERE l.status='active' ORDER BY l.created_at DESC").all();
    return send(res, 200, { listings:rows.map(publicListing) });
  }
  if (method === 'GET' && /^\/api\/listings\/\d+$/.test(route)) {
    const row = await db.prepare("SELECT l.*,c.category_name,(IF(l.photo_data IS NULL,0,1)+(SELECT COUNT(*) FROM listing_photos p WHERE p.listing_id=l.id)) AS photo_count FROM listings l LEFT JOIN categories c USING(category_id) WHERE l.id=? AND l.status='active'").get(Number(route.split('/').pop()));
    if (!row) fail(404, 'This listing is no longer available.');
    const extras=await db.prepare('SELECT photo_data FROM listing_photos WHERE listing_id=? ORDER BY photo_order').all(row.id);
    return send(res, 200, { listing:publicListing(row,true,[...(row.photo_data?[row.photo_data]:[]),...extras.map(photo=>photo.photo_data)]) });
  }
  if (method === 'GET' && route === '/api/auth/me') return send(res, 200, { user:safeUser(await currentUser(req)) });
  if (method === 'GET' && route === '/api/auth/listings') {
    const user=await requireUser(req);
    const allListings=url.searchParams.get('all')==='1';
    const rows=await db.prepare(`SELECT l.id,l.title,l.status,l.price_cents,l.category,l.emoji,l.art,l.photo_data,l.created_at
      FROM listings l WHERE l.seller_id=? ORDER BY l.created_at DESC,l.id DESC${allListings?'':' LIMIT 6'}`).all(user.id);
    return send(res,200,{listings:rows.map(row=>({id:Number(row.id),title:row.title,status:row.status,price:Number(row.price_cents)/100,
      category:row.category,emoji:row.emoji,art:row.art,photoData:row.photo_data||null,createdAt:row.created_at}))});
  }
  if (method === 'GET' && route === '/api/orders') {
    const user=await requireUser(req);
    const rows=await db.prepare(`SELECT o.id,o.listing_id,o.buyer_id,o.seller_id,o.order_date,o.queue_status,o.amount_cents,o.currency,o.status,o.stripe_session_id,
      l.title,l.status AS listing_status,l.photo_data,l.emoji,l.art,b.display_name AS buyer_name,s.display_name AS seller_name,
      s.stripe_account_id AS seller_stripe_account,s.stripe_charges_enabled AS seller_charges_enabled,s.stripe_payouts_enabled AS seller_payouts_enabled,
      CASE WHEN o.queue_status='queued' THEN (SELECT COUNT(*) FROM orders q WHERE q.listing_id=o.listing_id AND q.queue_status='queued' AND (q.order_date<o.order_date OR (q.order_date=o.order_date AND q.id<=o.id))) ELSE NULL END AS queue_position,
      EXISTS(SELECT 1 FROM reviews r WHERE r.order_id=o.id AND r.reviewer_id=?) AS has_review
      FROM orders o JOIN listings l ON l.id=o.listing_id JOIN users b ON b.id=o.buyer_id JOIN users s ON s.id=o.seller_id
      WHERE o.buyer_id=? OR o.seller_id=? ORDER BY o.order_date DESC,o.id DESC`).all(user.id,user.id,user.id);
    let reviewsByOrder=new Map();
    if(rows.length){
      const ids=rows.map(row=>Number(row.id));
      const reviews=await db.prepare(`SELECT r.order_id,r.reviewer_id,r.rating,r.remarks,r.created_at,u.display_name AS reviewer_name FROM reviews r JOIN users u ON u.id=r.reviewer_id WHERE r.order_id IN (${ids.map(()=>'?').join(',')}) ORDER BY r.created_at`).all(...ids);
      reviewsByOrder=new Map(ids.map(id=>[id,[]]));
      for(const review of reviews)reviewsByOrder.get(Number(review.order_id))?.push({reviewerId:Number(review.reviewer_id),reviewerName:review.reviewer_name,rating:Number(review.rating),remarks:review.remarks,createdAt:review.created_at});
    }
    const orders=rows.map(row=>{
      const isSeller=Number(row.seller_id)===Number(user.id);
      return {id:Number(row.id),listingId:Number(row.listing_id),buyerId:Number(row.buyer_id),sellerId:Number(row.seller_id),buyerName:row.buyer_name,sellerName:row.seller_name,
        otherName:isSeller?row.buyer_name:row.seller_name,myRole:isSeller?'seller':'buyer',itemTitle:row.title,itemStatus:row.listing_status,itemPhoto:row.photo_data||null,itemEmoji:row.emoji,itemArt:row.art,
        date:row.order_date,queueStatus:row.queue_status,queuePosition:row.queue_position===null?null:Number(row.queue_position),status:row.status,amount:Number(row.amount_cents)/100,currency:row.currency,
        hasReviewed:Boolean(row.has_review),reviews:reviewsByOrder.get(Number(row.id))||[],hasPaymentSession:Boolean(row.stripe_session_id),
        paymentReady:Boolean(process.env.STRIPE_SECRET_KEY&&process.env.STRIPE_WEBHOOK_SECRET&&row.seller_stripe_account&&row.seller_charges_enabled&&row.seller_payouts_enabled)};
    });
    const listingRows=await db.prepare(`SELECT l.id,l.title,l.status,l.price_cents,
      (SELECT COUNT(*) FROM orders o WHERE o.listing_id=l.id AND o.queue_status='queued') AS queued_count,
      (SELECT COUNT(*) FROM orders o WHERE o.listing_id=l.id AND o.queue_status='approved') AS approved_count
      FROM listings l WHERE l.seller_id=? ORDER BY l.created_at DESC`).all(user.id);
    return send(res,200,{orders,myListings:listingRows.map(row=>({id:Number(row.id),title:row.title,status:row.status,price:Number(row.price_cents)/100,queuedCount:Number(row.queued_count),approvedCount:Number(row.approved_count)}))});
  }
  if (method === 'POST' && route === '/api/orders') {
    const user=await requireVerifiedUser(req);const body=await readBody(req);const listingId=Number(body.listingId);
    if(!Number.isSafeInteger(listingId)||listingId<1)fail(400,'Choose an available item to request.');
    const orderId=await db.transaction(async()=>{
      const listing=await db.prepare('SELECT * FROM listings WHERE id=? FOR UPDATE').get(listingId);
      if(!listing||listing.status!=='active')fail(409,'This item is no longer available.');
      if(!listing.seller_id)fail(400,'Only member listings can receive order requests.');
      if(Number(listing.seller_id)===Number(user.id))fail(403,'You cannot request your own listing.');
      const prior=await db.prepare("SELECT id FROM orders WHERE listing_id=? AND buyer_id=? AND queue_status IN ('queued','approved') LIMIT 1").get(listing.id,user.id);
      if(prior)fail(409,'You already have an open request for this item.');
      const timestamp=nowIso();
      const result=await db.prepare(`INSERT INTO orders(listing_id,buyer_id,seller_id,order_date,amount_cents,currency,created_at,queue_status)
        VALUES(?,?,?,?,?,?,?,'queued')`).run(listing.id,user.id,listing.seller_id,timestamp,listing.price_cents,(process.env.PLATFORM_CURRENCY||'php').toLowerCase(),timestamp);
      return Number(result.lastInsertRowid);
    });
    return send(res,201,{orderId,queueStatus:'queued'});
  }
  if (method === 'PATCH' && route === '/api/auth/profile') {
    const user = await requireUser(req); const body = await readBody(req);
    const displayName = text(body.displayName, 60, 'Full name');
    const schoolId = text(body.schoolId, 40, 'School ID').toUpperCase();
    const contactNo = text(body.contactNo, 25, 'Contact number', 7);
    if (await db.prepare("SELECT 1 FROM users WHERE school_id=? AND id<>? AND school_id<>''").get(schoolId,user.id)) fail(409, 'That school ID is already in use.');
    const submittedIdPhoto=body.idPhoto?validateIdPhoto(body.idPhoto):null;
    const idChanged=schoolId!==user.school_id;
    if(idChanged&&!submittedIdPhoto)fail(400,'Upload a clear photo of your new school ID number.');
    if(['unsubmitted','rejected'].includes(user.id_verification_status||'unsubmitted')&&!submittedIdPhoto)fail(400,'Upload a clear school ID photo to submit it for admin review.');
    let profilePhoto = null;
    if (body.profilePhoto !== undefined && body.profilePhoto !== null && body.profilePhoto !== '') {
      if (typeof body.profilePhoto !== 'string' || body.profilePhoto.length > 1500000) fail(400, 'Profile photo must be a JPG image no larger than 1 MB after processing.');
      const match = body.profilePhoto.match(/^data:image\/jpeg;base64,([A-Za-z0-9+/]+={0,2})$/);
      if (!match) fail(400, 'Upload a JPG, PNG, or WebP image.');
      const bytes = Buffer.from(match[1], 'base64');
      if (bytes.length > 1024*1024 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[bytes.length-2] !== 0xff || bytes[bytes.length-1] !== 0xd9) fail(400, 'The profile photo is invalid or too large.');
      profilePhoto = body.profilePhoto;
    }
    await db.prepare("UPDATE users SET school_id=?,display_name=?,full_name=?,contact_no=?,profile_photo=?,id_photo_data=COALESCE(?,id_photo_data),id_verification_status=CASE WHEN ? IS NOT NULL THEN 'pending' WHEN ? THEN 'unsubmitted' ELSE id_verification_status END WHERE id=?").run(schoolId,displayName,displayName,contactNo,profilePhoto,submittedIdPhoto,submittedIdPhoto,idChanged,user.id);
    if(submittedIdPhoto)await db.prepare('UPDATE listings SET verified=0 WHERE seller_id=?').run(user.id);
    await db.prepare('UPDATE listings SET seller_name=?,initial=? WHERE seller_id=?').run(displayName,displayName.slice(0,2).toUpperCase(),user.id);
    return send(res, 200, { user:safeUser(await db.prepare('SELECT * FROM users WHERE id=?').get(user.id)) });
  }
  if (method === 'POST' && route === '/api/auth/register') {
    const body = await readBody(req); const email = text(body.email, 254, 'Email').toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, 'Enter a valid email address.');
    const displayName = text(body.displayName, 60, 'Full name');
    const schoolId = text(body.schoolId, 40, 'School ID').toUpperCase();
    const contactNo = text(body.contactNo, 25, 'Contact number', 7);
    const idPhoto=validateIdPhoto(body.idPhoto);
    const password = text(body.password, 200, 'Password', 12);
    if (!/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/[0-9]/.test(password) || !/[^A-Za-z0-9]/.test(password)) fail(400, 'Password must include a lowercase letter, an uppercase letter, a digit, and a special character.');
    if (await db.prepare('SELECT 1 FROM users WHERE email=?').get(email)) fail(409, 'An account with that email already exists.');
    if (await db.prepare("SELECT 1 FROM users WHERE school_id=? AND school_id<>''").get(schoolId)) fail(409, 'An account with that school ID already exists.');
    const salt = crypto.randomBytes(16); const derived = await scrypt(password, salt, 64, { N:1 << 15, r:8, p:1, maxmem:64 * 1024 * 1024 });
    const result = await db.prepare("INSERT INTO users(school_id,display_name,full_name,contact_no,id_photo_data,id_verification_status,role,email,password_hash,created_at) VALUES(?,?,?,?,?,'pending',?,?,?,?)")
      .run(schoolId,displayName,displayName,contactNo,idPhoto,'buyer',email,`scrypt$32768$8$1$${salt.toString('hex')}$${Buffer.from(derived).toString('hex')}`,nowIso());
    const user = await db.prepare('SELECT * FROM users WHERE id=?').get(Number(result.lastInsertRowid)); await createSession(user, res);
    return send(res, 201, { user:safeUser(user) });
  }
  if (method === 'POST' && (route === '/api/auth/login' || route === '/api/admin/login')) {
    rateLimitLogin(req); const body = await readBody(req); const email = text(body.email, 254, 'Email').toLowerCase(); const password = text(body.password, 200, 'Password');
    const user = await db.prepare('SELECT * FROM users WHERE email=?').get(email); const parts = user?.password_hash.split('$') || [];
    let matches = false;
    if (parts.length === 6 && parts[0] === 'scrypt') {
      const derived = await scrypt(password, Buffer.from(parts[4], 'hex'), 64, { N:Number(parts[1]), r:Number(parts[2]), p:Number(parts[3]), maxmem:64 * 1024 * 1024 });
      matches = crypto.timingSafeEqual(Buffer.from(parts[5], 'hex'), Buffer.from(derived));
    }
    if (!matches) fail(401, 'Email or password is incorrect.');
    const adminLogin = route === '/api/admin/login';
    if (adminLogin && user.role !== 'admin') fail(403, 'This account does not have admin access.');
    if (!adminLogin && user.role === 'admin') fail(403, 'Administrators must sign in from the dedicated admin login page.');
    await createSession(user, res, adminLogin); return send(res, 200, { user:safeUser(user) });
  }
  if (method === 'POST' && route === '/api/auth/logout') { await clearSession(req, res); return send(res, 200, { ok:true }); }
  if (method === 'POST' && route === '/api/admin/logout') { await clearSession(req, res); return send(res, 200, { ok:true }); }

  if (method === 'POST' && route === '/api/listings') {
    const user = await requireVerifiedUser(req); const body = await readBody(req);
    const title = text(body.title, 100, 'Title'); const description = text(body.description, 2000, 'Description', 5);
    const place=text(body.place,80,'School community');
    if(!['UM Panabo College','Aces Polytechnic College','Southern Davao National High School'].includes(place))fail(400,'Choose a school community for this listing.');
    const price = Number(body.price); if (!Number.isFinite(price) || price < 1 || price > 1000000) fail(400, 'Price must be between PHP 1 and PHP 1,000,000.');
    const validatePhoto = value => {
      if (typeof value !== 'string' || value.length > 1500000) fail(400, 'Each photo must be a JPG image no larger than 1 MB after processing.');
      const match = value.match(/^data:image\/jpeg;base64,([A-Za-z0-9+/]+={0,2})$/);
      if (!match) fail(400, 'Upload JPG, PNG, or WebP images.');
      const bytes = Buffer.from(match[1], 'base64');
      if (bytes.length > 1024*1024 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[bytes.length-2] !== 0xff || bytes[bytes.length-1] !== 0xd9) fail(400, 'A photo is invalid or too large.');
      return value;
    };
    let photosData=[];
    if (body.photosData !== undefined) {
      if (!Array.isArray(body.photosData) || body.photosData.length > 10) fail(400, 'Choose up to 10 item photos.');
      photosData=body.photosData.map(validatePhoto);
    } else if (body.photoData) photosData=[validatePhoto(body.photoData)];
    const photoData=photosData[0] || null;
    const kind = body.kind === 'digital' ? 'digital' : body.kind === 'physical' ? 'physical' : fail(400, 'Choose physical or digital goods.');
    const category = text(body.category, 60, 'Category');
    const categoryId = await ensureCategory(category);
    const condition = kind === 'digital' ? text(body.condition || 'Instant download', 40, 'Delivery type') : text(body.condition || 'Good', 40, 'Condition');
    
    const palette = kind === 'digital' ? 'linear-gradient(140deg,#d6d0f1,#a9a0dc)' : 'linear-gradient(140deg,#d4e4ce,#a8c6a4)';
    const result = await db.transaction(async()=>{
      const inserted=await db.prepare(`INSERT INTO listings(seller_id,title,seller_name,initial,price_cents,kind,category_id,category,\`condition\`,place,emoji,art,photo_data,note,open_to_trade,description,status,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',?)`).run(user.id,title,user.display_name,user.display_name.slice(0,1).toUpperCase(),Math.round(price*100),kind,categoryId,category,condition,place,kind==='digital'?'💾':'✨',palette,photoData,'AWAITING REVIEW',body.trade?1:0,description,nowIso());
      const listingId=Number(inserted.lastInsertRowid);
      await db.prepare('UPDATE listings SET verified=? WHERE id=?').run(user.id_verification_status==='verified'?1:0,listingId);
      for(let index=1;index<photosData.length;index++)await db.prepare('INSERT INTO listing_photos(listing_id,photo_order,photo_data) VALUES(?,?,?)').run(listingId,index+1,photosData[index]);
      return inserted;
    });
    const listingId=Number(result.lastInsertRowid);
    return send(res, 201, { listing:publicListing(await db.prepare('SELECT * FROM listings WHERE id=?').get(listingId),true,photosData),reviewRequired:true });
  }

  const listingStatusMatch=route.match(/^\/api\/listings\/(\d+)\/status$/);
  if(method==='PATCH'&&listingStatusMatch){
    const user=await requireVerifiedUser(req);const body=await readBody(req);
    const stateMap={available:'active',reserved:'reserved',sold:'sold'};const target=stateMap[body.status];
    if(!target)fail(400,'Choose Available, Reserved, or Sold.');
    const listingId=Number(listingStatusMatch[1]);
    await db.transaction(async()=>{
      const listing=await db.prepare('SELECT * FROM listings WHERE id=? FOR UPDATE').get(listingId);
      if(!listing||Number(listing.seller_id)!==Number(user.id))fail(404,'Your listing could not be found.');
      if(['hidden','traded'].includes(listing.status))fail(409,'This listing status can only be changed by its current marketplace process.');
      const approved=await db.prepare("SELECT id FROM orders WHERE listing_id=? AND queue_status='approved' LIMIT 1 FOR UPDATE").get(listing.id);
      if(approved&&target==='sold')fail(409,'Complete the approved order to mark this item sold and enable reviews.');
      if(approved&&target!=='reserved')fail(409,'This item is reserved for an approved order. Complete or cancel that order first.');
      await db.prepare('UPDATE listings SET status=? WHERE id=?').run(target,listing.id);
      if(target==='sold')await db.prepare("UPDATE orders SET queue_status='cancelled',status='cancelled' WHERE listing_id=? AND queue_status='queued'").run(listing.id);
    });
    return send(res,200,{listingId,status:target});
  }

  const orderMatch=route.match(/^\/api\/orders\/(\d+)$/);
  if(method==='PATCH'&&orderMatch){
    const user=await requireUser(req);const body=await readBody(req);const action=body.action;
    if(!['approved','cancelled','completed'].includes(action))fail(400,'Choose Approve, Decline, or Complete exchange.');
    const orderId=Number(orderMatch[1]);
    await db.transaction(async()=>{
      const order=await db.prepare('SELECT * FROM orders WHERE id=? FOR UPDATE').get(orderId);
      if(!order)fail(404,'Order request not found.');
      if(action==='approved'){
        if(Number(order.seller_id)!==Number(user.id))fail(403,'Only the seller can approve this order.');
        if(order.queue_status!=='queued')fail(409,'This request is no longer waiting for approval.');
        const first=await db.prepare("SELECT id FROM orders WHERE listing_id=? AND queue_status='queued' ORDER BY order_date,id LIMIT 1 FOR UPDATE").get(order.listing_id);
        if(!first||Number(first.id)!==Number(order.id))fail(409,'Review the earlier queued request first.');
        const listing=await db.prepare('SELECT * FROM listings WHERE id=? FOR UPDATE').get(order.listing_id);
        if(!listing||Number(listing.seller_id)!==Number(user.id)||listing.status!=='active')fail(409,'This listing is not available to approve.');
        await db.prepare("UPDATE listings SET status='reserved' WHERE id=? AND status='active'").run(listing.id);
        await db.prepare("UPDATE orders SET queue_status='approved',status='pending' WHERE id=? AND queue_status='queued'").run(order.id);
        await db.prepare("UPDATE orders SET queue_status='cancelled',status='cancelled' WHERE listing_id=? AND id<>? AND queue_status='queued'").run(order.listing_id,order.id);
      }else if(action==='cancelled'){
        const isBuyer=Number(order.buyer_id)===Number(user.id),isSeller=Number(order.seller_id)===Number(user.id);
        if(!isBuyer&&!isSeller)fail(403,'You cannot cancel this order.');
        const canCancelQueued=order.queue_status==='queued';
        const canCancelApproved=order.queue_status==='approved'&&!order.stripe_session_id;
        if(!canCancelQueued&&!canCancelApproved)fail(409,'This order can no longer be cancelled here.');
        await db.prepare("UPDATE orders SET queue_status='cancelled',status='cancelled' WHERE id=?").run(order.id);
        if(canCancelApproved)await db.prepare("UPDATE listings SET status='active' WHERE id=? AND seller_id=? AND status='reserved'").run(order.listing_id,order.seller_id);
      }else{
        if(Number(order.seller_id)!==Number(user.id))fail(403,'Only the seller can confirm the exchange.');
        if(order.queue_status!=='approved')fail(409,'Only an approved order can be completed.');
        if(order.stripe_session_id)fail(409,'This order has secure checkout in progress. Wait for payment confirmation before completing it.');
        const listing=await db.prepare('SELECT * FROM listings WHERE id=? FOR UPDATE').get(order.listing_id);
        if(!listing||Number(listing.seller_id)!==Number(user.id)||listing.status!=='reserved')fail(409,'The reserved listing could not be completed.');
        await db.prepare("UPDATE orders SET queue_status='completed',status='completed' WHERE id=? AND queue_status='approved'").run(order.id);
        await db.prepare("UPDATE listings SET status='sold' WHERE id=? AND seller_id=? AND status='reserved'").run(listing.id,user.id);
      }
    });
    return send(res,200,{orderId,action,queueStatus:action==='approved'?'approved':action==='completed'?'completed':'cancelled'});
  }

  const reviewMatch=route.match(/^\/api\/orders\/(\d+)\/reviews$/);
  if(method==='POST'&&reviewMatch){
    const user=await requireUser(req);const body=await readBody(req);const orderId=Number(reviewMatch[1]);
    const rating=Number(body.rating);if(!Number.isInteger(rating)||rating<1||rating>5)fail(400,'Choose a rating from 1 to 5.');
    const remarks=typeof body.remarks==='string'?body.remarks.trim().slice(0,2000):'';
    const reviewId=await db.transaction(async()=>{
      const order=await db.prepare('SELECT * FROM orders WHERE id=? FOR UPDATE').get(orderId);
      if(!order||order.queue_status!=='completed')fail(409,'Reviews are available after a completed exchange.');
      if(Number(order.buyer_id)!==Number(user.id)&&Number(order.seller_id)!==Number(user.id))fail(403,'Only the buyer and seller can review this exchange.');
      const previous=await db.prepare('SELECT review_id FROM reviews WHERE order_id=? AND reviewer_id=?').get(order.id,user.id);
      if(previous)fail(409,'You already reviewed this exchange.');
      const result=await db.prepare('INSERT INTO reviews(order_id,reviewer_id,rating,remarks,created_at) VALUES(?,?,?,?,?)').run(order.id,user.id,rating,remarks,nowIso());
      return Number(result.lastInsertRowid);
    });
    return send(res,201,{reviewId,orderId,rating,remarks});
  }

  if (method === 'POST' && route === '/api/trades') {
    const user = await requireVerifiedUser(req); const body = await readBody(req); const listingId = Number(body.listingId); const offeredId = Number(body.offeredListingId);
    const wanted = await db.prepare("SELECT * FROM listings WHERE id=? AND status='active'").get(listingId);
    const offered = await db.prepare("SELECT * FROM listings WHERE id=? AND status='active'").get(offeredId);
    if (!wanted || !offered) fail(404, 'One of those listings is no longer available.');
    if (!wanted.open_to_trade) fail(400, 'This seller is not accepting trade offers.');
    if (Number(wanted.seller_id) === Number(user.id)) fail(403, 'You can’t make a trade offer on your own listing.');
    if (Number(offered.seller_id) !== Number(user.id) || Number(offered.id) === Number(wanted.id)) fail(403, 'Choose one of your listings to offer for another member’s listing.');
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
    const user = await requireVerifiedUser(req); const body = await readBody(req); const status = body.status;
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
        await db.prepare("UPDATE orders SET queue_status='cancelled',status='cancelled' WHERE listing_id IN (?,?) AND queue_status='queued'").run(offer.listing_id,offer.offered_listing_id);
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
    if (listing.status === 'reserved') {
      const approvedOrder=await db.prepare("SELECT 1 FROM orders WHERE listing_id=? AND queue_status='approved' AND buyer_id=? AND seller_id=?").get(listingId,isSeller?otherId:user.id,isSeller?user.id:otherId);
      if(!approvedOrder)fail(403,'Only members in the approved order can message about this reserved item.');
    }
    if (isSeller && !await db.prepare('SELECT 1 FROM messages WHERE listing_id=? AND ((sender_id=? AND receiver_id=?) OR (sender_id=? AND receiver_id=?))').get(listingId,user.id,otherId,otherId,user.id)) fail(403, 'That conversation has not been started.');
    const rows = await db.prepare(`SELECT m.id,m.body,m.created_at,m.sender_id,u.display_name AS sender_name
      FROM messages m JOIN users u ON u.id=m.sender_id WHERE m.listing_id=? AND
      ((m.sender_id=? AND m.receiver_id=?) OR (m.sender_id=? AND m.receiver_id=?)) ORDER BY m.id`).all(listingId,user.id,otherId,otherId,user.id);
    return send(res, 200, { messages:rows.map(m=>({id:m.id,body:m.body,createdAt:m.created_at,senderId:m.sender_id,sender:m.sender_name,mine:Number(m.sender_id)===Number(user.id)})) });
  }
  if (messageMatch && method === 'POST') {
    const user = await requireVerifiedUser(req); const body = await readBody(req); const listingId = Number(messageMatch[1]);
    const listing = await db.prepare(`SELECT * FROM listings WHERE id=? AND (status='active' OR (status='reserved' AND EXISTS (
      SELECT 1 FROM orders o WHERE o.listing_id=listings.id AND o.queue_status='approved' AND
      ((o.buyer_id=? AND o.seller_id=listings.seller_id) OR (o.seller_id=? AND o.buyer_id=?)))))`).get(listingId,user.id,user.id,user.id);
    if (!listing) fail(404, 'Listing not found or no approved order exists for it.');
    if (!listing.seller_id) fail(400, 'Messages are available for member listings.');
    const isSeller = Number(user.id) === Number(listing.seller_id);
    const receiverId = isSeller ? Number(body.recipientId) : listing.seller_id;
    if (!receiverId || receiverId === user.id) fail(400, 'Choose the other member in this conversation.');
    if (listing.status === 'reserved') {
      const approvedOrder=await db.prepare("SELECT 1 FROM orders WHERE listing_id=? AND queue_status='approved' AND buyer_id=? AND seller_id=?").get(listingId,isSeller?receiverId:user.id,isSeller?user.id:receiverId);
      if(!approvedOrder)fail(403,'Only members in the approved order can message about this reserved item.');
    }
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
    const user = await requireVerifiedUser(req); const feeBps = stripeReady(); const body = await readBody(req); const orderId=Number(body.orderId);
    if(!Number.isSafeInteger(orderId)||orderId<1)fail(400,'Choose an approved order to pay.');
    const order=await db.prepare("SELECT * FROM orders WHERE id=? AND buyer_id=? AND queue_status='approved' AND status='pending' AND stripe_session_id IS NULL").get(orderId,user.id);
    if(!order)fail(409,'Only an approved, unpaid order can use secure checkout.');
    const listing=await db.prepare("SELECT * FROM listings WHERE id=? AND status='reserved'").get(order.listing_id);
    if(!listing)fail(409,'The item is no longer reserved for this order.');
    const seller = await db.prepare('SELECT * FROM users WHERE id=?').get(order.seller_id);
    if (!seller?.stripe_account_id || !seller.stripe_charges_enabled || !seller.stripe_payouts_enabled) fail(409,'The seller has not finished setting up payouts yet.');
    const fee = Math.floor(listing.price_cents*feeBps/10000);
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
    const saved=await db.prepare("UPDATE orders SET stripe_session_id=? WHERE id=? AND queue_status='approved' AND status='pending' AND stripe_session_id IS NULL").run(session.id,orderId);
    if(!saved.changes){try{await stripePost(`checkout/sessions/${encodeURIComponent(session.id)}/expire`,{});}catch{}fail(409,'This order changed while checkout was opening. Refresh your orders.');}
    return send(res,201,{url:session.url});
  }
  if (method === 'POST' && route === '/api/payments/cancel') {
    const user = await requireUser(req); const body=await readBody(req); const orderId=Number(body.orderId);
    const order=await db.prepare("SELECT * FROM orders WHERE id=? AND buyer_id=? AND status='pending' AND queue_status='approved'").get(orderId,user.id);
    if (!order) return send(res,200,{ok:true});
    if (order.stripe_session_id) await stripePost(`checkout/sessions/${encodeURIComponent(order.stripe_session_id)}/expire`,{});
    await db.exec('BEGIN IMMEDIATE');
    try {
      await db.prepare("UPDATE orders SET status='expired',queue_status='cancelled' WHERE id=? AND status='pending' AND queue_status='approved'").run(order.id);
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
        const order = await db.prepare("SELECT * FROM orders WHERE id=? AND status='pending' AND queue_status='approved'").get(orderId);
        if (order) {
          await db.exec('BEGIN IMMEDIATE');
          try {
            await db.prepare("UPDATE orders SET status='paid',queue_status='completed',paid_at=? WHERE id=? AND status='pending' AND queue_status='approved'").run(nowIso(),order.id);
            await db.prepare("UPDATE listings SET status='sold' WHERE id=? AND seller_id=? AND status='reserved'").run(order.listing_id,order.seller_id);
            await db.exec('COMMIT');
          } catch (e) { await db.exec('ROLLBACK'); throw e; }
        }
      }
    }
    if (event.type === 'checkout.session.expired') {
      const session = event.data?.object; if (session?.client_reference_id) {
        const orderId=Number(session.client_reference_id); const order=await db.prepare("SELECT * FROM orders WHERE id=? AND status='pending' AND queue_status='approved'").get(orderId);
        if(order){await db.exec('BEGIN IMMEDIATE');try{await db.prepare("UPDATE orders SET status='expired',queue_status='cancelled' WHERE id=? AND status='pending' AND queue_status='approved'").run(order.id);await db.prepare("UPDATE listings SET status='active' WHERE id=? AND status='reserved'").run(order.listing_id);await db.exec('COMMIT');}catch(error){if(db.isTransaction)await db.exec('ROLLBACK');throw error;}}
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
    if (url.pathname === '/admin' || url.pathname === '/admin/') {
      res.writeHead(302,{ Location:`${ADMIN_ORIGIN}/${url.search}`, 'Cache-Control':'no-store' });
      return res.end();
    }
    if (url.pathname === '/auth') {
      res.writeHead(301,{ Location:`${url.pathname}/${url.search}`, 'Cache-Control':'no-store' });
      return res.end();
    }
    const publicFiles = new Map([
      ['/','index.html'],['/index.html','index.html'],['/assets/favicon.png','assets/favicon.png'],['/assets/css/landing.css','assets/css/landing.css'],['/assets/css/theme.css','assets/css/theme.css'],['/assets/css/design-refresh.css','assets/css/design-refresh.css'],['/assets/js/theme.js','assets/js/theme.js'],['/assets/js/landing.js','assets/js/landing.js'],['/marketplace.html','marketplace.html'],['/orders.html','orders.html'],['/profile.html','profile.html'],['/assets/js/profile-page.js','assets/js/profile-page.js'],['/assets/js/orders-page.js','assets/js/orders-page.js'],['/assets/css/styles.css','assets/css/styles.css'],['/assets/js/data.js','assets/js/data.js'],['/assets/js/app.js','assets/js/app.js'],
      ['/auth/','auth/index.html'],['/auth/index.html','auth/index.html'],['/auth/auth.css','auth/auth.css'],['/auth/auth.js','auth/auth.js']
    ]);
    const asset = publicFiles.get(decodeURIComponent(url.pathname));
    if (!asset) return send(res,404,{error:'Not found.'});
    const filePath = path.join(ROOT,asset);
    let stat; try { stat = fs.statSync(filePath); } catch { return send(res,404,{error:'Not found.'}); }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200,{ 'Content-Type':mime[ext]||'application/octet-stream', 'X-Content-Type-Options':'nosniff', 'Referrer-Policy':'same-origin', 'X-Frame-Options':'DENY', 'Content-Security-Policy':"default-src 'self' https://fonts.googleapis.com https://fonts.gstatic.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' blob: https://cdn.jsdelivr.net; worker-src 'self' blob:; img-src 'self' data: blob:; connect-src 'self' https://cdn.jsdelivr.net https://tessdata.projectnaptha.com; frame-ancestors 'none'" });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(filePath).pipe(res);
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    if (status === 500) console.error(error);
    if (!res.headersSent) send(res,status,{error:status===500?'Internal server error.':error.message}); else res.destroy();
  }
}

async function adminHandler(req,res){
  try{
    if(req.method!=='GET'&&req.method!=='HEAD')return send(res,405,{error:'Method not allowed.'});
    const route=new URL(req.url,'http://localhost').pathname;
    const files=new Map([['/','live.html'],['/index.html','live.html'],['/admin.css','live.css'],['/admin.js','live.js'],['/assets/favicon.png',path.join(ROOT,'assets/favicon.png')],['/assets/css/styles.css',path.join(ROOT,'assets/css/styles.css')],['/assets/css/theme.css',path.join(ROOT,'assets/css/theme.css')],['/assets/css/design-refresh.css',path.join(ROOT,'assets/css/design-refresh.css')],['/assets/js/theme.js',path.join(ROOT,'assets/js/theme.js')]]);
    const asset=files.get(decodeURIComponent(route));
    if(!asset)return send(res,404,{error:'Not found.'});
    const filePath=path.isAbsolute(asset)?asset:path.join(ADMIN_ROOT,asset);
    const stat=fs.statSync(filePath);if(!stat.isFile())return send(res,404,{error:'Not found.'});
    const ext=path.extname(filePath).toLowerCase();
    res.writeHead(200,{'Content-Type':mime[ext]||'application/octet-stream','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','X-Frame-Options':'DENY','Content-Security-Policy':`default-src 'self' https://fonts.googleapis.com https://fonts.gstatic.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ${APP_URL}; frame-ancestors 'none'`});
    if(req.method==='HEAD')return res.end();
    fs.createReadStream(filePath).pipe(res);
  }catch(error){if(!res.headersSent)send(res,500,{error:'Admin page could not be opened.'});else res.destroy();}
}

initializeDatabase().then(()=>{
  http.createServer(handler).listen(PORT,'127.0.0.1',()=>console.log(`YouFind API and marketplace listening at ${APP_URL}`));
  http.createServer(adminHandler).listen(ADMIN_PORT,'127.0.0.1',()=>console.log(`YouFind admin panel listening at ${ADMIN_ORIGIN}`));
}).catch(async error=>{console.error(error.message);await pool.end();process.exitCode=1;});
