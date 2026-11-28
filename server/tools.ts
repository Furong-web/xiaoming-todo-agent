/**
 * DeepSeek Function Calling 工具定义与本地执行器。
 *
 * 模型不直接回答增删改查，而是通过 tool_calls 声明要执行的操作，
 * 由这里的 executeTool 真正落到本地 JSON 存储上，再把结果回喂给模型，
 * 从根本上避免模型「嘴上说完成了、实际没改」的幻觉。
 */
import { detectQuadrant, isQuadrantId, QUADRANT_IDS } from "../shared/quadrants.ts";
import {
  buildDailySummary,
  buildHabits,
  buildRoutePlan,
  recommendTasks,
  resolveSummaryDate,
} from "./coach.ts";
import type { CheckInStore, QuizStore } from "./checkin-store.ts";
import type { HistoryStore } from "./history-store.ts";
import { setTaskDone } from "./task-completion.ts";
import {
  assignDisplayIds,
  collectDescendants,
  detectCategory,
  detectLocation,
  detectModule,
  detectRepeat,
  type Task,
} from "./task-model.ts";
import type { TaskStore } from "./task-store.ts";

/** 执行工具所需的全部依赖。 */
export interface ToolContext {
  tasks: TaskStore;
  checkIns: CheckInStore;
  quizzes: QuizStore;
  /** 可选：删除已完成任务时归档到历史 */
  history?: HistoryStore;
  now?: Date;
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export const TOOLS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "list_tasks",
      description: "列出全部任务及其状态、优先级、截止日期和层级关系",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "create_task",
      description: "新增一条任务（或子任务）",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "任务标题" },
          priority: {
            type: "string",
            enum: ["high", "medium", "low"],
            description: "优先级：high=高、medium=中、low=低",
          },
          effort: {
            type: "string",
            enum: ["small", "medium", "large"],
            description: "工作量：small=小、medium=中、large=大",
          },
          dueDate: { type: "string", description: "截止日期，格式 YYYY-MM-DD" },
          parentId: { type: "string", description: "父任务 id，创建子任务时填写" },
          module: {
            type: "string",
            description: "学习模块/科目，如 数学、英语、政治、专业课",
          },
          category: {
            type: "string",
            enum: ["study", "life"],
            description: "任务类别：study=学习、life=生活琐事（取快递、买菜、洗衣服等）",
          },
          repeat: {
            type: "string",
            enum: ["daily", "weekly"],
            description: "周期性习惯：daily=每天、weekly=每周，一次性任务不填",
          },
          location: {
            type: "string",
            description: "任务涉及的地点，如 超市、驿站、公司，用于动线优化",
          },
          quadrant: {
            type: "string",
            enum: QUADRANT_IDS,
            description:
              "四象限归类：urgent-important=紧急且重要、not-urgent-not-important=不紧急不重要、urgent-not-important=紧急不重要、not-urgent-important=不紧急但重要。用户明确提到象限时填写，标题里不要保留这些词",
          },
        },
        required: ["title"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_task",
      description: "修改任务标题、完成状态、优先级、截止日期等",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "任务 id" },
          title: { type: "string", description: "新标题" },
          done: { type: "boolean", description: "是否完成" },
          priority: {
            type: "string",
            enum: ["high", "medium", "low"],
            description: "优先级",
          },
          effort: {
            type: "string",
            enum: ["small", "medium", "large"],
            description: "工作量",
          },
          dueDate: { type: "string", description: "截止日期 YYYY-MM-DD" },
          quadrant: {
            type: "string",
            enum: QUADRANT_IDS,
            description: "调整任务的四象限归类",
          },
        },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_task",
      description: "删除一条任务（连同其所有子任务）",
      parameters: {
        type: "object",
        properties: { id: { type: "string", description: "任务 id" } },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "generate_daily_summary",
      description:
        "生成某一天的学习复盘数据（完成了哪些任务、各模块进度、未完成的待办）。晨间规划和晚间复盘都要先调用它。",
      parameters: {
        type: "object",
        properties: {
          date: {
            type: "string",
            description: "目标日期，支持「昨天」「今天」「前天」或 YYYY-MM-DD",
          },
        },
        required: ["date"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "check_in_task",
      description:
        "为某条任务打卡（记录完成时间、学习模块与进度笔记），并把任务标记为完成。用户说「学完了」「做完了」时调用。",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "任务 id 或子任务展示序号（如 1、2）" },
          module: {
            type: "string",
            description: "学习模块/科目，如 数学、英语、政治、专业课",
          },
          note: {
            type: "string",
            description: "本次学习的进度笔记，例如「学完了第一章极限的定义」",
          },
        },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "send_quiz",
      description:
        "给用户出一道巩固题。必须同时提供题目和标准答案，答案会保存到服务端供后续批改。",
      parameters: {
        type: "object",
        properties: {
          module: { type: "string", description: "所属模块，如 数学、英语" },
          question: { type: "string", description: "题目正文" },
          answer: { type: "string", description: "标准答案及解析" },
        },
        required: ["question", "answer"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "plan_route",
      description:
        "把待办按地点聚合，给出顺路/合并处理的动线建议。用户一次提到多个不同地点的任务（公司开会、取快递、逛超市）时先调用它。",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "list_habits",
      description:
        "查看周期性习惯（每天/每周）的连续打卡情况，用于「昨天你做到了，今天继续保持」这类连续激励。",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "grade_quiz",
      description:
        "批改用户对上一道题的作答，并记录批改结论。用户给出答案后调用，随后据返回的标准答案给出讲解。",
      parameters: {
        type: "object",
        properties: {
          response: { type: "string", description: "用户的作答内容" },
          verdict: { type: "string", description: "批改结论：正确 / 部分正确 / 错误，附简要理由" },
        },
        required: ["response", "verdict"],
      },
    },
  },
];

/** 用子任务展示序号(1/2/3)定位真实 UUID；父任务没有序号，只能用 UUID 或标题指代。 */
function resolveId(idOrSeq: string, store: TaskStore): string | null {
  const all = store.list();
  if (all.some((task) => task.id === idOrSeq)) return idOrSeq;
  // 允许用户用清单里看到的序号指代
  for (const [id, seq] of assignDisplayIds(all)) {
    if (String(seq) === idOrSeq) return id;
  }
  return null;
}

/**
 * 序列化任务给模型。展示序号必须与 toMarkdownTable 一致，
 * 都走 assignDisplayIds（树形深度优先），否则模型会把表格里的 ID 张冠李戴。
 */
function serializeTasks(all: Task[]): Array<Record<string, unknown>> {
  const ids = assignDisplayIds(all);
  return all.map((task) => ({
    id: task.id,
    displayId: ids.get(task.id),
    title: task.title,
    done: task.done,
    priority: task.priority ?? null,
    effort: task.effort ?? null,
    dueDate: task.dueDate ?? null,
    parentId: task.parentId ?? null,
    module: task.module ?? null,
    category: task.category ?? null,
    repeat: task.repeat ?? null,
    location: task.location ?? null,
    quadrant: task.quadrant ?? null,
  }));
}

/** 序列化单条任务时，展示序号必须基于全量清单计算（不能用单元素数组）。 */
function serializeOne(task: Task, all: Task[]): Record<string, unknown> {
  return serializeTasks(all).find((item) => item.id === task.id) ?? {};
}

/**
 * 执行一次工具调用，返回 JSON 字符串结果（作为 tool 消息回喂给模型）。
 * 找不到任务时返回明确错误信息，而不是捏造成功。
 */
export function executeTool(
  name: string,
  args: Record<string, unknown>,
  context: ToolContext,
): string {
  const { tasks: store, checkIns, quizzes, now } = context;

  switch (name) {
    case "list_tasks": {
      return JSON.stringify({ tasks: serializeTasks(store.list()) });
    }

    case "create_task": {
      const title = typeof args.title === "string" ? args.title.trim() : "";
      if (!title) return JSON.stringify({ error: "任务标题不能为空。" });

      // 父任务允许传 UUID 或表格里看到的展示序号
      const rawParent = args.parentId ? String(args.parentId) : "";
      const parentId = rawParent ? resolveId(rawParent, store) : undefined;
      if (rawParent && !parentId) {
        return JSON.stringify({ error: `找不到父任务「${rawParent}」，请先 list_tasks 确认。` });
      }

      const all = store.list();
      // 防止模型重复创建同名同父任务（实测模型可能连续调用两次 create_task）
      const duplicate = all.find(
        (task) =>
          !task.done &&
          task.title.trim() === title &&
          (task.parentId ?? "") === (parentId ?? ""),
      );
      if (duplicate) {
        const dupSeq = assignDisplayIds(all).get(duplicate.id);
        return JSON.stringify({
          error: `「${title}」已经存在${dupSeq ? `（序号 ${dupSeq}）` : ""}，没有重复创建。`,
          duplicated: true,
          task: serializeOne(duplicate, all),
        });
      }

      const category =
        args.category === "study" || args.category === "life"
          ? args.category
          : detectCategory(title);
      const created = store.create(title, {
        priority: args.priority ?? undefined,
        effort: args.effort ?? undefined,
        dueDate: args.dueDate ?? undefined,
        parentId,
        category,
        // 模型没显式给模块时，从标题里识别（数学/英语/政治/专业课…）
        module:
          (typeof args.module === "string" && args.module) ||
          (category === "study" ? detectModule(title) : undefined) ||
          undefined,
        repeat:
          args.repeat === "daily" || args.repeat === "weekly"
            ? args.repeat
            : detectRepeat(title),
        location:
          (typeof args.location === "string" && args.location) ||
          detectLocation(title) ||
          undefined,
        quadrant: isQuadrantId(args.quadrant) ? args.quadrant : detectQuadrant(title),
      });
      return JSON.stringify({ ok: true, task: serializeOne(created, store.list()) });
    }

    case "update_task": {
      const id = resolveId(String(args.id ?? ""), store);
      if (!id) return JSON.stringify({ error: "找不到这条任务，请先调用 list_tasks 确认。" });
      const changes: Record<string, unknown> = {};
      if (typeof args.title === "string") changes.title = args.title.trim();
      if (typeof args.done === "boolean") changes.done = args.done;
      if (args.priority) changes.priority = args.priority;
      if (args.effort) changes.effort = args.effort;
      if (args.dueDate) changes.dueDate = args.dueDate;
      if (isQuadrantId(args.quadrant)) changes.quadrant = args.quadrant;
      if (Object.keys(changes).length === 0) {
        return JSON.stringify({ error: "没有提供要修改的字段。" });
      }
      // 只改完成状态时走联动模块，顺带写入服务端生成的完成时刻；
      // 同时改标题等字段时，至少也要把完成时刻补上，保证各入口一致。
      const doneFlag = typeof changes.done === "boolean" ? changes.done : undefined;
      let updated;
      if (doneFlag !== undefined && Object.keys(changes).length === 1) {
        updated = setTaskDone(store, id, doneFlag, now, context.history);
      } else {
        updated = store.update(id, {
          ...changes,
          ...(doneFlag !== undefined
            ? { completedAt: doneFlag ? (now ?? new Date()).toISOString() : undefined }
            : {}),
        });
      }
      if (!updated) return JSON.stringify({ error: "找不到这条任务，请先调用 list_tasks 确认。" });
      // 没走联动模块的分支（同时改标题等字段）也要同步历史记录
      if (doneFlag !== undefined && context.history) {
        if (doneFlag) context.history.recordCompletion(updated, store.list(), now);
        else context.history.withdraw(id);
      }
      return JSON.stringify({ ok: true, task: serializeOne(updated, store.list()) });
    }

    case "delete_task": {
      const id = resolveId(String(args.id ?? ""), store);
      if (!id) return JSON.stringify({ error: "找不到这条任务，请先调用 list_tasks 确认。" });
      const descendants = collectDescendants(id, store.list());
      // 历史记录在勾选完成时已经写过，删除不再重复处理
      for (const child of descendants) store.remove(child.id);
      store.remove(id);
      return JSON.stringify({ ok: true, removedChildren: descendants.length });
    }

    case "generate_daily_summary": {
      const raw = typeof args.date === "string" && args.date ? args.date : "今天";
      const clock = now ?? new Date();
      const date = resolveSummaryDate(raw, clock);
      const summary = buildDailySummary(date, store.list(), checkIns.list());
      // 附带推荐任务，便于模型按「攻克 [推荐任务]」的开场白模板组织语言
      const recommendations = recommendTasks(store.list()).map((task) => ({
        displayId: assignDisplayIds(store.list()).get(task.id),
        title: task.title,
        module: task.module ?? null,
        category: task.category ?? null,
        priority: task.priority ?? null,
        dueDate: task.dueDate ?? null,
      }));
      // 周期性习惯的连续打卡情况，支撑「昨天你喝了牛奶，今天继续保持」这类话术
      const habits = buildHabits(store.list(), checkIns.list(), clock);
      return JSON.stringify({ summary, recommendations, habits });
    }

    case "check_in_task": {
      const id = resolveId(String(args.id ?? ""), store);
      if (!id) return JSON.stringify({ error: "找不到这条任务，请先 list_tasks 确认。" });
      const task = store.list().find((item) => item.id === id);
      if (!task) return JSON.stringify({ error: "找不到这条任务，请先 list_tasks 确认。" });

      const category =
        task.category === "life" || task.category === "study"
          ? task.category
          : detectCategory(task.title);
      const module =
        (typeof args.module === "string" && args.module) ||
        (typeof task.module === "string" && task.module) ||
        (category === "study" ? detectModule(task.title) : undefined);
      const note = typeof args.note === "string" ? args.note.trim() : "";

      const checkin = checkIns.add(
        {
          taskId: task.id,
          taskTitle: task.title,
          module,
          category,
          note: note || undefined,
        },
        now,
      );
      // 打卡同时把任务置为完成，并联动父子任务与历史记录
      setTaskDone(store, id, true, now ?? new Date(), context.history);

      return JSON.stringify({
        ok: true,
        checkIn: {
          taskTitle: checkin.taskTitle,
          module: checkin.module ?? null,
          note: checkin.note ?? null,
          date: checkin.date,
          time: checkin.createdAt,
        },
        needNote: !note,
      });
    }

    case "plan_route": {
      const plan = buildRoutePlan(store.list());
      return JSON.stringify(plan);
    }

    case "list_habits": {
      const habits = buildHabits(store.list(), checkIns.list(), now ?? new Date());
      return JSON.stringify({ habits });
    }

    case "send_quiz": {
      const question = typeof args.question === "string" ? args.question.trim() : "";
      const answer = typeof args.answer === "string" ? args.answer.trim() : "";
      if (!question || !answer) {
        return JSON.stringify({ error: "出题必须同时提供 question 和 answer。" });
      }
      const quiz = quizzes.create(
        {
          module: typeof args.module === "string" ? args.module : undefined,
          question,
          answer,
        },
        now,
      );
      // 答案不回传给模型，避免模型在本轮就把答案说漏
      return JSON.stringify({ ok: true, quizId: quiz.id, module: quiz.module ?? null });
    }

    case "grade_quiz": {
      const response = typeof args.response === "string" ? args.response.trim() : "";
      const verdict = typeof args.verdict === "string" ? args.verdict.trim() : "";
      if (!response || !verdict) {
        return JSON.stringify({ error: "批改需要提供 response 和 verdict。" });
      }
      const pending = quizzes.latestUngraded();
      if (!pending) {
        return JSON.stringify({ error: "当前没有待批改的题目，请先调用 send_quiz 出题。" });
      }
      const graded = quizzes.grade(pending.id, response, verdict, now);
      return JSON.stringify({
        ok: true,
        question: pending.question,
        standardAnswer: pending.answer,
        response,
        verdict,
        gradedAt: graded?.gradedAt ?? null,
      });
    }

    default:
      return JSON.stringify({ error: `未知工具：${name}` });
  }
}
