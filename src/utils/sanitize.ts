// Strips HTML tags and stray angle brackets to prevent stored XSS via free-text fields.
export function sanitizeText(input: unknown, maxLen = 500): string {
  if (typeof input !== "string") return "";
  return input
    .replace(/<[^>]*>/g, "")
    .replace(/[<>]/g, "")
    .trim()
    .slice(0, maxLen);
}
