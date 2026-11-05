import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fundingProgress } from '../funding-progress.mjs';

test('funding progress waits for actual confirmation and NEAR recording', () => {
  assert.equal(fundingProgress('Preparing').step, 0);
  assert.equal(fundingProgress('Pending').step, 1);
  assert.equal(fundingProgress('Signed').step, 1);
  assert.equal(fundingProgress('Recording').step, 2);
  assert.equal(fundingProgress('Recorded').step, 3);
  assert.equal(fundingProgress('Recorded').busy, false);
});

test('uncertain and failed funding never appear complete', () => {
  assert.equal(fundingProgress('Checking').busy, true);
  for (const phase of ['Failed', 'NeedsReview']) {
    assert.equal(fundingProgress(phase).issue, true);
    assert.equal(fundingProgress(phase).step, -1);
    assert.equal(fundingProgress(phase).busy, false);
  }
});
