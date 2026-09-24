/** This excludes identifiable editorial matter; it is not a substitute for
 * confirming the corpus. Preserve exact character ranges, never paraphrase the
 * retrieved text to save tokens. Ambiguous/oversized unbroken text is omitted. */
export function primaryExcerpt(text: string, query: string, maximum = 2400): { text: string; start: number; end: number } | null {
  const filenameWrapper = /^「[^\r\n」]{1,300}\.(?:pdf|md|txt|docx?)」\r?\n(?:[ \t]*\r?\n)?/i.exec(text);
  if (filenameWrapper) {
    const offset = filenameWrapper[0].length;
    const excerpt = primaryExcerpt(text.slice(offset), query, maximum);
    return excerpt ? { text: excerpt.text, start: offset + excerpt.start, end: offset + excerpt.end } : null;
  }
  const normalized = text.normalize("NFKC").replace(/\s/g, "");
  const headings = [...text.matchAll(/^\s*#{1,6}\s+(.+)$/gm)].map((match) => match[1]!.replace(/\s/g, ""));
  if (headings.some((heading) => /译者[序跋]|译序|编者[序跋]|编者按|编后记|出版说明|版权|目录|导读|专家解读|内容简介/.test(heading))
    || /出版社数字业务|DigitalLab是|术语的译名|译名做.{0,8}说明|译者按/.test(normalized)
    || /^[ \t]*目录[ \t]*$/m.test(text)
    || /更新时间\s*\d{4}[-年]/.test(text) || !/[\p{L}\p{N}]{3}/u.test(text)) return null;
  const editorialNote = /[—－-]{1,2}\s*(?:原编者注|编者注|校注|译注|译者注)/;
  const editorialLead = /(?:^|\r?\n)\s*(?:>\s*)?(?:\*\*)?(?:原编者注|编者按|编者注|译者按|译者注|译注|校注)\s*[:：]/;
  if (text.length <= maximum && !editorialNote.test(text) && !editorialLead.test(text)) return { text, start: 0, end: text.length };
  const terms = new Set((query.toLowerCase().match(/[a-z]{3,}|[\u3400-\u9fff]{2,}/g) ?? []).flatMap((term) => /^[a-z]/.test(term) ? [term] : Array.from({ length: term.length - 1 }, (_, index) => term.slice(index, index + 2))));
  const paragraphs = [...text.matchAll(/\S[\s\S]*?(?=\r?\n\s*\r?\n|$)/g)].flatMap((match) => {
    const value = match[0];
    if (/^(?:#|「|<|!\[|\[)/.test(value) || editorialNote.test(value) || editorialLead.test(value) || value.length < 8 || value.length > maximum) return [];
    return [{ start: match.index, end: match.index + value.length, score: [...terms].filter((term) => value.toLowerCase().includes(term)).length }];
  });
  paragraphs.sort((a, b) => b.score - a.score || a.start - b.start);
  const best = paragraphs[0];
  if (!best || best.score === 0) return null;
  return { text: text.slice(best.start, best.end), start: best.start, end: best.end };
}
