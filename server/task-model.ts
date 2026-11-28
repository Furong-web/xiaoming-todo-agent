import type { QuadrantId } from "../shared/quadrants.ts";

/**
 * 任务的数据模型与文本解析工具。
 *
 * 存储层（task-store.ts）用的是 z.looseObject，会原样保留额外字段，
 * 因此这里定义的扩展字段（priority / effort / dueDate / parentId）不需要改存储层，
 * 创建时把这些字段一起写进 JSON 即可。
 */

export interface Task {
  id: string;
  title: string;
  done: boolean;
  /** 扩展字段：完成时刻（ISO 8601），仅由服务端在勾选完成时生成，取消完成则清除 */
  completedAt?: string;
  /** 扩展字段：四象限归类，用户显式指定；未指定时按 priority/dueDate 自动推断 */
  quadrant?: QuadrantId;
  /** 扩展字段：优先级 */
  priority?: Priority;
  /** 扩展字段：工作量 */
  effort?: Effort;
  /** 扩展字段：截止日期，YYYY-MM-DD（按 Asia/Shanghai 本地日期） */
  dueDate?: string;
  /** 扩展字段：父任务 id，支持无限层级 */
  parentId?: string;
  /** 扩展字段：学习模块/科目，用于按模块统计进度，例如「数学」「英语」 */
  module?: string;
  /** 扩展字段：任务类别，study=学习、life=生活琐事 */
  category?: TaskCategory;
  /** 扩展字段：周期性习惯（daily=每天、weekly=每周），无则是一次性任务 */
  repeat?: RepeatRule;
  /** 扩展字段：任务涉及的地点，用于动线优化，例如「超市」「驿站」 */
  location?: string;
}

export type TaskCategory = "study" | "life";
export type RepeatRule = "daily" | "weekly";

export const CATEGORY_LABEL: Record<TaskCategory, string> = {
  study: "学习",
  life: "生活",
};

export const REPEAT_LABEL: Record<RepeatRule, string> = {
  daily: "每天",
  weekly: "每周",
};

/** 生活琐事关键词：用于区分「繁重学习」和「日常杂事」。 */
const LIFE_KEYWORDS =
  /(快递|取件|驿站|超市|买菜|购物|洗衣|洗衣服|晾衣|倒垃圾|扔垃圾|喝牛奶|喝水|喝|牛奶|早餐|午餐|晚餐|做饭|洗澡|理发|缴费|交费|水电|房租|银行卡|银行|挂号|买药|体检|打扫|收拾|整理房间|遛狗|喂猫|接孩子|送孩子|地铁|公交|加油|修|换|取|买)/;

/** 判断任务属于学习还是生活，默认按是否命中科目/生活关键词推断。 */
export function detectCategory(text: string): TaskCategory {
  if (detectModule(text)) return "study";
  if (LIFE_KEYWORDS.test(text)) return "life";
  return "study";
}

/**
 * 识别周期性习惯。
 * 只有同时出现「日常性表达 + 习惯动词」才算，避免把普通任务误判为每日重复。
 */
export function detectRepeat(text: string): RepeatRule | undefined {
  if (/(每天|每日|天天|Daily)/i.test(text)) return "daily";
  if (/(每周|每星期|Weekly)/i.test(text)) return "weekly";
  return undefined;
}

/** 常见备考科目关键词，用于把任务归到模块。 */
const MODULE_KEYWORDS: Array<{ module: string; pattern: RegExp }> = [
  { module: "数学", pattern: /(数学|高数|线代|线性代数|概率论|微积分)/ },
  { module: "英语", pattern: /(英语|单词|词汇|阅读理解|完形|作文模板|四六级|雅思|托福)/ },
  { module: "政治", pattern: /(政治|马原|毛中特|史纲|思修|时政)/ },
  { module: "专业课", pattern: /(专业课|专业综合|名词解释|真题|导师)/ },
  { module: "语文", pattern: /(语文|申论|行测|公文写作)/ },
];

/** 从标题或原话里识别学习模块，识别不出返回 undefined。 */
export function detectModule(text: string): string | undefined {
  for (const { module, pattern } of MODULE_KEYWORDS) {
    if (pattern.test(text)) return module;
  }
  return undefined;
}

/**
 * 常见地点关键词。顺序有意义：更具体的匹配放在前面。
 * 用于动线规划——把同一地点的任务归组，减少来回跑。
 */
const LOCATION_KEYWORDS: Array<{ location: string; pattern: RegExp }> = [
  { location: "驿站", pattern: /(驿站|快递点|菜鸟|丰巢|取快递|拿快递)/ },
  { location: "超市", pattern: /(超市|菜市场|买菜|生鲜|便利店)/ },
  { location: "公司", pattern: /(公司|办公室|开会|工位|上班|客户)/ },
  { location: "银行", pattern: /(银行|柜台|ATM)/ },
  { location: "医院", pattern: /(医院|诊所|挂号|看病|体检|牙科)/ },
  { location: "药店", pattern: /(药店|买药)/ },
  { location: "邮局", pattern: /(邮局|寄件|寄快递)/ },
  { location: "健身房", pattern: /(健身房|健身|游泳馆|运动馆)/ },
  { location: "学校", pattern: /(学校|图书馆|自习室|教室|上课)/ },
  { location: "家", pattern: /(家里|在家|回家|楼下|小区)/ },
];

/** 从任务标题里识别地点，识别不出返回 undefined。 */
export function detectLocation(text: string): string | undefined {
  for (const { location, pattern } of LOCATION_KEYWORDS) {
    if (pattern.test(text)) return location;
  }
  return undefined;
}

export type Priority = "high" | "medium" | "low";
export type Effort = "small" | "medium" | "large";

export const PRIORITY_LABEL: Record<Priority, string> = {
  high: "高优先级",
  medium: "中优先级",
  low: "低优先级",
};

export const EFFORT_LABEL: Record<Effort, string> = {
  small: "小",
  medium: "中",
  large: "大",
};

const PRIORITY_RANK: Record<Priority, number> = { high: 0, medium: 1, low: 2 };

// ---------- 文本小工具 ----------

/** 去掉空白和常见标点，便于匹配。 */
export function clean(text: string): string {
  return text
    .replace(/[\s，。！？、：:；;“”‘’「」()（）?？,.!~～]/g, "")
    .trim();
}

/** 全角数字/字母转半角，避免「２条」之类识别不到。 */
function normalizeWidth(text: string): string {
  return text
    .replace(/[\uFF01-\uFF5E]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, " ");
}

/** 去掉语气词、指代词，用于语义匹配。 */
export function stripFiller(text: string): string {
  return text
    .replace(/[了吧呢啊哦呀嘛哈]/g, "")
    .replace(/(这条|那条|这个|那个|这个任务|那个任务|任务)/g, "");
}

// ---------- 日期解析 ----------

function formatDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** 相对今天偏移若干天（本地时间，避免 UTC 时区错位）。 */
export function today(now: Date = new Date()): string {
  return formatDate(now);
}

export function addDays(days: number, now: Date = new Date()): string {
  const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + days);
  return formatDate(date);
}

const WEEKDAY_INDEX: Record<string, number> = {
  日: 0,
  天: 0,
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
};

/** 解析「今天/明天/后天/周五/下周一/3月5日」为 YYYY-MM-DD。 */
export function parseDate(text: string, now: Date = new Date()): string | null {
  const value = normalizeWidth(text);
  if (/今天|今日|当天/.test(value)) return addDays(0, now);
  if (/后天/.test(value)) return addDays(2, now);
  if (/明天|明日/.test(value)) return addDays(1, now);

  const weekday = value.match(/(下)?(?:周|星期|礼拜)([一二三四五六日天])/);
  if (weekday) {
    const target = WEEKDAY_INDEX[weekday[2]];
    const current = now.getDay();
    // 「周三」：本周内（含今天）的最近一次
    const offset = (target - current + 7) % 7;
    if (!weekday[1]) return addDays(offset, now);

    // 「下周三」：下一个自然周的周三。以本周一为 -((current+6)%7) 天，
    // 则下周一 = 本周一 + 7，周三再往后 (target+6)%7 天。
    const daysFromMonday = (current + 6) % 7;
    const nextMonday = 7 - daysFromMonday;
    return addDays(nextMonday + ((target + 6) % 7), now);
  }

  const monthDay = value.match(/(\d{1,2})月(\d{1,2})[日号]?/);
  if (monthDay) {
    const month = Number(monthDay[1]) - 1;
    const day = Number(monthDay[2]);
    const candidate = new Date(now.getFullYear(), month, day);
    if (candidate < new Date(now.getFullYear(), now.getMonth(), now.getDate())) {
      candidate.setFullYear(candidate.getFullYear() + 1);
    }
    return formatDate(candidate);
  }

  const iso = value.match(/\d{4}-\d{1,2}-\d{1,2}/);
  if (iso) {
    const [year, month, day] = iso[0].split("-").map(Number);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return formatDate(new Date(year, month - 1, day));
    }
  }
  return null;
}

// ---------- 优先级 / 工作量解析 ----------

const HIGH_WORDS = /(高优先级|重要|紧急|加急|优先)/;
const LOW_WORDS = /(低优先级|不着急|不紧急|有空再|闲了再)/;
const EFFORT_LARGE = /(大工作量|大工程|工作量大|工作量是大)/;
const EFFORT_SMALL = /(小工作量|小工程|工作量大?小|很快能做完?)/;
const EFFORT_MEDIUM = /(中工作量|中等工作量|工作量中等)/;

export function parsePriority(text: string): Priority | null {
  if (LOW_WORDS.test(text)) return "low";
  if (HIGH_WORDS.test(text)) return "high";
  if (/中优先级/.test(text)) return "medium";
  return null;
}

export function parseEffort(text: string): Effort | null {
  if (EFFORT_LARGE.test(text)) return "large";
  if (EFFORT_SMALL.test(text)) return "small";
  if (EFFORT_MEDIUM.test(text)) return "medium";
  return null;
}

/**
 * 从原始消息里剥掉「高优先级」「大工作量」「明天截止」这类修饰，
 * 避免它们混进任务标题。只剥修饰本身，不动任务正文。
 */
export function stripMeta(raw: string): string {
  return raw
    // 象限短语要整段先剥，避免「不紧急不重要」被后面的「重要/紧急」拆成碎片残留在标题里
    .replace(
      /(既不紧急也不重要|不紧急[^，。\s]{0,4}不重要|不重要[^，。\s]{0,4}不紧急|紧急[^，。\s]{0,4}不重要|不重要[^，。\s]{0,4}紧急|急但不重要|不紧急[^，。\s]{0,4}重要|重要[^，。\s]{0,4}不紧急|重要但不急|不急但重要|紧急[^，。\s]{0,4}重要|重要[^，。\s]{0,4}紧急|又急又重要|又重要又急|第一象限)[的得地]?/g,
      "",
    )
    .replace(/[（(【[]?\s*(高优先级|中优先级|低优先级|重要|紧急|加急)\s*[）)】\]]?/g, "")
    .replace(/[（(【[]?\s*(大工作量|中工作量|小工作量|工作量[大小中])\s*[）)】\]]?/g, "")
    .replace(/\d{4}-\d{1,2}-\d{1,2}/g, "")
    .replace(/\d{1,2}月\d{1,2}[日号]?/g, "")
    .replace(/(下周|周|星期|礼拜)[一二三四五六日天]/g, "")
    .replace(/(今天|今日|当天|明天|明日|后天)(之前|以前|前|截止|到期)?/g, "")
    .replace(/(截止|到期)\s*(之前|以前|前|当天)?/g, "");
}

// ---------- 任务匹配 ----------

/**
 * 在候选任务里按语义找最匹配的一条。
 * 完全相等 100，标题包含片段 60，片段包含标题 50；并列时取更早创建的那条。
 */
export function matchTask(snippet: string, candidates: Task[]): Task | null {
  const text = clean(snippet);
  if (!text) return null;

  const scored = candidates
    .map((task) => {
      const title = clean(task.title);
      let score = 0;
      if (title === text) score += 100;
      if (title.includes(text)) score += 60;
      if (text.includes(title)) score += 50;
      return { task, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);

  return scored[0]?.task ?? null;
}

/** 找出所有匹配的任务，用于「多条相似任务先反问」。 */
export function matchAll(snippet: string, candidates: Task[]): Task[] {
  const text = clean(snippet);
  if (!text) return [];
  return candidates.filter((task) => {
    const title = clean(task.title);
    return title === text || title.includes(text) || text.includes(title);
  });
}

// ---------- 排序 ----------

/** 未完成优先、截止日期早的在前、高优先级在前、其余保持创建顺序。 */
export function sortForDisplay(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1;
    const dueA = a.dueDate ?? "9999-99-99";
    const dueB = b.dueDate ?? "9999-99-99";
    if (dueA !== dueB) return dueA < dueB ? -1 : 1;
    return (PRIORITY_RANK[a.priority ?? "medium"] ?? 1) - (PRIORITY_RANK[b.priority ?? "medium"] ?? 1);
  });
}

export function isParent(task: Task): boolean {
  return !task.parentId;
}

// ---------- 无限层级遍历 ----------

/** 按「先父后子」的深度优先顺序展开，返回 { task, depth }，depth 从 0 开始。 */
export function flattenTree(all: Task[]): Array<{ task: Task; depth: number }> {
  const byId = new Map(all.map((task) => [task.id, task]));
  const childrenOf = (id: string) => all.filter((task) => task.parentId === id);
  const result: Array<{ task: Task; depth: number }> = [];

  const visit = (task: Task, depth: number) => {
    result.push({ task, depth });
    for (const child of childrenOf(task.id)) visit(child, depth + 1);
  };

  // 根任务（无 parentId），以及父任务缺失的孤儿任务也按根处理
  for (const task of all) {
    if (!task.parentId) visit(task, 0);
  }
  for (const task of all) {
    if (task.parentId && !byId.has(task.parentId)) visit(task, 0);
  }
  return result;
}

/** 返回某任务的所有后代（含子、孙……），用于删除/完成联动。 */
export function collectDescendants(rootId: string, all: Task[]): Task[] {
  const result: Task[] = [];
  const walk = (id: string) => {
    for (const child of all.filter((task) => task.parentId === id)) {
      result.push(child);
      walk(child.id);
    }
  };
  walk(rootId);
  return result;
}

// ---------- 展示：短序号 + 纯文本分组清单 ----------

const PRIORITY_EMOJI: Record<Priority, string> = { high: "🔴", medium: "🟡", low: "🟢" };
const PRIORITY_SHORT: Record<Priority, string> = { high: "高", medium: "中", low: "低" };

/** 给当前列表里的任务分配 101、102、103…… 递增展示序号（先父后子）。 */
export function assignDisplayIds(all: Task[]): Map<string, number> {
  const map = new Map<string, number>();
  let counter = 100;
  for (const { task } of flattenTree(all)) {
    counter += 1;
    map.set(task.id, counter);
  }
  return map;
}

function priorityTag(task: Task): string {
  if (!task.priority) return "";
  return ` ${PRIORITY_EMOJI[task.priority]}${PRIORITY_SHORT[task.priority]}`;
}

function dueTag(task: Task): string {
  if (!task.dueDate) return "";
  if (!task.done && task.dueDate < today()) return ` · ⚠️逾期 ${task.dueDate}`;
  return ` · 截止 ${task.dueDate}`;
}

/**
 * 以纯文本分组清单展示任务（前端不渲染 Markdown，用 □/☑ 方框和缩进实现勾选清单观感）：
 * - 根任务作为分组标题，带子任务数量
 * - 每行用 □(待办)/☑(已完成) 方框 + 展示序号 + 标题
 * - 子任务按层级缩进 2 个空格，支持无限层级
 */
export function formatChecklist(all: Task[]): string {
  if (all.length === 0) {
    return "你的清单还是空的，说一句「帮我记一下买牛奶」就能添加。";
  }

  const ids = assignDisplayIds(all);
  const lines: string[] = [];
  const roots = all.filter((task) => !task.parentId || !all.some((p) => p.id === task.parentId));
  const childrenOf = (id: string) => all.filter((task) => task.parentId === id);

  for (const root of roots) {
    const children = childrenOf(root.id);
    const openChildren = children.filter((task) => !task.done).length;
    const count = children.length > 0 ? `（${openChildren}/${children.length}）` : "";
    lines.push(
      `📌 ${root.done ? "☑" : "□"} ${ids.get(root.id)} ${root.title}${count}${priorityTag(root)}${dueTag(root)}`,
    );

    const render = (parentId: string, depth: number) => {
      const indent = "  ".repeat(depth);
      for (const child of childrenOf(parentId)) {
        lines.push(
          `${indent}${child.done ? "☑" : "□"} ${ids.get(child.id)} ${child.title}${priorityTag(child)}${dueTag(child)}`,
        );
        render(child.id, depth + 1);
      }
    };
    render(root.id, 1);
    lines.push("");
  }

  const open = all.filter((task) => !task.done).length;
  lines.push(open === 0 ? "太棒了，待办都清空了 🎉" : `还有 ${open} 条待办没完成。`);
  return lines.join("\n");
}

/** 兼容旧调用名（规则版/模型版都改用 formatChecklist）。 */
export const toMarkdownTable = formatChecklist;

/** 排程建议：逾期任务 > 高优先级 > 截止日期临近。 */
export function suggestNext(all: Task[]): string {
  const open = all.filter((task) => !task.done);
  if (open.length === 0) return "太棒了，待办都清空了 🎉 现在可以放松一下。";

  const overdue = open
    .filter((task) => task.dueDate && task.dueDate < today())
    .sort((a, b) => (a.dueDate ?? "").localeCompare(b.dueDate ?? ""));
  if (overdue.length > 0) {
    const top = overdue[0];
    return `建议先处理已逾期的「${top.title}」（截止 ${top.dueDate}），它已经超期了，优先级最高。`;
  }

  const ranked = [...open].sort((a, b) => {
    const pa = a.priority ?? "medium";
    const pb = b.priority ?? "medium";
    if (pa !== pb) return PRIORITY_RANK[pa] - PRIORITY_RANK[pb];
    return (a.dueDate ?? "9999-99-99").localeCompare(b.dueDate ?? "9999-99-99");
  });
  const top = ranked[0];
  if (top.priority === "high") {
    return `建议先做高优先级的「${top.title}」${top.dueDate ? `（截止 ${top.dueDate}）` : ""}，其余可稍后处理。`;
  }
  if (top.dueDate) {
    return `建议先做「${top.title}」，它截止日期最近（${top.dueDate}）。`;
  }
  return `建议先做「${top.title}」，其余任务暂时没有明确优先级或截止日期。`;
}
