import { fetch } from "expo/fetch";
import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import * as WebBrowser from "expo-web-browser";
import { createOpenBotSession, openBotRedirectUri, parseOpenBotOrigins } from "./openbot-session";

export function configureOpenBotSession() {
  const { apiOrigin, webOrigin } = parseOpenBotOrigins({
    api: process.env.EXPO_PUBLIC_OPENBOT_API_ORIGIN,
    web: process.env.EXPO_PUBLIC_OPENBOT_WEB_ORIGIN,
    allowLocalHttp: __DEV__,
  });
  const key = async () => {
    const digest = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, apiOrigin);
    return `openbot.session.${digest}`;
  };
  const session = createOpenBotSession({
    apiOrigin,
    storage: {
      read: async () => SecureStore.getItemAsync(await key()),
      write: async (value) =>
        SecureStore.setItemAsync(await key(), value, {
          keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
        }),
      clear: async () => SecureStore.deleteItemAsync(await key()),
    },
    createProof: async () => {
      const [verifier, state] = await Promise.all([randomHex(), randomHex()]);
      const digest = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, verifier, {
        encoding: Crypto.CryptoEncoding.BASE64,
      });
      return {
        verifier,
        state,
        challenge: digest.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
      };
    },
    openBrowser: async (url) => {
      const result = await WebBrowser.openAuthSessionAsync(url, openBotRedirectUri);
      return result.type === "success" ? result.url : null;
    },
    request: async (url, init) => {
      const abort = new AbortController();
      const signal = init.signal;
      const cancel = () => abort.abort();
      if (signal?.aborted) cancel();
      else signal?.addEventListener("abort", cancel);
      const timer = setTimeout(() => abort.abort(), 12_000);
      try {
        const response = await fetch(url, { ...init, signal: abort.signal });
        // Drain the body while the deadline is active as well.
        const body = await response.text();
        return new Response(body || null, { status: response.status, headers: response.headers });
      } finally {
        signal?.removeEventListener("abort", cancel);
        clearTimeout(timer);
      }
    },
  });
  return { ...session, webOrigin };
}

async function randomHex() {
  const bytes = await Crypto.getRandomBytesAsync(32);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
