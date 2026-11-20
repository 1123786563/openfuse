import assert from "node:assert/strict";
import test from "node:test";
import { OpenBotAdapter } from "../../../packages/backends/src/openbot.ts";
import { observeOpenBotRun, stopOpenBotRun, syncOpenBotRun } from "../src/openbot-run.ts";

const outgoing = { id: "client-message", text: "hello" };
const runtimeUrl = "https://openbot.test/api/copilotkit";

for (const scenario of ["lost response", "conflict"] as const) {
  test(`${scenario} checks history then joins without another send`, async () => {
    const steps: string[] = [];
    let saved = false;
    const signal = new AbortController().signal;
    const transport = {
      runtimeUrl,
      async request(path: string) {
        if (path === "/api/channels?limit=30")
          return Response.json({ channels: [channel], nextCursor: null });
        if (path === "/api/channels/channel") return Response.json({ channel });
        assert.equal(path, "/api/copilotkit/threads/thread/messages?agentId=bot");
        steps.push("history");
        return Response.json({
          messages: saved ? [{ id: outgoing.id, role: "user", content: outgoing.text }] : [],
        });
      },
      async requestRuntime(url: string, init: RequestInit) {
        if (url === `${runtimeUrl}/info`)
          return Response.json({
            mode: "intelligence",
            intelligence: { wsUrl: "wss://gateway.test" },
          });
        assert.equal(init.method, "POST");
        const body = JSON.parse(String(init.body));
        assert.equal(body.threadId, "thread");
        if (url === `${runtimeUrl}/agent/bot/run`) {
          steps.push("run");
          assert.deepEqual(body.messages, [
            { id: outgoing.id, role: "user", content: outgoing.text },
          ]);
          if (scenario === "conflict") return new Response(null, { status: 409 });
          saved = true;
          throw new Error("connection dropped after acceptance");
        }
        assert.equal(url, `${runtimeUrl}/agent/bot/connect`);
        steps.push("connect");
        return new Response(null, { status: 204 });
      },
    };
    const channel = {
      id: "channel",
      name: "Bot",
      active: true,
      threadId: "thread",
      agentIds: ["bot"],
      lastMessageAt: null,
    };
    const adapter = new OpenBotAdapter({ enabled: true, transport });
    const {
      conversations: [listed],
    } = await adapter.listConversations({});
    assert.ok(listed);
    const result = await syncOpenBotRun({
      read: () => adapter.openConversation(listed.channelId),
      observe: (history, send) =>
        observeOpenBotRun({
          history,
          send,
          signal,
          transport,
          onMessages: () => {},
          onRun: () => {},
        }),
      send: outgoing,
      pending: null,
    });
    assert.deepEqual(steps, ["history", "run", "history", "connect", "history"]);
    assert.deepEqual(result.unconfirmed, scenario === "conflict" ? outgoing : null);
    if (scenario === "lost response") {
      steps.length = 0;
      const review = await syncOpenBotRun({
        read: () => adapter.openConversation(listed.channelId),
        observe: (history, send) =>
          observeOpenBotRun({
            history,
            send,
            signal,
            transport,
            onMessages: () => {},
            onRun: () => {},
          }),
        send: { id: "new-id", text: outgoing.text },
        pending: outgoing,
      });
      assert.deepEqual(steps, ["history", "connect", "history"]);
      assert.equal(review.unconfirmed, null);
    }
  });
}

async function openStopTarget(agentId: string, threadId: string) {
  const channel = {
    id: "channel",
    name: "Bot",
    active: true,
    threadId,
    agentIds: [agentId],
    lastMessageAt: null,
  };
  const adapter = new OpenBotAdapter({
    enabled: true,
    transport: {
      runtimeUrl,
      async request(path) {
        if (path.startsWith("/api/channels?"))
          return Response.json({ channels: [channel], nextCursor: null });
        if (path === "/api/channels/channel") return Response.json({ channel });
        return Response.json({ messages: [] });
      },
    },
  });
  const {
    conversations: [listed],
  } = await adapter.listConversations({});
  assert.ok(listed);
  return adapter.openConversation(listed.channelId);
}

test("a delayed stop targets the captured run even after a newer run starts", async () => {
  let activeRun = "old-run";
  const history = await openStopTarget("bot/id", "thread/id");
  let deliverStop = () => {};
  const deliver = new Promise<void>((resolve) => {
    deliverStop = resolve;
  });
  const transport = {
    runtimeUrl,
    request: async () => {
      throw new Error("Unexpected workspace request");
    },
    async requestRuntime(url: string, init: RequestInit) {
      await deliver;
      assert.equal(url, `${runtimeUrl}/agent/bot%2Fid/stop/thread%2Fid`);
      assert.equal(init.method, "POST");
      const body = JSON.parse(String(init.body));
      const stopped = activeRun === body.runId;
      if (stopped) activeRun = "";
      return Response.json({ stopped });
    },
  };
  const signal = new AbortController().signal;
  const pending = stopOpenBotRun({ history, runId: activeRun, transport, signal });
  activeRun = "new-run";
  deliverStop();
  await pending;
  assert.equal(activeRun, "new-run");
  await stopOpenBotRun({ history, runId: activeRun, transport, signal });
  assert.equal(activeRun, "");
});

for (const [status, code] of [
  [401, "authentication_required"],
  [403, "refused"],
  [404, "refused"],
] as const) {
  test(`stop preserves the runtime's ${status} refusal`, async () => {
    const transport = {
      runtimeUrl,
      request: async () => {
        throw new Error("Unexpected workspace request");
      },
      requestRuntime: async () => new Response(null, { status }),
    };
    await assert.rejects(
      stopOpenBotRun({
        history: await openStopTarget("bot", "private-thread"),
        runId: "private-run",
        transport,
        signal: new AbortController().signal,
      }),
      { status, code },
    );
  });
}

test("a Web stop leaves the mobile observer with saved history and no failed run", {
  timeout: 3000,
}, async (t) => {
  const channel = {
    id: "channel",
    name: "Bot",
    active: true,
    threadId: "thread",
    agentIds: ["bot"],
    lastMessageAt: null,
  };
  const saved = { id: "reply", role: "assistant", content: "Saved partial reply" };
  let stopped = false;
  class GatewaySocket {
    readyState = 0;
    onopen = () => {};
    onmessage = (_event: { data: string }) => {};
    onclose = (_event: { code: number }) => {};

    constructor() {
      queueMicrotask(() => {
        this.readyState = 1;
        this.onopen();
      });
    }

    send(data: string) {
      const [joinRef, ref, topic, event] = JSON.parse(data);
      if (event !== "phx_join") return;
      const push = (name: string, payload: object, messageRef: string | null = null) => {
        if (this.readyState === 1) {
          this.onmessage({ data: JSON.stringify([joinRef, messageRef, topic, name, payload]) });
        }
      };
      queueMicrotask(() => {
        push("phx_reply", { status: "ok", response: {} }, ref);
        stopped = true;
        push("ag_ui_event", { type: "RUN_STARTED", threadId: "thread", runId: "web-run" });
        push("ag_ui_event", {
          type: "RUN_FINISHED",
          threadId: "thread",
          runId: "web-run",
          outcome: { type: "cancelled" },
        });
        push("replay_complete", {});
        push("stream_idle", {});
      });
    }

    close() {
      this.readyState = 3;
      this.onclose({ code: 1000 });
    }
  }
  const originalWebSocket = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: GatewaySocket });
  t.after(() => {
    if (originalWebSocket) Object.defineProperty(globalThis, "WebSocket", originalWebSocket);
    else Reflect.deleteProperty(globalThis, "WebSocket");
  });

  const transport = {
    runtimeUrl,
    async request(path: string) {
      if (path.startsWith("/api/channels?"))
        return Response.json({ channels: [channel], nextCursor: null });
      if (path === "/api/channels/channel") return Response.json({ channel });
      assert.equal(path, "/api/copilotkit/threads/thread/messages?agentId=bot");
      return Response.json({ messages: stopped ? [saved] : [] });
    },
    async requestRuntime(url: string) {
      if (url === `${runtimeUrl}/info`)
        return Response.json({
          mode: "intelligence",
          intelligence: { wsUrl: "wss://gateway.test" },
        });
      assert.equal(url, `${runtimeUrl}/agent/bot/connect`);
      return Response.json({
        threadId: "thread",
        runId: "web-run",
        joinToken: "join-token",
        realtime: { clientUrl: "wss://gateway.test", topic: "thread:thread" },
      });
    },
  };
  const adapter = new OpenBotAdapter({ enabled: true, transport });
  const {
    conversations: [listed],
  } = await adapter.listConversations({});
  assert.ok(listed);
  const controller = new AbortController();
  t.after(() => controller.abort());
  const runIds: (string | null)[] = [];
  const transcript: string[][] = [];
  const result = await syncOpenBotRun({
    read: async () => {
      const history = await adapter.openConversation(listed.channelId);
      transcript.push(history.messages.map(({ text }) => text));
      return history;
    },
    observe: (history) =>
      observeOpenBotRun({
        history,
        transport,
        signal: controller.signal,
        onMessages: () => {},
        onRun: (runId) => runIds.push(runId),
      }),
    pending: null,
  });
  assert.deepEqual(result, { unconfirmed: null, streamFailed: false });
  assert.deepEqual(runIds, ["web-run", null]);
  assert.deepEqual(transcript, [[], [saved.content]]);
});
