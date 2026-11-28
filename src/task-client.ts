/** 任务 REST API 的前端封装，供清单卡片视图使用。 */
import type { QuadrantId } from "../shared/quadrants.ts";

export interface Task {
  id: string;
  title: string;
  done: boolean;
  /** 服务端生成的完成时刻（ISO 8601），只有真正记录过的任务才有 */
  completedAt?: string;
  priority?: "high" | "medium" | "low";
  effort?: "small" | "medium" | "large";
  dueDate?: string;
  parentId?: string;
  quadrant?: QuadrantId;
}

async function parseResponse<T>(response: Response): Promise<T> {
  const body: unknown = await response.json();
  if (!response.ok) {
    if (typeof body === "object" && body !== null && "error" in body && typeof body.error === "string") {
      throw new Error(body.error);
    }
    throw new Error("操作失败，请重试。");
  }
  return body as T;
}

export async function listTasks(): Promise<Task[]> {
  const response = await fetch("/api/tasks");
  return parseResponse<Task[]>(response);
}

export async function updateTask(id: string, changes: { done: boolean }): Promise<Task> {
  const response = await fetch(`/api/tasks/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(changes),
  });
  return parseResponse<Task>(response);
}

export async function deleteTask(id: string): Promise<void> {
  const response = await fetch(`/api/tasks/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!response.ok) throw new Error("删除失败，请重试。");
}
