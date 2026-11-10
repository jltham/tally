// Turning submitted form fields into clean values, with messages people can act on.
import { toCents, splitEqual, formatCents } from './ledger.js';
import { isIsoDate } from './dates.js';

/** Trimmed text, cut to `maxLength`. Missing fields become ''. */
export const cleanText = (value, maxLength) => String(value ?? '').trim().slice(0, maxLength);

/** A repeated form field (checkboxes) as an array of integer ids. */
export function toIds(value) {
  const values = value === undefined ? [] : Array.isArray(value) ? value : [value];
  return values.map(Number).filter(Number.isSafeInteger);
}

export const isEmail = (text) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text);

/**
 * Only same-site paths are allowed as a post-login destination. The path is resolved the way a
 * browser would (which reads "/\evil.com" as "//evil.com", drops tabs, and collapses "." and ".."),
 * and kept only if it stays on this site. A resolved path starting with "//" is refused too:
 * "/..//evil.com" resolves to "//evil.com", which a browser treats as another site.
 * Anything that isn't a valid URL (e.g. "//[") also falls back to the dashboard.
 */
export function safeNextPath(path) {
  if (typeof path !== 'string' || !path.startsWith('/')) return '/';
  const PLACEHOLDER_ORIGIN = 'http://tally.invalid'; // only used to resolve and compare
  let url;
  try {
    url = new URL(path, PLACEHOLDER_ORIGIN);
  } catch {
    return '/';
  }
  if (url.origin !== PLACEHOLDER_ORIGIN || url.pathname.startsWith('//')) return '/';
  return `${url.pathname}${url.search}${url.hash}`;
}

/**
 * Validate the expense form. `people` are those who may appear on it.
 * Returns { value } or { error, draft }; the draft re-fills the form as the user left it.
 */
export function parseExpense(body, people) {
  const allowed = new Set(people.map((p) => p.id));
  const draft = {
    description: cleanText(body.description, 100),
    amount: cleanText(body.amount, 20),
    paidBy: Number(body.paid_by),
    spentOn: cleanText(body.spent_on, 10),
    splitType: body.split_type === 'exact' ? 'exact' : 'equal',
  };
  const amountCents = toCents(draft.amount);
  const participants = toIds(body.participants).filter((id) => allowed.has(id));
  const exactShares = people
    .map((p) => ({ userId: p.id, text: cleanText(body[`share_${p.id}`], 20) }))
    .filter((s) => s.text !== '')
    .map((s) => ({ userId: s.userId, cents: toCents(s.text) }));
  draft.shares = draft.splitType === 'equal'
    ? participants.map((userId) => ({ userId, cents: 0 }))
    : exactShares.filter((s) => s.cents !== null);
  const fail = (error) => ({ error, draft });

  if (!draft.description) return fail('Add a short description.');
  if (!amountCents) return fail('Enter an amount greater than zero, like 12.50.');
  if (!allowed.has(draft.paidBy)) return fail('Choose who paid.');
  if (!isIsoDate(draft.spentOn)) return fail('Choose a valid date.');

  if (draft.splitType === 'equal') {
    if (!participants.length) return fail('Pick at least one person to split with.');
    return { value: { ...draft, amountCents, shares: splitEqual(amountCents, participants, draft.paidBy) } };
  }
  if (exactShares.some((s) => s.cents === null)) return fail('One of the amounts isn’t a valid number.');
  const shares = exactShares.filter((s) => s.cents > 0);
  if (!shares.length) return fail('Enter how much each person owes.');
  const sum = shares.reduce((total, s) => total + s.cents, 0);
  if (sum !== amountCents) return fail(`The amounts add up to ${formatCents(sum)}, but the total is ${formatCents(amountCents)}.`);
  return { value: { ...draft, amountCents, shares } };
}

/** Validate the payment form. Returns { value } or { error, draft }. */
export function parseSettlement(body, people) {
  const allowed = new Set(people.map((p) => p.id));
  const draft = {
    fromUser: Number(body.from_user),
    toUser: Number(body.to_user),
    amount: cleanText(body.amount, 20),
    paidOn: cleanText(body.paid_on, 10),
    note: cleanText(body.note, 100),
  };
  const amountCents = toCents(draft.amount);
  const fail = (error) => ({ error, draft });
  if (!allowed.has(draft.fromUser) || !allowed.has(draft.toUser)) return fail('Choose who paid and who received it.');
  if (draft.fromUser === draft.toUser) return fail('Someone can’t pay themselves.');
  if (!amountCents) return fail('Enter an amount greater than zero.');
  if (!isIsoDate(draft.paidOn)) return fail('Choose a valid date.');
  return { value: { ...draft, amountCents } };
}
