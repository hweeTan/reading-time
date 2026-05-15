export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function basename(p: string): string {
  return p.split(/[/\\]/).pop() ?? p;
}

export function slugify(s: string): string {
  return (
    s
      .slice(0, 40)
      .replace(/[^\w\u00C0-\u024f]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase() || "speech"
  );
}

export function stripUnwantedChars(text: string): string {
  return text.replace(/\u25a0/g, "");
}

export function streamJobTitle(text: string): string {
  return text.slice(0, 48).replace(/\s+/g, " ") + (text.length > 48 ? "…" : "");
}
