// Progressive enhancement only: every page works without this file.

// Confirm before destructive actions.
document.addEventListener('submit', (ev) => {
  const msg = ev.target.dataset?.confirm;
  if (msg && !window.confirm(msg)) ev.preventDefault();
});

// Expense form: show the right split section and live totals.
const form = document.getElementById('expense-form');
if (form) {
  const toCents = (v) => {
    const s = String(v).trim().replace(/,/g, '');
    return /^\d+(\.\d{1,2})?$/.test(s) ? Math.round(Number(s) * 100) : null;
  };
  const fmt = (c) => `S$${(c / 100).toFixed(2)}`;
  const amount = form.querySelector('#amount');
  const sections = form.querySelectorAll('[data-split]');
  const remaining = form.querySelector('[data-remaining]');

  const update = () => {
    const type = form.querySelector('input[name="split_type"]:checked')?.value ?? 'equal';
    sections.forEach((s) => (s.hidden = s.dataset.split !== type));
    const total = toCents(amount.value) ?? 0;

    // Equal: show each person's share (leftover cents go to the first people, as on the server).
    const boxes = [...form.querySelectorAll('input[name="participants"]')];
    const chosen = boxes.filter((b) => b.checked).sort((a, b) => Number(a.value) - Number(b.value));
    const base = chosen.length ? Math.floor(total / chosen.length) : 0;
    let extra = chosen.length ? total - base * chosen.length : 0;
    const each = new Map(chosen.map((b) => [b, base + (extra-- > 0 ? 1 : 0)]));
    boxes.forEach((b) => {
      b.closest('label').querySelector('[data-each]').textContent = each.has(b) && total ? fmt(each.get(b)) : '';
    });

    // Exact: show how much is left to assign.
    const sum = [...form.querySelectorAll('input.share')].reduce((a, i) => a + (toCents(i.value) ?? 0), 0);
    const left = total - sum;
    remaining.textContent = left === 0 ? `✓ Adds up to ${fmt(total)}` : left > 0 ? `${fmt(left)} left to assign` : `${fmt(-left)} too much`;
    remaining.className = `small ${left === 0 ? 'pos' : 'neg'}`;
  };
  form.addEventListener('input', update);
  form.addEventListener('change', update);
  update();
}
