import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes as nodeRandomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";

const COOKIE_NAME = "conveyor_session";
const DEFAULT_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const HASH_BYTES = 32;
const CSRF_BYTES = 32;
const MAX_COOKIE_LENGTH = 4096;
const SCRYPT_MAX_MEMORY = 64 * 1024 * 1024;

export interface PasswordHashOptions {
  /** Salt bytes, or a UTF-8 salt string, for reproducible provisioning/tests. */
  salt?: Uint8Array | string;
  cost?: number;
  blockSize?: number;
  parallelization?: number;
}

export interface WebAuthConfig {
  /** Set from CONVEYOR_PASSWORD_HASH. Format: scrypt$N$r$p$salt$hash, base64url salt/hash. */
  passwordHash: string | undefined;
  /** Set from CONVEYOR_SESSION_SECRET; use at least 32 random bytes. */
  sessionSecret: string | undefined;
  sessionTtlSeconds?: number;
  secureCookies?: boolean;
  username?: string;
  accountById?: (id: string) => WebAccountIdentity | null;
  accountByUsername?: (username: string) => (WebAccountIdentity & { passwordHash: string }) | null;
}

export interface WebAccountIdentity {
  id: string;
  username: string;
  role: "superuser" | "user";
  avatar: string;
  sessionVersion: number;
}

export interface WebAuthDependencies {
  now?: () => number;
  randomBytes?: (size: number) => Uint8Array;
}

export interface WebSession {
  csrfToken: string;
  expiresAt: number;
  account: WebAccountIdentity;
}

export interface CreatedWebSession extends WebSession {
  cookie: string;
}

interface ParsedPasswordHash {
  cost: number;
  blockSize: number;
  parallelization: number;
  salt: Buffer;
  hash: Buffer;
}

interface SessionPayload {
  csrf: string;
  exp: number;
  account: WebAccountIdentity;
}

function toBase64Url(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function fromBase64Url(value: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const decoded = Buffer.from(value, "base64url");
    return decoded.toString("base64url") === value ? decoded : null;
  } catch {
    return null;
  }
}

function getPasswordHashParts(encoded: string): ParsedPasswordHash | null {
  const parts = encoded.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return null;
  const [costText, blockText, parallelText, saltText, hashText] = parts.slice(1);
  if (!/^(?:[1-9][0-9]*)$/.test(costText!) || !/^(?:[1-9][0-9]*)$/.test(blockText!) || !/^(?:[1-9][0-9]*)$/.test(parallelText!)) {
    return null;
  }
  const cost = Number(costText);
  const blockSize = Number(blockText);
  const parallelization = Number(parallelText);
  // Keep provisioning hashes practical and bound the work an untrusted env value can request.
  if (cost < 2 ** 14 || cost > 2 ** 18 || (cost & (cost - 1)) !== 0 || blockSize > 16 || parallelization > 4) {
    return null;
  }
  if (128 * cost * blockSize > SCRYPT_MAX_MEMORY) return null;
  const salt = fromBase64Url(saltText!);
  const hash = fromBase64Url(hashText!);
  if (!salt || salt.length < 16 || salt.length > 64 || !hash || hash.length !== HASH_BYTES) return null;
  return { cost, blockSize, parallelization, salt, hash };
}

/** Creates a dependency-free provisioning hash suitable for CONVEYOR_PASSWORD_HASH. */
export function hashPassword(password: string, options: PasswordHashOptions = {}): string {
  const salt = options.salt === undefined
    ? nodeRandomBytes(16)
    : typeof options.salt === "string"
      ? Buffer.from(options.salt, "utf8")
      : Buffer.from(options.salt);
  const cost = options.cost ?? 2 ** 14;
  const blockSize = options.blockSize ?? 8;
  const parallelization = options.parallelization ?? 1;
  if (salt.length < 16 || salt.length > 64) throw new Error("scrypt salt must be 16 to 64 bytes");
  if (!Number.isInteger(cost) || cost < 2 ** 14 || cost > 2 ** 18 || (cost & (cost - 1)) !== 0) {
    throw new Error("scrypt cost must be a power of two from 16384 to 262144");
  }
  if (!Number.isInteger(blockSize) || blockSize < 1 || blockSize > 16) throw new Error("scrypt block size must be from 1 to 16");
  if (!Number.isInteger(parallelization) || parallelization < 1 || parallelization > 4) {
    throw new Error("scrypt parallelization must be from 1 to 4");
  }
  if (128 * cost * blockSize > SCRYPT_MAX_MEMORY) throw new Error("scrypt parameters exceed the memory limit");
  const hash = scryptSync(password, salt, HASH_BYTES, {
    N: cost,
    r: blockSize,
    p: parallelization,
    maxmem: SCRYPT_MAX_MEMORY,
  });
  return `scrypt$${cost}$${blockSize}$${parallelization}$${toBase64Url(salt)}$${toBase64Url(hash)}`;
}

/** Returns false for malformed or unsupported encodings and compares valid hashes in constant time. */
export function verifyPassword(password: string, encodedHash: string): boolean {
  const parsed = getPasswordHashParts(encodedHash);
  if (!parsed) return false;
  try {
    const actual = scryptSync(password, parsed.salt, parsed.hash.length, {
      N: parsed.cost,
      r: parsed.blockSize,
      p: parsed.parallelization,
      maxmem: SCRYPT_MAX_MEMORY,
    });
    return timingSafeEqual(actual, parsed.hash);
  } catch {
    return false;
  }
}

/** Reads one cookie value. Duplicate names and invalid cookie syntax fail closed. */
export function parseCookie(header: string | undefined, name: string): string | null {
  if (!header || header.length > 16_384 || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) return null;
  let found: string | null = null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const key = part.slice(0, separator).trim();
    if (key !== name) continue;
    if (found !== null) return null;
    const value = part.slice(separator + 1).trim();
    if (!value || value.length > MAX_COOKIE_LENGTH || !/^[A-Za-z0-9._~-]+$/.test(value)) return null;
    found = value;
  }
  return found;
}

function serializeSessionCookie(value: string, expiresAt: number, ttlSeconds: number, secure: boolean): string {
  const expires = new Date(expiresAt).toUTCString();
  return `${COOKIE_NAME}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${ttlSeconds}; Expires=${expires}${secure ? "; Secure" : ""}`;
}

function deriveKey(secret: Buffer, purpose: string): Buffer {
  return createHmac("sha256", secret).update(`conveyor-web-auth:${purpose}`).digest();
}

function safeEqualBase64Url(left: string, right: string, byteLength: number): boolean {
  const leftBytes = fromBase64Url(left);
  const rightBytes = fromBase64Url(right);
  const validLengths = leftBytes?.length === byteLength && rightBytes?.length === byteLength;
  const normalizedLeft = leftBytes?.length === byteLength ? leftBytes : Buffer.alloc(byteLength);
  const normalizedRight = rightBytes?.length === byteLength ? rightBytes : Buffer.alloc(byteLength);
  return timingSafeEqual(normalizedLeft, normalizedRight) && Boolean(validLengths);
}

function constantTextEquals(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function cookieTokenFromHeader(header: string | undefined): string | null {
  return parseCookie(header, COOKIE_NAME);
}

/**
 * Builds a single-user auth API from explicit environment values. No process environment
 * or filesystem access occurs here, which keeps configuration and tests deterministic.
 */
export function createWebAuth(config: WebAuthConfig, dependencies: WebAuthDependencies = {}) {
  const hashParts = config.passwordHash ? getPasswordHashParts(config.passwordHash) : null;
  const secret = config.sessionSecret && Buffer.byteLength(config.sessionSecret, "utf8") >= 32
    ? Buffer.from(config.sessionSecret, "utf8")
    : null;
  const ttl = config.sessionTtlSeconds ?? DEFAULT_SESSION_TTL_SECONDS;
  const validTtl = Number.isInteger(ttl) && ttl >= 1 && ttl <= 30 * 24 * 60 * 60;
  const isConfigured = Boolean(hashParts && secret && validTtl);
  const now = dependencies.now ?? Date.now;
  const random = dependencies.randomBytes ?? ((size: number) => nodeRandomBytes(size));
  const encryptionKey = secret ? deriveKey(secret, "session-encryption") : null;
  const signingKey = secret ? deriveKey(secret, "session-signing") : null;
  const secureCookies = config.secureCookies ?? true;

  function getSession(header: string | undefined): WebSession | null {
    if (!isConfigured || !encryptionKey || !signingKey) return null;
    const token = cookieTokenFromHeader(header);
    if (!token || token.length > MAX_COOKIE_LENGTH) return null;
    const parts = token.split(".");
    if (parts.length !== 5 || parts[0] !== "v1") return null;
    const [, ivText, ciphertextText, tagText, signatureText] = parts;
    const iv = fromBase64Url(ivText!);
    const ciphertext = fromBase64Url(ciphertextText!);
    const tag = fromBase64Url(tagText!);
    const signature = fromBase64Url(signatureText!);
    if (!iv || iv.length !== 12 || !ciphertext || ciphertext.length > 1024 || !tag || tag.length !== 16 || !signature || signature.length !== 32) {
      return null;
    }
    const signedData = parts.slice(0, 4).join(".");
    const expectedSignature = createHmac("sha256", signingKey).update(signedData).digest();
    if (!timingSafeEqual(signature, expectedSignature)) return null;
    try {
      const decipher = createDecipheriv("aes-256-gcm", encryptionKey, iv);
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
      const payload = JSON.parse(plaintext) as Partial<SessionPayload>;
      if (typeof payload.csrf !== "string" || typeof payload.exp !== "number" || !Number.isSafeInteger(payload.exp) || !payload.account || typeof payload.account.id !== "string" || typeof payload.account.username !== "string" || (payload.account.role !== "user" && payload.account.role !== "superuser") || typeof payload.account.avatar !== "string" || !Number.isSafeInteger(payload.account.sessionVersion)) return null;
      const csrfBytes = fromBase64Url(payload.csrf);
      if (!csrfBytes || csrfBytes.length !== CSRF_BYTES || payload.exp <= now()) return null;
      const account = config.accountById ? config.accountById(payload.account.id) : payload.account;
      if (!account) return null;
      if (account.sessionVersion !== payload.account.sessionVersion) return null;
      return { csrfToken: payload.csrf, expiresAt: payload.exp, account };
    } catch {
      return null;
    }
  }

  function createSession(account: WebAccountIdentity = { id: "legacy", username: config.username ?? "operator", role: "superuser", avatar: "🐼", sessionVersion: 1 }): CreatedWebSession | null {
    if (!isConfigured || !encryptionKey || !signingKey) return null;
    const issuedAt = now();
    if (!Number.isSafeInteger(issuedAt)) return null;
    const expiresAt = issuedAt + ttl * 1000;
    const csrfToken = toBase64Url(random(CSRF_BYTES));
    if (fromBase64Url(csrfToken)?.length !== CSRF_BYTES) return null;
    const ivBytes = random(12);
    if (ivBytes.length !== 12) return null;
    const iv = Buffer.from(ivBytes);
    const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify({ csrf: csrfToken, exp: expiresAt, account } satisfies SessionPayload), "utf8"),
      cipher.final(),
    ]);
    const base = `v1.${toBase64Url(iv)}.${toBase64Url(ciphertext)}.${toBase64Url(cipher.getAuthTag())}`;
    const signature = createHmac("sha256", signingKey).update(base).digest();
    const token = `${base}.${toBase64Url(signature)}`;
    return {
      csrfToken,
      expiresAt,
      account,
      cookie: serializeSessionCookie(token, expiresAt, ttl, secureCookies),
    };
  }

  return {
    isConfigured,
    cookieName: COOKIE_NAME,
    authenticate(username: string, password?: string): boolean {
      if (config.accountByUsername) {
        if (password === undefined) return false;
        const account = config.accountByUsername(username);
        const hash = account?.passwordHash ?? config.passwordHash;
        const passwordMatches = Boolean(hash && verifyPassword(password, hash));
        return Boolean(account && passwordMatches);
      }
      if (password !== undefined && config.username && !constantTextEquals(username, config.username)) return false;
      const submittedPassword = password ?? username;
      if (!hashParts || !config.passwordHash || !secret) return false;
      return verifyPassword(submittedPassword, config.passwordHash);
    },
    findAccount(username: string): WebAccountIdentity | null {
      const account = config.accountByUsername?.(username);
      if (!account) return null;
      const { passwordHash: _passwordHash, ...identity } = account;
      return identity;
    },
    createSession,
    getSession,
    validateCsrf(cookieHeader: string | undefined, submittedToken: string | undefined): boolean {
      const session = getSession(cookieHeader);
      if (!session || !submittedToken) return false;
      return safeEqualBase64Url(session.csrfToken, submittedToken, CSRF_BYTES);
    },
    clearCookie(): string {
      return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT${secureCookies ? "; Secure" : ""}`;
    },
  };
}
