import { useEffect, useState } from "react";
import { Linking, Text, View } from "react-native";
import { type OpenBotAdapter, OpenBotError } from "../../../packages/backends/src/openbot";
import { openBotConversationUrl } from "./openbot-conversation-url";
import { Button, ErrorNotice, s } from "./ui";

type History = Awaited<ReturnType<OpenBotAdapter["openConversation"]>>;

export function OpenBotApprovalStatus({
  adapter,
  history,
  webOrigin,
  onSessionExpired,
}: {
  adapter: OpenBotAdapter;
  history: History;
  webOrigin: string;
  onSessionExpired: () => void;
}) {
  const [status, setStatus] = useState<"loading" | "pending" | "clear" | "unavailable">("loading");
  const [linkFailed, setLinkFailed] = useState(false);
  const { channelId, threadId } = history;

  useEffect(() => {
    const controller = new AbortController();
    void adapter.hasPendingApproval(threadId, controller.signal).then(
      (pending) => {
        if (!controller.signal.aborted) setStatus(pending ? "pending" : "clear");
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        if (error instanceof OpenBotError && error.code === "authentication_required") {
          onSessionExpired();
        } else {
          setStatus("unavailable");
        }
      },
    );
    return () => controller.abort();
  }, [adapter, threadId, onSessionExpired]);

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
