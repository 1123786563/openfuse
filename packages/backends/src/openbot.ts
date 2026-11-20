import { MessageSchema } from "@ag-ui/core";
import { z } from "zod";

/** Original adapter contract reference. See mobile/OPENBOT.md for connected-mode requirements. */
export const OPENBOT_CONTRACT_REF = "a96d88c6fb75385842529d7db7d463f4a8c4a86e";

/**
 * Inject an authenticated, per-person transport from the host application.
 * Paths are relative to the OpenBot deployment. The transport owns its session;
 * this adapter never accepts a shared administrator token or calls global fetch.
 */
export interface OpenBotTransport {
  runtimeUrl: string;
  requestRuntime?(url: string, init: RequestInit): Promise<Response>;
  request(path: string, init?: RequestInit): Promise<Pick<Response, "ok" | "status" | "json">>;
}

export type OpenBotErrorCode =
  | "disabled"
  | "not_configured"
  | "unsupported_gateway"
  | "invalid_input"
  | "invalid_response"
  | "authentication_required"
  | "refused"
  | "http_error"
  | "unavailable"
  | "cancelled";

export function openBotHttpErrorCode(status: number): OpenBotErrorCode {
  switch (status) {
    case 401:
      return "authentication_required";
    case 403:
      return "refused";
    default:
      return "http_error";
  }
}

export class OpenBotError extends Error {
  constructor(
    readonly code: OpenBotErrorCode,
    message: string,
    readonly status?: number,
    readonly rule?: string,
    /** An action may have happened. Reconcile before offering another attempt. */
    readonly outcomeUnknown = false,
  ) {
    super(message);
    this.name = "OpenBotError";
  }
}

const nonempty = z.string().min(1);
const capabilitiesSchema = z.object({
  mode: z.literal("intelligence"),
  durableHistory: z.boolean(),
  generativeUi: z.boolean(),
});
const userSchema = z.object({ user: z.object({ id: nonempty }) });
const computerStatusSchema = z.object({
  botId: nonempty,
  state: z.enum(["absent", "starting", "ready", "unreachable"]),
  reason: z.string().optional(),
});
const controlSchema = z.object({
  holder: z.enum(["bot", "human"]),
  since: nonempty,
  requested: z.boolean(),
  reason: z.string().optional(),
  requestedAt: z.string().optional(),
  secretWanted: z.string().optional(),
});
const snapshotSchema = z.object({
  snapshotId: z.number().int().nonnegative(),
  url: nonempty,
  title: z.string(),
  truncated: z.boolean(),
  elements: z.array(
    z.object({
      ref: nonempty,
      role: z.string(),
      name: z.string(),
      value: z.string().optional(),
      type: z.string().optional(),
      disabled: z.boolean().optional(),
      checked: z.boolean().optional(),
    }),
  ),
});
const navigationSchema = z.object({
  url: nonempty,
  title: z.string(),
  text: z.string(),
  truncated: z.boolean(),
  elapsedMs: z.number().nonnegative(),
});
const channelListEntry = z.object({
  id: nonempty.brand<"OpenBotChannelId">(),
  name: nonempty,
  active: z.boolean(),
  agentIds: z.array(nonempty),
  summary: z.string().nullish(),
  opening: z.string().nullish(),
});
const botRoster = z.object({
  agents: z.array(z.object({ id: nonempty.brand<"OpenBotAgentId">(), name: nonempty })),
});
const channelSchema = z.object({
  channel: channelListEntry.pick({ id: true }).extend({
    threadId: nonempty.brand<"OpenBotThreadId">(),
    agentIds: z.array(nonempty).min(1),
  }),
});
const channelPage = z.object({
  channels: z.array(channelListEntry),
  nextCursor: nonempty.nullable(),
});
const openedChannel = z.object({
  channel: channelListEntry.pick({ id: true, active: true, agentIds: true }).extend({
    threadId: nonempty.brand<"OpenBotThreadId">(),
    lastMessageAt: z.string().nullable(),
  }),
});
const userContent = z.union([
  z.string(),
  z.array(
    z.discriminatedUnion("type", [
      z.looseObject({ type: z.literal("text"), text: z.string() }),
      z.looseObject({ type: z.literal("image") }),
      z.looseObject({ type: z.literal("audio") }),
      z.looseObject({ type: z.literal("video") }),
      z.looseObject({ type: z.literal("document") }),
      z.looseObject({ type: z.literal("binary") }),
    ]),
  ),
]);
const threadHistory = z.object({
  messages: z.array(
    z.discriminatedUnion("role", [
      z.looseObject({ id: nonempty, role: z.literal("user"), content: userContent }),
      z.looseObject({ id: nonempty, role: z.literal("assistant"), content: z.string().nullish() }),
      z.looseObject({
        id: nonempty,
        role: z.enum(["tool", "system", "developer", "activity", "reasoning"]),
      }),
    ]),
  ),
});
export type OpenBotChannelId = z.infer<typeof channelListEntry>["id"];
type OpenBotThreadId = z.infer<typeof openedChannel>["channel"]["threadId"];
const approvalInbox = z.object({
  requests: z.array(
    z.object({
      id: nonempty,
      status: z.enum(["pending", "approved", "denied", "consumed", "completed"]),
      action: z.object({ threadId: z.string() }),
    }),
  ),
});
const errorSchema = z.object({ error: z.string().optional(), rule: z.string().optional() });

export type OpenBotComputerStatus = z.infer<typeof computerStatusSchema>;
export type OpenBotControl = z.infer<typeof controlSchema>;
export type OpenBotSnapshot = z.infer<typeof snapshotSchema>;
export type OpenBotNavigation = z.infer<typeof navigationSchema>;
export type OpenBotProbe =
  | { state: "disabled" | "not_configured" | "authentication_required" }
  | { state: "unavailable"; reason: string }
  | ({ state: "authenticated"; userId: string } & z.infer<typeof capabilitiesSchema>);

/**
 * Future integration seam; constructing it does not connect to OpenBot.
 * The caller must enforce OpenFuse proposals before dispatching external writes.
 * OpenBot's own policy/audit gateway remains authoritative for every request.
 */
export class OpenBotAdapter {
  readonly unsupportedCapabilities = Object.freeze([
    "gmail",
    "calendar",
    "pdf",
    "approval_persistence",
  ] as const);

  constructor(
    private readonly options: {
      enabled?: boolean;
      agentId?: string;
      transport?: OpenBotTransport;
    } = {},
  ) {}

  /** Configure a compatible public CopilotKit client. This is NOT an AG-UI SSE URL. */
  runtime() {
    const transport = this.requireTransport();
    if (!this.options.agentId?.trim()) {
      throw new OpenBotError(
        "not_configured",
        "Choose an OpenBot agent before configuring its runtime.",
      );
    }
    const runtimeUrl = httpUrl(transport.runtimeUrl);
    return {
      runtimeUrl,
      agentId: identifier(this.options.agentId),
      mode: "intelligence" as const,
      credentials: "include" as const,
    };
  }

  /** Authenticated API reachability, not evidence that a model can complete a run. */
  async probe(signal?: AbortSignal): Promise<OpenBotProbe> {
    if (this.options.enabled !== true) return { state: "disabled" };
    if (!this.options.transport) return { state: "not_configured" };
    try {
      const { user } = await this.json("/api/me", userSchema, { signal });
      const capabilities = await this.json("/api/capabilities", capabilitiesSchema, { signal });
      return { state: "authenticated", userId: user.id, ...capabilities };
    } catch (error) {
      if (!(error instanceof OpenBotError)) throw error;
      if (error.code === "authentication_required") return { state: "authentication_required" };
      return { state: "unavailable", reason: error.message };
    }
  }

  async listBots(signal?: AbortSignal) {
    const { agents } = await this.json("/api/agents", botRoster, { signal });
    return agents;
  }

  async listConversations({ cursor, signal }: { cursor?: string; signal?: AbortSignal }) {
    const query = new URLSearchParams({ limit: "30" });
    if (cursor !== undefined) query.set("cursor", cursor);
    const page = await this.json(`/api/channels?${query}`, channelPage, { signal });
    return {
      conversations: page.channels
        .filter((channel) => channel.active && channel.agentIds.length === 1)
        .map((channel) => ({
          channelId: channel.id,
          title: channel.summary || channel.opening || channel.name,
        })),
      nextCursor: page.nextCursor,
    };
  }

  async openConversation(channelId: OpenBotChannelId, signal?: AbortSignal) {
    const id = identifier(channelId);
    const channel = await this.readDirectChannel(id, signal);
    const { messages } = await this.json(
      `/api/copilotkit/threads/${encodeURIComponent(identifier(channel.threadId))}/messages?agentId=${encodeURIComponent(identifier(channel.agentId))}`,
      threadHistory,
      { signal },
    ).catch(async (error: unknown) => {
      if (!(error instanceof OpenBotError) || error.status !== 404) throw error;
      const current = await this.readDirectChannel(id, signal);
      // Intelligence creates the Thread on its first run. Confirm the mapping survived the
      // history request, and report an error if the Channel already has recorded activity.
      if (
        error.message === "Failed to fetch thread messages" &&
        channel.threadId === current.threadId &&
        channel.agentId === current.agentId &&
        channel.lastMessageAt === null &&
        current.lastMessageAt === null
      ) {
        return { messages: [] };
      }
      throw new OpenBotError("unavailable", "Could not load OpenBot conversation history.");
    });
    let hasNonTextMessages = false;
    const transcript = messages.flatMap((message) => {
      if (message.role !== "user" && message.role !== "assistant") {
        hasNonTextMessages = true;
        return [];
      }
      const { id, role, content } = message;
      const text = Array.isArray(content)
        ? content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")
        : content;
      if (!text || (Array.isArray(content) && content.some((part) => part.type !== "text"))) {
        hasNonTextMessages = true;
      }
      return text ? [{ id, role, text }] : [];
    });
    const runMessages = MessageSchema.array().safeParse(
      messages.map((message) =>
        message.role === "assistant" && message.content === null
          ? { ...message, content: undefined }
          : message,
      ),
    );
    return {
      channelId: channel.id,
      threadId: channel.threadId,
      agentId: channel.agentId,
      runMessages: runMessages.success ? runMessages.data : null,
      messages: transcript,
      hasNonTextMessages,
    };
  }

  async listUnsettledApprovals(threadId: OpenBotThreadId, signal?: AbortSignal) {
    const query = new URLSearchParams({ threadId });
    const { requests } = await this.json(`/api/approvals?${query}`, approvalInbox, { signal });
    return requests
      .filter((request) => request.action.threadId === threadId && request.status !== "completed")
      .map(({ id, status }) => ({ id, status }));
  }

  private async readDirectChannel(id: string, signal?: AbortSignal) {
    const { channel } = await this.json(`/api/channels/${encodeURIComponent(id)}`, openedChannel, {
      signal,
    }).catch((error: unknown) => {
      if (error instanceof OpenBotError && error.status === 404) {
        throw new OpenBotError("refused", "This OpenBot conversation is unavailable.", 404);
      }
      throw error;
    });
    if (channel.id !== id) {
      throw new OpenBotError("invalid_response", "OpenBot returned a different Channel.");
    }
    const [agentId] = channel.agentIds;
    if (!channel.active || channel.agentIds.length !== 1 || !agentId) {
      throw new OpenBotError("refused", "This OpenBot conversation is unavailable.");
    }
    return { ...channel, agentId };
  }

  async createConversation(agentId: string, signal?: AbortSignal) {
    const id = identifier(agentId);
    const { channel } = await this.json(
      "/api/channels",
      channelSchema,
      {
        method: "POST",
        body: JSON.stringify({ agentIds: [id] }),
        signal,
      },
      true,
    );
    if (channel.agentIds.length !== 1 || channel.agentIds[0] !== id) {
      throw new OpenBotError(
        "invalid_response",
        "OpenBot returned a channel for a different agent.",
        undefined,
        undefined,
        true,
      );
    }
    return { channelId: channel.id, threadId: channel.threadId, agentIds: channel.agentIds };
  }

  async computerStatus(botId: string, signal?: AbortSignal): Promise<OpenBotComputerStatus> {
    const result = await this.json(computerPath(botId, "status"), computerStatusSchema, { signal });
    if (result.botId !== botId.trim()) {
      throw new OpenBotError("invalid_response", "OpenBot returned another Bot's computer status.");
    }
    return result;
  }

  snapshot(botId: string, signal?: AbortSignal): Promise<OpenBotSnapshot> {
    return this.json(computerPath(botId, "snapshot"), snapshotSchema, { method: "POST", signal });
  }

  async navigate(
    botId: string,
    input: { url: string; toolCallId?: string },
    signal?: AbortSignal,
  ): Promise<OpenBotNavigation> {
    const url = httpUrl(input.url);
    return this.json(
      computerPath(botId, "navigate"),
      navigationSchema,
      {
        method: "POST",
        body: JSON.stringify({
          url,
          ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
        }),
        signal,
      },
      true,
    );
  }

  computerControl(botId: string, signal?: AbortSignal): Promise<OpenBotControl> {
    return this.json(computerPath(botId, "control"), controlSchema, { signal });
  }

  requestControl(botId: string, reason: string, signal?: AbortSignal): Promise<OpenBotControl> {
    return this.json(
      computerPath(botId, "control/request"),
      controlSchema,
      {
        method: "POST",
        body: JSON.stringify({ reason }),
        signal,
      },
      true,
    );
  }

  takeControl(botId: string, signal?: AbortSignal): Promise<OpenBotControl> {
    return this.json(
      computerPath(botId, "control/take"),
      controlSchema,
      { method: "POST", signal },
      true,
    );
  }

  releaseControl(botId: string, signal?: AbortSignal): Promise<OpenBotControl> {
    return this.json(
      computerPath(botId, "control/release"),
      controlSchema,
      { method: "POST", signal },
      true,
    );
  }

  private requireTransport(): OpenBotTransport {
    if (this.options.enabled !== true)
      throw new OpenBotError("disabled", "OpenBot integration is disabled.");
    if (!this.options.transport)
      throw new OpenBotError(
        "not_configured",
        "An authenticated OpenBot transport has not been configured.",
      );
    return this.options.transport;
  }

  private async json<T>(
    path: string,
    schema: z.ZodType<T>,
    init: RequestInit = {},
    mutates = false,
  ): Promise<T> {
    const transport = this.requireTransport();
    if (init.signal?.aborted)
      throw new OpenBotError("cancelled", "OpenBot request cancelled before dispatch.");
    let response: Awaited<ReturnType<OpenBotTransport["request"]>>;
    try {
      response = await transport.request(path, {
        ...init,
        method: init.method ?? "GET",
        credentials: "include",
        redirect: "error",
        headers: {
          Accept: "application/json",
          ...(init.body ? { "Content-Type": "application/json" } : {}),
        },
      });
    } catch {
      throw new OpenBotError(
        init.signal?.aborted ? "cancelled" : "unavailable",
        "OpenBot did not return a response.",
        undefined,
        undefined,
        mutates,
      );
    }
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const detail = errorSchema.safeParse(body);
      throw new OpenBotError(
        openBotHttpErrorCode(response.status),
        detail.success && detail.data.error
          ? detail.data.error.slice(0, 1000)
          : `OpenBot request failed (${response.status}).`,
        response.status,
        detail.success ? detail.data.rule : undefined,
        mutates && (response.status >= 500 || response.status === 408),
      );
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success)
      throw new OpenBotError(
        "invalid_response",
        "OpenBot returned an incompatible response.",
        response.status,
        undefined,
        mutates,
      );
    return parsed.data;
  }
}

function identifier(value: string): string {
  const id = value.trim();
  if (!id || id === "." || id === "..")
    throw new OpenBotError("invalid_input", "An OpenBot ID is required.");
  return id;
}

function computerPath(botId: string, operation: string): string {
  return `/api/computers/${encodeURIComponent(identifier(botId))}/${operation}`;
}

function httpUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new OpenBotError("invalid_input", "A valid HTTP(S) URL is required.");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new OpenBotError(
      "invalid_input",
      "A valid HTTP(S) URL without embedded credentials is required.",
    );
  }
  return url.toString();
}
