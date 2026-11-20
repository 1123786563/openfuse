import assert from "node:assert/strict";
import test from "node:test";
import { OpenBotAdapter } from "../../../packages/backends/src/openbot";
import { createOpenBotConversation } from "../src/openbot-create-conversation";

function fixture(outcome: "created" | "lost" | "refused", pinned = false) {
  const requests: string[] = [];
  let channelCreated = false;
  let listAvailable = true;
  const adapter = new OpenBotAdapter({
    enabled: true,
    transport: {
      runtimeUrl: "https://openbot.example/api/copilotkit",
      async request(path, init) {
        requests.push(`${init?.method} ${path}`);
        if (path === "/api/agents") {
          return Response.json({ agents: [{ id: "bot-1", name: "Research" }] });
        }
        if (path === "/api/channels" && init?.method === "POST") {
          assert.deepEqual(JSON.parse(String(init.body)), { agentIds: ["bot-1"] });
          if (outcome === "refused") {
            return Response.json({ error: "Access denied" }, { status: 403 });
          }
          channelCreated = true;
          if (outcome === "lost") throw new Error("Response lost after commit");
          return Response.json(
            {
              channel: { id: "channel-1", threadId: "thread-9", agentIds: ["bot-1"] },
            },
            { status: 201 },
          );
        }
        if (pinned && path === "/api/channels?limit=30") {
          return Response.json({
            channels: [{ id: "pinned", name: "Pinned", active: true, agentIds: ["bot-1"] }],
            nextCursor: "next",
          });
        }
        assert.equal(
          path,
          pinned ? "/api/channels?limit=30&cursor=next" : "/api/channels?limit=30",
        );
        if (!listAvailable) return Response.json({}, { status: 503 });
        return Response.json({
          channels: channelCreated
            ? [{ id: "channel-1", name: "Research", active: true, agentIds: ["bot-1"] }]
            : [],
          nextCursor: null,
        });
      },
    },
  });
  return {
    adapter,
    requests,
    setListAvailable: (available: boolean) => {
      listAvailable = available;
    },
  };
}

test("an uncertain creation refreshes Conversations and exposes the committed Channel", async () => {
  const { adapter, requests } = fixture("lost");
  const [bot] = await adapter.listBots();
  assert.ok(bot);
  const result = await createOpenBotConversation(adapter, { kind: "create", bot });
  assert.deepEqual(result, {
    kind: "reconciled",
    page: { conversations: [{ channelId: "channel-1", title: "Research" }], nextCursor: null },
  });
  assert.deepEqual(requests, [
    "GET /api/agents",
    "POST /api/channels",
    "GET /api/channels?limit=30",
  ]);
});

test("when the list is unavailable after a lost response, checking again only reads", async () => {
  const { adapter, requests, setListAvailable } = fixture("lost");
  const [bot] = await adapter.listBots();
  assert.ok(bot);
  setListAvailable(false);
  assert.deepEqual(await createOpenBotConversation(adapter, { kind: "create", bot }), {
    kind: "needs_refresh",
  });

  setListAvailable(true);
  assert.deepEqual(await createOpenBotConversation(adapter, { kind: "refresh" }), {
    kind: "reconciled",
    page: { conversations: [{ channelId: "channel-1", title: "Research" }], nextCursor: null },
  });
  assert.deepEqual(requests, [
    "GET /api/agents",
    "POST /api/channels",
    "GET /api/channels?limit=30",
    "GET /api/channels?limit=30",
  ]);
});

test("creation opens the returned Channel and a refusal does not trigger reconciliation", async () => {
  const created = fixture("created");
  const [bot] = await created.adapter.listBots();
  assert.ok(bot);
  assert.deepEqual(await createOpenBotConversation(created.adapter, { kind: "create", bot }), {
    kind: "created",
    conversation: { channelId: "channel-1", title: "Research" },
  });
  assert.deepEqual(created.requests, ["GET /api/agents", "POST /api/channels"]);

  const refused = fixture("refused");
  await assert.rejects(createOpenBotConversation(refused.adapter, { kind: "create", bot }), {
    code: "refused",
  });
  assert.deepEqual(refused.requests, ["POST /api/channels"]);
});

test("uncertain creation stays guarded until later pages are checked", async () => {
  const { adapter, requests, setListAvailable } = fixture("lost", true);
  const [bot] = await adapter.listBots();
  assert.ok(bot);
  setListAvailable(false);
  assert.deepEqual(await createOpenBotConversation(adapter, { kind: "create", bot }), {
    kind: "needs_refresh",
  });
  setListAvailable(true);
  assert.deepEqual(await createOpenBotConversation(adapter, { kind: "refresh" }), {
    kind: "reconciled",
    page: {
      conversations: [
        { channelId: "pinned", title: "Pinned" },
        { channelId: "channel-1", title: "Research" },
      ],
      nextCursor: null,
    },
  });
  assert.equal(requests.filter((request) => request.startsWith("POST")).length, 1);
});
