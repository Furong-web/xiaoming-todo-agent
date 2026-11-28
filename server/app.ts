import { resolve } from "node:path";
import express, { type ErrorRequestHandler } from "express";
import { chatRequestSchema, type ChatMessage } from "../shared/chat.ts";
import type { CheckInStore } from "./checkin-store.ts";
import type { ConversationStore } from "./conversation-store.ts";
import { conversationsRouter } from "./conversations.ts";
import type { TaskStore } from "./task-store.ts";
import { taskRouter } from "./tasks.ts";

interface AppDependencies {
  reply(messages: ChatMessage[]): Promise<string>;
  tasks: TaskStore;
  /** 可选：用于给历史已完成任务补全真实打卡时刻 */
  checkIns?: CheckInStore;
  /** 可选：提供后，/api/chat 会把对话按会话持久化 */
  conversations?: ConversationStore;
}

export function createApp({ reply, tasks, checkIns, conversations }: AppDependencies) {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.post("/api/chat", async (req, res) => {
    const input = chatRequestSchema.safeParse(req.body);
    if (!input.success) {
      return res.status(400).json({ error: "请提供对话记录，并以用户消息结尾。" });
    }

    const conversationId = input.data.conversationId;
    const conversation = conversationId ? conversations?.get(conversationId) : undefined;
    if (conversationId && !conversation) {
      return res.status(404).json({ error: "会话不存在，请刷新后重试。" });
    }

    const answer = await reply(input.data.messages);

    // 会话模式下由服务端记录完整对话，消息时间也由服务端生成，前端不可伪造
    if (conversationId && conversations) {
      const last = input.data.messages.at(-1);
      if (last) {
        const stamp = new Date().toISOString();
        conversations.append(conversationId, [
          { role: "user", content: last.content, time: stamp },
          { role: "assistant", content: answer, time: new Date().toISOString() },
        ]);
      }
    }

    res.json({ reply: answer });
  });

  if (conversations) app.use("/api/conversations", conversationsRouter(conversations));
  app.use("/api/tasks", taskRouter(tasks, checkIns));
  app.use("/api", (_req, res) => res.status(404).json({ error: "接口不存在。" }));
  app.use(handleApiError);

  app.use(express.static(resolve("public")));
  app.get("/assets/chat.js", (_req, res) => res.sendFile(resolve("dist/chat.js")));
  return app;
}

const handleApiError: ErrorRequestHandler = (error, _req, res, _next) => {
  if (error.type === "entity.parse.failed") {
    return res.status(400).json({ error: "请求需要使用有效的 JSON。" });
  }
  if (error.type === "entity.too.large") {
    return res.status(413).json({ error: "对话太长，请刷新后开始新的对话。" });
  }
  console.error(error);
  res.status(500).json({ error: "服务暂时无法处理请求，请稍后重试。" });
};
