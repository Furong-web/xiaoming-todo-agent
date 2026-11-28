/**
 * 任务历史记录。
 *
 * 历史记录 = 完成记录：任务被勾选完成的那一刻就写进 data/history.json，
 * 按「完成那天」归组。用户自己决定什么时候删，删不删都不影响历史。
 *
 * - 勾选完成 → 记录（同一条任务重复完成时按 taskId 覆盖更新）。
 * - 取消完成 → 撤掉记录，历史只保留真正完成过的。
 * - 删除任务 → 不动历史：完成过的留档，没完成过的本来就没有。
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { today } from "./task-model.ts";
import type { Task } from "./task-model.ts";

const recordSchema = z.looseObject({
  id: z.string(),
  taskId: z.string(),
  title: z.string(),
  /** 完成时刻（ISO 8601），极少数历史数据可能为空 */
  completedAt: z.string().optional(),
  /** 归属日期 YYYY-MM-DD，按完成时刻的本地日期算 */
  date: z.string(),
  parentId: z.string().optional(),
  parentTitle: z.string().optional(),
  module: z.string().optional(),
  category: z.string().optional(),
  priority: z.string().optional(),
  dueDate: z.string().optional(),
  location: z.string().optional(),
  quadrant: z.string().optional(),
  /** 记录写入时间 */
  recordedAt: z.string().optional(),
});

export type HistoryRecord = z.infer<typeof recordSchema>;

/** 记录只需要任务的部分字段，这里放宽类型，避免和存储层的宽松类型打架。 */
export type HistoryTask = Pick<Task, "id" | "title" | "done"> &
  Partial<Omit<Task, "id" | "title" | "done">>;

export interface HistoryStore {
  list(): HistoryRecord[];
  /** 勾选完成时调用；按 taskId 覆盖更新，重复勾选不会产生重复记录。 */
  recordCompletion(task: HistoryTask, all: HistoryTask[], now?: Date): HistoryRecord;
  /** 取消完成时调用，把这条任务的记录撤掉。 */
  withdraw(taskId: string): void;
}

const listSchema = z.array(recordSchema);

export function createHistoryStore(filename: string): HistoryStore {
  const list = () => (existsSync(filename) ? listSchema.parse(JSON.parse(readFileSync(filename, "utf8"))) : []);

  function save(records: HistoryRecord[]) {
    mkdirSync(dirname(filename), { recursive: true });
    const temporary = filename + ".tmp";
    writeFileSync(temporary, JSON.stringify(records, null, 2) + "\n");
    renameSync(temporary, filename);
  }

  return {
    list,

    recordCompletion(task, all, now = new Date()) {
      const records = list();
      const completedAt = task.completedAt;
      // 没有完成时刻时用当前时间兜底，保证一定能按日期归组
      const date = completedAt ? today(new Date(completedAt)) : today(now);

      const build = (): HistoryRecord => {
        const parent = task.parentId ? all.find((item) => item.id === task.parentId) : undefined;
        const existing = records.find((record) => record.taskId === task.id);
        return {
          id: existing?.id ?? randomUUID(),
          taskId: task.id,
          title: task.title,
          completedAt,
          date,
          parentId: task.parentId,
          parentTitle: parent?.title ?? existing?.parentTitle,
          module: typeof task.module === "string" ? task.module : existing?.module,
          category: typeof task.category === "string" ? task.category : existing?.category,
          priority: typeof task.priority === "string" ? task.priority : existing?.priority,
          dueDate: task.dueDate,
          location: task.location ?? existing?.location,
          quadrant: typeof task.quadrant === "string" ? task.quadrant : existing?.quadrant,
          recordedAt: now.toISOString(),
        };
      };

      const next = records.some((record) => record.taskId === task.id)
        ? records.map((record) => (record.taskId === task.id ? build() : record))
        : [...records, build()];
      save(next);
      return build();
    },

    withdraw(taskId) {
      const records = list();
      if (!records.some((record) => record.taskId === taskId)) return;
      save(records.filter((record) => record.taskId !== taskId));
    },
  };
}
