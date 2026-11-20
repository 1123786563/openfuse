import { fetch } from "expo/fetch";
import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import * as WebBrowser from "expo-web-browser";
import { createOpenBotSession, openBotRedirectUri, parseOpenBotOrigin } from "./openbot-session";

export function configureOpenBotSession() {
  const configuredOrigin = process.env.EXPO_PUBLIC_OPENBOT_API_ORIGIN;
  if (!configuredOrigin) return null;

  const apiOrigin = parseOpenBotOrigin(configuredOrigin, __DEV__);
  const key = async () => {
    const digest = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, apiOrigin);
    return `openbot.session.${digest}`;
  };
  return createOpenBotSession({
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
      const timer = setTimeout(() => abort.abort(), 12_000);
      try {
        const response = await fetch(url, { ...init, signal: abort.signal });
        // Drain the body while the deadline is active as well.
        const body = await response.text();
        return { ok: response.ok, status: response.status, json: async () => JSON.parse(body) };
      } finally {
        clearTimeout(timer);
      }
    },
  });
}

async function randomHex() {
  const bytes = await Crypto.getRandomBytesAsync(32);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
