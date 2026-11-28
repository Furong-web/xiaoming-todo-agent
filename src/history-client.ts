/** 历史记录 REST API 的前端封装。 */
export interface HistoryRecord {
  id: string;
  taskId: string;
  title: string;
  /** 完成时刻（ISO 8601），老任务可能没有 */
  completedAt?: string;
  /** 归属日期 YYYY-MM-DD */
  date: string;
  parentTitle?: string;
  module?: string;
  category?: string;
  priority?: string;
  dueDate?: string;
  location?: string;
}

/** 按日期区间与关键词查询历史；参数为空表示不限制。 */
export async function listHistory(options: { from?: string; to?: string; q?: string } = {}) {
  const params = new URLSearchParams();
  if (options.from) params.set("from", options.from);
  if (options.to) params.set("to", options.to);
  if (options.q) params.set("q", options.q);
  const query = params.toString();

  const response = await fetch(`/api/history${query ? `?${query}` : ""}`);
  const body: unknown = await response.json();
  if (!response.ok) {
    if (typeof body === "object" && body !== null && "error" in body && typeof body.error === "string") {
      throw new Error(body.error);
    }
    throw new Error("历史记录加载失败，请重试。");
  }
  return body as HistoryRecord[];
}
