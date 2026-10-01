/** Render the small Markdown subset used by operator-facing reports and messages. */

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      default: return "&#39;";
    }
  });
}

function safeHref(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

const INLINE = /(`[^`\n]+`|\[[^\]\n]+\]\([^\s)]+\)|\*\*[^*\n]+\*\*|\*[^*\n]+\*|_[^_\n]+_|https?:\/\/[^\s<>"')\]]+)/g;

function inline(markdown: string): string {
  let rendered = "";
  let cursor = 0;
  for (const match of markdown.matchAll(INLINE)) {
    const token = match[0];
    const index = match.index;
    rendered += escapeHtml(markdown.slice(cursor, index));
    if (token.startsWith("`")) {
      rendered += `<code>${escapeHtml(token.slice(1, -1))}</code>`;
    } else if (token.startsWith("[")) {
      const parts = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
      const href = parts ? safeHref(parts[2]!) : null;
      rendered += href
        ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${inline(parts![1]!)}</a>`
        : escapeHtml(token);
    } else if (token.startsWith("**")) {
      rendered += `<strong>${inline(token.slice(2, -2))}</strong>`;
    } else if (token.startsWith("*") || token.startsWith("_")) {
      rendered += `<em>${inline(token.slice(1, -1))}</em>`;
    } else {
      const href = safeHref(token.replace(/[.,;:!?]+$/, ""));
      const suffix = href ? token.slice(href.length) : "";
      rendered += href
        ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(href)}</a>${escapeHtml(suffix)}`
        : escapeHtml(token);
    }
    cursor = index + token.length;
  }
  return rendered + escapeHtml(markdown.slice(cursor));
}

/**
 * Escape first and emit only paragraphs, line breaks, lists, emphasis, code and safe links.
 * Raw HTML is always displayed as text.
 */
export function renderSafeMarkdown(markdown: string): string {
  const output: string[] = [];
  let paragraph: string[] = [];
  let list: "ul" | "ol" | null = null;
  const flushParagraph = () => {
    if (paragraph.length > 0) output.push(`<p>${paragraph.map(inline).join("<br>")}</p>`);
    paragraph = [];
  };
  const closeList = () => {
    if (list) output.push(`</${list}>`);
    list = null;
  };

  for (const line of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    const bullet = /^\s*[-*]\s+(.+)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.+)$/.exec(line);
    const nextList = bullet ? "ul" : numbered ? "ol" : null;
    if (nextList) {
      flushParagraph();
      if (list !== nextList) {
        closeList();
        output.push(`<${nextList}>`);
        list = nextList;
      }
      output.push(`<li>${inline((bullet ?? numbered)![1]!)}</li>`);
    } else if (line.trim().length === 0) {
      flushParagraph();
      closeList();
    } else {
      closeList();
      paragraph.push(line);
    }
  }
  flushParagraph();
  closeList();
  return output.join("");
}
