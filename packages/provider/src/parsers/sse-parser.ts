export interface SSEEvent {
  event?: string;
  data: string;
}

/**
 * Parse a single SSE event block (text between two `\n\n` delimiters, or
 * the trailing buffer after stream end) into an `SSEEvent`.
 * Returns `null` when the block contains no `data:` lines.
 */
function parseSSEEvent(eventText: string): SSEEvent | null {
  let eventType: string | undefined;
  const dataLines: string[] = [];

  for (const line of eventText.split("\n")) {
    if (line.startsWith("event:")) {
      eventType = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trim());
    }
  }

  if (dataLines.length === 0) return null;
  return { event: eventType, data: dataLines.join("\n") };
}

export async function* parseSSEStream(
  response: Response,
  abortSignal?: AbortSignal,
): AsyncGenerator<SSEEvent, void, unknown> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      if (abortSignal?.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;

      // Per the SSE spec, line terminators may be \r\n, \n, or bare \r.
      // Normalize to \n so that event delimiters (\n\n) and `event:`/`data:`
      // prefixes parse correctly regardless of upstream proxy/CDN behavior.
      // Doing this per-chunk is safe even when \r\n straddles a chunk
      // boundary: \r becomes \n and the trailing \n stays \n, yielding the
      // same \n\n delimiter after concatenation.
      const chunk = decoder.decode(value, { stream: true })
        .replace(/\r\n/g, "\n")
        .replace(/\r/g, "\n");
      buffer += chunk;

      const events = buffer.split("\n\n");
      buffer = events.pop()!;

      for (const eventText of events) {
        if (!eventText.trim()) continue;
        const evt = parseSSEEvent(eventText);
        if (evt) yield evt;
      }
    }

    // Flush any remaining buffered data after the stream ends. Many SSE
    // servers do not append a trailing `\n\n` after the final event, so
    // without this the last event (often carrying usage/finish_reason)
    // would be silently dropped.
    if (buffer.trim()) {
      const evt = parseSSEEvent(buffer);
      if (evt) yield evt;
      buffer = "";
    }
  } finally {
    reader.releaseLock();
  }
}
