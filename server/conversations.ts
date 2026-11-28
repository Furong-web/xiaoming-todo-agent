import { Router } from "express";
import { z } from "zod";
import type { ConversationStore } from "./conversation-store.ts";

const renameSchema = z.strictObject({ title: z.string().trim().min(1).max(50) });
const createSchema = z.strictObject({ title: z.string().trim().min(1).max(50) });
const notFound = { error: "找不到这个会话。" };

/** 会话列表摘要：列表页不需要完整消息，减少传输量。 */
function summarize(conversation: {
  id: string;
  title: string;
  updatedAt: string;
  messages: unknown[];
}) {
  return {
    id: conversation.id,
    title: conversation.title,
    // 侧边栏展示的「最近提问」，让用户不点开也能看到具体问了什么
    preview: lastQuestionPreview(conversation.messages),
    updatedAt: conversation.updatedAt,
    messageCount: conversation.messages.length,
  };
}

/** 最近一条用户消息，压成单行并截断；没有用户消息时返回 undefined。 */
function lastQuestionPreview(messages: unknown[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (typeof message !== "object" || message === null) continue;
    if (!("role" in message) || !("content" in message)) continue;
    const candidate = message as { role: unknown; content: unknown };
    if (candidate.role !== "user" || typeof candidate.content !== "string") continue;
    const text = candidate.content.replace(/\s+/g, " ").trim();
    if (text) return text.slice(0, 40);
  }
  return undefined;
}

export function conversationsRouter(store: ConversationStore) {
  const router = Router();

  // 最近更新的会话排在最前，侧边栏直接按此顺序渲染
  router.get("/", (_req, res) => {
    const items = [...store.list()]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(summarize);
    res.json(items);
  });

  router.post("/", (req, res) => {
    const input = createSchema.safeParse(req.body);
    if (!input.success) {
      return res.status(400).json({ error: "会话标题需要 1 至 50 个字符。" });
    }
    res.status(201).json(store.create(input.data.title));
  });

  router.get("/:id", (req, res) => {
    const conversation = store.get(req.params.id);
    if (!conversation) return res.status(404).json(notFound);
    res.json(conversation);
  });

  router.patch("/:id", (req, res) => {
    const input = renameSchema.safeParse(req.body);
    if (!input.success) {
      return res.status(400).json({ error: "会话标题需要 1 至 50 个字符。" });
    }
    const renamed = store.rename(req.params.id, input.data.title);
    if (!renamed) return res.status(404).json(notFound);
    res.json(summarize(renamed));
  });

  router.delete("/:id", (req, res) => {
    if (!store.remove(req.params.id)) return res.status(404).json(notFound);
    res.sendStatus(204);
  });

  return router;
}
