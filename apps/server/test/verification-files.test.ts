import { test } from 'node:test';
import assert from 'node:assert/strict';
import { suggestVerificationFiles, verificationFiles } from '../server/portal/verification-files.ts';
test('suggests existing tests across languages, prioritizing acceptance and excluding generated files', () => {
  const result = suggestVerificationFiles(['src/index.ts', 'Cargo.toml', 'tests/receipts.rs', 'src/payment.test.ts', 'test_api.py', 'service_test.go', 'node_modules/pkg/test/x.js', 'target/tests/output.rs', 'tests/fixtures/example.ts', 'tests/acceptance.test.mjs']);
  assert.equal(result[0], 'tests/acceptance.test.mjs');
  assert.deepEqual(new Set(result), new Set(['tests/receipts.rs', 'src/payment.test.ts', 'test_api.py', 'service_test.go', 'tests/acceptance.test.mjs']));
});
test('reads the selected branch, excludes directories, and reports partial results', async () => {
  const paths: string[] = [];
  const gh = { get: async <T>(path: string): Promise<T> => { paths.push(path); return { truncated: true, tree: [{type:'blob',path:'tests/acceptance.rs'}, {type:'tree',path:'tests/spec.rs'}] } as T; } };
  const result = await verificationFiles(gh, 'owner/repo', 'release/demo');
  assert.deepEqual(result, { suggestions: ['tests/acceptance.rs'], truncated: true });
  assert.equal(paths[0], '/repos/owner/repo/git/trees/release%2Fdemo?recursive=1');
  await assert.rejects(verificationFiles(gh, '../repo', 'main'));
});
