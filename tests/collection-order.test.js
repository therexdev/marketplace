'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { latestSales, orderCollections } = require('../lib/collection-order');
test('recent completed sales lead; unsold projects retain launch order and new projects append', () => {
  const rows = ['old-unsold', 'older-sale', 'newer-sale', 'new-unsold'].map(address => ({ address }));
  const events = [
    { kind: 'sold', collection: 'older-sale', seq: 10, idx: 0 },
    { kind: 'sold', collection: 'newer-sale', seq: 20, idx: 0 },
    { kind: 'listed', collection: 'old-unsold', seq: 99, idx: 0 },
    { kind: 'cancelled', collection: 'older-sale', seq: 100, idx: 0 },
  ];
  const sales = latestSales(events);
  assert.deepEqual(orderCollections(rows, sales).map(c => c.address), ['newer-sale','older-sale','old-unsold','new-unsold']);
  assert.deepEqual(orderCollections(rows, {}).map(c => c.address), rows.map(c => c.address));
  const next = latestSales([{ kind: 'sold', collection: 'older-sale', seq: 101, idx: 0 }], sales);
  assert.equal(orderCollections(rows, next)[0].address, 'older-sale');
  assert.deepEqual(latestSales([], next), next, 'sale ranking survives history truncation');
});
