export const SUBMISSION_METADATA_BODY_LIMIT_BYTES = 16_384;

export function normalizeDemoUrl(value: unknown): string | null {
  if (typeof value !== "string" || /[\u0000-\u001f\u007f-\u009f]/.test(value)) throw new Error("Invalid demo URL");
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > 2048 || trimmed.includes("\\")) throw new Error("Invalid demo URL");
  const authority = /^https?:\/\/([^/?#]+)(?:[/?#]|$)/i.exec(trimmed)?.[1];
  if (!authority || authority.includes("@")) throw new Error("Invalid demo URL");
  const url = new URL(trimmed);
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password || url.href.length > 2048) throw new Error("Invalid demo URL");
  return url.href;
}
