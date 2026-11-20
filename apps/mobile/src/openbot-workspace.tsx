import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { OpenBotConversations } from "./openbot-conversations";
import { configureOpenBotSession } from "./openbot-native";
import type { OpenBotSessionState } from "./openbot-session";
import { Button, Card, colors, ErrorNotice, s } from "./ui";

type Session = NonNullable<ReturnType<typeof configureOpenBotSession>>;
type Action = "restore" | "signIn" | "signOut";
type Screen = { kind: "loading" } | { kind: "retry"; action: Action } | OpenBotSessionState;

export function OpenBotWorkspace({ onOpenStandalone }: { onOpenStandalone: () => void }) {
  const [session] = useState(() => {
    try {
      return configureOpenBotSession();
    } catch {
      return null;
    }
  });

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.canvas, padding: 24 }}>
      <View style={{ flex: 1, width: "100%", maxWidth: 520, gap: 18, alignSelf: "center" }}>
        <Text accessibilityRole="header" style={s.title}>
          OpenBot workspace
        </Text>
        {session ? (
          <OpenBotSessionPanel session={session} onOpenStandalone={onOpenStandalone} />
        ) : (
          <>
            <ErrorNotice error="Set a valid OpenBot API origin in EXPO_PUBLIC_OPENBOT_API_ORIGIN." />
            <Button onPress={onOpenStandalone}>OpenFuse workspace</Button>
          </>
        )}
      </View>
    </SafeAreaView>
  );
}

function OpenBotSessionPanel({
  session,
  onOpenStandalone,
}: {
  session: Session;
  onOpenStandalone: () => void;
}) {
  const [screen, setScreen] = useState<Screen>({ kind: "loading" });
  const running = useRef(false);
  const run = useCallback(
    async (action: Action) => {
      if (running.current) return;
      running.current = true;
      setScreen({ kind: "loading" });
      try {
        setScreen(await session[action]());
      } catch {
        setScreen({ kind: "retry", action });
      } finally {
        running.current = false;
      }
    },
    [session],
  );

  useEffect(() => {
    void run("restore");
  }, [run]);

  const onSessionExpired = useCallback(() => void run("restore"), [run]);
  if (screen.kind === "connected") {
    return (
      <>
        <Text style={s.muted}>Signed in as {screen.user.name || screen.user.id}</Text>
        <OpenBotConversations
          key={screen.user.id}
          transport={screen.transport}
          webOrigin={session.webOrigin}
          onSessionExpired={onSessionExpired}
        />
        <Button onPress={() => void run("signOut")}>Sign out of OpenBot</Button>
        <Button onPress={onOpenStandalone}>OpenFuse workspace</Button>
      </>
    );
  }

  return (
    <>
      <Card>
        {screen.kind === "loading" ? (
          <ActivityIndicator
            accessibilityLabel="Checking OpenBot session"
            color={colors.blueDark}
          />
        ) : screen.kind === "retry" ? (
          <>
            <ErrorNotice
              error={
                screen.action === "signOut"
                  ? "Could not sign out of OpenBot."
                  : "Could not open your OpenBot workspace."
              }
            />
            <Button primary onPress={() => void run(screen.action)}>
              Try again
            </Button>
          </>
        ) : (
          <>
            {screen.kind === "expired" && <ErrorNotice error="Your OpenBot session expired." />}
            <Button primary onPress={() => void run("signIn")}>
              {screen.kind === "expired" ? "Sign in again" : "Sign in to OpenBot"}
            </Button>
          </>
        )}
      </Card>
      <Button disabled={screen.kind === "loading"} onPress={onOpenStandalone}>
        OpenFuse workspace
      </Button>
    </>
  );
}
