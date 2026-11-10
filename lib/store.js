// All SQL lives here. Routes call these functions; they never write SQL themselves.
import { tx } from './db.js';
import { computeBalances } from './ledger.js';

export function createStore(db) {
  const sql = (text) => db.prepare(text);

  // ---------- users ----------
  const users = {
    count: () => sql('SELECT COUNT(*) AS n FROM users').get().n,
    all: () => sql('SELECT id, name, email FROM users ORDER BY name COLLATE NOCASE').all(),
    get: (id) => sql('SELECT id, name, email FROM users WHERE id = ?').get(id),
    byEmail: (email) => sql('SELECT * FROM users WHERE email = ?').get(email),
    passwordHash: (id) => sql('SELECT password_hash FROM users WHERE id = ?').get(id)?.password_hash,
    create: (name, email, hash) =>
      Number(sql('INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)').run(name, email, hash).lastInsertRowid),
    rename: (id, name) => sql('UPDATE users SET name = ? WHERE id = ?').run(name, id),
    setPassword: (id, hash) => sql('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, id),
    groupCount: (id) => sql('SELECT COUNT(*) AS n FROM group_members WHERE user_id = ?').get(id).n,
    // Users referenced by expenses/settlements can't be deleted (FKs); callers check groupCount first.
    isReferenced: (id) =>
      sql(`SELECT EXISTS(SELECT 1 FROM expenses WHERE paid_by = ?1)
           OR EXISTS(SELECT 1 FROM expense_shares WHERE user_id = ?1)
           OR EXISTS(SELECT 1 FROM settlements WHERE from_user = ?1 OR to_user = ?1) AS r`).get(id).r === 1,
    delete: (id) => sql('DELETE FROM users WHERE id = ?').run(id),
  };

  // ---------- groups ----------
  const groups = {
    forUser: (userId) =>
      sql(`SELECT g.id, g.name FROM groups g JOIN group_members m ON m.group_id = g.id
         WHERE m.user_id = ? ORDER BY g.name COLLATE NOCASE`).all(userId),
    /** The group, only if userId is a member. */
    getForMember: (groupId, userId) =>
      sql(`SELECT g.id, g.name, g.created_by FROM groups g JOIN group_members m ON m.group_id = g.id
         WHERE g.id = ? AND m.user_id = ?`).get(groupId, userId),
    members: (groupId) =>
      sql(`SELECT u.id, u.name, u.email FROM users u JOIN group_members m ON m.user_id = u.id
         WHERE m.group_id = ? ORDER BY u.name COLLATE NOCASE`).all(groupId),
    create: (name, creatorId, memberIds) =>
      tx(db, () => {
        const id = Number(sql('INSERT INTO groups (name, created_by) VALUES (?, ?)').run(name, creatorId).lastInsertRowid);
        const add = sql('INSERT OR IGNORE INTO group_members (group_id, user_id) VALUES (?, ?)');
        for (const uid of new Set([creatorId, ...memberIds])) add.run(id, uid);
        return id;
      }),
    rename: (id, name) => sql('UPDATE groups SET name = ? WHERE id = ?').run(name, id),
    addMembers: (id, userIds) => {
      const add = sql('INSERT OR IGNORE INTO group_members (group_id, user_id) VALUES (?, ?)');
      tx(db, () => userIds.forEach((uid) => add.run(id, uid)));
    },
    removeMember: (id, userId) => sql('DELETE FROM group_members WHERE group_id = ? AND user_id = ?').run(id, userId),
    delete: (id) => sql('DELETE FROM groups WHERE id = ?').run(id),
  };

  // ---------- expenses & settlements ----------
  const toExpense = (row) =>
    row && {
      id: row.id,
      groupId: row.group_id,
      description: row.description,
      amountCents: row.amount_cents,
      paidBy: row.paid_by,
      spentOn: row.spent_on,
      splitType: row.split_type,
      shares: sql('SELECT user_id AS userId, share_cents AS cents FROM expense_shares WHERE expense_id = ? ORDER BY user_id')
        .all(row.id)
        .map((s) => ({ ...s })),
    };

  const toSettlement = (row) =>
    row && {
      id: row.id,
      groupId: row.group_id,
      fromUser: row.from_user,
      toUser: row.to_user,
      amountCents: row.amount_cents,
      paidOn: row.paid_on,
      note: row.note,
    };

  const expenses = {
    get: (id) => toExpense(sql('SELECT * FROM expenses WHERE id = ?').get(id)),
    forGroup: (groupId) =>
      sql('SELECT * FROM expenses WHERE group_id = ? ORDER BY spent_on DESC, id DESC').all(groupId).map(toExpense),
    /** Insert (no id) or replace an expense and its shares. Returns the id. */
    save: (e, actorId) =>
      tx(db, () => {
        let id = e.id;
        if (id) {
          sql(`UPDATE expenses SET description = ?, amount_cents = ?, paid_by = ?, spent_on = ?, split_type = ?,
             updated_at = datetime('now') WHERE id = ?`).run(e.description, e.amountCents, e.paidBy, e.spentOn, e.splitType, id);
          sql('DELETE FROM expense_shares WHERE expense_id = ?').run(id);
        } else {
          id = Number(
            sql(`INSERT INTO expenses (group_id, description, amount_cents, paid_by, spent_on, split_type, created_by)
               VALUES (?, ?, ?, ?, ?, ?, ?)`).run(e.groupId, e.description, e.amountCents, e.paidBy, e.spentOn, e.splitType, actorId)
              .lastInsertRowid,
          );
        }
        const add = sql('INSERT INTO expense_shares (expense_id, user_id, share_cents) VALUES (?, ?, ?)');
        for (const s of e.shares) add.run(id, s.userId, s.cents);
        return id;
      }),
    delete: (id) => sql('DELETE FROM expenses WHERE id = ?').run(id),
  };

  const settlements = {
    get: (id) => toSettlement(sql('SELECT * FROM settlements WHERE id = ?').get(id)),
    forGroup: (groupId) =>
      sql('SELECT * FROM settlements WHERE group_id = ? ORDER BY paid_on DESC, id DESC').all(groupId).map(toSettlement),
    save: (s, actorId) => {
      if (s.id) {
        sql('UPDATE settlements SET from_user = ?, to_user = ?, amount_cents = ?, paid_on = ?, note = ? WHERE id = ?').run(
          s.fromUser, s.toUser, s.amountCents, s.paidOn, s.note, s.id,
        );
        return s.id;
      }
      return Number(
        sql(`INSERT INTO settlements (group_id, from_user, to_user, amount_cents, paid_on, note, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?)`).run(s.groupId, s.fromUser, s.toUser, s.amountCents, s.paidOn, s.note, actorId)
          .lastInsertRowid,
      );
    },
    delete: (id) => sql('DELETE FROM settlements WHERE id = ?').run(id),
  };

  /** Net balances in a group, as a Map userId -> cents (positive = owed money). */
  const groupBalances = (groupId) => computeBalances(expenses.forGroup(groupId), settlements.forGroup(groupId));

  return { users, groups, expenses, settlements, groupBalances };
}
