/** How a failure from an upstream service (GitHub) should be treated: wait and retry, or investigate. */
export interface UpstreamErrorClass {
  kind: "transient" | "permanent";
  upstream?: "github";
  status?: number;
  /** First line of the message with tokens and secrets removed. */
  detail: string;
}

const SECRET_PATTERNS: RegExp[] = [
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\b(Bearer|token|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /(https?:\/\/)[^\s/@:]+(?::[^\s/@]*)?@/gi,
  /\b(authorization|x-access-token|password|secret|token)(\s*[:=]\s*)\S+/gi,
];

function redact(text: string): string {
  let out = text;
  out = out.replace(SECRET_PATTERNS[0]!, "[redacted]").replace(SECRET_PATTERNS[1]!, "[redacted]");
  out = out.replace(SECRET_PATTERNS[2]!, "$1 [redacted]");
  out = out.replace(SECRET_PATTERNS[3]!, "$1[redacted]@");
  out = out.replace(SECRET_PATTERNS[4]!, "$1$2[redacted]");
  return out;
}

function firstLine(message: string): string {
  return redact(message.split(/\r?\n/, 1)[0]!.trim()).slice(0, 300);
}

function httpStatus(message: string): number | undefined {
  const match = /\bHTTP[/ ]*(?:\d\.\d\s+)?(\d{3})\b/i.exec(message) ?? /\b(?:status(?: code)?|returned|error)[:\s]+(\d{3})\b/i.exec(message);
  if (!match) return undefined;
  const status = Number(match[1]);
  return status >= 100 && status <= 599 ? status : undefined;
}

/** Classify a thrown value. Pure: it only reads the error's message (and cause chain). */
export function classifyUpstreamError(error: unknown): UpstreamErrorClass {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current !== undefined && current !== null; depth += 1) {
    if (current instanceof Error) {
      parts.push(current.message);
      const stderr = (current as { stderr?: unknown }).stderr;
      if (typeof stderr === "string" && stderr) parts.push(stderr);
      current = current.cause;
    } else {
      parts.push(String(current));
      break;
    }
  }
  const message = parts.join("\n");
  const detail = firstLine(parts[0] ?? "");
  const status = httpStatus(message);

  if (status !== undefined && (status >= 500 || status === 429)) return { kind: "transient", upstream: "github", status, detail };
  if (/something went wrong while executing your query/i.test(message)) return { kind: "transient", upstream: "github", ...(status !== undefined ? { status } : {}), detail };
  if (/secondary rate limit|rate limit exceeded|too many requests/i.test(message)) return { kind: "transient", upstream: "github", status: status ?? 429, detail };
  if (/fatal error|internal server error/i.test(message) && /(push|remote|refs?\b|commit_refs)/i.test(message)) return { kind: "transient", upstream: "github", detail };
  if (/unexpected end of json input/i.test(message)) return { kind: "transient", upstream: "github", detail };
  return { kind: "permanent", ...(status !== undefined ? { status } : {}), detail };
}
