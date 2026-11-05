import test from 'node:test';
import assert from 'node:assert/strict';
import { deadlineWindow } from '../server/portal/deadline-window.ts';
import type { FixedView } from '../server/market/fixed.ts';

test('deadline projection keeps timing and submission receipt, without exposing identity or policy details', () => {
  const view = { deliveryHours: 1, serverNow: 100, settlement: null, assignment: {
    confirmed: true, deadline: 3600100, withdrawRequested: false,
    login: 'private-login', marker: 'private-marker', userId: 12,
    submission: { receivedAt: 200, headSha: 'private-commit', prNumber: 9 },
  } } as unknown as FixedView;
  assert.deepEqual(deadlineWindow(view), { deliveryHours: 1, serverNow: 100, settlement: null,
    assignment: { confirmed: true, deadline: 3600100, withdrawRequested: false, submission: { receivedAt: 200 } } });
  assert.equal(deadlineWindow(null), null);
});
