import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, FlatList, ScrollView, Text, View } from "react-native";
import type { OpenBotTransport } from "../../../packages/backends/src/openbot";
import { OpenBotAdapter, OpenBotError } from "../../../packages/backends/src/openbot";
import { AssistantResponse } from "./assistant-response";
import { OpenBotBotPicker } from "./openbot-bot-picker";
import { Button, colors, ErrorNotice, s } from "./ui";

type Page = Awaited<ReturnType<OpenBotAdapter["listConversations"]>>;
type Conversation = Page["conversations"][number];
type History = Awaited<ReturnType<OpenBotAdapter["openConversation"]>>;
type HistoryState = { kind: "loading" | "failed" } | { kind: "ready"; history: History };

function requiresSignIn(error: unknown) {
  return error instanceof OpenBotError && error.code === "authentication_required";
}

export function OpenBotConversations({
  transport,
  onSessionExpired,
}: {
  transport: OpenBotTransport;
  onSessionExpired: () => void;
}) {
  const [adapter] = useState(() => new OpenBotAdapter({ enabled: true, transport }));
  const [page, setPage] = useState<Page | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "failed">("loading");
  const [selected, setSelected] = useState<Conversation | null>(null);
  const [accessLost, setAccessLost] = useState(false);
  const [choosingBot, setChoosingBot] = useState(false);
  const [reconciled, setReconciled] = useState(false);
  const pending = useRef<AbortController | null>(null);

  const loadPage = useCallback(
    async (cursor?: string) => {
      if (pending.current) return;
      const controller = new AbortController();
      pending.current = controller;
      setStatus("loading");
      try {
        const result = await adapter.listConversations({ cursor, signal: controller.signal });
        if (controller.signal.aborted) return;
        setPage((previous) => ({
          nextCursor: result.nextCursor,
          conversations:
            cursor && previous
              ? [
                  ...new Map(
                    [...previous.conversations, ...result.conversations].map((item) => [
                      item.channelId,
                      item,
                    ]),
                  ).values(),
                ]
              : result.conversations,
        }));
        setStatus("ready");
      } catch (error) {
        if (controller.signal.aborted) return;
        if (requiresSignIn(error)) onSessionExpired();
        else setStatus("failed");
      } finally {
        if (pending.current === controller) pending.current = null;
      }
    },
    [adapter, onSessionExpired],
  );

  useEffect(() => {
    void loadPage();
    return () => {
      pending.current?.abort();
      pending.current = null;
    };
  }, [loadPage]);

  const onAccessLost = useCallback((channelId: Conversation["channelId"]) => {
    setSelected(null);
    setAccessLost(true);
    setPage(
      (previous) =>
        previous && {
          ...previous,
          conversations: previous.conversations.filter((item) => item.channelId !== channelId),
        },
    );
  }, []);

  if (selected) {
    return (
      <OpenBotHistory
        key={selected.channelId}
        adapter={adapter}
        conversation={selected}
        onBack={() => setSelected(null)}
        onAccessLost={onAccessLost}
        onSessionExpired={onSessionExpired}
      />
    );
  }

  if (choosingBot) {
    return (
      <OpenBotBotPicker
        adapter={adapter}
        onBack={() => setChoosingBot(false)}
        onCreated={(conversation) => {
          pending.current?.abort();
          pending.current = null;
          setChoosingBot(false);
          setAccessLost(false);
          setReconciled(false);
          setSelected(conversation);
          void loadPage();
        }}
        onReconciled={(refreshedPage) => {
          pending.current?.abort();
          pending.current = null;
          setPage(refreshedPage);
          setStatus("ready");
          setChoosingBot(false);
          setAccessLost(false);
          setReconciled(true);
        }}
        onSessionExpired={onSessionExpired}
      />
    );
  }

  return (
    <FlatList
      style={{ flex: 1 }}
      contentContainerStyle={{ gap: 10, paddingBottom: 12 }}
      data={page?.conversations ?? []}
      keyExtractor={(item) => item.channelId}
      renderItem={({ item }) => (
        <Button
          onPress={() => {
            setAccessLost(false);
            setSelected(item);
          }}
        >
          {item.title}
        </Button>
      )}
      ListHeaderComponent={
        <View style={{ gap: 10 }}>
          <Text accessibilityRole="header" style={s.heading}>
            Conversations
          </Text>
          <Button primary onPress={() => setChoosingBot(true)}>
            New conversation
          </Button>
          {reconciled && (
            <Text accessibilityLiveRegion="polite" style={s.muted}>
              The conversation may have been created. Check the refreshed list before starting
              another.
            </Text>
          )}
          {accessLost && <ErrorNotice error="You can no longer access this conversation." />}
        </View>
      }
      ListEmptyComponent={
        status === "ready" && page?.nextCursor === null ? (
          <Text style={s.muted}>No conversations yet.</Text>
        ) : null
      }
      ListFooterComponent={
        <View style={{ gap: 8 }}>
          {status === "loading" && <Loading label="Loading conversations" />}
          {status === "failed" && (
            <>
              <ErrorNotice error="Could not load conversations." />
              <Button onPress={() => void loadPage(page?.nextCursor ?? undefined)}>
                Try again
              </Button>
            </>
          )}
          {status === "ready" && page?.nextCursor && (
            <Button onPress={() => void loadPage(page.nextCursor ?? undefined)}>Load more</Button>
          )}
        </View>
      }
    />
  );
}

function OpenBotHistory({
  adapter,
  conversation,
  onBack,
  onAccessLost,
  onSessionExpired,
}: {
  adapter: OpenBotAdapter;
  conversation: Conversation;
  onBack: () => void;
  onAccessLost: (channelId: Conversation["channelId"]) => void;
  onSessionExpired: () => void;
}) {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<HistoryState>({ kind: "loading" });
  const { channelId, title } = conversation;

  useEffect(() => {
    const controller = new AbortController();
    void adapter.openConversation(channelId, controller.signal).then(
      (history) => {
        if (!controller.signal.aborted) setState({ kind: "ready", history });
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        if (requiresSignIn(error)) onSessionExpired();
        else if (error instanceof OpenBotError && error.code === "refused") {
          onAccessLost(channelId);
        } else {
          setState({ kind: "failed" });
        }
      },
    );
    return () => controller.abort();
  }, [adapter, attempt, channelId, onAccessLost, onSessionExpired]);

  return (
    <View style={{ flex: 1, gap: 12 }}>
      <Button small onPress={onBack}>
        Back to conversations
      </Button>
      <Text accessibilityRole="header" style={s.heading}>
        {title}
      </Text>
      {state.kind === "loading" && <Loading label="Loading conversation history" />}
      {state.kind === "failed" && (
        <>
          <ErrorNotice error="Could not load conversation history." />
          <Button
            onPress={() => {
              setState({ kind: "loading" });
              setAttempt((previous) => previous + 1);
            }}
          >
            Try again
          </Button>
        </>
      )}
      {state.kind === "ready" && (
        <ScrollView contentContainerStyle={{ gap: 14, paddingBottom: 12 }}>
          {state.history.messages.map((message) => (
            <View key={message.id} style={s.card}>
              <Text style={s.label}>{message.role === "user" ? "You" : "Bot"}</Text>
              {message.role === "assistant" ? (
                <AssistantResponse content={message.text} />
              ) : (
                <Text selectable style={s.text}>
                  {message.text}
                </Text>
              )}
            </View>
          ))}
          {state.history.hasNonTextMessages ? (
            <Text style={s.muted}>OpenBot Web can display additional conversation content.</Text>
          ) : state.history.messages.length === 0 ? (
            <Text style={s.muted}>No messages yet.</Text>
          ) : null}
        </ScrollView>
      )}
    </View>
  );
}

function Loading({ label }: { label: string }) {
  return <ActivityIndicator accessibilityLabel={label} color={colors.blueDark} />;
}
