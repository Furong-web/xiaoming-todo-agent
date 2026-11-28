import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { buildDailySummary, resolveSummaryDate } from "./coach.ts";
import { createCheckInStore, createQuizStore } from "./checkin-store.ts";
import { createJsonTaskStore } from "./task-store.ts";
import { executeTool } from "./tools.ts";

async function setup(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "coach-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const tasks = createJsonTaskStore(join(dir, "tasks.json"));
  const checkIns = createCheckInStore(join(dir, "checkins.json"));
  const quizzes = createQuizStore(join(dir, "quizzes.json"));
  // 固定「现在」为 2026-11-26 10:00，保证日期断言稳定
  const now = new Date(2026, 10, 26, 10, 0, 0);
  return { tasks, checkIns, quizzes, ctx: { tasks, checkIns, quizzes, now } };
}

test("resolveSummaryDate 支持昨天/前天/今天与绝对日期", () => {
  const now = new Date(2026, 10, 26);
  assert.equal(resolveSummaryDate("昨天", now), "2026-11-25");
  assert.equal(resolveSummaryDate("前天", now), "2026-11-24");
  assert.equal(resolveSummaryDate("今天", now), "2026-11-26");
  assert.equal(resolveSummaryDate("2026-11-20", now), "2026-11-20");
});

test("check_in_task 记录时间戳、模块与进度笔记，并把任务标记完成", async (t) => {
  const { tasks, checkIns, ctx } = await setup(t);
  const created = tasks.create("学习数学第一章", { module: "数学" });

  const raw = executeTool("check_in_task", { id: created.id, note: "学完了极限的定义" }, ctx);
  const result = JSON.parse(raw);
  assert.equal(result.ok, true);
  assert.equal(result.needNote, false);
  assert.equal(result.checkIn.module, "数学");
  assert.equal(result.checkIn.date, "2026-11-26");

  assert.equal(tasks.list()[0].done, true);
  const records = checkIns.list();
  assert.equal(records.length, 1);
  assert.ok(records[0].createdAt.includes("2026-11-26"));
});

test("check_in_task 未提供笔记时返回 needNote=true 供模型追问", async (t) => {
  const { tasks, ctx } = await setup(t);
  const created = tasks.create("背单词");
  const result = JSON.parse(executeTool("check_in_task", { id: created.id }, ctx));
  assert.equal(result.needNote, true);
});

test("check_in_task 能从标题自动识别模块", async (t) => {
  const { tasks, ctx } = await setup(t);
  const created = tasks.create("做一套英语真题");
  const result = JSON.parse(executeTool("check_in_task", { id: created.id }, ctx));
  assert.equal(result.checkIn.module, "英语");
});

test("generate_daily_summary 按模块聚合当天进度并给出推荐任务", async (t) => {
  const { tasks, checkIns, ctx } = await setup(t);
  const math = tasks.create("学数学", { module: "数学" });
  const english = tasks.create("背单词", { module: "英语" });
  checkIns.add({ taskId: english.id, taskTitle: english.title, module: "英语", note: "背了 100 个" }, new Date(2026, 10, 25, 9, 0, 0));
  checkIns.add({ taskId: math.id, taskTitle: math.title, module: "数学", note: "学了极限" }, new Date(2026, 10, 25, 20, 0, 0));
  checkIns.add({ taskId: math.id, taskTitle: math.title, module: "数学", note: "做了 20 题" }, new Date(2026, 10, 25, 21, 0, 0));

  const pending = tasks.create("明天再看政治", { priority: "high", dueDate: "2026-11-26" });
  assert.ok(pending.id);

  const result = JSON.parse(executeTool("generate_daily_summary", { date: "昨天" }, ctx));
  assert.equal(result.summary.date, "2026-11-25");
  assert.equal(result.summary.completedCount, 3);

  const mathProgress = result.summary.modules.find((m: { module: string }) => m.module === "数学");
  assert.equal(mathProgress.checkIns, 2);
  assert.deepEqual(mathProgress.notes, ["学了极限", "做了 20 题"]);

  assert.ok(result.recommendations.length > 0);
  assert.equal(result.recommendations[0].title, "明天再看政治");
});

test("send_quiz 保存答案但不对模型回传答案；grade_quiz 批改后返回标准答案", async (t) => {
  const { quizzes, ctx } = await setup(t);

  const sent = JSON.parse(
    executeTool(
      "send_quiz",
      { module: "数学", question: "求 lim(x→0) sinx/x", answer: "1，因为 sinx~x" },
      ctx,
    ),
  );
  assert.equal(sent.ok, true);
  assert.ok(sent.quizId);
  // 出题结果里不能泄露答案
  assert.equal(JSON.stringify(sent).includes("sinx~x"), false);

  const graded = JSON.parse(
    executeTool("grade_quiz", { response: "等于 1", verdict: "正确" }, ctx),
  );
  assert.equal(graded.ok, true);
  assert.equal(graded.standardAnswer, "1，因为 sinx~x");
  assert.equal(graded.question, "求 lim(x→0) sinx/x");

  const saved = quizzes.list()[0];
  assert.equal(saved.response, "等于 1");
  assert.equal(saved.verdict, "正确");
  assert.ok(saved.gradedAt);
});

test("grade_quiz 在没有待批改题目时报错，不编造结果", async (t) => {
  const { ctx } = await setup(t);
  const result = JSON.parse(executeTool("grade_quiz", { response: "1", verdict: "正确" }, ctx));
  assert.match(result.error, /没有待批改/);
});

test("buildDailySummary 空数据时给出零值，不抛错", () => {
  const summary = buildDailySummary("2026-11-25", [], []);
  assert.equal(summary.completedCount, 0);
  assert.deepEqual(summary.modules, []);
  assert.deepEqual(summary.completedTasks, []);
});

test("create_task 自动识别模块并落库", async (t) => {
  const { tasks, ctx } = await setup(t);
  const result = JSON.parse(executeTool("create_task", { title: "背政治马原" }, ctx));
  assert.equal(result.ok, true);
  assert.equal(tasks.list()[0].module, "政治");
});
