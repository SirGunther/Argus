import assert from 'node:assert/strict';
import test from 'node:test';
import { compareDerivedOrder, ensureDerivedOrder } from '../ui/ui-state.mjs';

test('ensureDerivedOrder assigns each item a stable index on first sight, in call order', () => {
  const orderMap = new Map();
  assert.equal(ensureDerivedOrder(orderMap, 'item-a'), 0);
  assert.equal(ensureDerivedOrder(orderMap, 'item-b'), 1);
  // Seeing an already-known item again must not reassign or reorder it.
  assert.equal(ensureDerivedOrder(orderMap, 'item-a'), 0);
  assert.equal(ensureDerivedOrder(orderMap, 'item-c'), 2);
});

test('compareDerivedOrder sorts by logging order even when logged_at is out of order (the reported bug)', () => {
  // Reproduces the reported scenario: relaunching the app and resuming a session that already had
  // logged items causes the audio-capture session-elapsed clock to restart, so a genuinely later
  // item can carry a `logged_at`/source time string that sorts earlier than the prior item's.
  const orderMap = new Map();
  const olderItem = { item_id: 'item-before-restart', logged_at: '00:21:50.464' };
  const newerItemWithEarlyTimestamp = { item_id: 'item-after-restart', logged_at: '00:00:12.800' };

  // Arrival/logging order: olderItem first, then newerItemWithEarlyTimestamp - exactly as the real
  // app pushes items onto the collection as they arrive.
  ensureDerivedOrder(orderMap, olderItem.item_id);
  ensureDerivedOrder(orderMap, newerItemWithEarlyTimestamp.item_id);

  const sorted = [newerItemWithEarlyTimestamp, olderItem].sort((a, b) => compareDerivedOrder(orderMap, a, b));

  assert.deepEqual(sorted.map((item) => item.item_id), ['item-before-restart', 'item-after-restart']);
  // The old, buggy behavior (string-comparing `logged_at`) would have sorted the newer item first;
  // guard against ever reintroducing that by asserting the naive comparison really does disagree here.
  assert.ok(newerItemWithEarlyTimestamp.logged_at.localeCompare(olderItem.logged_at) < 0);
});

test('pushing items one at a time and assigning order before each re-sort (as app.js does) keeps arrival order regardless of Array.sort internals', () => {
  // app.js pushes exactly one new item onto the existing collection, assigns its order via
  // ensureDerivedOrder, and only then re-sorts - it never lets the comparator itself decide when
  // an item first gets an index, because Array.prototype.sort does not guarantee which argument
  // order it compares elements in. Reproduce that exact push-assign-sort sequence.
  const orderMap = new Map();
  const collection = [];

  for (const id of ['item-1', 'item-2', 'item-3']) {
    collection.push({ item_id: id });
    ensureDerivedOrder(orderMap, id);
    collection.sort((a, b) => compareDerivedOrder(orderMap, a, b));
  }

  assert.deepEqual(collection.map((item) => item.item_id), ['item-1', 'item-2', 'item-3']);
  assert.equal(orderMap.size, 3);
});

test('compareDerivedOrder alone, without pre-assignment, is order-dependent on comparison sequence (documents why assignment cannot be lazy)', () => {
  // This is the failure mode ensureDerivedOrder-before-sort exists to avoid: comparing two
  // never-before-seen items lazily assigns indices in whatever order the comparator happens to
  // receive them, which is an Array.prototype.sort implementation detail, not arrival order.
  const orderMap = new Map();
  const lazyCompare = (a, b) => {
    if (!orderMap.has(a.item_id)) orderMap.set(a.item_id, orderMap.size);
    if (!orderMap.has(b.item_id)) orderMap.set(b.item_id, orderMap.size);
    return orderMap.get(a.item_id) - orderMap.get(b.item_id);
  };
  // Compare in reverse-of-arrival order, as a real sort implementation legitimately might.
  const result = lazyCompare({ item_id: 'item-newer' }, { item_id: 'item-older' });
  assert.ok(result < 0, 'the item compared first (item-newer) wins the earlier index purely because of comparison order, not arrival order - the exact bug class this file exists to prevent');
});
