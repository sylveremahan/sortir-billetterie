import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import pg from 'pg';
import QRCode from 'qrcode';

const { Pool } = pg;
const app = express();
const publicDirectory = fileURLToPath(new URL('./public/', import.meta.url));
const vercelEnvironment = process.env.VERCEL_ENV || process.env.NODE_ENV || 'development';
const isProduction = vercelEnvironment === 'production';
const isHosted = process.env.VERCEL === '1' && vercelEnvironment !== 'development';
const secureCookies = isProduction || isHosted;
const vercelHost = isProduction
  ? process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL
  : process.env.VERCEL_URL;
const origin = process.env.APP_ORIGIN || (vercelHost ? `https://${vercelHost}` : undefined);
const proxyHops = Number(process.env.TRUST_PROXY_HOPS ?? (isHosted ? 1 : 0));
const cookieName = secureCookies ? '__Host-festin_session' : 'festin_session';
const sessionHours = 8;
const passInfo = Object.freeze({
  jeunesse: { label: 'Ticket "Jeunesse"', price: 5000, prefix: 'J' },
  doyen: { label: 'Pass "Doyen"', price: 10000, prefix: 'D' },
});

function validPasswordHash(encoded) {
  const parts = String(encoded || '').split('$');
  return parts.length === 6 && parts[0] === 'scrypt' && parts[1] === '16384' && parts[2] === '8' && parts[3] === '1' &&
    Buffer.from(parts[4], 'base64url').length === 16 && Buffer.from(parts[5], 'base64url').length === 64;
}

const adminHash = process.env.ADMIN_PASSWORD_HASH;
const verifierHash = process.env.VERIFIER_PASSWORD_HASH;
if (!origin || !process.env.DATABASE_URL || !validPasswordHash(adminHash) || !validPasswordHash(verifierHash)) {
  throw new Error('Configure APP_ORIGIN, DATABASE_URL, ADMIN_PASSWORD_HASH, and VERIFIER_PASSWORD_HASH before starting Festin.');
}
const parsedOrigin = new URL(origin);
if (parsedOrigin.origin !== origin || parsedOrigin.pathname !== '/' || parsedOrigin.search || parsedOrigin.hash) throw new Error('APP_ORIGIN must contain only the site origin, without a path.');
if (!Number.isInteger(proxyHops) || proxyHops < 0 || proxyHops > 5) throw new Error('TRUST_PROXY_HOPS must be an integer from 0 to 5.');
if ((isProduction || isHosted) && parsedOrigin.protocol !== 'https:') throw new Error('APP_ORIGIN must use HTTPS in hosted environments.');
if ((isProduction || isHosted) && (process.env.DATABASE_SSL === 'disable' || process.env.PGSSL_REJECT_UNAUTHORIZED === 'false')) {
  throw new Error('PostgreSQL TLS verification cannot be disabled in hosted environments.');
}

const databaseUrl = new URL(process.env.DATABASE_URL);
for (const setting of ['sslmode', 'ssl', 'sslcert', 'sslkey', 'sslrootcert']) databaseUrl.searchParams.delete(setting);
const pool = new Pool({
  connectionString: databaseUrl.toString(),
  ssl: process.env.DATABASE_SSL === 'disable' && !isHosted && !isProduction ? false : { rejectUnauthorized: true },
  max: 2,
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 30000,
});

app.disable('x-powered-by');
app.set('trust proxy', proxyHops);
app.use(helmet({
  hsts: secureCookies ? undefined : false,
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      baseUri: ["'self'"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      imgSrc: ["'self'", 'data:'],
      objectSrc: ["'none'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      upgradeInsecureRequests: isProduction ? [] : null,
    },
  },
  crossOriginEmbedderPolicy: false,
}));
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()');
  if ((isProduction || isHosted) && !req.secure) return res.status(400).send('HTTPS is required.');
  if (req.method === 'POST' || req.method === 'DELETE') {
    if (req.get('origin') !== origin) return res.sendStatus(403);
    if (!req.is('application/json')) return res.status(415).json({ error: 'Content-Type application/json is required.' });
  }
  next();
});
app.use(express.json({ limit: '2mb', strict: true }));
app.use('/api/auth/login', rateLimit({ windowMs: 15 * 60_000, limit: 8, standardHeaders: 'draft-8', legacyHeaders: false }));
app.use('/api/check-in', rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false }));
app.use('/api/tickets', rateLimit({ windowMs: 60_000, limit: 40, standardHeaders: 'draft-8', legacyHeaders: false }));

app.get('/api/health', async (_req, res) => {
  try { await pool.query('SELECT 1'); res.json({ ok: true }); }
  catch { res.status(503).json({ ok: false }); }
});

app.post('/api/auth/login', async (req, res) => {
  const username = typeof req.body?.username === 'string' ? req.body.username.trim().toLowerCase() : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  let loginLimit;
  try { loginLimit = await consumeLoginAttempt(req.ip || 'unknown'); }
  catch { return res.status(503).json({ error: 'Connexion indisponible. Réessayez plus tard.' }); }
  if (!loginLimit.allowed) {
    res.setHeader('Retry-After', String(loginLimit.retryAfter));
    return res.status(429).json({ error: 'Trop de tentatives. Réessayez plus tard.' });
  }
  const role = username === 'admin' ? 'admin' : username === 'verif' ? 'verifier' : null;
  const configuredHash = role === 'admin' ? adminHash : role === 'verifier' ? verifierHash : adminHash;
  const matches = await verifyPassword(password, configuredHash);
  if (!role || !matches) return res.status(401).json({ error: 'Identifiant ou mot de passe incorrect.' });

  const rawToken = crypto.randomBytes(32).toString('base64url');
  const tokenHash = digest(rawToken);
  const expiresAt = new Date(Date.now() + sessionHours * 60 * 60 * 1000);
  try {
    await pool.query('DELETE FROM festin_sessions WHERE expires_at <= now()');
    await pool.query('DELETE FROM festin_login_attempts WHERE window_started_at < now()-interval \'1 day\'');
    await pool.query('INSERT INTO festin_sessions (token_hash,username,role,expires_at) VALUES ($1,$2,$3,$4)', [tokenHash, username, role, expiresAt]);
    await pool.query('DELETE FROM festin_login_attempts WHERE bucket_hash=$1', [digest(`login-ip:${req.ip || 'unknown'}`)]);
  } catch {
    return res.status(503).json({ error: 'Connexion indisponible. Réessayez plus tard.' });
  }
  setSessionCookie(res, rawToken, expiresAt);
  res.json({ username, role, expiresAt });
});

app.post('/api/auth/logout', requireSession, async (req, res) => {
  await pool.query('DELETE FROM festin_sessions WHERE token_hash=$1', [req.session.tokenHash]);
  clearSessionCookie(res);
  res.sendStatus(204);
});

app.get('/api/auth/session', requireSession, (req, res) => {
  res.json({ username: req.session.username, role: req.session.role, expiresAt: req.session.expiresAt });
});

app.post('/api/tickets', requireSession, requireRole('admin'), async (req, res) => {
  const buyerName = cleanText(req.body?.buyerName, 1, 120);
  const buyerPhone = cleanText(req.body?.buyerPhone, 7, 40);
  const pass = req.body?.pass;
  if (!buyerName || !buyerPhone || !Object.hasOwn(passInfo, pass)) {
    return res.status(400).json({ error: 'Indiquez un nom, un téléphone et un pass valide.' });
  }
  if (!/^[+0-9 ()-]+$/.test(buyerPhone)) return res.status(400).json({ error: 'Le numéro de téléphone contient des caractères invalides.' });

  const info = passInfo[pass];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let ticket;
    let qrToken;
    for (let attempt = 0; attempt < 8 && !ticket; attempt++) {
      const digits = String(crypto.randomInt(0, 1_000_000_000_000)).padStart(12, '0');
      const ticketCode = `${info.prefix}-${digits}`;
      qrToken = crypto.randomBytes(32).toString('base64url');
      const inserted = await client.query(
        `INSERT INTO festin_tickets (ticket_code,qr_token_hash,buyer_name,buyer_phone,pass,price_xof)
         VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (ticket_code) DO NOTHING
         RETURNING id,ticket_code,buyer_name,buyer_phone,pass,price_xof,status,created_at,checked_in_at`,
        [ticketCode, digest(qrToken), buyerName, buyerPhone, pass, info.price],
      );
      ticket = inserted.rows[0];
    }
    if (!ticket) throw new Error('Could not allocate ticket code.');
    await client.query('INSERT INTO festin_audit_log (actor,action,ticket_id,ticket_code) VALUES ($1,$2,$3,$4)', [req.session.username, 'ticket_created', ticket.id, ticket.ticket_code]);
    const qrDataUrl = await makeQr(qrToken);
    await client.query('COMMIT');
    res.status(201).json({ ticket: ticketForAdmin(ticket), qrDataUrl });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Festin ticket creation failed:', error.message);
    res.status(503).json({ error: 'Le billet n’a pas pu être enregistré. Réessayez.' });
  } finally { client.release(); }
});

app.get('/api/tickets', requireSession, requireRole('admin'), async (req, res) => {
  const search = cleanText(req.query.q, 0, 100) || '';
  try {
    const { rows } = await pool.query(
      `SELECT id,ticket_code,buyer_name,buyer_phone,pass,price_xof,status,created_at,checked_in_at
       FROM festin_tickets
       WHERE ($1 = '' OR ticket_code ILIKE $2 OR buyer_name ILIKE $2 OR buyer_phone ILIKE $2)
       ORDER BY created_at DESC LIMIT 500`,
      [search, `%${search.replace(/[\\%_]/g, '\\$&')}%`],
    );
    const { rows: totals } = await pool.query(
      `SELECT count(*) FILTER (WHERE status<>'cancelled')::int AS total,
              count(*) FILTER (WHERE status='used')::int AS checked_in,
              coalesce(sum(price_xof),0)::bigint AS revenue
       FROM festin_tickets WHERE status <> 'cancelled'`,
    );
    res.json({ tickets: rows.map(ticketForAdmin), totals: totals[0] });
  } catch { res.status(503).json({ error: 'Historique indisponible.' }); }
});

app.get('/api/tickets/export', requireSession, requireRole('admin'), async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT ticket_code AS id,
              CASE WHEN pass='jeunesse' THEN 'J' ELSE 'D' END AS prefix,
              buyer_name AS "buyerName",buyer_phone AS "buyerPhone",pass,
              CASE WHEN pass='jeunesse' THEN 'Ticket "Jeunesse"' ELSE 'Pass "Doyen"' END AS "passLabel",
              price_xof AS price,created_at AS "createdAt",(status='used') AS "checkedIn",
              checked_in_at AS "checkedInAt"
       FROM festin_tickets WHERE status <> 'cancelled' ORDER BY created_at DESC`,
    );
    res.setHeader('Content-Disposition', 'attachment; filename="festin-tickets-export.json"');
    res.json(rows);
  } catch { res.status(503).json({ error: 'Export indisponible.' }); }
});

app.post('/api/tickets/import', requireSession, requireRole('admin'), async (req, res) => {
  const source = req.body?.tickets;
  if (!Array.isArray(source) || source.length > 10000) return res.status(400).json({ error: 'Le fichier doit contenir au plus 10 000 billets.' });
  const normalized = new Map();
  for (const item of source) {
    const ticket = validateLegacyTicket(item);
    if (!ticket) return res.status(400).json({ error: 'Import refusé : un billet contient des données invalides.' });
    const previous = normalized.get(ticket.code);
    if (previous && (previous.pass !== ticket.pass || previous.buyerName !== ticket.buyerName || previous.buyerPhone !== ticket.buyerPhone || previous.price !== ticket.price)) {
      return res.status(409).json({ error: `Import refusé : le code ${ticket.code} désigne plusieurs billets différents.` });
    }
    if (!previous || (ticket.checkedIn && !previous.checkedIn)) normalized.set(ticket.code, ticket);
  }

  const client = await pool.connect();
  let imported = 0;
  let merged = 0;
  try {
    await client.query('BEGIN');
    for (const ticket of normalized.values()) {
      const token = crypto.randomBytes(32).toString('base64url');
      const inserted = await client.query(
        `INSERT INTO festin_tickets (ticket_code,qr_token_hash,buyer_name,buyer_phone,pass,price_xof,status,created_at,checked_in_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (ticket_code) DO NOTHING RETURNING id,ticket_code,status`,
        [ticket.code, digest(token), ticket.buyerName, ticket.buyerPhone, ticket.pass, ticket.price,
          ticket.checkedIn ? 'used' : 'valid', ticket.createdAt, ticket.checkedInAt],
      );
      if (inserted.rows[0]) {
        imported++;
        await client.query('INSERT INTO festin_audit_log (actor,action,ticket_id,ticket_code) VALUES ($1,$2,$3,$4)',
          [req.session.username, 'ticket_imported', inserted.rows[0].id, ticket.code]);
        if (ticket.checkedIn) {
          await client.query('INSERT INTO festin_audit_log (actor,action,ticket_id,ticket_code) VALUES ($1,$2,$3,$4)',
            [req.session.username, 'check_in_imported', inserted.rows[0].id, ticket.code]);
        }
        continue;
      }
      const existing = await client.query(
        'SELECT id,buyer_name,buyer_phone,pass,price_xof,status FROM festin_tickets WHERE ticket_code=$1 FOR UPDATE', [ticket.code],
      );
      const current = existing.rows[0];
      if (!current || current.buyer_name !== ticket.buyerName || current.buyer_phone !== ticket.buyerPhone || current.pass !== ticket.pass || Number(current.price_xof) !== ticket.price) {
        const conflict = new Error(`Conflicting ticket ${ticket.code}`); conflict.status = 409; throw conflict;
      }
      if (ticket.checkedIn && current.status === 'valid') {
        await client.query("UPDATE festin_tickets SET status='used',checked_in_at=$2 WHERE id=$1", [current.id, ticket.checkedInAt]);
        await client.query('INSERT INTO festin_audit_log (actor,action,ticket_id,ticket_code) VALUES ($1,$2,$3,$4)',
          [req.session.username, 'check_in_imported', current.id, ticket.code]);
        merged++;
      }
    }
    await client.query('COMMIT');
    res.json({ imported, merged, processed: normalized.size });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(error.status || 503).json({ error: error.status ? error.message : 'Import impossible. Aucune modification n’a été enregistrée.' });
  } finally { client.release(); }
});

app.post('/api/tickets/:id/reissue-qr', requireSession, requireRole('admin'), async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(400).json({ error: 'Billet invalide.' });
  const qrToken = crypto.randomBytes(32).toString('base64url');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `UPDATE festin_tickets SET qr_token_hash=$2 WHERE id=$1 AND status='valid'
       RETURNING id,ticket_code,buyer_name,buyer_phone,pass,price_xof,status,created_at,checked_in_at`,
      [req.params.id, digest(qrToken)],
    );
    if (!rows[0]) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Billet introuvable, annulé ou déjà utilisé.' });
    }
    await client.query('INSERT INTO festin_audit_log (actor,action,ticket_id,ticket_code) VALUES ($1,$2,$3,$4)', [req.session.username, 'qr_reissued', rows[0].id, rows[0].ticket_code]);
    const qrDataUrl = await makeQr(qrToken);
    await client.query('COMMIT');
    res.json({ ticket: ticketForAdmin(rows[0]), qrDataUrl });
  } catch {
    await client.query('ROLLBACK').catch(() => {});
    res.status(503).json({ error: 'Réémission impossible.' });
  } finally { client.release(); }
});

app.delete('/api/tickets/:id', requireSession, requireRole('admin'), async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(400).json({ error: 'Billet invalide.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `UPDATE festin_tickets SET status='cancelled',cancelled_at=now()
       WHERE id=$1 AND status='valid' RETURNING id,ticket_code`, [req.params.id],
    );
    if (!rows[0]) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Billet introuvable, déjà utilisé ou déjà annulé.' });
    }
    await client.query('INSERT INTO festin_audit_log (actor,action,ticket_id,ticket_code) VALUES ($1,$2,$3,$4)', [req.session.username, 'ticket_cancelled', rows[0].id, rows[0].ticket_code]);
    await client.query('COMMIT');
    res.sendStatus(204);
  } catch {
    await client.query('ROLLBACK').catch(() => {});
    res.status(503).json({ error: 'Annulation impossible.' });
  } finally { client.release(); }
});

app.post('/api/check-in/lookup', requireSession, requireRole('admin', 'verifier'), async (req, res) => {
  const lookup = parseLookup(req.body?.value);
  if (!lookup) return res.status(400).json({ error: 'Saisissez un code billet ou scannez un QR valide.' });
  try {
    const { rows } = await findTicket(lookup);
    if (!rows[0]) return res.status(404).json({ error: 'Billet introuvable.' });
    res.json(ticketForCheckin(rows[0]));
  } catch { res.status(503).json({ error: 'Vérification indisponible.' }); }
});

app.post('/api/check-in/confirm', requireSession, requireRole('admin', 'verifier'), async (req, res) => {
  const lookup = parseLookup(req.body?.value);
  if (!lookup) return res.status(400).json({ error: 'Billet invalide.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const params = lookup.kind === 'code' ? [lookup.value] : [digest(lookup.value)];
    const where = lookup.kind === 'code' ? 'ticket_code=$1' : 'qr_token_hash=$1';
    const { rows } = await client.query(
      `UPDATE festin_tickets SET status='used',checked_in_at=now()
       WHERE ${where} AND status='valid'
       RETURNING id,ticket_code,buyer_name,pass,price_xof,status,created_at,checked_in_at`, params,
    );
    if (!rows[0]) {
      const existing = await client.query(
        `SELECT id,ticket_code,buyer_name,pass,price_xof,status,created_at,checked_in_at
         FROM festin_tickets WHERE ${where} LIMIT 1`, params,
      );
      await client.query('ROLLBACK');
      return existing.rows[0]
        ? res.status(409).json({ error: existing.rows[0].status === 'used' ? 'Billet déjà utilisé.' : 'Billet annulé.', ticket: ticketForCheckin(existing.rows[0]) })
        : res.status(404).json({ error: 'Billet introuvable.' });
    }
    await client.query('INSERT INTO festin_audit_log (actor,action,ticket_id,ticket_code) VALUES ($1,$2,$3,$4)', [req.session.username, 'check_in', rows[0].id, rows[0].ticket_code]);
    await client.query('COMMIT');
    res.json({ message: 'Entrée enregistrée.', ticket: ticketForCheckin(rows[0]) });
  } catch {
    await client.query('ROLLBACK').catch(() => {});
    res.status(503).json({ error: 'Enregistrement de l’entrée impossible.' });
  } finally { client.release(); }
});

app.use(express.static(publicDirectory, { index: 'index.html', fallthrough: true }));
app.use('/api', (_req, res) => res.status(404).json({ error: 'Route inconnue.' }));
app.use((_req, res) => res.status(404).send('Page introuvable.'));
app.use((error, _req, res, _next) => {
  console.error('Festin request failed:', error.message);
  if (res.headersSent) return;
  res.status(error.status === 413 ? 413 : 400).json({ error: 'Requête invalide.' });
});

function digest(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
async function consumeLoginAttempt(ip) {
  const bucketHash = digest(`login-ip:${ip}`);
  const { rows } = await pool.query(
    `INSERT INTO festin_login_attempts (bucket_hash,attempts,window_started_at) VALUES ($1,1,now())
     ON CONFLICT (bucket_hash) DO UPDATE SET
       attempts=CASE WHEN festin_login_attempts.window_started_at < now()-interval '15 minutes' THEN 1 ELSE festin_login_attempts.attempts+1 END,
       window_started_at=CASE WHEN festin_login_attempts.window_started_at < now()-interval '15 minutes' THEN now() ELSE festin_login_attempts.window_started_at END
     RETURNING attempts,window_started_at+interval '15 minutes' AS reset_at`, [bucketHash],
  );
  const retryAfter = Math.max(1, Math.ceil((new Date(rows[0].reset_at).getTime() - Date.now()) / 1000));
  return { allowed: rows[0].attempts <= 8, retryAfter };
}
function isUuid(value) { return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
function cleanText(value, min, max) {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return cleaned.length >= min && cleaned.length <= max ? cleaned : null;
}
function parseLookup(value) {
  if (typeof value !== 'string' || value.length > 256) return null;
  const normalized = value.trim();
  if (/^[JD]-\d{5,12}$/i.test(normalized)) return { kind: 'code', value: normalized.toUpperCase() };
  const parts = normalized.split('|');
  if (parts[0] !== 'FESTIN-DU-LAPIN' || parts.length < 2) return null;
  if (/^[JD]-\d{5,12}$/i.test(parts[1])) return { kind: 'code', value: parts[1].toUpperCase() };
  return parts.length === 2 && /^[A-Za-z0-9_-]{40,50}$/.test(parts[1]) ? { kind: 'qr', value: parts[1] } : null;
}
function validateLegacyTicket(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  if (typeof item.id !== 'string' || !/^[JD]-\d{5,12}$/i.test(item.id)) return null;
  if (!Object.hasOwn(passInfo, item.pass)) return null;
  const info = passInfo[item.pass];
  if (item.prefix !== info.prefix || item.passLabel !== info.label || item.price !== info.price) return null;
  const buyerName = cleanText(item.buyerName, 1, 120);
  const buyerPhone = cleanText(item.buyerPhone, 7, 40);
  if (!buyerName || !buyerPhone || !/^[+0-9 ()-]+$/.test(buyerPhone)) return null;
  if (typeof item.createdAt !== 'string' || !Number.isFinite(Date.parse(item.createdAt))) return null;
  if (typeof item.checkedIn !== 'boolean') return null;
  if (item.checkedIn && (typeof item.checkedInAt !== 'string' || !Number.isFinite(Date.parse(item.checkedInAt)))) return null;
  if (!item.checkedIn && item.checkedInAt !== null) return null;
  return { code: item.id.toUpperCase(), buyerName, buyerPhone, pass: item.pass, price: info.price,
    checkedIn: item.checkedIn, createdAt: new Date(item.createdAt), checkedInAt: item.checkedIn ? new Date(item.checkedInAt) : null };
}
function setSessionCookie(res, value, expiresAt) {
  const parts = [`${cookieName}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Expires=${expiresAt.toUTCString()}`];
  if (secureCookies) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}
function clearSessionCookie(res) {
  const parts = [`${cookieName}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0'];
  if (secureCookies) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}
function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  const entry = raw.split(';').map(part => part.trim()).find(part => part.startsWith(`${name}=`));
  return entry ? entry.slice(name.length + 1) : '';
}
async function requireSession(req, res, next) {
  const rawToken = readCookie(req, cookieName);
  if (!/^[A-Za-z0-9_-]{40,50}$/.test(rawToken)) return res.status(401).json({ error: 'Connexion requise.' });
  try {
    const { rows } = await pool.query(
      'SELECT username,role,expires_at FROM festin_sessions WHERE token_hash=$1 AND expires_at>now()', [digest(rawToken)],
    );
    if (!rows[0]) { clearSessionCookie(res); return res.status(401).json({ error: 'Session expirée. Reconnectez-vous.' }); }
    req.session = { ...rows[0], tokenHash: digest(rawToken), expiresAt: rows[0].expires_at };
    next();
  } catch { res.status(503).json({ error: 'Authentification indisponible.' }); }
}
function requireRole(...roles) {
  return (req, res, next) => roles.includes(req.session?.role) ? next() : res.sendStatus(403);
}
function verifyPassword(password, encoded) {
  const [scheme, n, r, p, saltEncoded, hashEncoded] = String(encoded).split('$');
  if (scheme !== 'scrypt' || typeof password !== 'string' || password.length > 1024) return Promise.resolve(false);
  const salt = Buffer.from(saltEncoded, 'base64url');
  const expected = Buffer.from(hashEncoded, 'base64url');
  return new Promise(resolve => crypto.scrypt(password, salt, expected.length, { N: Number(n), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024 }, (error, actual) => {
    resolve(!error && actual.length === expected.length && crypto.timingSafeEqual(actual, expected));
  }));
}
async function makeQr(token) {
  return QRCode.toDataURL(`FESTIN-DU-LAPIN|${token}`, { errorCorrectionLevel: 'M', margin: 2, width: 240 });
}
async function findTicket(lookup) {
  const query = lookup.kind === 'code'
    ? 'SELECT id,ticket_code,buyer_name,pass,price_xof,status,created_at,checked_in_at FROM festin_tickets WHERE ticket_code=$1'
    : 'SELECT id,ticket_code,buyer_name,pass,price_xof,status,created_at,checked_in_at FROM festin_tickets WHERE qr_token_hash=$1';
  return pool.query(query, [lookup.kind === 'code' ? lookup.value : digest(lookup.value)]);
}
function ticketForAdmin(row) {
  return { id: row.id, code: row.ticket_code, buyerName: row.buyer_name, buyerPhone: row.buyer_phone,
    pass: row.pass, passLabel: passInfo[row.pass].label, price: Number(row.price_xof), status: row.status,
    createdAt: row.created_at, checkedInAt: row.checked_in_at };
}
function ticketForCheckin(row) {
  return { code: row.ticket_code, buyerName: row.buyer_name, passLabel: passInfo[row.pass].label,
    status: row.status, createdAt: row.created_at, checkedInAt: row.checked_in_at };
}

export default app;
export async function closePool() { await pool.end(); }
