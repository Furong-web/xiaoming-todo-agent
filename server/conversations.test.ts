/** 多会话 API：创建、按会话记录对话、列表排序、删除。 */
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { ChatMessage } from "../shared/chat.ts";
import { createApp } from "./app.ts";
import { createConversationStore } from "./conversation-store.ts";
import { createJsonTaskStore } from "./task-store.ts";

async function startTestApp(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "todo-agent-conv-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const app = createApp({
    tasks: createJsonTaskStore(join(directory, "tasks.json")),
    conversations: createConversationStore(join(directory, "conversations.json")),
    async reply(messages) {
      return `回复：${messages.at(-1)?.content ?? ""}`;
    },
  });

  const server = app.listen(0, "127.0.0.1");
  t.after(() => server[Symbol.asyncDispose]());
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;

  async function request(method: string, path: string, body?: unknown) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return {
      status: response.status,
      body: response.status === 204 ? null : await response.json(),
    };
  }

  return { request };
}

test("对话按会话持久化，无会话 id 时不记录", async (t) => {
  const { request } = await startTestApp(t);
  const created = await request("POST", "/api/conversations", { title: "备考日常" });
  assert.equal(created.status, 201);
  const id = created.body.id as string;

  const messages: ChatMessage[] = [{ role: "user", content: "今天复习什么？" }];
  const chat = await request("POST", "/api/chat", { conversationId: id, messages });
  assert.equal(chat.status, 200);
  assert.equal(chat.body.reply, "回复：今天复习什么？");

  const detail = await request("GET", `/api/conversations/${id}`);
  assert.equal(detail.body.messages.length, 2);
  assert.equal(detail.body.messages[0].content, "今天复习什么？");
  assert.equal(detail.body.messages[1].content, "回复：今天复习什么？");
  assert.equal(typeof detail.body.messages[0].time, "string");

  // 不带会话 id 的请求不影响任何会话
  const loose = await request("POST", "/api/chat", {
    messages: [{ role: "user", content: "临时提问" }],
  });
  assert.equal(loose.status, 200);
  const untouched = await request("GET", `/api/conversations/${id}`);
  assert.equal(untouched.body.messages.length, 2);

  // 会话不存在时明确报错
  const missing = await request("POST", "/api/chat", {
    conversationId: "missing",
    messages: [{ role: "user", content: "你好" }],
  });
  assert.equal(missing.status, 404);
});

test("会话列表按最近更新排序，删除后列表减少", async (t) => {
  const { request } = await startTestApp(t);
  const first = (await request("POST", "/api/conversations", { title: "第一段" })).body;
  const second = (await request("POST", "/api/conversations", { title: "第二段" })).body;

  // 向较早创建的会话追加一轮对话，它应排到最前
  await request("POST", "/api/chat", {
    conversationId: first.id,
    messages: [{ role: "user", content: "继续" }],
  });

  const list = (await request("GET", "/api/conversations")).body;
  assert.deepEqual(
    list.map((item: { id: string }) => item.id),
    [first.id, second.id],
  );
  assert.equal(list[0].messageCount, 2);
  // 列表带「最近提问」预览，侧边栏不点开也能看到具体问题
  assert.equal(list[0].preview, "继续");

  assert.equal((await request("DELETE", `/api/conversations/${first.id}`)).status, 204);
  assert.equal(((await request("GET", "/api/conversations")).body).length, 1);
  assert.equal((await request("GET", "/api/conversations/missing")).status, 404);
  assert.equal((await request("DELETE", "/api/conversations/missing")).status, 404);
});
