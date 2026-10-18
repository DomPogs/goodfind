-- MySQL/MariaDB schema for the YouFind local marketplace.
-- Select the youfind database in phpMyAdmin, then use Import to run this file.
SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

CREATE TABLE IF NOT EXISTS users (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  school_id VARCHAR(40) NOT NULL DEFAULT '',
  display_name VARCHAR(120) NOT NULL,
  full_name VARCHAR(120) NOT NULL,
  contact_no VARCHAR(25) NOT NULL DEFAULT '',
  profile_photo MEDIUMTEXT NULL,
  email VARCHAR(254) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role ENUM('buyer','seller','admin') NOT NULL DEFAULT 'buyer',
  stripe_account_id VARCHAR(128) NULL,
  stripe_charges_enabled TINYINT(1) NOT NULL DEFAULT 0,
  stripe_payouts_enabled TINYINT(1) NOT NULL DEFAULT 0,
  created_at VARCHAR(32) NOT NULL,
  PRIMARY KEY (id), UNIQUE KEY uq_users_email (email),
  UNIQUE KEY uq_users_school_id (school_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS categories (
  category_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  category_name VARCHAR(100) NOT NULL,
  description VARCHAR(500) NOT NULL DEFAULT '',
  PRIMARY KEY (category_id), UNIQUE KEY uq_categories_name (category_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sessions (
  token_hash CHAR(64) NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  expires_at BIGINT NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  PRIMARY KEY (token_hash), KEY idx_sessions_expiry (expires_at),
  CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS listings (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  seller_id BIGINT UNSIGNED NULL,
  category_id BIGINT UNSIGNED NOT NULL,
  category VARCHAR(100) NOT NULL,
  title VARCHAR(255) NOT NULL,
  seller_name VARCHAR(120) NOT NULL,
  initial VARCHAR(8) NOT NULL,
  verified TINYINT(1) NOT NULL DEFAULT 0,
  price_cents BIGINT NOT NULL,
  kind ENUM('physical','digital') NOT NULL,
  `condition` VARCHAR(80) NOT NULL,
  place VARCHAR(120) NOT NULL,
  emoji VARCHAR(32) NOT NULL,
  art VARCHAR(255) NOT NULL,
  photo_data MEDIUMTEXT NULL,
  note VARCHAR(255) NOT NULL,
  open_to_trade TINYINT(1) NOT NULL DEFAULT 0,
  description TEXT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  created_at VARCHAR(32) NOT NULL,
  PRIMARY KEY (id),
  KEY idx_listings_active (status, created_at), KEY idx_listings_category (category_id),
  CONSTRAINT fk_listings_seller FOREIGN KEY (seller_id) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_listings_category FOREIGN KEY (category_id) REFERENCES categories(category_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS orders (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  listing_id BIGINT UNSIGNED NOT NULL,
  buyer_id BIGINT UNSIGNED NOT NULL,
  seller_id BIGINT UNSIGNED NOT NULL,
  order_date VARCHAR(32) NOT NULL,
  queue_status ENUM('queued','approved','completed','cancelled') NOT NULL DEFAULT 'queued',
  amount_cents BIGINT NOT NULL,
  currency CHAR(3) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  stripe_session_id VARCHAR(255) NULL,
  created_at VARCHAR(32) NOT NULL,
  paid_at VARCHAR(32) NULL,
  PRIMARY KEY (id), UNIQUE KEY uq_orders_stripe (stripe_session_id),
  CONSTRAINT fk_orders_listing FOREIGN KEY (listing_id) REFERENCES listings(id),
  CONSTRAINT fk_orders_buyer FOREIGN KEY (buyer_id) REFERENCES users(id),
  CONSTRAINT fk_orders_seller FOREIGN KEY (seller_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS reviews (
  review_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  order_id BIGINT UNSIGNED NOT NULL,
  reviewer_id BIGINT UNSIGNED NOT NULL,
  rating TINYINT UNSIGNED NOT NULL,
  remarks VARCHAR(2000) NOT NULL DEFAULT '',
  created_at VARCHAR(32) NOT NULL,
  PRIMARY KEY (review_id), UNIQUE KEY uq_reviews_order (order_id),
  CONSTRAINT chk_reviews_rating CHECK (rating BETWEEN 1 AND 5),
  CONSTRAINT fk_reviews_order FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
  CONSTRAINT fk_reviews_user FOREIGN KEY (reviewer_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS trade_offers (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  listing_id BIGINT UNSIGNED NOT NULL,
  offered_listing_id BIGINT UNSIGNED NOT NULL,
  sender_id BIGINT UNSIGNED NOT NULL,
  receiver_id BIGINT UNSIGNED NOT NULL,
  note VARCHAR(500) NOT NULL DEFAULT '',
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  PRIMARY KEY (id),
  CONSTRAINT fk_trades_listing FOREIGN KEY (listing_id) REFERENCES listings(id),
  CONSTRAINT fk_trades_offered FOREIGN KEY (offered_listing_id) REFERENCES listings(id),
  CONSTRAINT fk_trades_sender FOREIGN KEY (sender_id) REFERENCES users(id),
  CONSTRAINT fk_trades_receiver FOREIGN KEY (receiver_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS messages (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  listing_id BIGINT UNSIGNED NOT NULL,
  sender_id BIGINT UNSIGNED NOT NULL,
  receiver_id BIGINT UNSIGNED NOT NULL,
  body TEXT NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  PRIMARY KEY (id), KEY idx_messages_thread (listing_id, sender_id, receiver_id, id),
  CONSTRAINT fk_messages_listing FOREIGN KEY (listing_id) REFERENCES listings(id),
  CONSTRAINT fk_messages_sender FOREIGN KEY (sender_id) REFERENCES users(id),
  CONSTRAINT fk_messages_receiver FOREIGN KEY (receiver_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET FOREIGN_KEY_CHECKS = 1;
