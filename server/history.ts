/**
 * 历史记录的查询接口。
 *
 * 只有两件事：按日期筛选、按关键词搜索。
 * 分组（尤其是「每七天一个文件夹」）交给前端做，服务端只负责返回干净的数据。
 */
import { Router } from "express";
import { z } from "zod";
import type { HistoryStore } from "./history-store.ts";

const querySchema = z.object({
  /** 起始日期 YYYY-MM-DD（含） */
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  /** 结束日期 YYYY-MM-DD（含） */
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  /** 关键词，匹配标题、所属父任务和模块 */
  q: z.string().trim().max(50).optional(),
});

export function historyRouter(history: HistoryStore) {
  const router = Router();

  router.get("/", (req, res) => {
    const input = querySchema.safeParse({
      from: typeof req.query.from === "string" ? req.query.from : undefined,
      to: typeof req.query.to === "string" ? req.query.to : undefined,
      q: typeof req.query.q === "string" ? req.query.q : undefined,
    });
    if (!input.success) {
      return res.status(400).json({ error: "日期格式应为 YYYY-MM-DD。" });
    }

    const { from, to, q } = input.data;
    const keyword = q?.toLowerCase();
    const records = history
      .list()
      // 日期按字符串比较即可，YYYY-MM-DD 天然可比
      .filter((record) => (!from || record.date >= from) && (!to || record.date <= to))
      .filter(
        (record) =>
          !keyword ||
          record.title.toLowerCase().includes(keyword) ||
          (record.parentTitle ?? "").toLowerCase().includes(keyword) ||
          (record.module ?? "").toLowerCase().includes(keyword),
      )
      // 新的在前，同一天内按完成时刻倒序
      .sort((a, b) => {
        if (a.date !== b.date) return a.date < b.date ? 1 : -1;
        return (b.completedAt ?? "").localeCompare(a.completedAt ?? "");
      });

    res.json(records);
  });

  return router;
}
