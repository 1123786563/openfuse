import { useEffect, useState } from "react";
import { AppState, Linking, Text, View } from "react-native";
import { type OpenBotAdapter, OpenBotError } from "../../../packages/backends/src/openbot";
import { openBotConversationUrl } from "./openbot-conversation-url";
import { Button, ErrorNotice, s } from "./ui";

type History = Awaited<ReturnType<OpenBotAdapter["openConversation"]>>;

export function OpenBotApprovalStatus({
  adapter,
  history,
  webOrigin,
  watchingRun,
  onSessionExpired,
}: {
  adapter: OpenBotAdapter;
  history: History;
  webOrigin: string;
  watchingRun: boolean;
  onSessionExpired: () => void;
}) {
  const [status, setStatus] = useState<"loading" | "pending" | "clear" | "unavailable">("loading");
  const [linkFailed, setLinkFailed] = useState(false);
  const monitor = watchingRun || status === "pending";

  useEffect(() => {
    const controller = new AbortController();
    let checking = false;
    async function refresh() {
      if (checking || controller.signal.aborted) return;
      checking = true;
      try {
        const pending = await adapter.hasPendingApproval(history.threadId, controller.signal);
        if (!controller.signal.aborted) setStatus(pending ? "pending" : "clear");
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
    const interval = monitor
      ? setInterval(() => {
          if (AppState.currentState === "active") void refresh();
        }, 5000)
      : undefined;
    return () => {
      controller.abort();
      subscription.remove();
      clearInterval(interval);
    };
  }, [adapter, history, monitor, onSessionExpired]);

  async function openOnWeb() {
    setLinkFailed(false);
    try {
      await Linking.openURL(openBotConversationUrl({ webOrigin, channelId: history.channelId }));
    } catch {
      setLinkFailed(true);
    }
  }

  if (status === "unavailable") {
    return <Text style={s.muted}>Could not check approval status.</Text>;
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
