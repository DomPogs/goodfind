-- Core marketplace entities from the Campus Marketplace and Trading System ERD.
-- The extra session, messaging, trade, and payment columns support the current app.
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  user_id INTEGER GENERATED ALWAYS AS (id) VIRTUAL UNIQUE,
  school_id TEXT NOT NULL DEFAULT '',
  display_name TEXT NOT NULL,
  full_name TEXT NOT NULL,
  contact_no TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'buyer' CHECK(role IN ('buyer','seller','admin')),
  stripe_account_id TEXT,
  stripe_charges_enabled INTEGER NOT NULL DEFAULT 0,
  stripe_payouts_enabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS categories (
  category_id INTEGER PRIMARY KEY,
  category_name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS listings (
  id INTEGER PRIMARY KEY,
  listing_id INTEGER GENERATED ALWAYS AS (id) VIRTUAL UNIQUE,
  seller_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  category_id INTEGER NOT NULL REFERENCES categories(category_id),
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  seller_name TEXT NOT NULL,
  initial TEXT NOT NULL,
  verified INTEGER NOT NULL DEFAULT 0,
  price_cents INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('physical','digital')),
  condition TEXT NOT NULL,
  place TEXT NOT NULL,
  emoji TEXT NOT NULL,
  art TEXT NOT NULL,
  note TEXT NOT NULL,
  open_to_trade INTEGER NOT NULL DEFAULT 0,
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  item_status TEXT GENERATED ALWAYS AS (status) VIRTUAL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY,
  order_id INTEGER GENERATED ALWAYS AS (id) VIRTUAL UNIQUE,
  listing_id INTEGER NOT NULL REFERENCES listings(id),
  buyer_id INTEGER NOT NULL REFERENCES users(id),
  order_date TEXT NOT NULL,
  queue_status TEXT NOT NULL DEFAULT 'queued' CHECK(queue_status IN ('queued','approved','completed','cancelled')),
  seller_id INTEGER NOT NULL REFERENCES users(id),
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  stripe_session_id TEXT UNIQUE,
  created_at TEXT NOT NULL,
  paid_at TEXT
);

CREATE TABLE IF NOT EXISTS reviews (
  review_id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
  reviewer_id INTEGER NOT NULL REFERENCES users(id),
  rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
  remarks TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS trade_offers (
  id INTEGER PRIMARY KEY,
  listing_id INTEGER NOT NULL REFERENCES listings(id),
  offered_listing_id INTEGER NOT NULL REFERENCES listings(id),
  sender_id INTEGER NOT NULL REFERENCES users(id),
  receiver_id INTEGER NOT NULL REFERENCES users(id),
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  listing_id INTEGER NOT NULL REFERENCES listings(id),
  sender_id INTEGER NOT NULL REFERENCES users(id),
  receiver_id INTEGER NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_listings_active ON listings(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(listing_id, sender_id, receiver_id, id);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);
