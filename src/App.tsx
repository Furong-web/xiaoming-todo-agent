import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { ChatMessage } from "../shared/chat.ts";
import {
  loadLastConversationId,
  saveLastConversationId,
  type StoredMessage,
} from "./chat-storage.ts";
import { requestReply } from "./chat-client.ts";
import {
  createConversation,
  deleteConversation,
  getConversation,
  listConversations,
  renameConversation,
  type ConversationSummary,
} from "./conversation-client.ts";
import { Sidebar } from "./Sidebar.tsx";
import { ChatHistory } from "./ChatHistory.tsx";
import { TaskBoard } from "./TaskBoard.tsx";

function isSendShortcut(event: KeyboardEvent<HTMLTextAreaElement>) {
  // 中文输入法会用 Enter 确认选词，部分浏览器此时只报告键码 229。
  const composing = event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229;
  return event.key === "Enter" && !event.shiftKey && !composing;
}

/** 会话标题取第一条用户消息，过长截断。 */
function titleFrom(content: string): string {
  const text = content.trim().replace(/\s+/g, " ");
  return text.length > 30 ? `${text.slice(0, 30)}…` : text || "新对话";
}

export default function App() {
  const [tab, setTab] = useState<"chat" | "board">("chat");
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  // null 表示尚未落库的新对话，发出第一条消息时才真正创建
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [messages, setMessages] = useState<StoredMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const input = useRef<HTMLTextAreaElement>(null);
  /** 刚创建、尚未有消息落库的会话：切换 effect 跳过拉取，避免清掉乐观消息 */
  const skipLoadRef = useRef<string | null>(null);

  const refreshList = useCallback(async () => {
    try {
      setConversations(await listConversations());
    } catch {
      // 列表加载失败不阻塞聊天，下次发送后会再刷新
    }
  }, []);

  // 初始化：加载会话列表，并恢复上次打开的会话
  useEffect(() => {
    void refreshList().then(() => {
      const last = loadLastConversationId();
      if (last) setCurrentId(last);
    });
  }, [refreshList]);

  // 切换会话：从服务端拉取完整消息
  useEffect(() => {
    saveLastConversationId(currentId);
    if (!currentId) {
      setMessages([]);
      return;
    }
    if (skipLoadRef.current === currentId) {
      skipLoadRef.current = null;
      return;
    }
    let cancelled = false;
    getConversation(currentId)
      .then((detail) => {
        if (!cancelled) setMessages(detail.messages);
      })
      .catch(() => {
        if (!cancelled) {
          setCurrentId(null);
          setError("会话加载失败，已切换到新对话。");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [currentId]);

  async function send(text: string) {
    const content = text.trim();
    if (!content || pending) return;

    let conversationId = currentId;
    try {
      if (!conversationId) {
        const created = await createConversation(titleFrom(content));
        conversationId = created.id;
        skipLoadRef.current = created.id;
        setCurrentId(created.id);
      }

      const outgoing: ChatMessage[] = [...messages, { role: "user", content }];
      setMessages([...outgoing]);
      setDraft("");
      setPending(true);
      setError("");

      await requestReply(outgoing, conversationId);
      // 服务端已把本轮对话持久化，重新拉取保证与磁盘一致；
      // 用户若在等待回复时切到了别的会话，只刷新列表、不覆盖当前视图
      const detail = await getConversation(conversationId);
      if (conversationId === currentId) setMessages(detail.messages);
      await refreshList();
      setRefreshKey((key) => key + 1);
    } catch (cause) {
      setError(cause instanceof Error ? `发送失败：${cause.message}` : "发送失败，请重试。");
      setDraft(text);
    } finally {
      setPending(false);
      requestAnimationFrame(() => input.current?.focus());
    }
  }

  async function rename(conversation: ConversationSummary) {
    const title = window.prompt("修改会话名称：", conversation.title)?.trim();
    if (!title || title === conversation.title) return;
    try {
      await renameConversation(conversation.id, title.slice(0, 50));
      await refreshList();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "重命名失败，请重试。");
    }
  }

  async function remove(conversation: ConversationSummary) {
    if (!window.confirm(`删除会话「${conversation.title}」？聊天记录将无法恢复。`)) return;
    try {
      await deleteConversation(conversation.id);
      if (conversation.id === currentId) {
        setCurrentId(null);
        setMessages([]);
      }
      await refreshList();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "删除失败，请重试。");
    }
  }

  return (
    <div className="app">
      <Sidebar
        conversations={conversations}
        currentId={currentId}
        onSelect={(id) => {
          setCurrentId(id);
          setTab("chat");
        }}
        onDelete={(conversation) => void remove(conversation)}
        onRename={(conversation) => void rename(conversation)}
      />
      <div className="workspace">
        <header>
          <img src="/logo.png" alt="" />
          <strong>TokeNow</strong>
          <span>小明智能体</span>
          <nav className="tabs">
            <button
              type="button"
              className={tab === "chat" ? "active" : ""}
              onClick={() => setTab("chat")}
            >
              对话
            </button>
            <button
              type="button"
              className={tab === "board" ? "active" : ""}
              onClick={() => {
                setRefreshKey((key) => key + 1);
                setTab("board");
              }}
            >
              清单
            </button>
          </nav>
        </header>
        <main>
          {tab === "chat" ? (
            <>
              <ChatHistory messages={messages} pending={pending} onSelectPrompt={send} />
              <div className="compose">
                {error && (
                  <p className="error" role="alert">
                    {error}
                  </p>
                )}
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    void send(draft);
                  }}
                >
                  <textarea
                    aria-label="消息"
                    ref={input}
                    placeholder="输入消息…"
                    rows={2}
                    value={draft}
                    readOnly={pending}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (isSendShortcut(event)) {
                        event.preventDefault();
                        void send(draft);
                      }
                    }}
                  />
                  <button
                    className="send"
                    disabled={pending || !draft.trim()}
                    aria-label="发送消息"
                  >
                    ↑
                  </button>
                </form>
                <small>Enter 发送 · Shift + Enter 换行</small>
              </div>
            </>
          ) : (
            <TaskBoard refreshKey={refreshKey} />
          )}
        </main>
      </div>
    </div>
  );
}
