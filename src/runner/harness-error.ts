export type HarnessErrorKind =
  | "usage-limit"
  | "process"
  | "protocol"
  | "timeout"
  | "interrupted";

export class HarnessError extends Error {
  override readonly name: string = "HarnessError";

  constructor(
    message: string,
    readonly kind: HarnessErrorKind,
    options?: ErrorOptions,
    readonly stderr = "",
  ) {
    super(message, options);
  }
}

const USAGE_LIMIT_PATTERN = /usage limit|rate limit|too many requests|\b429\b|quota/i;

export function isUsageLimitFailure(detail: string): boolean {
  return USAGE_LIMIT_PATTERN.test(detail);
}
