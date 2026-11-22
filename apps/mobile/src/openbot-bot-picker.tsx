import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, ScrollView, Text, View } from "react-native";
import { type OpenBotAdapter, OpenBotError } from "../../../packages/backends/src/openbot";
import {
  createOpenBotConversation,
  type OpenBotChoice,
  type OpenBotCreateAction,
} from "./openbot-create-conversation";
import { Button, colors, ErrorNotice, s } from "./ui";

type Page = Awaited<ReturnType<OpenBotAdapter["listConversations"]>>;
type Roster = { kind: "loading" | "failed" } | { kind: "ready"; bots: OpenBotChoice[] };
type Submission = "idle" | "working" | "failed" | "refused" | "needs_refresh";

export function OpenBotBotPicker({
  adapter,
  onBack,
  onCreated,
  onReconciled,
  onSessionExpired,
}: {
  adapter: OpenBotAdapter;
  onBack: () => void;
  onCreated: (conversation: Page["conversations"][number]) => void;
  onReconciled: (page: Page) => void;
  onSessionExpired: () => void;
}) {
  const [attempt, setAttempt] = useState(0);
  const [roster, setRoster] = useState<Roster>({ kind: "loading" });
  const [submission, setSubmission] = useState<Submission>("idle");
  const pending = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void adapter.listBots(controller.signal).then(
      (bots) => {
        if (!controller.signal.aborted) setRoster({ kind: "ready", bots });
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        if (error instanceof OpenBotError && error.code === "authentication_required") {
          onSessionExpired();
        } else {
          setRoster({ kind: "failed" });
        }
      },
    );
    return () => controller.abort();
  }, [adapter, attempt, onSessionExpired]);

  useEffect(() => () => pending.current?.abort(), []);

  async function submit(action: OpenBotCreateAction) {
    if (pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setSubmission("working");
    try {
      const result = await createOpenBotConversation(adapter, action, controller.signal);
      if (controller.signal.aborted) return;
      switch (result.kind) {
        case "created":
          onCreated(result.conversation);
          break;
        case "reconciled":
          onReconciled(result.page);
          break;
        case "needs_refresh":
          setSubmission("needs_refresh");
          break;
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof OpenBotError && error.code === "authentication_required") {
        onSessionExpired();
      } else if (
        error instanceof OpenBotError &&
        (error.code === "refused" || error.status === 404)
      ) {
        setSubmission("refused");
      } else {
        setSubmission("failed");
      }
    } finally {
      pending.current = null;
    }
  }

  function reloadBots() {
    setSubmission("idle");
    setRoster({ kind: "loading" });
    setAttempt((previous) => previous + 1);
  }

  return (
    <View style={{ flex: 1, gap: 12 }}>
      <Button
        small
        disabled={submission === "working" || submission === "needs_refresh"}
        onPress={onBack}
      >
        Back to conversations
      </Button>
      <Text accessibilityRole="header" style={s.heading}>
        Choose a Bot
      </Text>
      {submission === "working" ? (
        <ActivityIndicator
          accessibilityLabel="Starting conversation or checking the list"
          color={colors.blueDark}
        />
      ) : submission === "needs_refresh" ? (
        <>
          <ErrorNotice error="The conversation may have been created. Check your conversations before starting another." />
          <Button onPress={() => void submit({ kind: "refresh" })}>Check conversations</Button>
        </>
      ) : (
        <>
          {submission === "failed" && (
            <ErrorNotice error="Could not start a conversation. Try again." />
          )}
          {submission === "refused" && (
            <>
              <ErrorNotice error="You can no longer start a conversation with this Bot." />
              <Button onPress={reloadBots}>Refresh Bots</Button>
            </>
          )}
          {roster.kind === "loading" && (
            <ActivityIndicator accessibilityLabel="Loading Bots" color={colors.blueDark} />
          )}
          {roster.kind === "failed" && (
            <>
              <ErrorNotice error="Could not load Bots." />
              <Button onPress={reloadBots}>Try again</Button>
            </>
          )}
          {roster.kind === "ready" && submission !== "refused" && (
            <ScrollView contentContainerStyle={{ gap: 10, paddingBottom: 12 }}>
              {roster.bots.length === 0 && <Text style={s.muted}>No Bots available.</Text>}
              {roster.bots.map((bot) => (
                <Button key={bot.id} onPress={() => void submit({ kind: "create", bot })}>
                  Start conversation with {bot.name}
                </Button>
              ))}
            </ScrollView>
          )}
        </>
      )}
    </View>
  );
}
