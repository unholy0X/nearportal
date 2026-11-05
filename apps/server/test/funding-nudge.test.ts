import test from "node:test";
import assert from "node:assert/strict";
import { TaskStore } from "../server/tasks/store.ts";

const nextAt = (store: TaskStore, id: string) =>
  (store.db.prepare("SELECT next_at FROM queue WHERE task_id=?").get(id) as { next_at: number }).next_at;

test("a watched funding check is brought forward only from a healthy wait", () => {
  const store = new TaskStore(":memory:");
  for (const id of ["healthy", "failing"]) store.db.prepare("INSERT INTO tasks(id, body) VALUES(?, '{}')").run(id);
  store.enqueue("healthy"); store.wait("healthy", 60_000);
  assert.equal(store.nudge("healthy"), true);
  assert.ok(nextAt(store, "healthy") <= Date.now());
  assert.equal(store.nudge("healthy"), false, "already due: nothing to change");

  store.enqueue("failing"); store.retry("failing", "RPC unavailable", 120_000);
  const backoff = nextAt(store, "failing");
  assert.equal(store.nudge("failing"), false, "failure backoff is never shortened");
  assert.equal(nextAt(store, "failing"), backoff);

  assert.equal(store.nudge("unknown"), false, "never creates queue rows");
});
