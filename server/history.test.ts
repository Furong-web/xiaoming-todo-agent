import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createApp } from "./app.ts";
import { createHistoryStore } from "./history-store.ts";
import { createJsonTaskStore } from "./task-store.ts";

async function startTestApp(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "todo-history-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const tasks = createJsonTaskStore(join(directory, "tasks.json"));
  const history = createHistoryStore(join(directory, "history.json"));

  const app = createApp({
    tasks,
    history,
    async reply() {
      return "收到";
    },
  });
  const server = app.listen(0, "127.0.0.1");
  t.after(() => server[Symbol.asyncDispose]());
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;

  async function request(method: string, path: string, body?: unknown) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return {
      status: response.status,
      body: response.status === 204 ? null : await response.json(),
    };
  }

  return { tasks, history, request };
}

test("勾选完成即进历史：父任务完成带动子任务一起记录", async (t) => {
  const { tasks, history, request } = await startTestApp(t);
  const parent = tasks.create("考研", { priority: "high" });
  tasks.create("背单词", { parentId: parent.id });

  const patched = await request("PATCH", `/api/tasks/${parent.id}`, { done: true });
  assert.equal(patched.status, 200);

  const records = history.list();
  assert.equal(records.length, 2);
  const child = records.find((item) => item.title === "背单词");
  assert.equal(child?.parentTitle, "考研");
  assert.equal(child?.completedAt, patched.body.completedAt);
  assert.ok(child?.date);
});

test("取消完成会撤掉历史记录，重复勾选不产生重复记录", async (t) => {
  const { tasks, history, request } = await startTestApp(t);
  const task = tasks.create("买牛奶");

  await request("PATCH", `/api/tasks/${task.id}`, { done: true });
  assert.equal(history.list().length, 1);
  // 重复勾选是幂等的，不会多记一条
  await request("PATCH", `/api/tasks/${task.id}`, { done: true });
  assert.equal(history.list().length, 1);

  await request("PATCH", `/api/tasks/${task.id}`, { done: false });
  assert.deepEqual(history.list(), []);
});

test("删除不影响历史：完成过的留档，没完成过的没有记录", async (t) => {
  const { tasks, history, request } = await startTestApp(t);
  const done = tasks.create("背单词");
  const open = tasks.create("洗奶瓶");
  await request("PATCH", `/api/tasks/${done.id}`, { done: true });

  assert.equal((await request("DELETE", `/api/tasks/${done.id}`)).status, 204);
  assert.equal((await request("DELETE", `/api/tasks/${open.id}`)).status, 204);

  const records = history.list();
  assert.equal(records.length, 1);
  assert.equal(records[0].title, "背单词");
});

test("历史接口按日期区间过滤，并按关键词搜索标题与父任务", async (t) => {
  const { history, request } = await startTestApp(t);
  const parent = { id: "parent", title: "考研", done: true };
  history.recordCompletion(
    { ...parent, completedAt: new Date(2026, 10, 20, 9).toISOString() },
    [],
  );
  history.recordCompletion(
    { id: "child", title: "背单词", done: true, parentId: parent.id, completedAt: new Date(2026, 10, 26, 9).toISOString() },
    [parent],
  );
  history.recordCompletion(
    { id: "other", title: "洗奶瓶", done: true, completedAt: new Date(2026, 10, 27, 9).toISOString() },
    [],
  );

  const all = await request("GET", "/api/history");
  assert.equal(all.body.length, 3);
  // 新的在前
  assert.deepEqual(
    all.body.map((item: { title: string }) => item.title),
    ["洗奶瓶", "背单词", "考研"],
  );

  const ranged = await request("GET", "/api/history?from=2026-11-21&to=2026-11-26");
  assert.deepEqual(
    ranged.body.map((item: { title: string }) => item.title),
    ["背单词"],
  );

  // 关键词能通过父任务标题命中子任务
  const searched = await request("GET", "/api/history?q=考研");
  assert.deepEqual(
    searched.body.map((item: { title: string }) => item.title),
    ["背单词", "考研"],
  );

  const badDate = await request("GET", "/api/history?from=11/26");
  assert.equal(badDate.status, 400);
});

