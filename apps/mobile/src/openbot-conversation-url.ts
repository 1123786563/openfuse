import type { OpenBotChannelId } from "../../../packages/backends/src/openbot";
import { parseOpenBotOrigin } from "./openbot-session";

export function openBotConversationUrl({
  webOrigin,
  channelId,
}: {
  webOrigin: string;
  channelId: OpenBotChannelId;
}) {
  const origin = parseOpenBotOrigin(webOrigin, true);
  if (/[/\\]/.test(channelId) || [".", "..", "new"].includes(channelId)) {
    throw new Error("Invalid OpenBot Conversation link.");
  }
  return `${origin}/channel/${encodeURIComponent(channelId)}`;
}
