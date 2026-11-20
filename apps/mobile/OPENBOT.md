# OpenBot connected mode on mobile

Use the [companion OpenBot revision `a2376497`](https://github.com/1123786563/OpenBot/tree/a23764974e532bdfd97fa3916e519a8719b21781), which provides native session exchange and Thread-scoped approvals. It uses CopilotKit runtime 1.85.0. Configure OpenBot to advertise a direct Intelligence WebSocket gateway reachable from the device. Set `INTELLIGENCE_GATEWAY_PROXY=off`. If the default gateway is private, set `INTELLIGENCE_BROWSER_GATEWAY_WS_URL` to a device-reachable gateway. OpenBot's browser proxy requires a browser session on the WebSocket connection. OpenFuse reports that configuration before starting a new Bot run.

Set `EXPO_PUBLIC_OPENBOT_API_ORIGIN` to the OpenBot API origin before building the native app. Set `EXPO_PUBLIC_OPENBOT_WEB_ORIGIN` if the Web app runs on a different origin. Both use HTTPS. Development builds also accept HTTP on the supported loopback hosts.

In the native app, select **OpenBot workspace** and sign in through the browser. The OpenBot server must support the OpenFuse authorization and code exchange endpoints and the `openfuse://auth/callback` redirect. OpenFuse keeps the per-user session in Expo SecureStore.

The Conversations list shows active direct Conversations with one Bot. **New conversation** opens the available Bot list. A Conversation displays text history, streams text replies, and lets you stop the active run. Use OpenBot Web for group Conversations, full rich content, and approval decisions. The mobile client reads approval status from OpenBot's `GET /api/approvals?threadId=<id>` endpoint and reloads the Conversation when a tracked approval settles.

If a send loses its response, OpenFuse checks saved history for the submitted message ID before enabling another send in that Conversation. You can edit a separate draft while you wait, and the draft and pending send survive returning to the Conversations list. If the message never appears, sending in that Conversation stays paused for the signed-in workspace session.

If a Channel creation loses its response, OpenFuse refreshes Conversations and pauses creation in that signed-in workspace session. You can open a Conversation from the refreshed list. The Channel API does not provide a request ID for identifying which Channel, if any, was created. Both safeguards are held in memory for the mounted signed-in workspace and end when you leave it, sign out, or restart the app.
