// Product rules shared by the server and the pages.
export const MAX_USERS = 10;
export const MIN_PASSWORD_LENGTH = 8;

/** Failed logins allowed per email and per network address within `windowMs`, before a pause. */
export const LOGIN_LIMITS = { perEmail: 5, perAddress: 20, windowMs: 15 * 60 * 1000 };

/**
 * Longest accepted text per field. The server trims input to these and the pages use them as
 * maxlength, so the two can't drift apart.
 */
export const MAX_LENGTH = { userName: 40, groupName: 60, email: 200, description: 100, note: 100, amount: 20, date: 10 };
