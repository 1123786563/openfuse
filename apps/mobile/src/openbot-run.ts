import { ProxiedCopilotRuntimeAgent } from "@copilotkit/core";
import { z } from "zod";
import {
  type OpenBotAdapter,
  OpenBotError,
  type OpenBotTransport,
} from "../../../packages/backends/src/openbot";

export type OpenBotHistory = Awaited<ReturnType<OpenBotAdapter["openConversation"]>>;
type TextMessage = OpenBotHistory["messages"][number];
export type OpenBotSend = { id: string; text: string };

const connection = z.object({
  threadId: z.string().min(1),
  runId: z.string().min(1).nullish(),
});

export async function stopOpenBotRun({
  history,
  runId,
  transport,
  signal,
}: {
  history: Pick<OpenBotHistory, "agentId" | "threadId">;
  runId: string;
  transport: OpenBotTransport;
  signal: AbortSignal;
}) {
  if (!transport.requestRuntime) {
    throw new OpenBotError("not_configured", "OpenBot runtime is unavailable.");
  }
  const { agentId, threadId } = history;
  const response = await transport.requestRuntime(
    `${transport.runtimeUrl}/agent/${encodeURIComponent(agentId)}/stop/${encodeURIComponent(threadId)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runId }),
      signal,
    },
  );
  if (!response.ok) {
    const code =
      response.status === 401
        ? "authentication_required"
        : response.status === 403 || response.status === 404
          ? "refused"
          : "http_error";
    throw new OpenBotError(code, "OpenBot could not stop the run.", response.status);
  }
}

export async function observeOpenBotRun({
  history,
  transport,
  signal,
  send,
  onMessages,
  onRun,
}: {
  history: OpenBotHistory;
  transport: OpenBotTransport;
  signal: AbortSignal;
  send?: OpenBotSend;
  onMessages: (messages: TextMessage[]) => void;
  onRun: (runId: string | null) => void;
}) {
  const request = transport.requestRuntime;
  if (!request) throw new OpenBotError("not_configured", "OpenBot runtime is unavailable.");
  if (send && !history.runMessages) {
    throw new OpenBotError(
      "invalid_response",
      "This conversation can be continued in OpenBot Web.",
    );
  }

  // REST returns the canonical identity and short-lived socket token. The SDK
  // owns WebSocket transport, event application, and reconnect cursors.
  let requestError: unknown;
  let streamFailed = false;
  const agent = new ProxiedCopilotRuntimeAgent({
    runtimeUrl: transport.runtimeUrl,
    runtimeMode: "pending",
    transport: "rest",
    credentials: "omit",
    agentId: history.agentId,
    threadId: history.threadId,
    // A join can replay the whole thread. Keep saved history outside the SDK until
    // reconciliation so text deltas never append to an already populated message.
    initialMessages: send ? (history.runMessages ?? []) : [],
    fetch: async (url, init) => {
      try {
        if (signal.aborted) throw new OpenBotError("cancelled", "OpenBot observation ended.");
        const response = await request(url, { ...init, signal });
        if (signal.aborted) throw new OpenBotError("cancelled", "OpenBot observation ended.");
        if (!response.ok) {
          const code =
            response.status === 401
              ? "authentication_required"
              : response.status === 403
                ? "refused"
                : "http_error";
          throw new OpenBotError(code, "OpenBot could not open the run.", response.status);
        }
        if (init.method === "POST" && response.status !== 204) {
          const joined = connection.parse(await response.clone().json());
          if (signal.aborted) throw new OpenBotError("cancelled", "OpenBot observation ended.");
          if (joined.threadId !== history.threadId) {
            throw new OpenBotError("invalid_response", "OpenBot returned a different Thread.");
          }
          if (joined.runId) onRun(joined.runId);
        }
        return response;
      } catch (error) {
        requestError = error;
        throw error;
      }
    },
  });

  const subscription = agent.subscribe({
    onMessagesChanged: ({ messages }) => {
      if (signal.aborted) return;
      const visible = new Map(history.messages.map((message) => [message.id, message]));
      for (const { id, role, content } of messages) {
        if ((role === "user" || role === "assistant") && typeof content === "string" && content) {
          visible.set(id, { id, role, text: content });
        }
      }
      onMessages([...visible.values()]);
    },
    onRunErrorEvent: () => {
      if (send) streamFailed = true;
    },
    onRunFailed: () => {
      streamFailed = true;
    },
  });
  const detach = () => {
    void agent.detachActiveRun();
  };
  signal.addEventListener("abort", detach);
  try {
    if (signal.aborted) throw new OpenBotError("cancelled", "OpenBot observation ended.");
    if (send) {
      agent.addMessage({ id: send.id, role: "user", content: send.text });
      await agent.runAgent({});
    } else {
      await agent.connectAgent({});
    }
    if (requestError) throw requestError;
    return { streamFailed };
  } catch (error) {
    throw requestError ?? error;
  } finally {
    if (!signal.aborted) onRun(null);
    signal.removeEventListener("abort", detach);
    subscription.unsubscribe();
    await agent.detachActiveRun();
  }
}

/** A send has landed only when the durable transcript contains its exact message ID. */
export function unconfirmedOpenBotSend(send: OpenBotSend | null, history: OpenBotHistory) {
  return send && !history.messages.some(({ id }) => id === send.id) ? send : null;
}

export async function syncOpenBotRun({
  read,
  observe,
  send,
  pending,
}: {
  read: () => Promise<OpenBotHistory>;
  observe: (history: OpenBotHistory, send?: OpenBotSend) => Promise<{ streamFailed: boolean }>;
  send?: OpenBotSend;
  pending: OpenBotSend | null;
}) {
  const saved = await read();
  let streamFailed = false;
  let beforeJoin = saved;
  let unresolved = pending;
  // A previous send may have appeared after the user opened the draft for review.
  if (
    send &&
    saved.runMessages &&
    (!pending || send.text !== pending.text || unconfirmedOpenBotSend(pending, saved))
  ) {
    unresolved = send;
    try {
      ({ streamFailed } = await observe(saved, send));
    } catch (error) {
      if (
        error instanceof OpenBotError &&
        (error.code === "authentication_required" || error.code === "refused")
      )
        throw error;
      // A request with a lost response or an occupied thread is reconciled by joining.
    }
    beforeJoin = await read();
  }
  const joined = await observe(beforeJoin);
  const finalHistory = await read();
  if (joined.streamFailed) throw new Error("Could not rejoin the OpenBot run.");
  return { unconfirmed: unconfirmedOpenBotSend(unresolved, finalHistory), streamFailed };
}
