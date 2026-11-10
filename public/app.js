// Progressive enhancement only: every page works without this file.
// Uses the same money maths as the server, so the live preview can't drift from what gets saved.
import { toCents, formatCents, splitEqual } from '/ledger.js';

// Confirm before destructive actions.
document.addEventListener('submit', (event) => {
  const message = event.target.dataset?.confirm;
  if (message && !window.confirm(message)) event.preventDefault();
});

// Expense form: show the right split section and live totals.
const form = document.getElementById('expense-form');
if (form) {
  const amount = form.querySelector('#amount');
  const sections = form.querySelectorAll('[data-split]');
  const remaining = form.querySelector('[data-remaining]');

  const update = () => {
    const splitType = form.querySelector('input[name="split_type"]:checked')?.value ?? 'equal';
    sections.forEach((section) => (section.hidden = section.dataset.split !== splitType));
    const total = toCents(amount.value) ?? 0;

    // Equal: show each person's share.
    const boxes = [...form.querySelectorAll('input[name="participants"]')];
    const chosen = boxes.filter((b) => b.checked).map((b) => Number(b.value));
    const payer = Number(form.querySelector('select[name="paid_by"]').value);
    const shares = total && chosen.length ? new Map(splitEqual(total, chosen, payer).map((s) => [s.userId, s.cents])) : new Map();
    boxes.forEach((box) => {
      const cents = shares.get(Number(box.value));
      box.closest('label').querySelector('[data-each]').textContent = cents === undefined ? '' : formatCents(cents);
    });

    // Exact: show how much is left to assign.
    const assigned = [...form.querySelectorAll('input.share')].reduce((sum, input) => sum + (toCents(input.value) ?? 0), 0);
    const left = total - assigned;
    remaining.textContent = left === 0 ? `✓ Adds up to ${formatCents(total)}`
      : left > 0 ? `${formatCents(left)} left to assign` : `${formatCents(-left)} too much`;
    remaining.className = `small ${left === 0 ? 'pos' : 'neg'}`;
  };
  form.addEventListener('input', update);
  form.addEventListener('change', update);
  update();
}
