import { describe, expect, it } from "vitest";

import { createSseParser, type SseMessage } from "./sse";

function parse(...chunks: string[]): SseMessage[] {
  const messages: SseMessage[] = [];
  const parser = createSseParser((m) => messages.push(m));
  for (const chunk of chunks) parser.feed(chunk);
  return messages;
}

describe("createSseParser", () => {
  it("parses id, event and data", () => {
    expect(parse('id: 1\nevent: token\ndata: {"a":1}\n\n')).toEqual([
      { id: "1", event: "token", data: '{"a":1}' },
    ]);
  });

  it("joins multi-line data and defaults the event name", () => {
    expect(parse("data: one\ndata: two\n\n")).toEqual([
      { id: undefined, event: "message", data: "one\ntwo" },
    ]);
  });

  it("ignores comments (keep-alives) and blank lines without data", () => {
    expect(parse(": ping\n\n", "\n\n", "data:x\n\n")).toEqual([
      { id: undefined, event: "message", data: "x" },
    ]);
  });

  it("handles chunks split anywhere, including inside \\r\\n", () => {
    const text = "id: 7\r\nevent: log\r\ndata: hello\r\n\r\ndata: second\r\n\r\n";
    for (let i = 1; i < text.length; i++) {
      expect(parse(text.slice(0, i), text.slice(i))).toEqual([
        { id: "7", event: "log", data: "hello" },
        { id: undefined, event: "message", data: "second" },
      ]);
    }
  });

  it("waits for the blank line before dispatching", () => {
    expect(parse("data: partial\n")).toEqual([]);
  });
});
