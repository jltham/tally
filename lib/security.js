// Browser-level protections. The session cookie is SameSite=Lax, but "same site" ignores the
// port, so pages on any other localhost port count as same-site and get the cookie too.

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  // Avatars set their colour with an inline style attribute; no inline <style> or scripts.
  "style-src 'self'",
  "style-src-attr 'unsafe-inline'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

/** Middleware: headers that stop Tally being framed (clickjacking) or loading anything foreign. */
export function securityHeaders(_req, res, next) {
  res.set({
    'Content-Security-Policy': CONTENT_SECURITY_POLICY,
    'X-Frame-Options': 'DENY', // for browsers without frame-ancestors
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
  });
  next();
}

const READ_ONLY_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Middleware: refuse form submissions that come from another site, including another
 * localhost port. Browsers send Origin on cross-site POSTs (and Sec-Fetch-Site in current
 * versions); requests with neither, such as curl, aren't from a web page and are allowed.
 */
export function refuseCrossSiteWrites(req, res, next) {
  if (READ_ONLY_METHODS.has(req.method)) return next();
  const origin = req.get('origin');
  const fetchSite = req.get('sec-fetch-site');
  const ownOrigin = `${req.protocol}://${req.get('host')}`;
  const allowed = origin !== undefined
    ? origin === ownOrigin
    : fetchSite === undefined || fetchSite === 'same-origin' || fetchSite === 'none';
  if (allowed) return next();
  res.status(403).type('text').send('Tally refused this request because it came from another site.');
}
