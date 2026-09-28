CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS events (
  id text PRIMARY KEY,
  title text NOT NULL,
  starts_at timestamptz NOT NULL,
  venue text NOT NULL,
  city text NOT NULL,
  active boolean NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS ticket_types (
  id text PRIMARY KEY,
  event_id text NOT NULL REFERENCES events(id),
  name text NOT NULL,
  price_xof bigint NOT NULL CHECK (price_xof > 0),
  capacity integer NOT NULL CHECK (capacity >= 0),
  sold_count integer NOT NULL DEFAULT 0 CHECK (sold_count >= 0),
  reserved_count integer NOT NULL DEFAULT 0 CHECK (reserved_count >= 0),
  sale_starts_at timestamptz,
  sale_ends_at timestamptz,
  active boolean NOT NULL DEFAULT false,
  CHECK (sold_count + reserved_count <= capacity)
);

CREATE TABLE IF NOT EXISTS payment_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference text NOT NULL UNIQUE,
  event_id text NOT NULL REFERENCES events(id),
  buyer_first_name text NOT NULL,
  buyer_last_name text NOT NULL,
  buyer_email text NOT NULL,
  buyer_phone text NOT NULL,
  amount_xof bigint NOT NULL CHECK (amount_xof > 0),
  currency char(3) NOT NULL DEFAULT 'XOF' CHECK (currency = 'XOF'),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','paid','failed','expired','paid_review')),
  expires_at timestamptz NOT NULL,
  reservation_released_at timestamptz,
  provider_transaction_id text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  paid_at timestamptz
);

CREATE TABLE IF NOT EXISTS payment_order_items (
  order_id uuid NOT NULL REFERENCES payment_orders(id),
  ticket_type_id text NOT NULL REFERENCES ticket_types(id),
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 8),
  unit_price_xof bigint NOT NULL CHECK (unit_price_xof > 0),
  PRIMARY KEY (order_id, ticket_type_id)
);

CREATE TABLE IF NOT EXISTS tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES payment_orders(id),
  ticket_type_id text NOT NULL REFERENCES ticket_types(id),
  code8 char(8) NOT NULL UNIQUE CHECK (code8 ~ '^[0-9]{8}$'),
  qr_token text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'valid' CHECK (status IN ('valid','used','cancelled')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS payment_orders_expiry_idx
  ON payment_orders (expires_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS payment_items_ticket_idx
  ON payment_order_items (ticket_type_id);
