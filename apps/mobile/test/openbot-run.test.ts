import assert from "node:assert/strict";
import test from "node:test";
import { OpenBotAdapter } from "../../../packages/backends/src/openbot.ts";
import { observeOpenBotRun, syncOpenBotRun } from "../src/openbot-run.ts";

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
