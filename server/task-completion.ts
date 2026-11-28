/**
 * 任务完成状态的父子联动（聊天路径、模型工具路径和 REST 路径共用）。
 *
 * 规则：
 * - 勾选父任务 → 所有后代（子、孙……）一起完成；取消同理。
 * - 子任务全部完成 → 父任务自动完成；任一子任务未完成 → 父任务回到待办。
 * - 向上回溯父链，支持无限层级。
 * - 完成时刻由服务端生成并写入 completedAt，取消完成时清除。
 *   已完成的任务重复勾选不会刷新时刻，避免把「刚才又点了一下」当成新的完成时间。
 */
import { collectDescendants } from "./task-model.ts";
import type { HistoryStore } from "./history-store.ts";
import type { TaskStore } from "./task-store.ts";

/**
 * 切换某任务的完成状态并联动整个家族树，返回更新后的该任务。
 * 找不到任务时返回 undefined。now 仅用于测试注入，生产环境一律取当前真实时间。
 * 传入 history 时，完成/取消完成会同步写/撤历史记录。
 */
export function setTaskDone(
  store: TaskStore,
  id: string,
  done: boolean,
  now: Date = new Date(),
  history?: HistoryStore,
) {
  const current = store.list().find((task) => task.id === id);
  if (!current) return undefined;

  // 同一批联动的任务共享同一个时刻；客户端无法传入或伪造这个字段。
  const stamp = now.toISOString();
  const mark = (taskId: string, value: boolean) => {
    const task = store.list().find((item) => item.id === taskId);
    if (!task || task.done === value) return;
    const updated = store.update(taskId, { done: value, completedAt: value ? stamp : undefined });
    if (!updated || !history) return;
    // 完成即进历史，取消完成就撤掉记录
    if (value) history.recordCompletion(updated, store.list(), now);
    else history.withdraw(taskId);
  };

  mark(id, done);

  // 向下：后代跟随
  for (const child of collectDescendants(id, store.list())) {
    if (child.done !== done) mark(child.id, done);
  }

  // 向上：逐层检查父任务
  let parentId: string | undefined =
    typeof current.parentId === "string" ? current.parentId : undefined;
  while (parentId) {
    const parent = store.list().find((task) => task.id === parentId);
    if (!parent) break;
    const siblings = store.list().filter((task) => task.parentId === parentId);
    const allDone = siblings.length > 0 && siblings.every((task) => task.done);
    if (parent.done !== allDone) mark(parentId, allDone);
    parentId = typeof parent.parentId === "string" ? parent.parentId : undefined;
  }

  return store.list().find((task) => task.id === id);
}
