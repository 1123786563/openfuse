# OpenFuse mobile

A shared React Native workspace for iOS, Android, and the web preview. The client uses native primitives and the CopilotKit headless hooks; the web preview renders those same screens through React Native Web.

## Demos

[Recording setup](../../docs/DEMO.md)

Meet OpenFuse's capybara in two different journeys: Hacker News and CopilotKit on iPhone; reading a school-trip email and researching aquarium exhibits on desktop. Results appear inline in chat, with **Take control** opening the same browser session. Send and Stop share the input pill's primary control.

## Run

Start the API from the repository root, then:

```sh
pnpm --dir apps/mobile web
pnpm --dir apps/mobile ios
pnpm --dir apps/mobile android
```

The default API is `http://localhost:8787`, or `http://10.0.2.2:8787` on the Android emulator. Set `EXPO_PUBLIC_API_URL` to your reachable server URL for a physical device or deployment. Live mode asks for the server access key; local mode opens the fictional workspace automatically. Tokens stay in memory.

PDFs use `react-native-pdf` and `react-native-blob-util` in an Expo **development build**. Expo Go does not include these native modules. The config plugins in `app.json` configure the native projects. Web uses the browser’s real PDF reader, with page/zoom controls and download/print access. PDF form fields save a new server artifact.

## OpenBot workspace

Set `EXPO_PUBLIC_OPENBOT_API_ORIGIN` to the HTTPS origin of an OpenBot API
that supports the OpenFuse sign-in handoff. For a native development build,
the client also accepts local HTTP origins such as `http://127.0.0.1:3001`
on an iOS simulator or `http://10.0.2.2:3001` on an Android emulator where
the build permits cleartext traffic. If OpenBot Web uses a separate origin,
set `EXPO_PUBLIC_OPENBOT_WEB_ORIGIN` to that deployment's Web origin. The
approval link opens the system browser and uses the browser's OpenBot session.

Rebuild the native app to include the browser and SecureStore modules.
Choose **OpenBot workspace** and sign in through the system browser. The
app verifies the account with OpenBot and stores its own session per API
origin. **Sign out of OpenBot** ends the native session. The **OpenFuse
workspace** button returns to standalone mode, and **Choose a workspace**
in the standalone menu returns to the workspace chooser.

## Checks

```sh
pnpm --dir apps/mobile typecheck
node --experimental-strip-types --test apps/mobile/test/date-time.test.ts
pnpm --dir apps/mobile build:web
pnpm --dir apps/mobile build:ios
pnpm --dir apps/mobile build:android
```

The `build:ios` and `build:android` commands validate and export platform JavaScript/Hermes bundles. They do not create signed installable apps. `ios` and `android` run Expo’s native development-build workflows and need the platform toolchains.

## Behavior

- Chat, Activity, Ideas, Goals and Apps are the primary navigation. Tasks, timelines and notifications refresh from the durable server state. Apps contains Mail, Calendar, Browser, Files and Connections.
- Drafts are saved in OpenFuse and can be reopened from Mail. Mail attachments import into Files before reading.
- Calendar edits preserve named time zones. Date entry rejects nonexistent times at daylight-saving transitions.
- Sending mail and creating, changing, or deleting events require a stored proposal and an explicit review decision. Editing a proposal declines the previous version, then opens a new draft.
- Chat restores/saves AG-UI conversation messages, renders frontend tool cards, and supports interruption, retry, and document references.
- While the agent replies, the send arrow becomes a stop square in the same input pill. Stop preserves the draft; the arrow returns when the run ends. A new message can continue immediately after stopping when no follow-ups are waiting. Held follow-ups resume through **Send queued messages**.
- Browser previews and consoles use only signed worker URLs returned by the API. PDF downloads import through the worker API.
- Google connects through the system browser. Refresh the workspace after completing OAuth.

Phone and wide layouts share Chat, Activity, Ideas, Goals and Apps. The task and notification sheets restore server state when reopened. Document and browser viewers have platform-specific files; presentation and state remain shared.
