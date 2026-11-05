import { test } from "node:test";
import assert from "node:assert/strict";
const branch = process.env.NEARPORTAL_JUDGE_BRANCH ?? "codex/nearportal-task/judge-1";
const match = /^codex\/nearportal-task\/judge-([1-5])$/.exec(branch);
if (!match) throw new Error("Use a configured judge-1 through judge-5 branch");
const { toCsv } = await import(`../src/csv-${match[1]}.mjs`);

test("exports every provided record in the selected column order", () => {
  assert.equal(toCsv([{ id: 1, name: "Ada" }, { id: 2, name: "Lin" }], ["name", "id"]), "name,id\r\nAda,1\r\nLin,2");
});
test("escapes commas, double quotes and embedded newlines", () => {
  assert.equal(toCsv([{ note: 'One, "two"\nthree' }], ["note"]), 'note\r\n"One, ""two""\nthree"');
});
test("preserves zero and false, and renders null as empty", () => {
  assert.equal(toCsv([{ count: 0, active: false, empty: null }], ["count", "active", "empty"]), "count,active,empty\r\n0,false,");
});
test("escapes headers and exports an empty selection", () => {
  assert.equal(toCsv([], ["last,name", "id"]), '"last,name",id');
});
