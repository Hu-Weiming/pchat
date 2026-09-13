/** Incremental SSE framing. Network fragments may end inside CRLF or data lines.
 * Both limits include comments/metadata, so keepalives cannot bypass a budget. */
export class SseDecoder {
  private line = "";
  private data: string[] = [];
  private skipLf = false;
  private eventChars = 0;
  private totalChars = 0;
  private first = true;

  constructor(private readonly maxResponseChars: number, private readonly maxEventChars: number) {}

  push(fragment: string): string[] {
    this.totalChars += fragment.length;
    if (this.totalChars > this.maxResponseChars) throw new Error("Response limit");
    const events: string[] = [];
    for (const char of fragment) {
      if (this.first) { this.first = false; if (char === "\uFEFF") continue; }
      if (this.skipLf) { this.skipLf = false; if (char === "\n") continue; }
      this.eventChars += char.length;
      if (this.eventChars > this.maxEventChars) throw new Error("Event limit");
      if (char === "\r" || char === "\n") {
        if (this.line === "") {
          if (this.data.length) events.push(this.data.join("\n"));
          this.data = []; this.eventChars = 0;
        } else if (!this.line.startsWith(":")) {
          const separator = this.line.indexOf(":");
          const field = separator === -1 ? this.line : this.line.slice(0, separator);
          let value = separator === -1 ? "" : this.line.slice(separator + 1);
          if (value.startsWith(" ")) value = value.slice(1);
          if (field === "data") this.data.push(value);
        }
        this.line = ""; this.skipLf = char === "\r";
      } else this.line += char;
    }
    return events;
  }
}
