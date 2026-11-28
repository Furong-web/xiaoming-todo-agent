import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { buildDailySummary, buildHabits } from "./coach.ts";
import { createCheckInStore, createQuizStore } from "./checkin-store.ts";
import { detectCategory, detectLocation, detectRepeat } from "./task-model.ts";
import { createJsonTaskStore } from "./task-store.ts";
import { executeTool } from "./tools.ts";

async function setup(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "life-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const tasks = createJsonTaskStore(join(dir, "tasks.json"));
  const checkIns = createCheckInStore(join(dir, "checkins.json"));
  const quizzes = createQuizStore(join(dir, "quizzes.json"));
  const now = new Date(2026, 10, 26, 10, 0, 0);
  return { tasks, checkIns, quizzes, ctx: { tasks, checkIns, quizzes, now } };
}

test("detectCategory 区分学习与生活琐事", () => {
  assert.equal(detectCategory("学习数学第一章"), "study");
  assert.equal(detectCategory("背英语单词"), "study");
  assert.equal(detectCategory("去驿站取快递"), "life");
  assert.equal(detectCategory("洗衣服"), "life");
  assert.equal(detectCategory("喝牛奶"), "life");
});

test("detectLocation 识别常见地点", () => {
  assert.equal(detectLocation("去驿站取快递"), "驿站");
  assert.equal(detectLocation("去超市买菜"), "超市");
  assert.equal(detectLocation("公司开会"), "公司");
  assert.equal(detectLocation("背英语单词"), undefined);
});

test("detectRepeat 只识别明确的周期性表达", () => {
  assert.equal(detectRepeat("每天喝牛奶"), "daily");
  assert.equal(detectRepeat("每周跑三次步"), "weekly");
  assert.equal(detectRepeat("买牛奶"), undefined);
});

test("plan_route 把同地点任务合并并优先安排外出事项", async (t) => {
  const { tasks, ctx } = await setup(t);
  tasks.create("去驿站取快递");
  tasks.create("去驿站寄件");
  tasks.create("去超市买菜");
  tasks.create("公司开会");
  tasks.create("在家打扫房间");

  const plan = JSON.parse(executeTool("plan_route", {}, ctx));
  const names = plan.stops.map((stop: { location: string }) => stop.location);
  assert.ok(names.includes("驿站"));
  assert.ok(names.includes("超市"));
  assert.ok(names.includes("公司"));

  const station = plan.stops.find((stop: { location: string }) => stop.location === "驿站");
  assert.equal(station.tasks.length, 2);
  // 驿站/超市这类外出地点排在「无需外出」之前
  assert.notEqual(names[names.length - 1], "驿站");
  assert.equal(plan.outdoorStops, 4);
  assert.ok(plan.mergeable >= 1);
});

test("plan_route 已完成任务不进入路线", async (t) => {
  const { tasks, ctx } = await setup(t);
  const done = tasks.create("去超市买菜");
  tasks.update(done.id, { done: true });
  const plan = JSON.parse(executeTool("plan_route", {}, ctx));
  assert.equal(plan.stops.length, 0);
});

test("buildHabits 计算连续打卡天数", () => {
  const tasks = [{ id: "h1", title: "每天喝牛奶", done: false, repeat: "daily" }] as never[];
  const make = (offset: number) => ({
    id: `c${offset}`,
    taskId: "h1",
    taskTitle: "每天喝牛奶",
    date: new Date(2026, 10, 26 - offset).toLocaleDateString("en-CA"),
    createdAt: new Date().toISOString(),
  });
  const now = new Date(2026, 10, 26, 20, 0, 0);
  // 今天、昨天、前天都打卡了
  const habits = buildHabits(tasks, [make(0), make(1), make(2)] as never[], now);
  assert.equal(habits[0].streak, 3);
  assert.equal(habits[0].doneToday, true);
  assert.equal(habits[0].doneYesterday, true);

  // 昨天没打卡，连续中断
  const broken = buildHabits(tasks, [make(0), make(2)] as never[], now);
  assert.equal(broken[0].doneYesterday, false);
  assert.equal(broken[0].streak, 1);
});

test("list_habits 工具返回连续打卡情况", async (t) => {
  const { tasks, checkIns, ctx } = await setup(t);
  tasks.create("每天喝牛奶", { repeat: "daily", category: "life" });
  checkIns.add(
    { taskId: "x", taskTitle: "每天喝牛奶", category: "life" },
    new Date(2026, 10, 25, 9, 0, 0),
  );
  const result = JSON.parse(executeTool("list_habits", {}, ctx));
  assert.equal(result.habits.length, 1);
  assert.equal(result.habits[0].doneYesterday, true);
  assert.equal(result.habits[0].doneToday, false);
});

test("复盘区分学习数与生活数，支持不偏心学习", () => {
  const tasks = [
    { id: "t1", title: "背英语单词", done: true, category: "study", module: "英语" },
    { id: "t2", title: "洗衣服", done: true, category: "life" },
    { id: "t3", title: "喝牛奶", done: true, category: "life" },
  ] as never[];
  const checkIns = [
    { id: "1", taskId: "t1", taskTitle: "背英语单词", module: "英语", category: "study", date: "2026-11-26", createdAt: new Date().toISOString() },
    { id: "2", taskId: "t2", taskTitle: "洗衣服", category: "life", date: "2026-11-26", createdAt: new Date().toISOString() },
    { id: "3", taskId: "t3", taskTitle: "喝牛奶", category: "life", date: "2026-11-26", createdAt: new Date().toISOString() },
  ] as never[];
  const summary = buildDailySummary("2026-11-26", tasks, checkIns);
  assert.equal(summary.studyCount, 1);
  assert.equal(summary.lifeCount, 2);
  assert.equal(summary.completedCount, 3);
});

test("create_task 自动识别生活类任务、地点与周期", async (t) => {
  const { tasks, ctx } = await setup(t);
  executeTool("create_task", { title: "每天去超市买牛奶" }, ctx);
  const task = tasks.list()[0];
  assert.equal(task.category, "life");
  assert.equal(task.repeat, "daily");
  assert.equal(task.location, "超市");
});

test("check_in_task 记录 category 供复盘区分", async (t) => {
  const { tasks, checkIns, ctx } = await setup(t);
  const created = tasks.create("洗衣服");
  const result = JSON.parse(executeTool("check_in_task", { id: created.id }, ctx));
  assert.equal(result.ok, true);
  assert.equal(checkIns.list()[0].category, "life");
});

test("generate_daily_summary 返回 habits 字段供连续激励", async (t) => {
  const { tasks, checkIns, ctx } = await setup(t);
  tasks.create("每天喝牛奶", { repeat: "daily" });
  checkIns.add(
    { taskId: "x", taskTitle: "每天喝牛奶", category: "life" },
    new Date(2026, 10, 25, 8, 0, 0),
  );
  const result = JSON.parse(executeTool("generate_daily_summary", { date: "今天" }, ctx));
  assert.ok(Array.isArray(result.habits));
  assert.equal(result.habits[0].doneYesterday, true);
  assert.equal(typeof result.summary.lifeCount, "number");
});
