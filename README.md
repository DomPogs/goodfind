# Goodfind

A web-first marketplace for physical and digital goods, with optional item photos, Philippine peso prices, member accounts, listings, trade offers, private messages, and optional Stripe Connect checkout.

## Use phpMyAdmin with the local app

The app stores its data in MySQL/MariaDB, which you manage with phpMyAdmin. Requires Node.js 24 or newer and a running local MySQL/MariaDB server.

1. In phpMyAdmin, create or select the `youfind` database and choose **Import**.
2. Import `database/schema.sql`.
3. Copy `.env.example` to `.env`, then set `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, and `DB_PASSWORD` to your local MySQL connection settings. Keep the password in `.env`.
4. In a terminal opened in this folder, run `npm install`, then `npm start`.
5. Open `http://localhost:3000`.

The server checks the MySQL connection at startup and creates the marketplace category choices. New databases start with no listings; members add their own items. The previous SQLite file remains in `server-data` as a backup; the app no longer reads from it.

## Sign in and sign up

The sign-in and sign-up forms use a dedicated page and create real accounts. Every account can buy and list items. Open /auth/ when running at http://localhost:3000, or /goodfind/auth/ through XAMPP.


## Included

- Email and password accounts. Passwords use Node's built-in scrypt hash; sessions use random, HTTP-only cookies.
- MySQL/MariaDB-backed member listings, trade offers, messages, and orders.
- The database schema in `database/schema.sql` follows the provided ERD: Users, Categories, Listings, Orders, and Reviews, including its one-to-many and one-review-per-order relationships.
- Trade offers can be accepted, declined, or withdrawn. Accepted trades mark both listings as traded.
- The admin panel is at `/admin/` (through the local Goodfind server: `http://localhost:3000/admin/`). Create a regular account, set `ADMIN_EMAIL` to that account's email in `.env`, and restart the server. The account can then sign in on the admin page to review marketplace counts and hide or restore listings.
- Stripe Connect seller onboarding and hosted Checkout integration are implemented, but payments stay disabled until Stripe is configured.
- Stripe webhook handling updates payment and connected-account status. Checkout reserves a listing so two buyers cannot purchase it at once.

## Optional Stripe test setup

Copy `.env.example` to `.env`, then add Stripe **test-mode** API and webhook secrets. Set `PLATFORM_FEE_BPS` to the marketplace fee you choose, in basis points (100 = 1%). The app intentionally has no default fee. Configure a Stripe Connect webhook at `/api/payments/stripe-webhook` for `checkout.session.completed`, `checkout.session.expired`, and connected-account `account.updated` events. Restart with `node --env-file=.env server.js`.

Use test keys and Stripe test accounts first. Live processing also requires a Stripe platform account, supported seller countries, an approved fee policy, and your tax, shipping, refund, and privacy terms. Those business settings are not inferred by this prototype.

## Notes

- The server binds to the local machine on port 3000 by default. Do not expose it to the public internet as-is.
- School ID and contact details are stored during registration, but the prototype does not verify IDs with the school. Password recovery, review submission UI, seller order approval, image uploads, shipping and tax calculation, and production deployment are not included.
- Trade messages are stored in the MySQL database. The interface refreshes messages on demand; it does not use live push updates.
- `.env` and `server-data/` are local/private and excluded from Git.

## Project folders

- `assets/css` and `assets/js` contain shared stylesheets and browser scripts.
- `admin` and `auth` contain their page-specific files.
- `database` contains the MySQL schema; `server-data` is reserved for local database data.
- `logs` contains server log files.
- The root holds the Node server, package files, environment configuration, and the landing and marketplace pages.