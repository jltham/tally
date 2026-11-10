# Tally — shared expenses for a small circle

**Demo:** [docs/tally-demo.webm](docs/tally-demo.webm), a 68-second captioned tour: logging in, adding and editing an expense, settling up, and what a non-member sees.

Tally is a Splitwise-style app for **one small circle of people (at most 10 accounts)**: flatmates, a travel group, a regular dinner crew. It runs on your own machine with a local SQLite database.

## Product thinking

**Who it's for.** A single group of up to 10 people who already trust each other and share costs often: rent and utilities, groceries, a holiday. One person usually ends up as the "bookkeeper" and runs this on their laptop.

**The problem.** When several people take turns paying, nobody knows who owes whom. Tracking it in a chat thread or a spreadsheet goes wrong quietly: rounding errors, forgotten repayments, and awkward "didn't I already pay you?" conversations. The cost is money leaking between friends and friction in the relationship. The cause is not the maths itself but the lack of one shared, always-current record.

**Why a 10-user cap.** It keeps the scope honest. With so few people there is no need for invitations, friend requests, search or currency conversion. Anyone who signs up can be added to any group. When the 10 accounts are used up, sign-up closes.

**What success looks like.**
- Every shared cost is recorded within a day of being paid (leading indicator: expenses added per week).
- At settle-up time, the group needs the fewest possible payments to get everyone to zero (Tally suggests them).
- Nobody has to do arithmetic by hand, including uneven splits and the leftover cent.

**Deliberately out of scope (for now).** Multiple currencies, receipt photos, recurring expenses, notifications, going online.

## What you can do (CRUD)

| Thing | Create | Read | Update | Delete |
|---|---|---|---|---|
| Account | Sign up (until 10 exist) | Dashboard | Change name, password | Delete account (once you've left every group) |
| Group | New group, pick members | Group page with timeline and balances | Rename, add/remove members | Delete group (once everyone is settled up) |
| Expense | Split equally or by exact amounts | Timeline, "you lent / you borrowed" | Edit everything | Delete |
| Payment (settle up) | Record "A paid B" (one click from a suggestion) | Timeline | Edit | Delete |

Rules that keep the money straight:

- Members can only be removed from a group once their balance there is zero, and Tally refuses any later edit or delete that would give a removed member a balance again (add them back first).
- When a bill doesn't split evenly, the person who paid covers the first leftover cent if they're part of the split. Any further leftover cents (there can be up to one fewer than the number of people) go to the others in a fixed order, oldest account first.
- When the last member leaves a group, the group is deleted, so it never lingers with nobody able to see it.
- Suggested payments can have you pay someone you never shared a bill with: that's how the number of payments is kept as low as possible, and everyone still ends up even.
- "Suggested payments" is the true minimum number of payments, not an approximation.

## Run it

Needs Node 22.5 or newer (uses the built-in `node:sqlite`; no database server to install).

```bash
npm install
npm run seed     # optional: 4 demo users and a sample group
npm start        # http://localhost:3000
```

Demo logins after seeding: `alice@example.com`, `ben@example.com`, `chloe@example.com`, `dev@example.com`, all with the password `password123`.

```bash
npm test
```

The database lives in `data/tally.db`. Delete that file to start over.

## How it's built

- **Server:** Node + Express 5, HTML rendered on the server (no build step).
- **Database:** SQLite through Node's built-in `node:sqlite`. Money is stored as whole cents to avoid rounding errors.
- **Login:** passwords hashed with scrypt; a random session token in an HttpOnly, SameSite=Lax cookie, stored in the database.
- **The maths** lives in `lib/ledger.js` (splitting, balances, fewest-payments settle-up) and is covered by unit tests. The browser imports the same file for the live preview on the expense form.

Where things are:

| File | Job |
|---|---|
| `server.js` | Routes: who may do what, and which page to show |
| `lib/forms.js` | Cleaning and validating what people type into forms |
| `lib/ledger.js` | Money maths (no database, no web) |
| `lib/store.js` | All the SQL |
| `lib/views.js` | The HTML pages |
| `lib/auth.js`, `lib/flash.js` | Login sessions, one-time messages |
| `lib/limits.js`, `lib/dates.js` | The 10-user and password rules; date helpers |
