import { type OpenBotAdapter, OpenBotError } from "../../../packages/backends/src/openbot";

type Page = Awaited<ReturnType<OpenBotAdapter["listConversations"]>>;
export type OpenBotChoice = Awaited<ReturnType<OpenBotAdapter["listBots"]>>[number];

export type OpenBotCreateAction = { kind: "create"; bot: OpenBotChoice } | { kind: "refresh" };

type Result =
  | { kind: "created"; conversation: Page["conversations"][number] }
  | { kind: "reconciled"; page: Page }
  | { kind: "needs_refresh" };

export async function createOpenBotConversation(
  adapter: OpenBotAdapter,
  action: OpenBotCreateAction,
  signal?: AbortSignal,
): Promise<Result> {
  if (action.kind === "create") {
    try {
      const { channelId } = await adapter.createConversation(action.bot.id, signal);
      return { kind: "created", conversation: { channelId, title: action.bot.name } };
    } catch (error) {
      if (!(error instanceof OpenBotError) || !error.outcomeUnknown || signal?.aborted) throw error;
    }
  }

  try {
    const page = await adapter.listConversations({ signal });
    return { kind: "reconciled", page };
  } catch (error) {
    if (error instanceof OpenBotError && error.code === "authentication_required") throw error;
    return { kind: "needs_refresh" };
  }
}
