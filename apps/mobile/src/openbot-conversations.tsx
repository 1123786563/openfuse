import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, AppState, FlatList, Text, View } from "react-native";
import type { OpenBotTransport } from "../../../packages/backends/src/openbot";
import { OpenBotAdapter, OpenBotError } from "../../../packages/backends/src/openbot";
import { OpenBotBotPicker } from "./openbot-bot-picker";
import { OpenBotChat } from "./openbot-chat";
import { Button, colors, ErrorNotice, s } from "./ui";

type Page = Awaited<ReturnType<OpenBotAdapter["listConversations"]>>;
type Conversation = Page["conversations"][number];

function requiresSignIn(error: unknown) {
  return error instanceof OpenBotError && error.code === "authentication_required";
}

export function OpenBotConversations({
  transport,
  webOrigin,
  onSessionExpired,
}: {
  transport: OpenBotTransport;
  webOrigin: string;
  onSessionExpired: () => void;
}) {
  const adapter = useMemo(() => new OpenBotAdapter({ enabled: true, transport }), [transport]);
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

  useEffect(() => {
    if (selected || choosingBot) return;
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void loadPage();
    });
    return () => subscription.remove();
  }, [choosingBot, loadPage, selected]);

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
      <View key={selected.channelId} style={{ flex: 1, gap: 12 }}>
        <Button small onPress={() => setSelected(null)}>
          Back to conversations
        </Button>
        <Text accessibilityRole="header" style={s.heading}>
          {selected.title}
        </Text>
        <OpenBotChat
          adapter={adapter}
          channelId={selected.channelId}
          webOrigin={webOrigin}
          transport={transport}
          onAccessLost={onAccessLost}
          onSessionExpired={onSessionExpired}
        />
      </View>
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

function Loading({ label }: { label: string }) {
  return <ActivityIndicator accessibilityLabel={label} color={colors.blueDark} />;
}
