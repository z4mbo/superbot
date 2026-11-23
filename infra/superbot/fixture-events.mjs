import assert from "node:assert/strict";

export function readFixtureEvents(stream) {
  assert.match(stream.headers.get("content-type"), /^text\/event-stream/);
  const reader = stream.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  return {
    close: () => reader.cancel(),
    async nextEvent() {
      for (;;) {
        const end = buffer.indexOf("\n\n");
        if (end >= 0) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const data = frame.split("\n").find((line) => line.startsWith("data: "));
          if (data) return JSON.parse(data.slice(6)).json;
        } else {
          const { done, value } = await reader.read();
          assert(!done, "Conversation stream ended");
          buffer += value.replaceAll("\r\n", "\n");
        }
      }
    },
  };
}
