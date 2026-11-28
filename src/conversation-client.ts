/** 多会话 API 的前端封装：会话保存在服务端 data/conversations.json。 */

export interface ChatItem {
  role: "user" | "assistant";
  content: string;
  /** 服务端生成的消息时间（ISO 8601） */
  time?: string;
}

export interface ConversationSummary {
  id: string;
  title: string;
  /** 最近一条用户提问，侧边栏预览用 */
  preview?: string;
  updatedAt: string;
  messageCount: number;
}

export interface ConversationDetail extends ConversationSummary {
  messages: ChatItem[];
  createdAt: string;
}

async function parse<T>(response: Response, fallback: string): Promise<T> {
  const body: unknown = await response.json();
  if (!response.ok) {
    if (typeof body === "object" && body !== null && "error" in body && typeof body.error === "string") {
      throw new Error(body.error);
    }
    throw new Error(fallback);
  }
  return body as T;
}

export async function listConversations(): Promise<ConversationSummary[]> {
  return parse<ConversationSummary[]>(await fetch("/api/conversations"), "会话列表加载失败。");
}

export async function createConversation(title: string): Promise<ConversationDetail> {
  return parse<ConversationDetail>(
    await fetch("/api/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    }),
    "创建会话失败。",
  );
}

export async function getConversation(id: string): Promise<ConversationDetail> {
  return parse<ConversationDetail>(
    await fetch(`/api/conversations/${encodeURIComponent(id)}`),
    "会话加载失败。",
  );
}

export async function deleteConversation(id: string): Promise<void> {
  const response = await fetch(`/api/conversations/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!response.ok) throw new Error("删除会话失败，请重试。");
}

export async function renameConversation(id: string, title: string): Promise<void> {
  const response = await fetch(`/api/conversations/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
  if (!response.ok) throw new Error("重命名失败，请重试。");
}
