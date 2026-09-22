/** Read only the documented answers prefix. Drafts are never accepted answers.
 * A different property order simply defers display until final validation. */
export function discussionDrafts(content: string): { roleId: string; text: string }[] {
  const prefix = /^\s*\{\s*"answers"\s*:\s*\[/.exec(content);
  if (!prefix) return [];
  let offset = prefix[0].length;
  const drafts: { roleId: string; text: string }[] = [];
  while (drafts.length < 3) {
    const remaining = content.slice(offset);
    const start = /^\s*,?\s*\{\s*"roleId"\s*:\s*("(?:[^"\\]|\\.)*")\s*,\s*"answer"\s*:\s*\{\s*"text"\s*:\s*"/.exec(remaining);
    if (!start) break;
    let end = start[0].length;
    let safeEnd = end;
    while (end < remaining.length && remaining[end] !== '"') {
      if (remaining[end] === "\\") {
        const width = remaining[end + 1] === "u" ? 6 : 2;
        if (end + width > remaining.length) break;
        end += width;
      } else end++;
      safeEnd = end;
    }
    try { drafts.push({ roleId: JSON.parse(start[1]!), text: JSON.parse(`"${remaining.slice(start[0].length, safeEnd)}"`) }); }
    catch { break; }
    // Locate the end of this complete answer item without treating braces in
    // strings (including escaped quotes) as structure.
    let depth = 0; let quoted = false; let escaped = false; let closed = false;
    for (let index = remaining.indexOf("{"); index < remaining.length; index++) {
      const char = remaining[index];
      if (quoted) { if (escaped) escaped = false; else if (char === "\\") escaped = true; else if (char === '"') quoted = false; }
      else if (char === '"') quoted = true;
      else if (char === "{") depth++;
      else if (char === "}" && --depth === 0) { offset += index + 1; closed = true; break; }
    }
    if (!closed) break;
  }
  return drafts;
}
