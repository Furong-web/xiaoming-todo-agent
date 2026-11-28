/** 完成时刻的记录规则：只在服务端生成、取消即清除、联动共享同一时刻、重复勾选不刷新。 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setTaskDone } from "./task-completion.ts";
import { createJsonTaskStore } from "./task-store.ts";

async function setup(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "completion-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return createJsonTaskStore(join(dir, "tasks.json"));
}

const NOW = new Date(2026, 10, 28, 10, 32, 0);
const STAMP = NOW.toISOString();

test("勾选完成写入服务端时刻，取消完成会清除", async (t) => {
  const store = await setup(t);
  const task = store.create("学言语");

  const done = setTaskDone(store, task.id, true, NOW);
  assert.equal(done?.completedAt, STAMP);

  const undone = setTaskDone(store, task.id, false, new Date(2026, 10, 28, 11, 0, 0));
  assert.equal(undone?.done, false);
  assert.equal(undone?.completedAt, undefined);
  assert.deepEqual(store.list()[0], { id: task.id, title: "学言语", done: false });
});

test("勾选父任务时，所有层级子任务共享同一个完成时刻", async (t) => {
  const store = await setup(t);
  const parent = store.create("备考计划");
  const child = store.create("学资料第一章节", { parentId: parent.id });
  store.create("学数量第 40 页", { parentId: child.id });

  setTaskDone(store, parent.id, true, NOW);
  for (const task of store.list()) {
    assert.equal(task.done, true);
    assert.equal(task.completedAt, STAMP);
  }
});

test("子任务全部完成后父任务自动完成，并记录完成时刻", async (t) => {
  const store = await setup(t);
  const parent = store.create("备考计划");
  const a = store.create("学言语", { parentId: parent.id });
  const b = store.create("学资料第一章节", { parentId: parent.id });

  setTaskDone(store, a.id, true, NOW);
  assert.equal(store.list().find((task) => task.id === parent.id)?.done, false);

  setTaskDone(store, b.id, true, NOW);
  assert.equal(store.list().find((task) => task.id === parent.id)?.completedAt, STAMP);

  // 取消任一子任务，父任务回到待办且清除完成时刻
  setTaskDone(store, a.id, false, NOW);
  const reopened = store.list().find((task) => task.id === parent.id);
  assert.equal(reopened?.done, false);
  assert.equal(reopened?.completedAt, undefined);
});

test("重复勾选不会刷新完成时刻", async (t) => {
  const store = await setup(t);
  const task = store.create("买牛奶");
  setTaskDone(store, task.id, true, NOW);
  setTaskDone(store, task.id, true, new Date(2026, 10, 28, 18, 0, 0));
  assert.equal(store.list()[0].completedAt, STAMP);
});
