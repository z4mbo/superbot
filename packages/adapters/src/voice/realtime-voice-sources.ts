/**
 * Origins browsers open realtime voice conversations to, for the app's Content-Security-Policy.
 * The web server's config loads this file directly, so it imports nothing; the voice conformance
 * test holds it equal to the `realtime.connectSources` every provider descriptor declares.
 */
export const realtimeVoiceConnectSources: readonly string[] = ["wss://api.x.ai"];
