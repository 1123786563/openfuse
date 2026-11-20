import * as Crypto from "expo-crypto";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, ScrollView, Text, TextInput, View } from "react-native";
import {
  type OpenBotAdapter,
  type OpenBotChannelId,
  OpenBotError,
  type OpenBotTransport,
} from "../../../packages/backends/src/openbot";
import { AssistantResponse } from "./assistant-response";
import { OpenBotApprovalStatus } from "./openbot-approval-status";
import {
  type OpenBotHistory,
  type OpenBotSend,
  observeOpenBotRun,
  stopOpenBotRun,
  syncOpenBotRun,
} from "./openbot-run";
import { Button, ErrorNotice, s } from "./ui";

type RunObservation = {
  controller: AbortController;
  runId: string | null;
  stoppingRunId: string | null;
};

export function OpenBotChat({
  adapter,
  channelId,
  webOrigin,
  transport,
  onSessionExpired,
  onAccessLost,
}: {
  adapter: OpenBotAdapter;
  channelId: OpenBotChannelId;
  webOrigin: string;
  transport: OpenBotTransport;
  onSessionExpired: () => void;
  onAccessLost: (channelId: OpenBotChannelId) => void;
}) {
  const [history, setHistory] = useState<OpenBotHistory | null>(null);
  const [messages, setMessages] = useState<OpenBotHistory["messages"]>([]);
  const [draft, setDraft] = useState("");
  const [state, setState] = useState<
    | { kind: "checking" | "ready" | "offline" }
    | { kind: "running"; runId: string; stop: "available" | "pending" | "failed" }
    | { kind: "unconfirmed"; send: OpenBotSend }
  >({ kind: "checking" });
  const [runFailed, setRunFailed] = useState(false);
  const pendingSend = useRef<OpenBotSend | null>(null);
  const displayedThread = useRef<string | null>(null);
  const operation = useRef<RunObservation | null>(null);
  const scroll = useRef<ScrollView>(null);

  const sync = useCallback(
    async (send?: OpenBotSend) => {
      if (operation.current) return false;
      const controller = new AbortController();
      const current: RunObservation = {
        controller,
        runId: null,
        stoppingRunId: null,
      };
      operation.current = current;
      const { signal } = controller;
      const pending = pendingSend.current;
      setState({ kind: "checking" });
      setRunFailed(false);
      const read = async () => {
        const saved = await adapter.openConversation(channelId, signal);
        if (signal.aborted) throw new OpenBotError("cancelled", "OpenBot observation ended.");
        if (displayedThread.current && displayedThread.current !== saved.threadId) {
          throw new OpenBotError("refused", "The conversation changed.");
        }
        displayedThread.current = saved.threadId;
        setHistory(saved);
        setMessages(saved.messages);
        return saved;
      };
      const observe = (saved: OpenBotHistory, outgoing?: OpenBotSend) =>
        observeOpenBotRun({
          history: saved,
          transport,
          signal,
          send: outgoing,
          onMessages: setMessages,
          onRun: (runId) => {
            current.runId = runId;
            setState(
              runId
                ? {
                    kind: "running",
                    runId,
                    stop: current.stoppingRunId === runId ? "pending" : "available",
                  }
                : { kind: "checking" },
            );
          },
        });

      try {
        const { unconfirmed, streamFailed } = await syncOpenBotRun({
          read,
          observe: (saved, outgoing) => {
            if (outgoing) {
              pendingSend.current = outgoing;
              setDraft((draft) => (draft.trim() === outgoing.text ? "" : draft));
            }
            return observe(saved, outgoing);
          },
          send,
          pending,
        });
        if (signal.aborted) return false;
        if (send && pending?.text === send.text && !unconfirmed) {
          setDraft((draft) => (draft.trim() === send.text ? "" : draft));
        }
        pendingSend.current = unconfirmed;
        setRunFailed(streamFailed);
        setState(unconfirmed ? { kind: "unconfirmed", send: unconfirmed } : { kind: "ready" });
        return true;
      } catch (error) {
        if (signal.aborted) return false;
        if (error instanceof OpenBotError && error.code === "authentication_required")
          onSessionExpired();
        else if (error instanceof OpenBotError && error.code === "refused") onAccessLost(channelId);
        else setState({ kind: "offline" });
        return false;
      } finally {
        if (operation.current === current) operation.current = null;
      }
    },
    [adapter, channelId, onAccessLost, onSessionExpired, transport],
  );

  const stop = async (runId: string, saved: OpenBotHistory) => {
    const current = operation.current;
    if (!current || current.runId !== runId || current.stoppingRunId === runId) return;
    current.stoppingRunId = runId;
    setState({ kind: "running", runId, stop: "pending" });
    const stillWatching = () => operation.current === current && current.runId === runId;
    try {
      await stopOpenBotRun({ history: saved, runId, transport, signal: current.controller.signal });
      if (current.stoppingRunId === runId) current.stoppingRunId = null;
      if (!stillWatching()) return;
      // Whether the stop landed or the run already ended, reload and join the
      // canonical run. A late response must leave any newer observation alone.
      current.controller.abort();
      operation.current = null;
      void sync();
    } catch (error) {
      if (current.stoppingRunId === runId) current.stoppingRunId = null;
      if (!stillWatching()) return;
      if (error instanceof OpenBotError && error.code === "authentication_required")
        onSessionExpired();
      else if (error instanceof OpenBotError && error.code === "refused") onAccessLost(channelId);
      else setState({ kind: "running", runId, stop: "failed" });
    }
  };

  useEffect(() => {
    const suspend = () => {
      operation.current?.controller.abort();
      operation.current = null;
    };
    void sync();
    const subscription = AppState.addEventListener("change", (next) => {
      if (next === "active") void sync();
      else suspend();
    });
    return () => {
      subscription.remove();
      suspend();
    };
  }, [sync]);

  const offline = state.kind === "offline";
  useEffect(() => {
    if (!offline) return;
    const timer = setInterval(() => {
      if (AppState.currentState === "active") void sync();
    }, 5000);
    return () => clearInterval(timer);
  }, [offline, sync]);

  const sendEnabled = state.kind === "ready" && !!history?.runMessages;
  return (
    <>
      {history && (
        <OpenBotApprovalStatus
          adapter={adapter}
          channelId={history.channelId}
          threadId={history.threadId}
          webOrigin={webOrigin}
          refreshConversation={sync}
          onSessionExpired={onSessionExpired}
        />
      )}
      {state.kind === "ready" && (
        <Button small onPress={() => void sync()}>
          Refresh conversation
        </Button>
      )}
      <ScrollView
        ref={scroll}
        onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: false })}
        contentContainerStyle={{ gap: 14, paddingBottom: 12 }}
      >
        {messages.map((message) => (
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
        {history?.hasNonTextMessages && (
          <Text style={s.muted}>OpenBot Web can display additional conversation content.</Text>
        )}
        {history && !history.hasNonTextMessages && messages.length === 0 && (
          <Text style={s.muted}>No messages yet.</Text>
        )}
      </ScrollView>
      {state.kind === "checking" && <Text style={s.muted}>Checking history and runs…</Text>}
      {state.kind === "running" && history && (
        <>
          <Text style={s.muted}>Bot is working…</Text>
          {state.stop === "failed" && <ErrorNotice error="Could not stop the Bot run." />}
          <Button
            small
            disabled={state.stop === "pending"}
            onPress={() => void stop(state.runId, history)}
          >
            {state.stop === "pending" ? "Stopping…" : "Stop run"}
          </Button>
        </>
      )}
      {state.kind === "offline" && (
        <>
          <ErrorNotice error="Could not sync with OpenBot." />
          <Button onPress={() => void sync()}>Reconnect</Button>
        </>
      )}
      {runFailed && (
        <ErrorNotice error="The Bot reply was interrupted. The transcript shows the saved conversation." />
      )}
      {state.kind === "unconfirmed" && (
        <>
          <ErrorNotice error="OpenBot history does not contain your last send. Check the conversation before trying again." />
          <Button onPress={() => void sync()}>Check again</Button>
          <Button
            onPress={() => {
              setDraft((current) => current || state.send.text);
              setState({ kind: "ready" });
            }}
          >
            Review unsent text
          </Button>
        </>
      )}
      {history?.runMessages === null && (
        <Text style={s.muted}>Continue this conversation in OpenBot Web.</Text>
      )}
      <TextInput
        accessibilityLabel="Message"
        placeholder="Message"
        multiline
        value={draft}
        onChangeText={setDraft}
        editable={sendEnabled}
        style={[s.input, { maxHeight: 100 }]}
      />
      <Button
        primary
        disabled={!sendEnabled || !draft.trim()}
        onPress={() => {
          const text = draft.trim();
          if (!text || !sendEnabled || operation.current) return;
          void sync({ id: Crypto.randomUUID(), text });
        }}
      >
        Send message
      </Button>
    </>
  );
}
