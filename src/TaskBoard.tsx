import { useEffect, useState } from "react";
import {
  QUADRANTS,
  quadrantFlags,
  quadrantFromFlags,
  type QuadrantId,
} from "../shared/quadrants.ts";
import { deleteTask, listTasks, updateTask, type Task } from "./task-client.ts";

const PRIORITY_EMOJI: Record<string, string> = {
  high: "🔴",
  medium: "🟡",
  low: "🟢",
};

/**
 * 把服务端记录的完成时刻格式化成本地时间。
 * 当天只显示时分；隔天补上日期。历史任务没有时间戳时不编造。
 */
function formatCompletedAt(iso: string, now = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  const sameDay = date.toDateString() === now.toDateString();
  return sameDay ? `${time} 完成` : `${date.getMonth() + 1}/${date.getDate()} ${time} 完成`;
}

/** 本地日期 YYYY-MM-DD，用于判断截止日期是否已经过去。 */
function localDay(now: Date): string {
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

interface StatusInfo {
  text: string;
  tone: "done" | "overdue" | "due" | "pending";
}

/**
 * 右侧状态标注：已完成的显示完成时刻，未完成的显示截止日期。
 * 既没完成时刻也没截止日期的，退化成「未完成」，不留空白。
 */
function statusOf(task: Task, now: Date): StatusInfo {
  if (task.done) {
    const doneAt = task.completedAt ? formatCompletedAt(task.completedAt, now) : "";
    return { text: doneAt || "已完成", tone: "done" };
  }
  if (task.dueDate) {
    const overdue = task.dueDate < localDay(now);
    return {
      text: overdue ? `已逾期 ${task.dueDate}` : `截止 ${task.dueDate}`,
      tone: overdue ? "overdue" : "due",
    };
  }
  return { text: "未完成", tone: "pending" };
}

interface Group {
  root: Task;
  children: Task[];
  all: Task[];
}

/**
 * 与服务端 assignDisplayIds 保持一致：父任务不编号，
 * 子任务按树形顺序从 1 开始递增，用于卡片里的角标显示。
 */
function computeDisplayIds(tasks: Task[]): Map<string, number> {
  const byId = new Set(tasks.map((task) => task.id));
  const childrenOf = (id: string) => tasks.filter((task) => task.parentId === id);
  const map = new Map<string, number>();
  let counter = 0;
  const visit = (id: string) => {
    for (const child of childrenOf(id)) {
      counter += 1;
      map.set(child.id, counter);
      visit(child.id);
    }
  };
  for (const task of tasks) {
    if (!task.parentId || !byId.has(task.parentId)) visit(task.id);
  }
  return map;
}

/** 按 parentId 把扁平任务列表组织成「根任务 + 后代」的分组。 */
function groupTasks(tasks: Task[]): Group[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const childrenOf = (id: string) => tasks.filter((task) => task.parentId === id);

  const roots = tasks.filter((task) => !task.parentId || !byId.has(task.parentId));
  return roots.map((root) => {
    const collect = (id: string): Task[] => {
      const result: Task[] = [];
      for (const child of childrenOf(id)) {
        result.push(child, ...collect(child.id));
      }
      return result;
    };
    // all 包含根任务自己：独立任务应显示 1/1 或 0/1，而不是 0/0
    return { root, children: childrenOf(root.id), all: [root, ...collect(root.id)] };
  });
}

/**
 * 判定一组任务属于哪个象限：
 * - 组内任一任务显式指定了 quadrant，以它为准；
 * - 否则汇总组内所有任务的「紧急 / 重要」维度，只要有一条紧急就算紧急，
 *   避免重要子任务被父任务的默认分类埋没。
 */
function groupQuadrant(group: Group, now: Date): QuadrantId {
  const explicit = group.all.find((task) => task.quadrant)?.quadrant;
  if (explicit) return explicit;
  let urgent = false;
  let important = false;
  for (const task of group.all) {
    const flags = quadrantFlags(task, now);
    urgent ||= flags.urgent;
    important ||= flags.important;
  }
  return quadrantFromFlags(urgent, important);
}

interface TaskBoardProps {
  /** 每次对话后父组件会递增它，用来触发清单刷新 */
  refreshKey: number;
}

export function TaskBoard({ refreshKey }: TaskBoardProps) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      setTasks(await listTasks());
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, [refreshKey]);

  async function toggle(task: Task) {
    if (busyId) return;
    setBusyId(task.id);
    try {
      await updateTask(task.id, { done: !task.done });
      // 服务端会联动父子任务，重新加载整份清单才能看到所有变化
      setTasks(await listTasks());
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "更新失败");
    } finally {
      setBusyId(null);
    }
  }

  async function remove(task: Task) {
    if (busyId) return;
    setBusyId(task.id);
    try {
      await deleteTask(task.id);
      setTasks((prev) => prev.filter((item) => item.id !== task.id && item.parentId !== task.id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "删除失败");
    } finally {
      setBusyId(null);
    }
  }

  const groups = groupTasks(tasks);
  const displayIds = computeDisplayIds(tasks);
  const pending = tasks.filter((task) => !task.done).length;
  const now = new Date();
  // 按用户指定的顺序展示四个象限；每个象限内部仍是原来的「父任务 + 子任务」卡片
  const sections = QUADRANTS.map((quadrant) => ({
    ...quadrant,
    groups: groups.filter((group) => groupQuadrant(group, now) === quadrant.id),
  }));

  return (
    <div className="board">
      <div className="board-heading">
        <strong>Day Checklist</strong>
        <span>
          {tasks.length === 0 ? "还没有任务" : `${pending} 条待办 · ${tasks.length} 条全部`}
        </span>
      </div>

      {error && <p className="board-error" role="alert">{error}</p>}
      {loading && <p className="board-empty">加载中…</p>}
      {!loading && tasks.length === 0 && (
        <p className="board-empty">清单还是空的，回到「对话」说一句「帮我记一下买牛奶」就能添加。</p>
      )}

      {!loading && sections.map((section) => {
        const open = section.groups.reduce(
          (sum, group) => sum + group.all.filter((task) => !task.done).length,
          0,
        );
        return (
          <section className={`quadrant q-${section.id}`} key={section.id}>
            <div className="quadrant-heading">
              <span className="quadrant-name">{section.label}</span>
              <span className="quadrant-hint">{section.hint}</span>
              <span className="quadrant-count">{open} 条待办</span>
            </div>
            {section.groups.length === 0 ? (
              <p className="quadrant-empty">暂无任务</p>
            ) : (
              <div className="quadrant-cards">
                {section.groups.map((group) => {
                  const doneCount = group.all.filter((task) => task.done).length;
                  const rootStatus = statusOf(group.root, now);
                  return (
                    <div className="board-card" key={group.root.id}>
                      <div className="board-card-header">
                        <label className="board-group-label">
                          <input
                            type="checkbox"
                            checked={group.root.done}
                            disabled={busyId !== null}
                            onChange={() => void toggle(group.root)}
                            aria-label={`切换「${group.root.title}」完成状态`}
                          />
                          <span className={group.root.done ? "is-done" : ""}>{group.root.title}</span>
                        </label>
                        <span className="board-count">
                          {doneCount}/{group.all.length}
                        </span>
                        <span className={`board-status ${rootStatus.tone}`}>{rootStatus.text}</span>
                      </div>
                      {group.root.priority && (
                        <span className={`board-priority ${group.root.priority}`}>
                          {PRIORITY_EMOJI[group.root.priority]} {group.root.priority === "high" ? "高" : group.root.priority === "medium" ? "中" : "低"}
                        </span>
                      )}

                      {group.children.length > 0 && (
                        <ul className="board-items">
                          {flattenChildren(group.root.id, tasks, 0).map(({ task, depth }) => {
                            const displayId = displayIds.get(task.id);
                            const status = statusOf(task, now);
                            return (
                              <li key={task.id} style={{ paddingLeft: depth * 20 }}>
                                <label className="board-item-label">
                                  <input
                                    type="checkbox"
                                    checked={task.done}
                                    disabled={busyId !== null}
                                    onChange={() => void toggle(task)}
                                    aria-label={`切换「${task.title}」完成状态`}
                                  />
                                  <span className={task.done ? "is-done" : ""}>{task.title}</span>
                                </label>
                                <span
                                  className={`board-status ${status.tone}`}
                                  title={displayId ? `任务 #${displayId}` : undefined}
                                >
                                  {status.text}
                                </span>
                                <button
                                  type="button"
                                  className="board-delete"
                                  disabled={busyId !== null}
                                  onClick={() => void remove(task)}
                                  aria-label={`删除「${task.title}」`}
                                >
                                  🗑
                                </button>
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

/** 深度优先展开子任务，返回带层级深度的列表。 */
function flattenChildren(
  parentId: string,
  tasks: Task[],
  depth: number,
): Array<{ task: Task; depth: number }> {
  const result: Array<{ task: Task; depth: number }> = [];
  for (const task of tasks.filter((item) => item.parentId === parentId)) {
    result.push({ task, depth });
    result.push(...flattenChildren(task.id, tasks, depth + 1));
  }
  return result;
}
