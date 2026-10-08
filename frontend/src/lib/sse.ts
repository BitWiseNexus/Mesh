/**
 * Minimal Server-Sent Events parser for streams read with fetch() (EventSource can't send the
 * Authorization header). Handles `id`, `event` and multi-line `data` fields, comments (`: ping`)
 * and chunks that split lines anywhere. https://html.spec.whatwg.org/#event-stream-interpretation
 */
export interface SseMessage {
  id?: string;
  event: string;
  data: string;
}

export function createSseParser(onMessage: (message: SseMessage) => void) {
  let buffer = "";
  let id: string | undefined;
  let event = "";
  let data: string[] = [];

  const dispatch = () => {
    if (data.length > 0) onMessage({ id, event: event || "message", data: data.join("\n") });
    id = undefined;
    event = "";
    data = [];
  };

  const line = (text: string) => {
    if (text === "") return dispatch();
    if (text.startsWith(":")) return; // comment / keep-alive
    const colon = text.indexOf(":");
    const field = colon === -1 ? text : text.slice(0, colon);
    let value = colon === -1 ? "" : text.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") data.push(value);
    else if (field === "event") event = value;
    else if (field === "id") id = value;
  };

  return {
    feed(chunk: string) {
      buffer += chunk;
      // A trailing "\r" may be the first half of "\r\n": hold it back until the next chunk.
      const end = buffer.endsWith("\r") ? buffer.length - 1 : buffer.length;
      const lines = buffer.slice(0, end).split(/\r\n|\r|\n/);
      buffer = (lines.pop() ?? "") + buffer.slice(end);
      for (const l of lines) line(l);
    },
  };
}
