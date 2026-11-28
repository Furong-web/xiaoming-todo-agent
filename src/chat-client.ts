import type { ChatMessage } from "../shared/chat.ts";

/** conversationId 提供时，服务端会把本轮对话持久化到该会话。 */
export async function requestReply(messages: ChatMessage[], conversationId?: string): Promise<string> {
  const response = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages, ...(conversationId ? { conversationId } : {}) }),
  });
  const body: unknown = await response.json();
  if (typeof body === "object" && body !== null) {
    if (response.ok && "reply" in body && typeof body.reply === "string") return body.reply;
    if ("error" in body && typeof body.error === "string") throw new Error(body.error);
  }
  throw new Error("服务暂时不可用。");
}
