import { join } from "node:path";
import type { ChatMessage } from "../shared/chat.ts";
import { detectQuadrant } from "../shared/quadrants.ts";
import { replyWithModel } from "./agent-ml.ts";
import { createCheckInStore, createQuizStore } from "./checkin-store.ts";
import { setTaskDone } from "./task-completion.ts";
import { createJsonTaskStore } from "./task-store.ts";
import {
  addDays,
  clean,
  collectDescendants,
  EFFORT_LABEL,
  matchAll,
  matchTask,
  parseDate,
  parseEffort,
  parsePriority,
  PRIORITY_LABEL,
  stripFiller,
  stripMeta,
  formatChecklist,
  suggestNext,
  today,
  type Task,
} from "./task-model.ts";

export type { ChatMessage } from "../shared/chat.ts";

// 与 server/index.ts 里任务路由共用同一个 JSON 文件。
// 两个 store 实例都直接读写 data/tasks.json，每次操作都先读文件、原子写回，
// 因此这里自建一个指向同一文件的 store 即可，无需改动装配代码。
const tasks = createJsonTaskStore(join("data", "tasks.json"));
// 打卡记录与测验题独立存储，避免污染官方 tasks.json 的 schema
export const checkIns = createCheckInStore(join("data", "checkins.json"));
const quizzes = createQuizStore(join("data", "quizzes.json"));

// ---------- 关键词：意图判定 ----------

/** 完成类：买好了、做完了、搞定了……（长词放前面，优先整体匹配） */
const DONE_WORDS =
  /(买好了|买好|做完了|做完|完成了|完成|搞定了|搞定|做好了|做好|弄完了|弄完|办完了|办完|结束了|结束|已办|已完成|勾掉|打勾|办好了|办好)/;
/** 删除类 */
const DELETE_WORDS = /(删掉|删除|去掉|移除|不要了|删了|清理掉)/;
/** 查看类 */
const LIST_WORDS =
  /(有哪些|有什么|看看|看一下|看下|看清单|清单|待办|任务列表|列表|全部任务|所有任务|查看|显示)/;
/** 「今天到期」类 */
const DUE_TODAY_WORDS = /(到期|截止|今天有什么|今天有哪些|今天要做什么|今天要做的|今天的事)/;
/** 创建类：明确的“记/提醒/添加”动词才触发新增，避免把问候误建成任务 */
const CREATE_WORDS =
  /(帮我记一下|帮我记|记一下|记一条|再记|记个|记录一下|记录|提醒我|帮我提醒|添加|新增|加一条|加个待办|记待办|安排|列入)/;
/** 改标题类（只保留整体改名的说法，「改成」另有它用） */
const RENAME_WORDS = /(改名为|改名|改标题|重命名为|叫做|叫成)/;
/** 推迟类（「改到」用来承担改截止日期的说法） */
const POSTPONE_WORDS = /(推迟到|推迟|延后到|延后|延期到|延期|改到)/;
/** 撤销完成 */
const UNDO_WORDS = /(取消完成|撤销完成|还没做完|恢复成待办|恢复成未完成|重新打开)/;
/** 排程建议 */
const SUGGEST_WORDS = /(接下来该做什么|接下来做什么|先办哪个|先做哪个|先干什么|优先做|建议先做|先做哪|该先)/;

/** 创建前缀，用于从句子里剥掉指令、还原任务标题。 */
const CREATE_PREFIX =
  /^(请|帮我|麻烦)?(再)?(帮我)?(记一下|记一条|记个|记录一下|记录|提醒我|帮我提醒|添加一条|添加|新增一条|新增|加一条|加个待办|记待办|安排|列入|记)/;

const CREATE_EXTRA_PREFIX = /^(一下|一条|一个|个|个待办|待办|任务)/;

// ---------- 任务标题提取 ----------

/**
 * 把原始句子整理成「可直接当标题用」的形式：
 * 全角转半角 → 去空白 → 去标点（保留空格），这样 stripMeta 的正则才能按词工作。
 */
function normalize(raw: string): string {
  return (
    raw
      // 只把全角数字和字母转半角（全角标点保持原样，交给下一步统一清掉）
      .replace(/[\uFF10-\uFF19\uFF21-\uFF3A\uFF41-\uFF5A]/g, (char) =>
        String.fromCharCode(char.charCodeAt(0) - 0xfee0),
      )
      .replace(/[\u3000\t\r\n]/g, " ")
      .replace(/[，。！？、：:；;“”‘’「」()（）,.!?~～]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

/** 去掉创建类前缀后，还原任务标题；没有前缀返回 null。 */
function extractTitle(raw: string): string | null {
  const text = clean(stripMeta(normalize(raw)));
  if (!CREATE_WORDS.test(text)) return null;

  // 只保留第一个创建动词之后的内容，前面的「帮我」「再」等自然被丢掉。
  let rest = text.substring(text.search(CREATE_WORDS)).replace(CREATE_PREFIX, "");
  rest = rest.replace(CREATE_EXTRA_PREFIX, "");
  // 「还要记一条买牛奶」之类的续接说法
  rest = rest.replace(/^(再|还)(记|添加)?/, "");
  // 「高优先级的交报告」去掉修饰后常留下一个孤零零的「的」
  rest = rest.replace(/^(的|地|得)+/, "");
  return rest.length > 0 ? rest : null;
}

function describeMeta(task: Task): string {
  const parts: string[] = [];
  if (task.priority) parts.push(PRIORITY_LABEL[task.priority]);
  if (task.effort) parts.push(`工作量${EFFORT_LABEL[task.effort]}`);
  if (task.dueDate) parts.push(`截止 ${task.dueDate}`);
  return parts.length > 0 ? `（${parts.join(" · ")}）` : "";
}

// ---------- 清单展示 ----------

function formatList(all: Task[]): string {
  return formatChecklist(all);
}

/** 把多条候选任务列出来让用户确认。 */
function askWhich(candidates: Task[], action: string): string {
  const names = candidates.slice(0, 5).map((task) => `「${task.title}」`);
  return `找到了多条相似的任务：${names.join("、")}。你想${action}哪一条？把标题说得更完整一点就行。`;
}

// ---------- 主入口 ----------

export async function reply(messages: ChatMessage[]): Promise<string> {
  const last = messages.at(-1);
  const raw = last?.content ?? "";
  const text = clean(raw);

  // 优先走大模型（未配置 Key 或调用失败时会返回 null，回退到规则版）
  const fromModel = await replyWithModel(messages, { tasks, checkIns, quizzes });
  if (fromModel !== null) return fromModel;

  if (!text) return "你好，欢迎使用小明智能体！我可以帮你记待办、看清单、标记完成或删除。";

  const all = tasks.list();

  // 0) 撤销完成（要先于「完成」判断，否则「取消完成」会被当成完成）
  if (UNDO_WORDS.test(text)) {
    const snippet = stripFiller(text.replace(UNDO_WORDS, ""));
    const target = matchTask(snippet, all.filter((task) => task.done)) ?? matchTask(snippet, all);
    if (!target) return "我没找到要恢复的任务。先看看清单里有什么？";
    setTaskDone(tasks, target.id, false);
    return `已把「${target.title}」恢复成待办 ⏳`;
  }

  // 1) 删除
  if (DELETE_WORDS.test(text)) {
    return handleDelete(text, all);
  }

  // 2) 改标题
  if (RENAME_WORDS.test(text)) {
    return handleRename(text, all);
  }

  // 3) 推迟
  if (POSTPONE_WORDS.test(text)) {
    return handlePostpone(text, all);
  }

  // 4) 今天到期
  if (DUE_TODAY_WORDS.test(text) && !CREATE_WORDS.test(text)) {
    return handleDueToday(all, text);
  }

  // 5) 智能排程建议
  if (SUGGEST_WORDS.test(text)) {
    return suggestNext(all);
  }

  // 6) 标记完成
  if (DONE_WORDS.test(text)) {
    return handleDone(text, all);
  }

  // 7) 查看清单
  if (LIST_WORDS.test(text)) {
    return formatList(all);
  }

  // 8) 创建（必须命中明确的创建动词）
  if (CREATE_WORDS.test(clean(normalize(raw)))) {
    return handleCreate(raw, all);
  }

  // 兜底：没听懂时给出能力引导
  return "你好，欢迎使用小明智能体！我可以帮你：\n1. 记一条待办：帮我记一下买牛奶\n2. 查看清单：我有哪些任务？\n3. 标记完成：牛奶买好了\n4. 删除任务：取快递这条删掉吧\n还可以加优先级（「高优先级」）、工作量（「大工作量」）、日期（「明天」）和子任务（「买牛奶下记一条洗奶瓶」）。";
}

function handleDelete(text: string, all: Task[]): string {
  const snippet = stripFiller(stripMeta(text.replace(DELETE_WORDS, "")));
  const candidates = matchAll(snippet, all);
  if (candidates.length === 0) {
    return "我没找到要删除的任务。你可以先看看清单里都有什么。";
  }
  if (candidates.length > 2 && new Set(candidates.map((t) => t.title)).size > 1) {
    return askWhich(candidates, "删除");
  }
  const target = matchTask(snippet, all) ?? candidates[0];
  const children = collectDescendants(target.id, all);
  for (const child of children) tasks.remove(child.id);
  tasks.remove(target.id);
  return children.length > 0
    ? `已删除「${target.title}」以及它下面的 ${children.length} 条子任务。`
    : `已删除「${target.title}」。`;
}

function handleRename(text: string, all: Task[]): string {
  const body = normalize(text);
  const match = RENAME_WORDS.exec(body);
  if (!match) return "没听懂要改什么，试着说「买牛奶改名为买酸奶」。";

  const before = stripFiller(clean(stripMeta(body.slice(0, match.index))));
  const after = clean(stripMeta(body.slice(match.index + match[0].length)));
  const target = matchTask(before, all);
  if (!target) return "我没找到要改名的任务，先看看清单里有哪些吧。";
  if (!after) return "请告诉我改成什么名字，例如「买牛奶改名为买酸奶」。";

  tasks.update(target.id, { title: after });
  return `已把「${target.title}」改名为「${after}」。`;
}

function handlePostpone(text: string, all: Task[]): string {
  const body = normalize(text);
  const match = POSTPONE_WORDS.exec(body);
  if (!match) return "试着说「买牛奶推迟到明天」。";

  const before = stripFiller(clean(stripMeta(body.slice(0, match.index))));
  const after = body.slice(match.index + match[0].length);
  const target = matchTask(before, all) ?? (all.length === 1 ? all[0] : null);
  if (!target) return "我没找到要推迟的任务，先看看清单里有哪些吧。";

  const next = parseDate(after) ?? parseDate(text) ?? addDays(1);
  tasks.update(target.id, { dueDate: next });
  return `已把「${target.title}」推迟到 ${next}。`;
}

function handleDueToday(all: Task[], text: string): string {
  const date = parseDate(text) ?? today();
  const matched = all.filter((task) => !task.done && task.dueDate === date);
  const overdue = all.filter((task) => !task.done && task.dueDate && task.dueDate < date);
  if (matched.length === 0 && overdue.length === 0) {
    return `${date} 没有到期的待办。要不要我帮你记一条？`;
  }
  const sections: string[] = [];
  if (matched.length > 0) {
    sections.push(`${date} 到期的待办（${matched.length}）：\n${formatChecklist(matched)}`);
  }
  if (overdue.length > 0) {
    sections.push(`已经逾期还没做的（${overdue.length}）：\n${formatChecklist(overdue)}`);
  }
  return sections.join("\n\n");
}

function handleDone(text: string, all: Task[]): string {
  const snippet = stripFiller(stripMeta(text.replace(DONE_WORDS, "")));
  const open = all.filter((task) => !task.done);
  const candidates = matchAll(snippet, open);
  if (candidates.length > 2 && new Set(candidates.map((t) => t.title)).size > 1) {
    return askWhich(candidates, "标记完成");
  }
  const target =
    matchTask(snippet, open) ?? matchTask(snippet, all) ?? (open.length === 1 ? open[0] : null);
  if (!target) {
    return "我没找到对应的任务来标记完成。先看看清单，或换个说法告诉我是哪条。";
  }
  if (target.done) return `「${target.title}」已经是完成状态了 ✅ 不用再标记一次。`;
  const children = collectDescendants(target.id, all);
  setTaskDone(tasks, target.id, true);
  return children.length > 0
    ? `已把「${target.title}」标记为完成 ✅（${children.length} 条子任务也一并完成了）`
    : `已把「${target.title}」标记为完成 ✅`;
}

function handleCreate(raw: string, all: Task[]): string {
  const priority = parsePriority(raw) ?? undefined;
  const effort = parseEffort(raw) ?? undefined;
  const dueDate = parseDate(raw) ?? undefined;

  // 先看是不是「挂在某条任务下面」的子任务：拆出父任务和子任务正文
  const hint = findParent(raw, all);
  const body = hint ? hint.childBody : raw;
  const title = extractTitle(body);
  if (!title) return "你想记什么任务？例如「帮我记一下买牛奶」。";

  let parentId: string | undefined;
  if (hint) {
    if (clean(hint.parent.title) === clean(title)) {
      return `「${hint.parent.title}」已经在待办里了，不用重复记。`;
    }
    parentId = hint.parent.id;
  }

  const dup = all.find(
    (task) =>
      !task.done &&
      clean(task.title) === clean(title) &&
      (task.parentId ?? "") === (parentId ?? ""),
  );
  if (dup) return `「${dup.title}」已经在待办里了，不用重复记。`;

  const created = tasks.create(title, {
    priority,
    effort,
    dueDate,
    parentId,
    quadrant: detectQuadrant(raw),
  });
  const parentTask = parentId ? all.find((task) => task.id === parentId) : undefined;
  const suffix = parentTask ? `，是「${parentTask.title}」的子任务` : "";
  return `已记下「${created.title}」${describeMeta(created)}${suffix}。`;
}

/**
 * 「买牛奶下面记一条洗奶瓶」「给买牛奶加个子任务：洗奶瓶」这类说法。
 * childBody 是去掉父任务描述后的剩余句子，后面再交给 extractTitle 剥前缀。
 */
function findParent(
  raw: string,
  all: Task[],
): { parent: Task; childBody: string } | null {
  const text = normalize(raw);

  // 说法一：买牛奶下面记一条洗奶瓶 / 买牛奶下再记一条洗奶瓶
  const below = text.match(/^(.*?)(?:下面|底下|下)(.*)$/);
  if (below) {
    const parent = matchTask(stripFiller(clean(stripMeta(below[1]))), all);
    if (parent && CREATE_WORDS.test(below[2])) {
      return { parent, childBody: below[2] };
    }
  }

  // 说法二：给买牛奶加个子任务：洗奶瓶
  const subtask = text.match(/^.*(?:给|在|为)(.*?)加(?:一)?个子?任务[:：]?(.*)$/);
  if (subtask) {
    const parent = matchTask(stripFiller(clean(stripMeta(subtask[1]))), all);
    if (parent && subtask[2].trim()) {
      return { parent, childBody: subtask[2] };
    }
  }

  return null;
}
