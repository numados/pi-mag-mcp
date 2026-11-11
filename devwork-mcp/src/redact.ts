/**
 * Redaction for anything that leaves the server: provider error bodies can echo
 * request headers, and a token that appears in a message is a token that ends up
 * in a transcript or a log file. One owner for the rule, used by every provider
 * and by the stderr log.
 */

const PATTERNS: RegExp[] = [
  // Authorization header values and their bare forms.
  /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  // Common secret-shaped JSON/query fields.
  // Field-shaped values, but never a scheme word: `Authorization: Bearer …` is
  // handled by the rule above and must not be redacted twice.
  /("?(?:access_token|refresh_token|api[_-]?token|token|pat|password|secret|authorization)"?\s*[:=]\s*"?)(?!Bearer\s|Basic\s|Token\s)([^",}\s&]{6,})/gi,
];

export function redact(text: string, secrets: (string | undefined)[] = []): string {
  let output = text;
  for (const secret of secrets) {
    if (!secret || secret.length < 6) continue;
    output = output.split(secret).join("[redacted]");
  }
  for (const pattern of PATTERNS) {
    output = output.replace(pattern, (match, prefix: string) => {
      // Keep the field name, drop the value.
      return match.includes("=") || match.includes(":")
        ? `${prefix}[redacted]`
        : `${prefix} [redacted]`;
    });
  }
  return output;
}

/** Provider error bodies are capped and redacted before they reach a caller. */
export function safeBody(body: string, limit = 400, secrets: (string | undefined)[] = []): string {
  return redact(body.slice(0, limit), secrets);
}
