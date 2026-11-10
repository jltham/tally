import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';

const SESSION_DAYS = 30;
export const COOKIE = 'tally_sid';

export function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return timingSafeEqual(actual, expected);
}

/** Decode a cookie value, keeping it as-is if it isn't valid percent-encoding. */
function decodeCookieValue(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Cookies by name. Cookies on localhost are shared by every port, so other local apps' cookies
 * arrive here too; a malformed one must not break the request.
 */
export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeCookieValue(part.slice(i + 1).trim());
  }
  return out;
}

// Session functions take `sessions`, the session store from lib/store.js (store.sessions).

export function startSession(sessions, res, userId) {
  const token = randomBytes(32).toString('base64url');
  const maxAge = SESSION_DAYS * 24 * 3600;
  sessions.create(token, userId, Date.now() + maxAge * 1000);
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`);
}

export function endSession(sessions, req, res) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) sessions.delete(token);
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}

/** Sign the user out everywhere except the session `keepToken` (used after a password change). */
export function endOtherSessions(sessions, userId, keepToken) {
  sessions.deleteOthers(userId, keepToken);
}

/** Delete sessions that have expired; they're already ignored, this just stops them piling up. */
export function purgeExpiredSessions(sessions) {
  sessions.deleteExpired(Date.now());
}

/** Middleware: sets req.user (and req.sessionToken) from the session cookie, or leaves them undefined. */
export function loadUser(sessions) {
  return (req, _res, next) => {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (token) req.user = sessions.userFor(token, Date.now());
    if (req.user) req.sessionToken = token;
    next();
  };
}

export function requireLogin(req, res, next) {
  if (req.user) return next();
  res.redirect(`/login?next=${encodeURIComponent(pageToReturnTo(req))}`);
}

/**
 * Where to send someone after they log in. For a page, the page itself. A form submission's URL
 * only accepts POST (opening it would be "Not found"), so go back to the page the form was on.
 */
function pageToReturnTo(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return req.originalUrl;
  try {
    const from = new URL(req.get('referer'));
    if (from.host === req.get('host')) return `${from.pathname}${from.search}`;
  } catch {
    // No referrer, or not a URL.
  }
  return '/';
}
