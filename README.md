# Goodfind

Goodfind is a local campus marketplace built with PHP 8 and MySQL/MariaDB. PHP serves the landing, marketplace, profile, order, sign-in, and admin pages, and `api.php` handles account, listing, order, review, trade, messaging, admin, and optional Stripe requests. CSS and browser JavaScript provide the page styling and interactive features.

## Run with XAMPP

1. Start **Apache** and **MySQL** in the XAMPP Control Panel.
2. In phpMyAdmin, create or select the `youfind` database and import `database/schema.sql`.
3. Set `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, and `DB_PASSWORD` in `.env` for your local MySQL connection. The file is blocked from web access.
4. Run `start-php.bat` from the Goodfind folder and leave its terminal open. It starts the PHP site locally on port 3000; Apache proxies the Goodfind folder to it.
5. Open `http://localhost/goodfind/`.
6. Open the separate admin page at `http://localhost/goodfind-admin/`.

The PHP application reads `.env` and connects through PDO MySQL. PHP 8.0+, PDO MySQL, cURL for optional Stripe payments, and the XAMPP OpenSSL executable are used. Set `OPENSSL_BIN` in `.env` if OpenSSL is installed elsewhere. PHP uses OpenSSL's SCRYPT KDF so existing account passwords remain usable.

For local troubleshooting, set `APP_DEBUG=1` in `.env`. API requests receive an `X-Request-ID` response header and are written to `logs/api-debug.log`; the log records route, method, status, duration, and server exceptions, but never request bodies or passwords.

No database reset is needed. Listings, users, orders, and sessions continue to use the current MySQL schema. New listings remain private until an admin approves them.

## Accounts and admin access

Sign-in and sign-up use the PHP page at `/goodfind/auth/`. Accounts are stored in MySQL and use HTTP-only cookies. New users submit a school ID photo for review. Administrators review school IDs and new listings from the separate admin page. Set `ADMIN_EMAIL` in `.env` to grant admin access to a registered account.

## Optional Stripe setup

Add Stripe test API and webhook secrets to `.env`, then set `PLATFORM_FEE_BPS` to the fee you chose (100 basis points = 1%). Configure webhook events `checkout.session.completed`, `checkout.session.expired`, and connected-account `account.updated`. Stripe needs a public webhook URL for a deployed site; localhost is suitable for local development only.

## Project folders

- Root `.php` pages contain the Goodfind site pages.
- `api.php` is the stable public endpoint used by the browser.
- `api/bootstrap.php` contains shared API setup, database helpers, and method dispatch.
- `api/crud/create.php`, `read.php`, `update.php`, and `delete.php` contain the matching route handlers.
- `assets/css` and `assets/js` contain styling and browser interactions.
- `auth` and `admin` contain the sign-in and admin page assets.
- `database/schema.sql` defines the MySQL tables.
