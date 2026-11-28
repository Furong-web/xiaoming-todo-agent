/**
 * 会话消息的时间工具。
 *
 * 消息由服务端按会话持久化（data/conversations.json），前端只负责展示；
 * localStorage 里不再存对话，仅保留上次打开的会话 id。
 */
export type { ChatItem as StoredMessage } from "./conversation-client.ts";

const LAST_KEY = "xiaoming-last-conversation";

/** 上次打开的会话 id，刷新页面后自动恢复。 */
export function loadLastConversationId(): string | null {
  try {
    return localStorage.getItem(LAST_KEY);
  } catch {
    return null;
  }
}

export function saveLastConversationId(id: string | null) {
  try {
    if (id) localStorage.setItem(LAST_KEY, id);
    else localStorage.removeItem(LAST_KEY);
  } catch {
    // 存储不可用时静默放弃
  }
}

/** 当天显示 HH:MM，隔天显示 M/D HH:MM。 */
export function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  const sameDay = date.toDateString() === new Date().toDateString();
  return sameDay ? time : `${date.getMonth() + 1}/${date.getDate()} ${time}`;
}
