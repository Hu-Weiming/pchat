import { AnswerSchema } from "@pchat/contracts";
import type { Answer } from "@pchat/contracts";

type State = "start" | "keyOrEnd" | "key" | "colon" | "value" | "arrayFirst" | "arrayValue" | "arrayAfter" | "after" | "done";
type Key = "text" | "kind" | "evidenceIds";
/** A deliberately small JSON grammar for Answer, not a repair parser. Only the
 * decoded top-level text string streams. Duplicate/unknown keys, nested values,
 * invalid escapes and incomplete objects fail closed; no regex searches data. */
export class AnswerStream {
  private state: State = "start";
  private key: Key | undefined;
  private keys = new Set<string>();
  private value: { text?: string; kind?: string; evidenceIds?: string[] } = {};
  private stringRole: "key" | "value" | "evidence" | undefined;
  private stringValue = "";
  private escape = false;
  private unicode: string | undefined;
  private highSurrogate = "";
  private length = 0;

  constructor(private readonly maxChars: number) {}

  push(fragment: string): string {
    this.length += fragment.length;
    if (this.length > this.maxChars) throw new Error("Answer limit");
    let delta = "";
    for (const char of fragment.split("")) {
      if (this.stringRole) {
        if (this.unicode !== undefined) {
          if (!"0123456789abcdefABCDEF".includes(char)) throw new Error("Invalid unicode escape");
          this.unicode += char;
          if (this.unicode.length === 4) {
            delta += this.append(String.fromCharCode(Number.parseInt(this.unicode, 16)));
            this.unicode = undefined;
          }
        } else if (this.escape) {
          this.escape = false;
          if (char === "u") this.unicode = "";
          else {
            const escapes: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
            const decoded = escapes[char];
            if (decoded === undefined) throw new Error("Invalid escape");
            delta += this.append(decoded);
          }
        } else if (char === "\\") this.escape = true;
        else if (char === '"') this.endString();
        else {
          if (char.charCodeAt(0) < 32) throw new Error("Unescaped control character");
          delta += this.append(char);
        }
        continue;
      }
      if (char === " " || char === "\t" || char === "\n" || char === "\r") continue;
      switch (this.state) {
        case "start": this.expect(char, "{"); this.state = "keyOrEnd"; break;
        case "keyOrEnd":
          if (char === "}") { this.state = "done"; break; }
          this.expect(char, '"'); this.beginString("key"); break;
        case "key": this.expect(char, '"'); this.beginString("key"); break;
        case "colon": this.expect(char, ":"); this.state = "value"; break;
        case "value":
          if (this.key === "evidenceIds") {
            this.expect(char, "["); this.value.evidenceIds = []; this.state = "arrayFirst";
          } else { this.expect(char, '"'); this.beginString("value"); }
          break;
        case "arrayFirst":
          if (char === "]") { this.state = "after"; break; }
          this.expect(char, '"'); this.beginString("evidence"); break;
        case "arrayValue": this.expect(char, '"'); this.beginString("evidence"); break;
        case "arrayAfter":
          if (char === "]") this.state = "after";
          else { this.expect(char, ","); this.state = "arrayValue"; }
          break;
        case "after":
          if (char === "}") this.state = "done";
          else { this.expect(char, ","); this.state = "key"; }
          break;
        case "done": throw new Error("Trailing data");
      }
    }
    return delta;
  }

  finish(): Answer {
    if (this.state !== "done" || this.stringRole) throw new Error("Incomplete answer");
    const answer = AnswerSchema.parse(this.value);
    if (!answer.text.trim()) throw new Error("Empty answer");
    return answer;
  }

  private expect(actual: string, expected: string) { if (actual !== expected) throw new Error("Invalid answer JSON"); }
  private beginString(role: "key" | "value" | "evidence") { this.stringRole = role; this.stringValue = ""; }
  private append(char: string): string {
    const code = char.charCodeAt(0);
    if (this.highSurrogate) {
      if (code < 0xdc00 || code > 0xdfff) throw new Error("Invalid surrogate");
      char = this.highSurrogate + char;
      this.highSurrogate = "";
    } else if (code >= 0xd800 && code <= 0xdbff) { this.highSurrogate = char; return ""; }
    else if (code >= 0xdc00 && code <= 0xdfff) throw new Error("Invalid surrogate");
    this.stringValue += char;
    return this.stringRole === "value" && this.key === "text" ? char : "";
  }
  private endString() {
    if (this.highSurrogate) throw new Error("Incomplete surrogate");
    if (this.stringRole === "key") {
      const key = this.stringValue;
      if ((key !== "text" && key !== "kind" && key !== "evidenceIds") || this.keys.has(key)) throw new Error("Invalid key");
      this.keys.add(key); this.key = key; this.state = "colon";
    } else if (this.stringRole === "evidence") {
      this.value.evidenceIds?.push(this.stringValue); this.state = "arrayAfter";
    } else {
      if (this.key === "text") this.value.text = this.stringValue;
      if (this.key === "kind") this.value.kind = this.stringValue;
      this.state = "after";
    }
    this.stringRole = undefined;
  }
}
