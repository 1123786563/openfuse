import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
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
  assert.deepEqual(await session.signIn(), connected);
  assert.ok(stored());
  assert.deepEqual(await session.restore(), connected);
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
