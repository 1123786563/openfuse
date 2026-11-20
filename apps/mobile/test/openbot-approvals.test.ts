import assert from "node:assert/strict";
import test from "node:test";
import { OpenBotAdapter } from "../../../packages/backends/src/openbot.ts";
import { openBotConversationUrl } from "../src/openbot-conversation-url.ts";

test("the opened Thread tracks an approval until its continuation completes", async () => {
  let status = "pending";
  const adapter = new OpenBotAdapter({
    enabled: true,
    transport: {
      runtimeUrl: "https://openbot.test/api/copilotkit",
      async request(path, init) {
        assert.equal(init?.method, "GET");
        switch (path) {
          case "/api/channels?limit=30":
            return Response.json({
              channels: [{ id: "channel-1", name: "Bot", active: true, agentIds: ["bot"] }],
              nextCursor: null,
            });
          case "/api/channels/channel-1":
            return Response.json({
              channel: {
                id: "channel-1",
                active: true,
                agentIds: ["bot"],
                threadId: "thread-1",
                lastMessageAt: null,
              },
            });
          case "/api/copilotkit/threads/thread-1/messages?agentId=bot":
            return Response.json({ messages: [] });
          case "/api/approvals?threadId=thread-1":
            return Response.json({
              requests: [
                {
                  id: "approval",
                  status,
                  action: { threadId: "thread-1", args: { preview: "private" } },
                },
                { id: "unrelated", status: "pending", action: { threadId: "channel-1" } },
              ],
            });
          default:
            assert.fail(`Unexpected request: ${path}`);
        }
      },
    },
  });

  const { conversations } = await adapter.listConversations({});
  const [conversation] = conversations;
  assert.ok(conversation);
  const history = await adapter.openConversation(conversation.channelId);
  for (const decision of ["pending", "approved", "denied", "consumed"]) {
    status = decision;
    assert.deepEqual(await adapter.listUnsettledApprovals(history.threadId), [
      { id: "approval", status: decision },
    ]);
  }
  status = "completed";
  assert.deepEqual(await adapter.listUnsettledApprovals(history.threadId), []);
});

test("Web links use the verified deployment and keep the Channel ID in one path segment", async () => {
  const adapter = new OpenBotAdapter({
    enabled: true,
    transport: {
      runtimeUrl: "https://openbot.test:8443/api/copilotkit",
      request: async () =>
        Response.json({
          channels: ["channel?view=#other", "..", "new", "nested/channel"].map((id) => ({
            id,
            name: id,
            active: true,
            agentIds: ["bot"],
          })),
          nextCursor: null,
        }),
    },
  });
  const { conversations } = await adapter.listConversations({});
  const [channel, dot, reserved, nested] = conversations;
  assert.ok(channel && dot && reserved && nested);
  const webOrigin = "https://openbot.test:8443";
  assert.equal(
    openBotConversationUrl({ webOrigin, channelId: channel.channelId }),
    "https://openbot.test:8443/channel/channel%3Fview%3D%23other",
  );
  for (const unsafe of [dot, reserved, nested]) {
    assert.throws(() => openBotConversationUrl({ webOrigin, channelId: unsafe.channelId }));
  }
  assert.throws(() =>
    openBotConversationUrl({ webOrigin: "file:///tmp/openbot", channelId: channel.channelId }),
  );
});
