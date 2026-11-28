import type { ConversationSummary } from "./conversation-client.ts";

interface SidebarProps {
  conversations: ConversationSummary[];
  currentId: string | null;
  /** 传 null 表示切换到未保存的新对话 */
  onSelect: (id: string | null) => void;
  onRename: (conversation: ConversationSummary) => void;
  onDelete: (conversation: ConversationSummary) => void;
}

/** 豆包式时间分组：今天 / 昨天 / 近 7 天 / 更早。 */
function timeGroup(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "更早";
  const startOfDay = (value: Date) =>
    new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const diffDays = Math.round((startOfDay(new Date()) - startOfDay(date)) / 86_400_000);
  if (diffDays <= 0) return "今天";
  if (diffDays === 1) return "昨天";
  if (diffDays <= 7) return "近 7 天";
  return "更早";
}

const GROUP_ORDER = ["今天", "昨天", "近 7 天", "更早"];

/** 按时间分组罗列，空组不渲染；顺序与豆包一致。 */
function groupConversations(conversations: ConversationSummary[]) {
  return GROUP_ORDER.map((label) => ({
    label,
    items: conversations.filter((conversation) => timeGroup(conversation.updatedAt) === label),
  })).filter((group) => group.items.length > 0);
}

export function Sidebar({ conversations, currentId, onSelect, onRename, onDelete }: SidebarProps) {
  const groups = groupConversations(conversations);

  return (
    <aside className="sidebar" aria-label="历史会话">
      <div className="sidebar-heading">
        <strong>历史会话</strong>
        <button
          type="button"
          className="sidebar-new"
          onClick={() => onSelect(null)}
          aria-label="新建对话"
        >
          ＋ 新对话
        </button>
      </div>
      <div className="sidebar-scroll">
        {groups.length === 0 && (
          <p className="sidebar-empty">还没有历史会话，发一条消息就会自动创建。</p>
        )}
        {groups.map((group) => (
          <section key={group.label} className="sidebar-group">
            <h3 className="sidebar-group-name">{group.label}</h3>
            <ul className="sidebar-list">
              {group.items.map((conversation) => (
                <li key={conversation.id} className="sidebar-row">
                  <button
                    type="button"
                    className={
                      conversation.id === currentId ? "sidebar-item active" : "sidebar-item"
                    }
                    onClick={() => onSelect(conversation.id)}
                    title={conversation.title}
                  >
                    <span className="sidebar-title">{conversation.title}</span>
                    {conversation.preview && conversation.preview !== conversation.title && (
                      <span className="sidebar-preview">{conversation.preview}</span>
                    )}
                    <span className="sidebar-meta">{conversation.messageCount} 条消息</span>
                  </button>
                  <span className="sidebar-actions">
                    <button
                      type="button"
                      className="sidebar-action"
                      onClick={() => onRename(conversation)}
                      aria-label={`重命名会话「${conversation.title}」`}
                      title="重命名"
                    >
                      ✏️
                    </button>
                    <button
                      type="button"
                      className="sidebar-action danger"
                      onClick={() => onDelete(conversation)}
                      aria-label={`删除会话「${conversation.title}」`}
                      title="删除会话"
                    >
                      🗑
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </aside>
  );
}
