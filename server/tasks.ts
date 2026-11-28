import { Router } from "express";
import { z } from "zod";
import type { CheckInStore } from "./checkin-store.ts";
import { setTaskDone } from "./task-completion.ts";
import type { TaskStore } from "./task-store.ts";

const createTaskSchema = z.strictObject({ title: z.string().trim().min(1).max(200) });
const updateTaskSchema = createTaskSchema
  .partial()
  .extend({ done: z.boolean().optional() })
  .refine((changes) => Object.keys(changes).length > 0);

const taskNotFound = { error: "找不到这条任务。" };

export function taskRouter(tasks: TaskStore, checkIns?: CheckInStore) {
  const router = Router();

  router.get("/", (_req, res) => {
    const all = tasks.list();
    if (!checkIns) return res.json(all);
    // 兼容加入 completedAt 之前完成的历史任务：用真实打卡记录补全完成时刻。
    // 只在响应里补，不落盘；没有记录就留空，前端仍显示短序号，绝不编造时间。
    const records = checkIns.list();
    return res.json(
      all.map((task) => {
        if (!task.done || task.completedAt) return task;
        const stamps = records
          .filter((item) => item.taskId === task.id)
          .map((item) => item.createdAt)
          .sort();
        const latest = stamps[stamps.length - 1];
        return latest ? { ...task, completedAt: latest } : task;
      }),
    );
  });

  router.post("/", (req, res) => {
    const input = createTaskSchema.safeParse(req.body);
    if (!input.success) {
      return res.status(400).json({ error: "请提供 1 至 200 个字符的任务标题。" });
    }
    res.status(201).json(tasks.create(input.data.title));
  });

  router.patch("/:id", (req, res) => {
    const input = updateTaskSchema.safeParse(req.body);
    if (!input.success) {
      return res.status(400).json({ error: "请提供有效的 title 或 done 字段。" });
    }

    // 只切换完成状态时，联动整个家族树（父→子、子→父）
    const updated =
      input.data.done !== undefined && Object.keys(input.data).length === 1
        ? setTaskDone(tasks, req.params.id, input.data.done)
        : tasks.update(req.params.id, input.data);
    if (!updated) return res.status(404).json(taskNotFound);
    res.json(updated);
  });

  router.delete("/:id", (req, res) => {
    if (!tasks.remove(req.params.id)) return res.status(404).json(taskNotFound);
    res.sendStatus(204);
  });

  return router;
}
