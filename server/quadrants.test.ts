/** 四象限：口语识别、priority/dueDate 自动推断、显式字段优先、标题剥离。 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyQuadrant,
  detectQuadrant,
  quadrantFromFlags,
  QUADRANTS,
} from "../shared/quadrants.ts";
import { stripMeta } from "./task-model.ts";
import { executeTool } from "./tools.ts";
import { createJsonTaskStore } from "./task-store.ts";
import { createCheckInStore, createQuizStore } from "./checkin-store.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";

const NOW = new Date(2026, 10, 28, 11, 0, 0);

test("detectQuadrant 区分四种口语表达，否定式不被误判", () => {
  assert.equal(detectQuadrant("加个紧急重要的任务"), "urgent-important");
  assert.equal(detectQuadrant("这件重要且紧急"), "urgent-important");
  assert.equal(detectQuadrant("不紧急不重要，有空再说"), "not-urgent-not-important");
  assert.equal(detectQuadrant("既不紧急也不重要"), "not-urgent-not-important");
  assert.equal(detectQuadrant("紧急不重要的杂事"), "urgent-not-important");
  assert.equal(detectQuadrant("不重要但紧急"), "urgent-not-important");
  assert.equal(detectQuadrant("不紧急但重要，排进计划"), "not-urgent-important");
  assert.equal(detectQuadrant("重要但不急"), "not-urgent-important");
  assert.equal(detectQuadrant("帮我记一下买牛奶"), undefined);
});

test("象限顺序按用户指定的四个分组", () => {
  assert.deepEqual(QUADRANTS.map((item) => item.label), [
    "紧急且重要",
    "不紧急不重要",
    "紧急不重要",
    "不紧急但重要",
  ]);
  assert.equal(quadrantFromFlags(true, true), "urgent-important");
  assert.equal(quadrantFromFlags(false, false), "not-urgent-not-important");
  assert.equal(quadrantFromFlags(true, false), "urgent-not-important");
  assert.equal(quadrantFromFlags(false, true), "not-urgent-important");
});

test("未指定象限时按截止日期与高优先级推断", () => {
  assert.equal(
    classifyQuadrant({ priority: "high", dueDate: "2026-11-28" }, NOW),
    "urgent-important",
  );
  // 逾期也算紧急
  assert.equal(
    classifyQuadrant({ dueDate: "2026-11-20" }, NOW),
    "urgent-not-important",
  );
  assert.equal(
    classifyQuadrant({ priority: "high", dueDate: "2026-12-30" }, NOW),
    "not-urgent-important",
  );
  assert.equal(classifyQuadrant({}, NOW), "not-urgent-not-important");
  // 显式象限优先于推断
  assert.equal(
    classifyQuadrant({ priority: "high", dueDate: "2026-11-28", quadrant: "not-urgent-not-important" }, NOW),
    "not-urgent-not-important",
  );
});

test("创建任务时象限词不会混进标题", () => {
  assert.equal(stripMeta("帮我记一下不紧急不重要的整理房间"), "帮我记一下整理房间");
  assert.equal(stripMeta("紧急重要：复习数学"), "：复习数学");
  assert.equal(stripMeta("加个不紧急但重要的背单词"), "加个背单词");
});

test("create_task 会把模型传入的 quadrant 落库", async (t: TestContext) => {
  const dir = await mkdtemp(join(tmpdir(), "quadrant-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const tasks = createJsonTaskStore(join(dir, "tasks.json"));
  const ctx = {
    tasks,
    checkIns: createCheckInStore(join(dir, "checkins.json")),
    quizzes: createQuizStore(join(dir, "quizzes.json")),
    now: NOW,
  };
  const result = JSON.parse(
    executeTool("create_task", { title: "整理笔记", quadrant: "not-urgent-important" }, ctx),
  );
  assert.equal(result.task.quadrant, "not-urgent-important");
  assert.equal(tasks.list()[0].quadrant, "not-urgent-important");
});
