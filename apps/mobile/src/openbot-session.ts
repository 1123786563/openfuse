import { z } from "zod";

export const openBotRedirectUri = "openfuse://auth/callback";

const cookie = z.string().regex(/^[A-Za-z0-9_.-]+=[!#-+\--:<-[\]-~]+$/);
const identity = z.object({
  user: z.object({ id: z.string().min(1).brand<"OpenBotUserId">(), name: z.string().optional() }),
});
const storedSession = z.object({ sessionCookie: cookie, signingOut: z.boolean() });

type Credential = z.infer<typeof storedSession>;
type SessionRequest = Pick<RequestInit, "credentials" | "redirect"> & {
  body?: string;
  headers?: Record<string, string>;
  method?: "POST";
};

export type OpenBotSessionState =
  | { kind: "signed-out" }
  | { kind: "expired" }
  | { kind: "connected"; user: z.infer<typeof identity>["user"] };

export type OpenBotSessionOptions = {
  apiOrigin: string;
  storage: {
    read: () => Promise<string | null>;
    write: (value: string) => Promise<void>;
    clear: () => Promise<void>;
  };
  createProof: () => Promise<{ state: string; verifier: string; challenge: string }>;
  openBrowser: (url: string) => Promise<string | null>;
  request: (url: string, init: SessionRequest) => Promise<Pick<Response, "ok" | "status" | "json">>;
};

export function parseOpenBotOrigin(value: string, allowLocalHttp = false) {
  const url = new URL(value);
  const localHttp =
    allowLocalHttp &&
    url.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]", "10.0.2.2"].includes(url.hostname);
  if (
    (!localHttp && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.href !== `${url.origin}/`
  ) {
    throw new Error("Configure an HTTPS OpenBot origin.");
  }
  return url.origin;
}

export function createOpenBotSession({
  apiOrigin,
  storage,
  createProof,
  openBrowser,
  request,
}: OpenBotSessionOptions) {
  async function send(path: string, init: SessionRequest) {
    return request(apiOrigin + path, { ...init, credentials: "omit", redirect: "error" });
  }

  async function readCredential() {
    const saved = await storage.read();
    return saved ? storedSession.parse(JSON.parse(saved)) : null;
  }

  async function revoke(credential: Credential): Promise<OpenBotSessionState> {
    if (!credential.signingOut) {
      await storage.write(JSON.stringify({ ...credential, signingOut: true }));
    }
    const response = await send("/api/auth/sign-out", {
      method: "POST",
      headers: { Cookie: credential.sessionCookie, Origin: apiOrigin },
    });
    if (!response.ok && response.status !== 401) throw new Error("Could not sign out of OpenBot.");
    await storage.clear();
    return { kind: "signed-out" };
  }

  async function restore(): Promise<OpenBotSessionState> {
    const credential = await readCredential();
    if (!credential) return { kind: "signed-out" };
    return credential.signingOut ? revoke(credential) : verify(credential);
  }

  async function verify(credential: Credential): Promise<OpenBotSessionState> {
    const response = await send("/api/me", { headers: { Cookie: credential.sessionCookie } });
    if (response.status === 401) {
      await storage.clear();
      return { kind: "expired" };
    }
    if (!response.ok) throw new Error("Could not verify your OpenBot session.");
    const result = identity.parse(await response.json());
    return { kind: "connected", user: result.user };
  }

  return {
    async signIn(): Promise<OpenBotSessionState> {
      if (await readCredential()) return restore();
      const { state, verifier, challenge } = await createProof();
      const authorize = new URL("/api/auth/openfuse/authorize", apiOrigin);
      authorize.search = new URLSearchParams({
        client_id: "openfuse",
        redirect_uri: openBotRedirectUri,
        code_challenge: challenge,
        code_challenge_method: "S256",
        state,
      }).toString();
      const callback = await openBrowser(authorize.href);
      if (!callback) return { kind: "signed-out" };

      const url = new URL(callback);
      const [code] = url.searchParams.getAll("code");
      let parameterCount = 0;
      url.searchParams.forEach(() => {
        parameterCount += 1;
      });
      if (
        !code ||
        url.searchParams.getAll("code").length !== 1 ||
        url.searchParams.getAll("state").length !== 1 ||
        url.searchParams.get("state") !== state ||
        parameterCount !== 2 ||
        url.hash ||
        callback.split("?")[0] !== openBotRedirectUri
      ) {
        throw new Error("OpenBot could not verify the sign-in callback. Sign in again.");
      }
      const response = await send("/api/auth/openfuse/exchange", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, codeVerifier: verifier }),
      });
      if (!response.ok) throw new Error("OpenBot could not complete sign-in. Sign in again.");
      const { sessionCookie } = z.object({ sessionCookie: cookie }).parse(await response.json());
      const credential = { sessionCookie, signingOut: false };
      await storage.write(JSON.stringify(credential));
      return verify(credential);
    },

    restore,

    async signOut(): Promise<OpenBotSessionState> {
      const credential = await readCredential();
      return credential ? revoke(credential) : { kind: "signed-out" };
    },
  };
}
