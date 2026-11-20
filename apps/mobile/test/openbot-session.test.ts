import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { OpenBotAdapter } from "../../../packages/backends/src/openbot.ts";

import { createOpenBotSession, type OpenBotSessionOptions } from "../src/openbot-session.ts";

const apiOrigin = "https://openbot.test";
const redirectUri = "openfuse://auth/callback";
const sessionCookie = "better-auth.session_token=native.signature";
const verifier = "a".repeat(64);
const state = "b".repeat(64);

function fixture(overrides: Partial<OpenBotSessionOptions> = {}) {
  let stored: string | null = null;
  const session = createOpenBotSession({
    apiOrigin,
    storage: {
      read: async () => stored,
      write: async (value) => {
        stored = value;
      },
      clear: async () => {
        stored = null;
      },
    },
    createProof: async () => ({
      verifier,
      state,
      challenge: createHash("sha256").update(verifier).digest("base64url"),
    }),
    openBrowser: async () => `${redirectUri}?code=one-time-code&state=${state}`,
    request: async () => {
      throw new Error("Unexpected request");
    },
    ...overrides,
  });
  return { session, stored: () => stored };
}

test("browser handoff verifies and restores the same Personal Workspace using a native cookie", async () => {
  const { session, stored } = fixture({
    openBrowser: async (url) => {
      const authorize = new URL(url);
      assert.equal(
        authorize.origin + authorize.pathname,
        `${apiOrigin}/api/auth/openfuse/authorize`,
      );
      assert.deepEqual(Object.fromEntries(authorize.searchParams), {
        client_id: "openfuse",
        redirect_uri: redirectUri,
        code_challenge: createHash("sha256").update(verifier).digest("base64url"),
        code_challenge_method: "S256",
        state,
      });
      return `${redirectUri}?code=one-time-code&state=${state}`;
    },
    request: async (url, init) => {
      assert.equal(new URL(url).origin, apiOrigin);
      assert.equal(init.credentials, "omit");
      assert.equal(init.redirect, "error");
      if (new URL(url).pathname === "/api/auth/openfuse/exchange") {
        assert.deepEqual(JSON.parse(String(init.body)), {
          code: "one-time-code",
          codeVerifier: verifier,
        });
        assert.equal(new Headers(init.headers).get("Cookie"), null);
        return Response.json({ sessionCookie });
      }
      assert.equal(new URL(url).pathname, "/api/me");
      assert.equal(new Headers(init.headers).get("Cookie"), sessionCookie);
      return Response.json({ user: { id: "person-1", name: "Ada" } });
    },
  });

  const connected = { kind: "connected", user: { id: "person-1", name: "Ada" } };
  const signedIn = await session.signIn();
  assert.equal(signedIn.kind, "connected");
  assert.deepEqual(signedIn.user, connected.user);
  assert.ok(stored());
  const restored = await session.restore();
  assert.equal(restored.kind, "connected");
  assert.deepEqual(restored.user, connected.user);
});

test("a failed native sign-out remains pending and retries revocation before restoring identity", async () => {
  let signOutAttempts = 0;
  const { session, stored } = fixture({
    request: async (url, init) => {
      switch (new URL(url).pathname) {
        case "/api/auth/openfuse/exchange":
          return Response.json({ sessionCookie });
        case "/api/auth/sign-out": {
          assert.equal(init.method, "POST");
          assert.equal(new Headers(init.headers).get("Origin"), apiOrigin);
          assert.equal(new Headers(init.headers).get("Cookie"), sessionCookie);
          return new Response(null, { status: ++signOutAttempts === 1 ? 503 : 200 });
        }
        case "/api/me":
          return Response.json({ user: { id: "person-1" } });
        default:
          throw new Error("Unexpected request");
      }
    },
  });
  assert.equal((await session.signIn()).kind, "connected");
  await assert.rejects(() => session.signOut(), /sign out/);
  assert.deepEqual(await session.restore(), { kind: "signed-out" });
  assert.equal(stored(), null);
});

test("untrusted callbacks never reach the exchange", async () => {
  for (const callback of [
    `${redirectUri}?code=one-time-code&state=wrong`,
    `${redirectUri}?code=one-time-code&state=${state}&state=${state}`,
    `${redirectUri}?code=one-time-code&state=${state}&sessionCookie=unexpected`,
    `other://auth/callback?code=one-time-code&state=${state}`,
  ]) {
    const { session, stored } = fixture({ openBrowser: async () => callback });
    await assert.rejects(() => session.signIn(), /verify the sign-in callback/);
    assert.equal(stored(), null);
  }
});

test("temporary API failure preserves a session but a 401 requires a fresh browser login", async () => {
  let meStatus = 200;
  const { session, stored } = fixture({
    request: async (url) => {
      if (new URL(url).pathname === "/api/auth/openfuse/exchange") {
        return Response.json({ sessionCookie });
      }
      return Response.json({ user: { id: "person-1" } }, { status: meStatus });
    },
  });
  assert.equal((await session.signIn()).kind, "connected");
  meStatus = 503;
  await assert.rejects(() => session.restore(), /verify your OpenBot session/);
  assert.ok(stored());
  meStatus = 401;
  assert.deepEqual(await session.restore(), { kind: "expired" });
  assert.equal(stored(), null);
  assert.deepEqual(await session.restore(), { kind: "signed-out" });
});

test("switching accounts invalidates A's in-flight history and B cannot open A's private Channel", async () => {
  const cookieB = "better-auth.session_token=account-b.signature";
  let exchanges = 0;
  const privateChannel = {
    id: "private-a",
    name: "Private",
    agentIds: ["bot"],
    active: true,
    threadId: "thread-a",
    lastMessageAt: null,
  };
  let finishHistory: (response: Response) => void = () => {};
  let startHistory: () => void = () => {};
  const historyStarted = new Promise<void>((resolve) => {
    startHistory = resolve;
  });
  const delayedHistory = new Promise<Response>((resolve) => {
    finishHistory = resolve;
  });
  const { session } = fixture({
    request: async (url, init) => {
      assert.equal(new URL(url).origin, apiOrigin);
      assert.equal(init.credentials, "omit");
      assert.equal(init.redirect, "error");
      const accountA = new Headers(init.headers).get("Cookie") === sessionCookie;
      switch (new URL(url).pathname) {
        case "/api/auth/openfuse/exchange":
          return Response.json({ sessionCookie: ++exchanges === 1 ? sessionCookie : cookieB });
        case "/api/me":
          return Response.json({ user: { id: accountA ? "account-a" : "account-b" } });
        case "/api/auth/sign-out":
          return new Response(null, { status: 204 });
        case "/api/channels":
          return Response.json({ channels: accountA ? [privateChannel] : [], nextCursor: null });
        case "/api/channels/private-a":
          return accountA
            ? Response.json({ channel: privateChannel })
            : new Response(null, { status: 404 });
        case "/api/copilotkit/agent/bot/connect":
          return accountA
            ? Response.json({ threadId: "thread-a", runId: "run-a" })
            : new Response(null, { status: 403 });
        case "/api/copilotkit/threads/thread-a/messages":
          if (!accountA) return new Response(null, { status: 403 });
          startHistory();
          return delayedHistory;
        default:
          throw new Error("Unexpected request");
      }
    },
  });

  const a = await session.signIn();
  assert.equal(a.kind, "connected");
  const adapterA = new OpenBotAdapter({ enabled: true, transport: a.transport });
  const {
    conversations: [listed],
  } = await adapterA.listConversations({});
  assert.ok(listed);
  const join = {
    method: "POST",
    body: JSON.stringify({ threadId: "thread-a" }),
  };
  const connectUrl = `${apiOrigin}/api/copilotkit/agent/bot/connect`;
  assert.equal(
    await (await a.transport.requestRuntime?.(connectUrl, join))
      ?.json()
      .then((response) => response.runId),
    "run-a",
  );
  const pending = assert.rejects(adapterA.openConversation(listed.channelId), { status: 401 });
  await historyStarted;
  await session.signOut();

  const b = await session.signIn();
  assert.equal(b.kind, "connected");
  const adapterB = new OpenBotAdapter({ enabled: true, transport: b.transport });
  assert.deepEqual(await adapterB.listConversations({}), { conversations: [], nextCursor: null });
  await assert.rejects(adapterB.openConversation(listed.channelId), { status: 404 });
  assert.equal(
    (await b.transport.request("/api/copilotkit/threads/thread-a/messages?agentId=bot")).status,
    403,
  );
  assert.equal((await b.transport.requestRuntime?.(connectUrl, join))?.status, 403);
  assert.equal((await a.transport.requestRuntime?.(connectUrl, join))?.status, 401);
  finishHistory(Response.json({ messages: [{ id: "1", role: "user", content: "Private" }] }));
  await pending;
  await assert.rejects(adapterA.listConversations({}), { status: 401 });
  await assert.rejects(b.transport.request("//other.example/api/channels"));
});

test("the SDK transport scopes runtime requests to the signed-in OpenBot origin", async () => {
  const requests: string[] = [];
  const { session } = fixture({
    request: async (url, init) => {
      const path = new URL(url).pathname;
      if (path === "/api/auth/openfuse/exchange") return Response.json({ sessionCookie });
      if (path === "/api/me") return Response.json({ user: { id: "person-1" } });
      requests.push(path);
      assert.equal(init.credentials, "omit");
      assert.equal(init.redirect, "error");
      assert.equal(new Headers(init.headers).get("Cookie"), sessionCookie);
      return new Response(null, { status: 204 });
    },
  });
  const connected = await session.signIn();
  assert.equal(connected.kind, "connected");
  const request = connected.transport.requestRuntime;
  assert.ok(request);
  const path = "/api/copilotkit/agent/bot/connect";
  await assert.rejects(request(`https://other.example${path}`, { method: "POST" }));
  await assert.rejects(request(`${apiOrigin}/api/copilotkit/agent/bot/stop`, { method: "POST" }));
  assert.equal((await request(`${apiOrigin}${path}`, { method: "POST", body: "{}" })).status, 204);
  await session.restore();
  assert.equal((await request(`${apiOrigin}${path}`, { method: "POST" })).status, 401);
  assert.deepEqual(requests, [path]);
});

test("the native session can create a direct Conversation and rejects unrelated writes", async () => {
  const channel = { id: "channel", threadId: "thread", agentIds: ["bot"] };
  const { session } = fixture({
    request: async (url, init) => {
      if (url === `${apiOrigin}/api/auth/openfuse/exchange`)
        return Response.json({ sessionCookie });
      if (url === `${apiOrigin}/api/me`) return Response.json({ user: { id: "person-1" } });
      assert.equal(url, `${apiOrigin}/api/channels`);
      assert.equal(init.method, "POST");
      assert.equal(new Headers(init.headers).get("Cookie"), sessionCookie);
      assert.deepEqual(JSON.parse(init.body ?? ""), { agentIds: ["bot"] });
      return Response.json({ channel }, { status: 201 });
    },
  });
  const connected = await session.signIn();
  assert.equal(connected.kind, "connected");
  const adapter = new OpenBotAdapter({ enabled: true, transport: connected.transport });
  assert.deepEqual(await adapter.createConversation("bot"), {
    channelId: channel.id,
    threadId: channel.threadId,
    agentIds: channel.agentIds,
  });
  await assert.rejects(
    connected.transport.request("/api/approvals", { method: "POST", body: "{}" }),
    /Invalid OpenBot workspace request/,
  );
});
