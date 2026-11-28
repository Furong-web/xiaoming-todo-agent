/**
 * 打卡记录与晚间测验的本地存储。
 *
 * - 打卡记录（checkins）：谁在什么时间、完成了哪条任务、学了什么模块、进度笔记。
 * - 测验（quizzes）：模型出的题目与标准答案，供用户作答后对照批改。
 *
 * 两者各自独立落盘到 data/checkins.json 与 data/quizzes.json，
 * 不污染官方 tasks.json（其 schema 由题目模板定义）。
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

// ---------- 打卡 ----------

const checkinSchema = z.looseObject({
  id: z.string(),
  taskId: z.string(),
  taskTitle: z.string(),
  /** 学习模块/科目，例如「数学」「英语」 */
  module: z.string().optional(),
  /** 任务类别：study=学习、life=生活琐事 */
  category: z.string().optional(),
  /** 进度笔记，例如「学到了极限的定义」 */
  note: z.string().optional(),
  /** 打卡时间（ISO 8601） */
  createdAt: z.string(),
  /** 打卡归属的本地日期 YYYY-MM-DD，便于按天聚合 */
  date: z.string(),
});
export type CheckIn = z.infer<typeof checkinSchema>;

/** 新增打卡需要的字段（id / createdAt / date 由 store 生成）。 */
export interface CheckInInput {
  taskId: string;
  taskTitle: string;
  module?: string;
  /** study=学习、life=生活琐事，用于复盘时不偏心 */
  category?: string;
  note?: string;
}

export interface CheckInStore {
  list(): CheckIn[];
  add(input: CheckInInput, now?: Date): CheckIn;
}

// ---------- 测验 ----------

const quizSchema = z.looseObject({
  id: z.string(),
  module: z.string().optional(),
  /** 题目正文 */
  question: z.string(),
  /** 标准答案与解析 */
  answer: z.string(),
  /** 用户作答 */
  response: z.string().optional(),
  /** 批改结果 */
  verdict: z.string().optional(),
  createdAt: z.string(),
  gradedAt: z.string().optional(),
});
export type Quiz = z.infer<typeof quizSchema>;

export interface QuizStore {
  list(): Quiz[];
  create(input: { module?: string; question: string; answer: string }, now?: Date): Quiz;
  /** 记录用户作答与批改结论 */
  grade(id: string, response: string, verdict: string, now?: Date): Quiz | undefined;
  latestUngraded(): Quiz | undefined;
}

function localDate(now: Date): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** 通用 JSON 读取，文件不存在时视为空数组。 */
function readJson<T>(filename: string, schema: z.ZodType<T[]>): T[] {
  if (!existsSync(filename)) return [];
  return schema.parse(JSON.parse(readFileSync(filename, "utf8")));
}

/** 通用 JSON 写入：先写临时文件再原子替换，避免半写损坏。 */
function writeJson(filename: string, value: unknown) {
  mkdirSync(dirname(filename), { recursive: true });
  const temporary = filename + ".tmp";
  writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n");
  renameSync(temporary, filename);
}

const checkinListSchema = z.array(checkinSchema);
const quizListSchema = z.array(quizSchema);

export function createCheckInStore(filename: string): CheckInStore {
  const list = () => readJson(filename, checkinListSchema);
  return {
    list,
    add(input: CheckInInput, now = new Date()) {
      const checkin: CheckIn = {
        taskId: input.taskId,
        taskTitle: input.taskTitle,
        module: input.module,
        category: input.category,
        note: input.note,
        id: randomUUID(),
        createdAt: now.toISOString(),
        date: localDate(now),
      };
      writeJson(filename, [...list(), checkin]);
      return checkin;
    },
  };
}

export function createQuizStore(filename: string): QuizStore {
  const list = () => readJson(filename, quizListSchema);
  const save = (quizzes: Quiz[]) => writeJson(filename, quizzes);

  return {
    list,
    create(input, now = new Date()) {
      const quiz: Quiz = {
        ...input,
        id: randomUUID(),
        createdAt: now.toISOString(),
      };
      save([...list(), quiz]);
      return quiz;
    },
    grade(id, response, verdict, now = new Date()) {
      const quizzes = list();
      const quiz = quizzes.find((item) => item.id === id);
      if (!quiz) return undefined;
      quiz.response = response;
      quiz.verdict = verdict;
      quiz.gradedAt = now.toISOString();
      save(quizzes);
      return quiz;
    },
    latestUngraded() {
      return [...list()].reverse().find((item) => !item.verdict);
    },
  };
}
