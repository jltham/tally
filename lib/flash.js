// One-time messages ("Expense updated.") that survive exactly one redirect, via a short-lived cookie.
import { parseCookies } from './auth.js';

const COOKIE = 'tally_flash';

/** Middleware: puts any pending message on req.flash and adds res.flashRedirect(url, message). */
export function flash(req, res, next) {
  const pending = parseCookies(req.headers.cookie)[COOKIE];
  if (pending) {
    req.flash = pending;
    res.append('Set-Cookie', `${COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`);
  }
  res.flashRedirect = (url, message) => {
    res.append('Set-Cookie', `${COOKIE}=${encodeURIComponent(message)}; Path=/; Max-Age=60; SameSite=Lax; HttpOnly`);
    res.redirect(url);
  };
  next();
}
