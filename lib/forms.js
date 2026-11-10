// Turning submitted form fields into clean values, with messages people can act on.
import { toCents, splitEqual, formatCents } from './ledger.js';
import { isIsoDate } from './dates.js';
import { MAX_LENGTH } from './limits.js';

/**
 * Trimmed text, cut to `maxLength`. Missing fields become ''. So does a field sent more than once
 * (an array), rather than its values joined with commas.
 */
export const cleanText = (value, maxLength) =>
  (Array.isArray(value) ? '' : String(value ?? '')).trim().slice(0, maxLength);

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
 * Returns { value } or { error, draft }. The draft re-fills the form exactly as the user left it:
 * the ticked boxes as submitted (`shares`), every exact amount as typed (`shareTexts`), and which
 * amount was invalid (`invalidShareUserId`).
 */
export function parseExpense(body, people) {
  const allowed = new Set(people.map((p) => p.id));
  const draft = {
    description: cleanText(body.description, MAX_LENGTH.description),
    amount: cleanText(body.amount, MAX_LENGTH.amount),
    paidBy: Number(body.paid_by),
    spentOn: cleanText(body.spent_on, MAX_LENGTH.date),
    splitType: body.split_type === 'exact' ? 'exact' : 'equal',
    shareTexts: {},
  };
  const amountCents = toCents(draft.amount);
  const participants = toIds(body.participants).filter((id) => allowed.has(id));
  const exactShares = people
    .map((p) => ({ userId: p.id, name: p.name, text: cleanText(body[`share_${p.id}`], MAX_LENGTH.amount) }))
    .filter((s) => s.text !== '')
    .map((s) => ({ ...s, cents: toCents(s.text) }));
  for (const s of exactShares) draft.shareTexts[s.userId] = s.text;
  draft.shares = draft.splitType === 'equal'
    ? participants.map((userId) => ({ userId, cents: 0 }))
    : exactShares.filter((s) => s.cents !== null).map(({ userId, cents }) => ({ userId, cents }));
  const fail = (error) => ({ error, draft });

  if (!draft.description) return fail('Add a short description.');
  if (!amountCents) return fail('Enter an amount greater than zero, like 12.50.');
  if (!allowed.has(draft.paidBy)) return fail('Choose who paid.');
  if (!isIsoDate(draft.spentOn)) return fail('Choose a valid date.');

  if (draft.splitType === 'equal') {
    // Without JavaScript both sections are on screen; don't throw away amounts someone typed.
    if (exactShares.length) {
      return fail('You chose “Equally” but also typed exact amounts. Choose “By exact amounts”, or clear those amounts.');
    }
    if (!participants.length) return fail('Pick at least one person to split with.');
    return { value: { ...draft, amountCents, shares: splitEqual(amountCents, participants, draft.paidBy) } };
  }
  const invalid = exactShares.find((s) => s.cents === null);
  if (invalid) {
    draft.invalidShareUserId = invalid.userId;
    return fail(`${invalid.name}’s amount isn’t a valid number.`);
  }
  const shares = exactShares.filter((s) => s.cents > 0).map(({ userId, cents }) => ({ userId, cents }));
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
    amount: cleanText(body.amount, MAX_LENGTH.amount),
    paidOn: cleanText(body.paid_on, MAX_LENGTH.date),
    note: cleanText(body.note, MAX_LENGTH.note),
  };
  const amountCents = toCents(draft.amount);
  const fail = (error) => ({ error, draft });
  if (!allowed.has(draft.fromUser) || !allowed.has(draft.toUser)) return fail('Choose who paid and who received it.');
  if (draft.fromUser === draft.toUser) return fail('Someone can’t pay themselves.');
  if (!amountCents) return fail('Enter an amount greater than zero.');
  if (!isIsoDate(draft.paidOn)) return fail('Choose a valid date.');
  return { value: { ...draft, amountCents } };
}
