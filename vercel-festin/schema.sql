CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS festin_sessions (
  token_hash char(64) PRIMARY KEY,
  username text NOT NULL CHECK (username IN ('admin', 'verif')),
  role text NOT NULL CHECK (role IN ('admin', 'verifier')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS festin_sessions_expiry_idx ON festin_sessions (expires_at);

CREATE TABLE IF NOT EXISTS festin_login_attempts (
  bucket_hash char(64) PRIMARY KEY,
  attempts integer NOT NULL CHECK (attempts >= 0),
  window_started_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS festin_login_attempts_window_idx ON festin_login_attempts (window_started_at);

CREATE TABLE IF NOT EXISTS festin_tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_code varchar(14) NOT NULL UNIQUE CHECK (ticket_code ~ '^[JD]-[0-9]{5,12}$'),
  qr_token_hash char(64) NOT NULL UNIQUE,
  buyer_name varchar(120) NOT NULL,
  buyer_phone varchar(40) NOT NULL,
  pass text NOT NULL CHECK (pass IN ('jeunesse', 'doyen')),
  price_xof integer NOT NULL CHECK (
    (pass = 'jeunesse' AND price_xof = 5000) OR
    (pass = 'doyen' AND price_xof = 10000)
  ),
  status text NOT NULL DEFAULT 'valid' CHECK (status IN ('valid', 'used', 'cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  checked_in_at timestamptz,
  cancelled_at timestamptz,
  CHECK ((status = 'used') = (checked_in_at IS NOT NULL)),
  CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS festin_tickets_created_idx ON festin_tickets (created_at DESC);
CREATE INDEX IF NOT EXISTS festin_tickets_name_idx ON festin_tickets (lower(buyer_name));

CREATE TABLE IF NOT EXISTS festin_audit_log (
  id bigserial PRIMARY KEY,
  actor text NOT NULL CHECK (actor IN ('admin', 'verif')),
  action text NOT NULL CHECK (action IN ('ticket_created', 'ticket_imported', 'ticket_cancelled', 'qr_reissued', 'check_in', 'check_in_imported')),
  ticket_id uuid REFERENCES festin_tickets(id),
  ticket_code varchar(14),
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS festin_audit_occurred_idx ON festin_audit_log (occurred_at DESC);
