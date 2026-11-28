import { z } from "zod";

const messageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().trim().min(1),
});

export type ChatMessage = z.infer<typeof messageSchema>;

export const chatRequestSchema = z.object({
  /** 可选：携带会话 id 时，服务端会把本轮对话记录进该会话 */
  conversationId: z.string().min(1).optional(),
  messages: z
    .array(messageSchema)
    .min(1)
    .refine((messages) => messages.at(-1)?.role === "user"),
});
