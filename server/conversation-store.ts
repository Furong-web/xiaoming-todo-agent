/**
 * 多会话的本地存储。
 *
 * 每个会话独立保存标题与完整消息列表，落盘到 data/conversations.json，
 * 刷新页面或换设备都能恢复历史对话。消息时间由服务端生成，前端不可伪造。
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

const messageSchema = z.looseObject({
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  /** 消息时间（ISO 8601），服务端生成 */
  time: z.string().optional(),
});
export type ConversationMessage = z.infer<typeof messageSchema>;

const conversationSchema = z.looseObject({
  id: z.string(),
  title: z.string(),
  messages: z.array(messageSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Conversation = z.infer<typeof conversationSchema>;

export interface ConversationStore {
  list(): Conversation[];
  get(id: string): Conversation | undefined;
  create(title: string, now?: Date): Conversation;
  /** 追加一批消息并更新 updatedAt；会话不存在时返回 undefined */
  append(id: string, messages: ConversationMessage[], now?: Date): Conversation | undefined;
  rename(id: string, title: string, now?: Date): Conversation | undefined;
  remove(id: string): boolean;
}

function readJson(filename: string): Conversation[] {
  if (!existsSync(filename)) return [];
  return z.array(conversationSchema).parse(JSON.parse(readFileSync(filename, "utf8")));
}

function writeJson(filename: string, value: unknown) {
  mkdirSync(dirname(filename), { recursive: true });
  const temporary = filename + ".tmp";
  writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n");
  renameSync(temporary, filename);
}

export function createConversationStore(filename: string): ConversationStore {
  const list = () => readJson(filename);
  const save = (items: Conversation[]) => writeJson(filename, items);

  return {
    list,
    get(id) {
      return list().find((item) => item.id === id);
    },
    create(title, now = new Date()) {
      const conversation: Conversation = {
        id: randomUUID(),
        title,
        messages: [],
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      };
      save([...list(), conversation]);
      return conversation;
    },
    append(id, messages, now = new Date()) {
      const items = list();
      const conversation = items.find((item) => item.id === id);
      if (!conversation) return undefined;
      conversation.messages.push(...messages);
      conversation.updatedAt = now.toISOString();
      save(items);
      return conversation;
    },
    rename(id, title, now = new Date()) {
      const items = list();
      const conversation = items.find((item) => item.id === id);
      if (!conversation) return undefined;
      conversation.title = title;
      conversation.updatedAt = now.toISOString();
      save(items);
      return conversation;
    },
    remove(id) {
      const items = list();
      const remaining = items.filter((item) => item.id !== id);
      if (remaining.length === items.length) return false;
      save(remaining);
      return true;
    },
  };
}
