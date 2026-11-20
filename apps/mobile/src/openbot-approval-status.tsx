import { useEffect, useState } from "react";
import { AppState, Linking, Text, View } from "react-native";
import { type OpenBotAdapter, OpenBotError } from "../../../packages/backends/src/openbot";
import { trackOpenBotApprovals } from "./openbot-approval-tracking";
import { openBotConversationUrl } from "./openbot-conversation-url";
import { Button, ErrorNotice, s } from "./ui";

type History = Awaited<ReturnType<OpenBotAdapter["openConversation"]>>;

export function OpenBotApprovalStatus({
  adapter,
  channelId,
  threadId,
  webOrigin,
  refreshConversation,
  onSessionExpired,
}: {
  adapter: OpenBotAdapter;
  channelId: History["channelId"];
  threadId: History["threadId"];
  webOrigin: string;
  refreshConversation: () => Promise<boolean>;
  onSessionExpired: () => void;
}) {
  const [status, setStatus] = useState<
    "loading" | "pending" | "continuing" | "clear" | "unavailable"
  >("loading");
  const [linkFailed, setLinkFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    let checking = false;
    const track = trackOpenBotApprovals();
    async function refresh() {
      if (checking || controller.signal.aborted) return;
      checking = true;
      try {
        const requests = await adapter.listUnsettledApprovals(threadId, controller.signal);
        if (controller.signal.aborted) return;
        await track(
          requests,
          async () => AppState.currentState === "active" && (await refreshConversation()),
          (status) => {
            if (!controller.signal.aborted) setStatus(status);
          },
        );
      } catch (error) {
        if (controller.signal.aborted) return;
        if (error instanceof OpenBotError && error.code === "authentication_required") {
          onSessionExpired();
        } else {
          setStatus("unavailable");
        }
      } finally {
        checking = false;
      }
    }
    void refresh();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void refresh();
    });
    const interval = setInterval(() => {
      if (AppState.currentState === "active") void refresh();
    }, 5000);
    return () => {
      controller.abort();
      subscription.remove();
      clearInterval(interval);
    };
  }, [adapter, threadId, refreshConversation, onSessionExpired]);

  async function openOnWeb() {
    setLinkFailed(false);
    try {
      await Linking.openURL(openBotConversationUrl({ webOrigin, channelId }));
    } catch {
      setLinkFailed(true);
    }
  }

  if (status === "unavailable") {
    return <Text style={s.muted}>Could not check approval status.</Text>;
  }
  if (status === "continuing") {
    return (
      <Text accessibilityLiveRegion="polite" style={s.muted}>
        Checking the conversation after approval…
      </Text>
    );
  }
  if (status !== "pending") return null;

  return (
    <View style={s.card}>
      <Text accessibilityLiveRegion="polite" style={s.label}>
        Waiting for approval
      </Text>
      <Button small onPress={() => void openOnWeb()}>
        Open in OpenBot Web
      </Button>
      {linkFailed && <ErrorNotice error="Could not open the OpenBot Web conversation." />}
    </View>
  );
}
