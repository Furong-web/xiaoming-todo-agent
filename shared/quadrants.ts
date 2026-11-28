/**
 * 四象限（艾森豪威尔矩阵）划分规则，前后端共用。
 *
 * - 显式 quadrant 优先：用户在对话里说「紧急重要」「不紧急但重要」时直接落库。
 * - 没写 quadrant 时按现有字段推断：紧急 = 截止日期在今天/明天/已逾期；
 *   重要 = 高优先级。两个维度独立，组合成四个象限。
 */
export const QUADRANTS = [
  { id: "urgent-important", label: "紧急且重要", hint: "立刻去做" },
  { id: "urgent-not-important", label: "紧急不重要", hint: "快速处理" },
  { id: "not-urgent-important", label: "不紧急但重要", hint: "排进计划" },
  { id: "not-urgent-not-important", label: "不紧急不重要", hint: "有空再说" },
] as const;

export type QuadrantId = (typeof QUADRANTS)[number]["id"];

export const QUADRANT_IDS: QuadrantId[] = QUADRANTS.map((quadrant) => quadrant.id);

export function isQuadrantId(value: unknown): value is QuadrantId {
  return typeof value === "string" && QUADRANT_IDS.includes(value as QuadrantId);
}

/** 从自然语言里识别象限。否定式短语放在前面，避免「不紧急不重要」被「紧急」抢先匹配。 */
const QUADRANT_WORDS: Array<{ pattern: RegExp; id: QuadrantId }> = [
  {
    pattern: /(不紧急[^，。\s]{0,4}不重要|不重要[^，。\s]{0,4}不紧急|既不紧急也不重要)/,
    id: "not-urgent-not-important",
  },
  {
    pattern: /(紧急[^，。\s]{0,4}不重要|不重要[^，。\s]{0,4}紧急|急但不重要|不重要的急事)/,
    id: "urgent-not-important",
  },
  {
    pattern: /(不紧急[^，。\s]{0,4}重要|重要[^，。\s]{0,4}不紧急|重要但不急|不急但重要)/,
    id: "not-urgent-important",
  },
  {
    pattern: /(紧急[^，。\s]{0,4}重要|重要[^，。\s]{0,4}紧急|又急又重要|又重要又急|第一象限)/,
    id: "urgent-important",
  },
];

export function detectQuadrant(text: string): QuadrantId | undefined {
  for (const { pattern, id } of QUADRANT_WORDS) {
    if (pattern.test(text)) return id;
  }
  return undefined;
}

export function quadrantFromFlags(urgent: boolean, important: boolean): QuadrantId {
  if (urgent && important) return "urgent-important";
  if (urgent) return "urgent-not-important";
  if (important) return "not-urgent-important";
  return "not-urgent-not-important";
}

export interface QuadrantInput {
  priority?: string;
  dueDate?: string;
  quadrant?: unknown;
}

/** 返回任务的「紧急 / 重要」两个维度。 */
export function quadrantFlags(task: QuadrantInput, now: Date = new Date()): {
  urgent: boolean;
  important: boolean;
} {
  if (isQuadrantId(task.quadrant)) {
    const id = task.quadrant;
    return {
      urgent: id === "urgent-important" || id === "urgent-not-important",
      important: id === "urgent-important" || id === "not-urgent-important",
    };
  }

  const day = (offset: number) => {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  };
  const tomorrow = day(1);
  // 逾期、今天、明天都算紧急；没有截止日期的不算紧急
  const urgent = Boolean(task.dueDate && task.dueDate <= tomorrow);
  const important = task.priority === "high";
  return { urgent, important };
}

export function classifyQuadrant(task: QuadrantInput, now: Date = new Date()): QuadrantId {
  const { urgent, important } = quadrantFlags(task, now);
  return quadrantFromFlags(urgent, important);
}
