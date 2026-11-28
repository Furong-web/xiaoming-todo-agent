import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { reply } from "./agent.ts";
import { addDays, parseDate } from "./task-model.ts";
import { createJsonTaskStore } from "./task-store.ts";

// agent.ts 里的 store 指向相对项目根目录的 data/tasks.json。
// 这里把工作目录切到临时目录，保证测试不污染真实数据；每个测试单独一个目录。
async function useTempData(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "todo-agent-chat-"));
  const previous = process.cwd();
  process.chdir(directory);
  t.after(async () => {
    process.chdir(previous);
    await rm(directory, { recursive: true, force: true });
  });
  return createJsonTaskStore(join(directory, "data", "tasks.json"));
}

function say(content: string) {
  return reply([{ role: "user", content }]);
}

// 测试全程走规则版（不依赖 DeepSeek），确保无 Key 也能稳定通过。
delete process.env.DEEPSEEK_API_KEY;

test("官方验收对话六句都能对上", async (t) => {
  const store = await useTempData(t);

  assert.match(await say("帮我记一下买牛奶"), /已记下「买牛奶」/);
  assert.match(await say("再记一条取快递"), /已记下「取快递」/);

  const listed = await say("我有哪些任务？");
  assert.match(listed, /买牛奶/);
  assert.match(listed, /取快递/);
  assert.match(listed, /□/);
  assert.doesNotMatch(listed, /\| ID /);

  assert.match(await say("牛奶买好了"), /已把「买牛奶」标记为完成/);
  const afterDone = store.list();
  assert.equal(afterDone.find((task) => task.title === "买牛奶")?.done, true);
  assert.equal(afterDone.find((task) => task.title === "取快递")?.done, false);

  assert.match(await say("取快递这条删掉吧"), /已删除「取快递」/);
  const final = await say("再给我看看清单");
  assert.doesNotMatch(final, /取快递/);
  assert.match(final, /买牛奶/);
  assert.deepEqual(
    store.list().map((task) => task.title),
    ["买牛奶"],
  );
});

test("空清单与闲聊不会误建任务", async (t) => {
  const store = await useTempData(t);
  assert.match(await say("我有哪些任务？"), /清单还是空的/);
  assert.match(await say("你好"), /欢迎使用小明智能体/);
  assert.match(await say("今天天气怎么样"), /欢迎使用小明智能体|我可以帮你/);
  assert.deepEqual(store.list(), []);
});

test("重复创建与找不到目标任务都有明确反馈", async (t) => {
  const store = await useTempData(t);
  await say("帮我记一下买牛奶");
  assert.match(await say("帮我记一下买牛奶"), /已经在待办里了/);
  assert.equal(store.list().length, 1);

  // 只剩一条任务时，模糊说法允许落到唯一一条上
  assert.match(await say("洗衣服做完了"), /已把「买牛奶」标记为完成/);
  // 已完成再标记一次是幂等的
  assert.match(await say("牛奶做完了"), /已经是完成状态/);
  // 撤销完成后可以重新完成
  assert.match(await say("取消完成买牛奶"), /恢复成待办/);
  assert.match(await say("牛奶做完了"), /已把「买牛奶」标记为完成/);

  assert.match(await say("不存在的任务删掉"), /我没找到/);
});

test("创建时解析优先级、工作量与截止日期", async (t) => {
  const store = await useTempData(t);
  const answer = await say("帮我记一条高优先级的交报告，大工作量，明天截止");
  assert.match(answer, /已记下「交报告」/);
  const task = store.list()[0];
  assert.equal(task.title, "交报告");
  assert.equal(task.priority, "high");
  assert.equal(task.effort, "large");
  assert.equal(task.dueDate, addDays(1));

  const listed = await say("我有哪些任务？");
  assert.match(listed, /🔴/);
  assert.match(listed, /交报告/);
  assert.match(listed, /截止 \d{4}-\d{2}-\d{2}/);
});

test("「今天有哪些任务到期」能筛出今天和逾期任务", async (t) => {
  const store = await useTempData(t);
  await say("帮我记一下今天交周报");
  await say("帮我记一下后天去银行");
  const dueToday = store.list().find((task) => task.title === "交周报");
  assert.equal(dueToday?.dueDate, addDays(0));

  const answer = await say("今天有哪些任务到期？");
  assert.match(answer, /交周报/);
  assert.doesNotMatch(answer, /去银行/);
});

test("子任务：父任务完成带动子任务，子任务全完成带动父任务", async (t) => {
  const store = await useTempData(t);
  await say("帮我记一下买牛奶");
  const parent = store.list()[0];

  assert.match(await say("买牛奶下面记一条洗奶瓶"), /是「买牛奶」的子任务/);
  assert.match(await say("买牛奶下面记一条买面包"), /是「买牛奶」的子任务/);
  const children = store.list().filter((task) => task.parentId === parent.id);
  assert.equal(children.length, 2);

  const listed = await say("我有哪些任务？");
  assert.match(listed, /□ 102 洗奶瓶|□ 10\d 洗奶瓶/);

  await say("买牛奶做完了");
  assert.equal(store.list().filter((task) => task.parentId).every((task) => task.done), true);

  await say("取消完成买牛奶");
  await say("洗奶瓶做完了");
  await say("买面包做完了");
  assert.equal(store.list().find((task) => task.id === parent.id)?.done, true);

  assert.match(await say("买牛奶删掉"), /以及它下面的 2 条子任务/);
  assert.deepEqual(store.list(), []);
});

test("改标题与推迟任务", async (t) => {
  const store = await useTempData(t);
  await say("帮我记一下买牛奶");
  assert.match(await say("买牛奶改名为买酸奶"), /改名为「买酸奶」/);
  assert.equal(store.list()[0]?.title, "买酸奶");

  assert.match(await say("买酸奶推迟到明天"), /推迟到/);
  assert.equal(store.list()[0]?.dueDate, addDays(1));
});

test("日期解析覆盖常见中文说法", () => {
  const base = new Date(2026, 10, 26); // 2026-11-26 周四
  assert.equal(parseDate("今天", base), "2026-11-26");
  assert.equal(parseDate("明天", base), "2026-11-27");
  assert.equal(parseDate("后天", base), "2026-11-28");
  assert.equal(parseDate("周五", base), "2026-11-27");
  assert.equal(parseDate("下周一", base), "2026-11-30");
  assert.equal(parseDate("12月1日", base), "2026-12-01");
  assert.equal(parseDate("没有日期", base), null);
});

test("智能排程建议：逾期 > 高优先级 > 截止临近", async (t) => {
  const store = await useTempData(t);
  await say("帮我记一下买牛奶"); // 无优先级、无日期
  const answer = await say("我接下来该做什么？");
  assert.match(answer, /建议先做/);
  assert.match(answer, /买牛奶/);

  // 加一条高优先级
  await say("帮我记一条高优先级的交报告");
  const answer2 = await say("我接下来该做什么？");
  assert.match(answer2, /交报告/);
  assert.match(answer2, /高优先级/);
  assert.equal(store.list().length, 2);
});

test("无限层级子任务：三层都能正确归属和联动", async (t) => {
  const store = await useTempData(t);
  await say("帮我记一下考研复习");
  const root = store.list()[0];
  await say("考研复习下面记一条学习专业课");
  const child = store.list().find((task) => task.title === "学习专业课");
  await say("学习专业课下面记一条背名词解释");
  const grandchild = store.list().find((task) => task.title === "背名词解释");

  assert.ok(child && child.parentId === root.id);
  assert.ok(grandchild && grandchild.parentId === child.id);

  const listed = await say("我有哪些任务？");
  assert.match(listed, /考研复习/);
  assert.match(listed, /  □ 10\d 学习专业课/);
  assert.match(listed, /    □ 10\d 背名词解释/);

  // 根任务完成，三层全部完成
  await say("考研复习做完了");
  assert.equal(store.list().every((task) => task.done), true);

  // 删除根任务，连带所有后代
  await say("考研复习删掉");
  assert.deepEqual(store.list(), []);
});

test("清单以纯文本勾选清单输出且带递增序号", async (t) => {
  await useTempData(t);
  await say("帮我记一下买牛奶");
  await say("再记一条取快递");
  const listed = await say("我有哪些任务？");
  assert.match(listed, /□ 101 买牛奶/);
  assert.match(listed, /□ 102 取快递/);
  assert.doesNotMatch(listed, /\|/);
});
