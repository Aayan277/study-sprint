import test from 'node:test';
import assert from 'node:assert/strict';
import { CARDS, IDS, defaultLayout, normaliseLayout, isDefaultLayout, toSaved, moveCard, setHidden, setSize, resetLayout, visibleOrder, pairRows, widths, acceptStatsLayout, canResize, reorderVisible, addWidget, hiddenCards, editPlan, cardInfo } from '../js/stats-layout.js';
import { acceptSetting, SYNCED_SETTINGS } from '../js/sync-data.js';

test('the default layout lists every card, shows all, with the statslayout sizes', () => {
  const d = defaultLayout();
  assert.deepEqual(d.order, IDS);
  assert.equal(IDS.length, 11);
  assert.deepEqual(d.hidden, []);
  assert.equal(d.size.rs, 'full'); assert.equal(d.size.cal, 'full'); assert.equal(d.size.mastery, 'full');
  assert.equal(d.size.perDay, 'half');
  assert.ok(isDefaultLayout(null) && isDefaultLayout(d));
  assert.equal(toSaved(d), null);
});

test('junk falls back to the default', () => {
  for (const bad of [undefined, null, 5, 'x', [], [1, 2], { order: 'no' }]) assert.deepEqual(normaliseLayout(bad), defaultLayout());
});

test('unknown ids are ignored and repeats dropped', () => {
  const l = normaliseLayout({ order: ['cal', 'nope', 'cal', 7, 'streak'], hidden: ['ghost', 'rs'], size: { mastery: 'half', streak: 'wide', zzz: 'half' } });
  assert.equal(l.order.indexOf('cal') < l.order.indexOf('streak'), true);
  assert.equal(l.order.length, IDS.length);
  assert.equal(new Set(l.order).size, IDS.length);
  assert.ok(!l.order.includes('nope'));
  assert.deepEqual(l.hidden, ['rs']);
  assert.equal(l.size.mastery, 'half');
  assert.equal(l.size.streak, 'half');      // 'wide' is not a size: the default stays
  assert.ok(!('zzz' in l.size));
});

test('a card the saved layout does not know appears after the card before it in the default order', () => {
  const saved = IDS.filter(id => id !== 'hours').reverse();       // an older version without "Time of day"
  const l = normaliseLayout({ order: saved });
  assert.equal(l.order.length, IDS.length);
  assert.equal(l.order.indexOf('hours'), l.order.indexOf('buttons') + 1);
  // junk in a restored backup is left out, a good value is cleaned
  assert.equal(acceptStatsLayout('x').ok, false);
  // a new first card goes to the front
  assert.equal(normaliseLayout({ order: IDS.slice(1) }).order[0], 'streak');
});

test('move swaps with the neighbour and stops at the ends', () => {
  const d = defaultLayout();
  assert.deepEqual(moveCard(d, 'retention', -1).order.slice(0, 2), ['retention', 'streak']);
  assert.deepEqual(moveCard(d, 'streak', 1).order.slice(0, 2), ['retention', 'streak']);
  assert.deepEqual(moveCard(d, 'streak', -1).order, IDS);
  assert.deepEqual(moveCard(d, IDS.at(-1), 1).order, IDS);
  assert.deepEqual(moveCard(d, 'nope', 1).order, IDS);
  assert.deepEqual(d.order, IDS);                                  // the input is not changed
});

test('hide and show', () => {
  let l = setHidden(defaultLayout(), 'hours', true);
  l = setHidden(l, 'streak', true);
  assert.deepEqual(l.hidden, ['streak', 'hours']);                 // in page order
  assert.ok(!visibleOrder(l).includes('hours'));
  assert.equal(visibleOrder(l, ['mastery']).includes('mastery'), false);
  l = setHidden(l, 'hours', false);
  assert.deepEqual(l.hidden, ['streak']);
  assert.deepEqual(setHidden(l, 'nope', true).hidden, ['streak']);
  assert.ok(!isDefaultLayout(l));
});

test('size', () => {
  let l = setSize(defaultLayout(), 'mastery', 'half');
  assert.equal(l.size.mastery, 'half');
  assert.equal(setSize(l, 'mastery', 'huge').size.mastery, 'half');
  assert.equal(setSize(l, 'mastery', 'full').size.mastery, 'full');
  assert.ok(isDefaultLayout(setSize(l, 'mastery', 'full')));
});

test('reset gives the default and saves as null', () => {
  const l = moveCard(setSize(setHidden(defaultLayout(), 'rs', true), 'mastery', 'half'), 'cal', -1);
  assert.ok(!isDefaultLayout(l));
  assert.deepEqual(resetLayout(), defaultLayout());
  assert.ok(toSaved(l) && toSaved(l).hidden[0] === 'rs');
  assert.equal(toSaved(resetLayout()), null);
});

test('pairing: neighbouring half cards share a row, a lone half card takes the row', () => {
  const rows = pairRows(defaultLayout());
  assert.deepEqual(rows, [['streak', 'retention'], ['rs'], ['cal'], ['perDay', 'forecast'], ['hardest', 'buttons'], ['hours', 'difficulty'], ['mastery']]);
  // hide Time of day: Difficulty has no partner left and fills its row
  const l = setHidden(defaultLayout(), 'hours', true);
  const r2 = pairRows(l);
  assert.deepEqual(r2.slice(4), [['hardest', 'buttons'], ['difficulty'], ['mastery']]);
  const w = widths(l, visibleOrder(l));
  assert.equal(w.get('difficulty'), 'full'); assert.equal(w.get('buttons'), 'half');
  // a full card between two halves splits them
  const l2 = setSize(defaultLayout(), 'forecast', 'full');
  assert.deepEqual(pairRows(l2).slice(3, 6), [['perDay'], ['forecast'], ['hardest', 'buttons']]);
  // every row is one or two cards, and every card is in exactly one row
  for (const lay of [defaultLayout(), l, l2]) {
    const flat = pairRows(lay).flat();
    assert.deepEqual(flat, visibleOrder(lay));
    assert.ok(pairRows(lay).every(r => r.length >= 1 && r.length <= 2));
  }
  assert.deepEqual(pairRows(defaultLayout(), []), []);
});

test('the synced setting: listed, and a value from outside is cleaned', () => {
  assert.ok(SYNCED_SETTINGS.includes('statsLayout'));
  assert.deepEqual(acceptSetting('statsLayout', null), { ok: true, value: null });
  assert.deepEqual(acceptSetting('statsLayout', 'junk'), { ok: false });
  assert.deepEqual(acceptSetting('statsLayout', [1]), { ok: false });
  assert.deepEqual(acceptSetting('statsLayout', defaultLayout()), { ok: true, value: null });
  const a = acceptStatsLayout({ order: ['cal', 'zzz', ...IDS.filter(i => i !== 'cal')], hidden: ['rs', 'zzz'], size: { mastery: 'half' } });
  assert.equal(a.ok, true);
  assert.equal(a.value.order[0], 'cal'); assert.deepEqual(a.value.hidden, ['rs']); assert.equal(a.value.size.mastery, 'half');
  assert.equal(CARDS.length, new Set(IDS).size);
});

test('a backup restores a cleaned layout and leaves junk out', async () => {
  const { restoredSettings } = await import('../js/db.js');
  const get = s => Object.fromEntries(restoredSettings(s));
  assert.ok(!('statsLayout' in get({ statsLayout: 'junk' })));
  assert.equal(get({ statsLayout: null }).statsLayout, null);
  const kept = get({ statsLayout: { order: ['cal', 'zzz'], hidden: ['rs'], size: { mastery: 'half' } } }).statsLayout;
  assert.equal(kept.hidden[0], 'rs'); assert.ok(!kept.order.includes('zzz'));
});

// ---------- edit mode (v4.36) ----------
test('which cards can change size: only those that work at both widths', () => {
  assert.deepEqual(CARDS.filter(c => !canResize(c.id)).map(c => c.id), ['rs', 'cal']);
  for (const c of CARDS) { assert.ok(c.sizes.includes(c.size), c.id + ': its default size is one of its sizes'); assert.ok(c.desc.length > 10, c.id + ' has a description'); }
  assert.equal(canResize('nope'), false);
});
test('a fixed-size card ignores a size it cannot have (older saved values still read)', () => {
  const l = normaliseLayout({ size: { cal: 'half', rs: 'half', perDay: 'full' } });
  assert.equal(l.size.cal, 'full'); assert.equal(l.size.rs, 'full'); assert.equal(l.size.perDay, 'full');
  assert.equal(setSize(defaultLayout(), 'cal', 'half').size.cal, 'full');
  assert.ok(isDefaultLayout({ size: { cal: 'half' } }));
  assert.equal(widths({ size: { cal: 'half' } }, ['cal', 'perDay']).get('cal'), 'full');
});
test('reorderVisible: hidden cards keep their places, shown ones take the new order', () => {
  let l = setHidden(defaultLayout(), 'rs', true);
  const shown = visibleOrder(l), next = [...shown]; [next[0], next[1]] = [next[1], next[0]];
  const r = reorderVisible(l, next);
  assert.deepEqual(visibleOrder(r), next);
  assert.equal(r.order.indexOf('rs'), l.order.indexOf('rs'));
  assert.deepEqual(r.hidden, ['rs']);
  assert.deepEqual(reorderVisible(l, shown.slice(1)).order, l.order);               // a missing card: unchanged
  assert.deepEqual(reorderVisible(l, [...shown.slice(1), 'streak', 'streak']).order, l.order);
  assert.deepEqual(reorderVisible(l, [...shown.slice(1), 'rs']).order, l.order);    // a hidden card is not a shown one
});
test('addWidget: a hidden card comes back at the end; hiddenCards lists them', () => {
  let l = setHidden(setHidden(defaultLayout(), 'hours', true), 'streak', true);
  assert.deepEqual(hiddenCards(l).map(c => c.id), ['streak', 'hours']);
  l = addWidget(l, 'streak');
  assert.equal(l.order.at(-1), 'streak'); assert.deepEqual(l.hidden, ['hours']);
  assert.equal(l.order.length, IDS.length);
  assert.deepEqual(addWidget(l, 'nope'), l);
  assert.deepEqual(hiddenCards(defaultLayout()), []);
});
test('editPlan: the true grid. A half card with no half partner stays half and is marked lone', () => {
  const l = { size: { forecast: 'full' } };             // perDay half, forecast full
  const plan = editPlan(l, ['rs', 'perDay', 'forecast', 'hardest', 'buttons']);
  assert.deepEqual(plan.get('rs'), { w: 'full', lone: false });
  assert.deepEqual(plan.get('perDay'), { w: 'half', lone: true });
  assert.deepEqual(plan.get('forecast'), { w: 'full', lone: false });
  assert.deepEqual(plan.get('hardest'), { w: 'half', lone: false }); assert.deepEqual(plan.get('buttons'), { w: 'half', lone: false });
  // outside editing the lone card stretches (widths), as before
  assert.equal(widths(l, ['rs', 'perDay', 'forecast']).get('perDay'), 'full');
  assert.equal(cardInfo('perDay').size, 'half');
});
