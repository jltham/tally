// Shared helpers for route tests: a fresh app per file and a tiny cookie-keeping client.
import { openDb } from '../lib/db.js';
import { createApp } from '../server.js';

/** Start the app on a free port with a fresh in-memory database. */
export async function startApp() {
  const db = openDb(':memory:');
  const server = createApp(db).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://localhost:${server.address().port}`;
  return {
    db,
    base,
    close: () => server.close(),
    client: (options) => client(base, options),
    userId: (email) => db.prepare('SELECT id FROM users WHERE email = ?').get(email)?.id,
  };
}

/**
 * A minimal browser: keeps the session cookie, posts forms, never follows redirects.
 * `extraCookies` is sent with every request (e.g. cookies set by another app on localhost).
 */
export function client(base, { extraCookies = '', headers = {} } = {}) {
  let session = '';
  const request = async (method, path, form) => {
    const cookie = [session, extraCookies].filter(Boolean).join('; ');
    const res = await fetch(base + path, {
      method,
      redirect: 'manual',
      headers: { ...headers, cookie, ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
      body: form ? new URLSearchParams(form).toString() : undefined,
    });
    for (const c of res.headers.getSetCookie()) {
      if (c.startsWith('tally_sid=')) session = c.split(';')[0];
    }
    return { status: res.status, location: res.headers.get('location'), text: await res.text() };
  };
  return {
    get: (path) => request('GET', path),
    post: (path, form = {}) => request('POST', path, form),
    signup: (name, email, password = 'password123') => request('POST', '/signup', { name, email, password }),
    login: (email, password = 'password123', next) =>
      request('POST', '/login', next === undefined ? { email, password } : { email, password, next }),
  };
}

/** The numeric id at the end of a redirect such as "/groups/3". */
export const idFromLocation = (location) => Number(location.split('/').pop());
