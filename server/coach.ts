/**
 * 备考教练的统计能力：把任务、打卡记录聚合成「某一天学到了什么」。
 *
 * 提供给 generate_daily_summary 工具使用：模型拿到结构化数据后，
 * 按设定里的开场白模板组织语言，做到「早上记得昨天干了啥」。
 */
import type { CheckIn } from "./checkin-store.ts";
import { addDays, detectLocation, type Task } from "./task-model.ts";

export interface ModuleProgress {
  module: string;
  /** 当天该模块打卡次数 */
  checkIns: number;
  /** 进度笔记摘要 */
  notes: string[];
}

export interface DailySummary {
  date: string;
  /** 口径：打卡记录条数（即当天实际完成的子任务数） */
  completedCount: number;
  /** 当天打卡涉及的任务标题 */
  completedTasks: string[];
  /** 按模块聚合的学习进度 */
  modules: ModuleProgress[];
  /** 当天应完成但未完成的待办（截止日期是这天且未完成） */
  overdue: Array<{ title: string; module?: string }>;
  /** 当天的学习记录明细 */
  checkIns: Array<{ taskTitle: string; module?: string; note?: string; time: string }>;
  /** 学习类完成数（不偏心学习时用于平衡评价） */
  studyCount: number;
  /** 生活类完成数 */
  lifeCount: number;
}

/**
 * 生成某天的复盘数据。
 * @param date 目标日期 YYYY-MM-DD
 * @param tasks 全量任务
 * @param checkIns 全量打卡记录
 */
export function buildDailySummary(date: string, tasks: Task[], checkIns: CheckIn[]): DailySummary {
  const dayCheckIns = checkIns.filter((item) => item.date === date);

  // 按模块聚合
  const byModule = new Map<string, ModuleProgress>();
  for (const item of dayCheckIns) {
    const module = item.module ?? "未分类";
    const entry = byModule.get(module) ?? { module, checkIns: 0, notes: [] };
    entry.checkIns += 1;
    if (item.note) entry.notes.push(item.note);
    byModule.set(module, entry);
  }

  // 按类别统计：打卡记录里存了 category，没有就按模块判断
  let studyCount = 0;
  let lifeCount = 0;
  for (const item of dayCheckIns) {
    const isLife = item.category === "life" || (!item.module && item.category !== "study");
    if (isLife) lifeCount += 1;
    else studyCount += 1;
  }

  const overdue = tasks
    .filter((task) => !task.done && task.dueDate === date)
    .map((task) => ({ title: task.title, module: task.module }));

  return {
    date,
    completedCount: dayCheckIns.length,
    completedTasks: [...new Set(dayCheckIns.map((item) => item.taskTitle))],
    modules: [...byModule.values()],
    overdue,
    checkIns: dayCheckIns.map((item) => ({
      taskTitle: item.taskTitle,
      module: item.module,
      note: item.note,
      time: item.createdAt,
    })),
    studyCount,
    lifeCount,
  };
}

/** 把相对日期（昨天/今天/前天）换算成 YYYY-MM-DD，也接受原样 YYYY-MM-DD。 */
export function resolveSummaryDate(input: string, now: Date = new Date()): string {
  const text = input.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  if (/前天/.test(text)) return addDays(-2, now);
  if (/昨天|昨日/.test(text)) return addDays(-1, now);
  return addDays(0, now);
}

// ---------- 生活管家：动线规划 ----------

export interface RouteStop {
  /** 地点，例如「驿站」「超市」；识别不出地点的记为「无需外出」 */
  location: string;
  /** 该地点下需要办的事 */
  tasks: Array<{ title: string; dueDate?: string; priority?: string }>;
}

export interface RoutePlan {
  /** 建议的出行顺序：按「顺路程度」粗排，驿站/超市这类会顺路的地点在一起 */
  stops: RouteStop[];
  /** 同一地点可合并处理的事项数 */
  mergeable: number;
  /** 需要外出的地点数 */
  outdoorStops: number;
}

/**
 * 把未完成的生活类任务按地点聚合，生成出行动线建议。
 * 不依赖具体地图数据，只做「同类合并 + 顺路归组」的结构化整理，
 * 具体的路线话术由模型根据 stops 组织。
 */
export function buildRoutePlan(tasks: Task[]): RoutePlan {
  const open = tasks.filter((task) => !task.done);
  const byLocation = new Map<string, RouteStop>();

  for (const task of open) {
    const location = task.location || detectLocation(task.title) || "无需外出";
    const stop = byLocation.get(location) ?? { location, tasks: [] };
    stop.tasks.push({
      title: task.title,
      dueDate: task.dueDate,
      priority: task.priority,
    });
    byLocation.set(location, stop);
  }

  const stops = [...byLocation.values()];
  // 「无需外出」的琐事放最后，优先处理要出门的
  stops.sort((a, b) => {
    if (a.location === "无需外出") return 1;
    if (b.location === "无需外出") return -1;
    return b.tasks.length - a.tasks.length;
  });

  const outdoorStops = stops.filter((stop) => stop.location !== "无需外出").length;
  const mergeable = stops.reduce((sum, stop) => sum + Math.max(0, stop.tasks.length - 1), 0);

  return { stops, mergeable, outdoorStops };
}

// ---------- 生活管家：周期性习惯 ----------

export interface HabitStatus {
  title: string;
  repeat: string;
  /** 连续打卡天数（含今天往前推，遇到断档就停） */
  streak: number;
  /** 昨天是否打卡 */
  doneYesterday: boolean;
  /** 今天是否已打卡 */
  doneToday: boolean;
}

/**
 * 计算周期性习惯的连续打卡情况，供「昨天你喝了牛奶，今天继续保持」这类话术使用。
 */
export function buildHabits(
  tasks: Task[],
  checkIns: CheckIn[],
  now: Date = new Date(),
): HabitStatus[] {
  const todayDate = addDays(0, now);
  const doneByDate = new Map<string, Set<string>>();
  for (const item of checkIns) {
    const set = doneByDate.get(item.date) ?? new Set<string>();
    // 用任务标题作为习惯标识，避免同名任务重建后 id 变化
    set.add(item.taskTitle);
    doneByDate.set(item.date, set);
  }

  return tasks
    .filter((task) => task.repeat)
    .map((task) => {
      const key = task.title;
      let streak = 0;
      for (let offset = 0; offset < 365; offset += 1) {
        const date = addDays(-offset, now);
        if (doneByDate.get(date)?.has(key)) streak += 1;
        else break;
      }
      const yesterday = addDays(-1, now);
      return {
        title: task.title,
        repeat: task.repeat as string,
        streak,
        doneYesterday: doneByDate.get(yesterday)?.has(key) ?? false,
        doneToday: doneByDate.get(todayDate)?.has(key) ?? false,
      };
    });
}

/** 明确给出可推荐给用户的今日候选任务：未完成且截止最近。 */
export function recommendTasks(tasks: Task[], limit = 3): Task[] {
  return tasks
    .filter((task) => !task.done)
    .sort((a, b) => {
      const dueA = a.dueDate ?? "9999-99-99";
      const dueB = b.dueDate ?? "9999-99-99";
      if (dueA !== dueB) return dueA < dueB ? -1 : 1;
      const rank = { high: 0, medium: 1, low: 2 };
      return rank[(a.priority ?? "medium") as keyof typeof rank] -
        rank[(b.priority ?? "medium") as keyof typeof rank];
    })
    .slice(0, limit);
}
