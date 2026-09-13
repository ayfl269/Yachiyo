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
      // Per the SSE spec, only ONE leading space after the colon is stripped.
      // `trim()` would also remove intentional leading/trailing whitespace in
      // the payload (e.g. `data:  {"a": 1}` where the JSON starts with a
      // significant space is fine, but `data: text ` would lose its trailing
      // space), so slice exactly one optional space.
      const value = line.slice(5);
      dataLines.push(value.startsWith(" ") ? value.slice(1) : value);
    }
  }

  if (dataLines.length === 0) return null;
  return { event: eventType, data: dataLines.join("\n") };
}

export async function* parseSSEStream(
  response: Response,
  abortSignal?: AbortSignal,
): AsyncGenerator<SSEEvent, void, unknown> {
  if (!response.body) {
    throw new Error("parseSSEStream: response.body is null (opaque or empty response).");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  // Set when a chunk ends with "\r" that might be the first half of a "\r\n"
  // terminator straddling the chunk boundary. The \r is held back and merged
  // into the next chunk before normalization.
  let pendingCR = false;

  try {
    while (true) {
      if (abortSignal?.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;

      // Per the SSE spec, line terminators may be \r\n, \n, or bare \r.
      // Normalize to \n so that event delimiters (\n\n) and `event:`/`data:`
      // prefixes parse correctly regardless of upstream proxy/CDN behavior.
      // We CANNOT normalize per-chunk blindly: if a \r\n straddles a chunk
      // boundary (\r at the end of this chunk, \n starting the next), a naive
      // `\r -> \n` conversion would produce "\n\n" across the boundary and
      // fabricate a phantom event delimiter. Instead, keep a trailing \r in
      // the buffer untouched; it is normalized on the next iteration once the
      // following byte is known. A bare \r that is genuinely the last byte of
      // the stream is flushed by the final normalization after the read loop.
      let chunk = decoder.decode(value, { stream: true });
      if (pendingCR) {
        // A previous chunk ended with "\r" — prepend it so a straddling
        // "\r\n" is normalized as a single terminator (no phantom event
        // delimiter) and a bare "\r" becomes a line terminator.
        chunk = "\r" + chunk;
        pendingCR = false;
      }
      if (chunk.endsWith("\r")) {
        // Hold back a trailing "\r": it may pair with the next chunk's "\n".
        pendingCR = true;
        chunk = chunk.slice(0, -1);
      }
      // Per the SSE spec, line terminators may be \r\n, \n, or bare \r.
      // Normalize to \n so that event delimiters (\n\n) and `event:`/`data:`
      // prefixes parse correctly regardless of upstream proxy/CDN behavior.
      chunk = chunk.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
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
    // A \r held back as potentially-straddling is now known to be a bare \r
    // terminator — normalize it like every other terminator.
    if (pendingCR) {
      buffer += "\n";
      pendingCR = false;
    }
    if (buffer.trim()) {
      const evt = parseSSEEvent(buffer);
      if (evt) yield evt;
      buffer = "";
    }
  } finally {
    // Cancel the reader first so the underlying HTTP connection is closed
    // promptly. `releaseLock()` only detaches the reader; without `cancel()`
    // the connection stays open until the server times out, leaking sockets
    // when consumers abort mid-stream.
    try {
      await reader.cancel();
    } catch {
      // ignore — best-effort cleanup
    }
    reader.releaseLock();
  }
}
