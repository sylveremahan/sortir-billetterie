# Paystack payment API

This API is intentionally separate from the GitHub Pages frontend. It must run on a Node host with HTTPS, a PostgreSQL database, and server-side secrets. The browser must never receive `PAYSTACK_SECRET_KEY`.

## Requirements

- Node.js 20+
- PostgreSQL
- A Paystack merchant integration enabled for Côte d'Ivoire / XOF
- An HTTPS API host

## Configure

1. Create a PostgreSQL database and apply `api/schema.sql`.
2. Add the actual events and ticket types to `events` and `ticket_types`. Keep each event and ticket type inactive until its title, dates, prices and capacity are verified. Prices are entered in whole XOF; the API converts them to Paystack's required XOF subunit amount.
3. Set backend environment variables: `APP_ORIGIN=https://sylveremahan.github.io`, `DATABASE_URL`, and `PAYSTACK_SECRET_KEY`. Start with Paystack's test secret key. Add them in the backend host's secret manager, never in GitHub Pages or the repository.
4. Deploy with `npm install` then `npm start`.
5. Set the Paystack webhook URL to `https://YOUR-API-HOST/api/payments/webhook`. Enable the Mobile Money channel in Paystack. Keep test mode until the end-to-end test is complete.
6. Set `PAYMENT_API_URL` in the public site's build/configuration and connect its checkout button to `POST /api/payments/initialize`. This front-end handoff is not active yet, so the deployed checkout remains in demo mode.

## API

- `POST /api/payments/initialize`: body `{ eventId, items: [{ticketTypeId, quantity}], buyer: {firstName, lastName, email, phone} }`. It reserves available inventory in PostgreSQL, calculates the total from database prices, creates a Paystack checkout, and returns `authorizationUrl`.
- Paystack redirects to `/?payment=return`. The frontend must read the reference and call `GET /api/payments/verify?reference=...`.
- `POST /api/payments/webhook`: verifies Paystack's HMAC SHA-512 signature over the raw request body and independently verifies the transaction before marking it paid. Paid amounts and XOF currency must match the order.
- A confirmed payment allocates ticket rows with unique 8-digit codes and opaque QR tokens. Tickets are not yet emailed or exposed in a customer account. Expired reservations are released when a new order is created; production should also schedule a periodic expiry worker and add operations for refunds and delivery.

## XOF amount handling

Paystack's current API reference says XOF has no fractional subunit, but API amounts must still be multiplied by 100. This conversion is implemented in the backend; do not multiply prices in the database or browser. See Paystack's [API reference](https://paystack.com/docs/api/).

## Deployment caveat

GitHub Pages cannot host this server or its secrets. Deploy the API and PostgreSQL separately, then configure the webhook and front-end API URL before enabling checkout. A valid Paystack merchant account and test/live keys are required.
