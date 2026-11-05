import { test } from 'node:test';
import assert from 'node:assert/strict';
import { workflowChecks } from '../server/portal/workflow-checks.ts';
function client(responses: unknown[]) {
  const paths: string[] = [];
  return { paths, get: async <T>(path: string): Promise<T> => { paths.push(path); return responses.shift() as T; } };
}
test('discovers exact job and matrix names without executing workflows', async () => {
  const gh = client([{ id: 42, path: '.github/workflows/ci.yml' }, { workflow_runs: [{ id: 99 }] }, { total_count: 3, jobs: [{ name: 'acceptance' }, { name: 'test (22)' }, { name: 'acceptance' }] }]);
  assert.deepEqual(await workflowChecks(gh, 'owner/repo', '.github/workflows/ci.yml'), { checkNames: ['acceptance', 'test (22)'], source: 'workflow-run', runId: 99 });
  assert.equal(gh.paths.length, 3);
});
test('no history returns no invented check', async () => {
  const gh = client([{ id: 42, path: '.github/workflows/ci.yml' }, { workflow_runs: [] }]);
  assert.deepEqual(await workflowChecks(gh, 'owner/repo', '.github/workflows/ci.yml'), { checkNames: [], source: 'no-jobs' });
});
test('rejects invalid paths before accessing GitHub', async () => {
  const gh = client([]);
  await assert.rejects(workflowChecks(gh, 'owner/repo', '../../ci.yml'), /Invalid workflow/);
  assert.equal(gh.paths.length, 0);
});
test('does not auto-select an incomplete job list', async () => {
  const gh = client([{ id: 42, path: '.github/workflows/ci.yml' }, { workflow_runs: [{ id: 99 }] }, { total_count: 101, jobs: [{ name: 'acceptance' }] }]);
  assert.deepEqual(await workflowChecks(gh, 'owner/repo', '.github/workflows/ci.yml'), { checkNames: [], source: 'too-many-jobs' });
});
