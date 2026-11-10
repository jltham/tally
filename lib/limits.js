// Product rules shared by the server and the pages.
export const MAX_USERS = 10;
export const MIN_PASSWORD_LENGTH = 8;

/** Failed logins allowed per email and per network address within `windowMs`, before a pause. */
export const LOGIN_LIMITS = { perEmail: 5, perAddress: 20, windowMs: 15 * 60 * 1000 };
