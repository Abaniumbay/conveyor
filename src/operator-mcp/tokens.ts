import { createHash, randomBytes } from "node:crypto";

const PREFIX = "cvop_";

/** A new random token; the caller shows it once and stores only `hashOperatorToken` of it. */
export function newOperatorToken(): string {
  return `${PREFIX}${randomBytes(32).toString("base64url")}`;
}

export function hashOperatorToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
