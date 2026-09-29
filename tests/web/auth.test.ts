import { describe, expect, test } from "bun:test";
import {
  createWebAuth,
  hashPassword,
  parseCookie,
  verifyPassword,
} from "../../src/web/auth";

const password = "correct horse battery staple";
const passwordHash = hashPassword(password, { salt: "0123456789abcdef" });
const sessionSecret = "test session secret with enough entropy 0123456789";

describe("web authentication", () => {
  test("creates and verifies the documented scrypt password hash format", () => {
    expect(passwordHash).toMatch(/^scrypt\$16384\$8\$1\$/);
    expect(verifyPassword(password, passwordHash)).toBe(true);
    expect(verifyPassword("wrong password", passwordHash)).toBe(false);
    expect(verifyPassword(password, "scrypt$999999999$8$1$bad$bad")).toBe(false);
  });

  test("creates an opaque signed HttpOnly Strict cookie and verifies its session", () => {
    const auth = createWebAuth({ passwordHash, sessionSecret }, {
      now: () => 1_000_000,
      randomBytes: (size) => new Uint8Array(size).fill(7),
    });
    const session = auth.createSession();

    expect(session).not.toBeNull();
    expect(session!.cookie).toContain("HttpOnly");
    expect(session!.cookie).toContain("SameSite=Strict");
    expect(session!.cookie).toContain("Path=/");
    expect(session!.cookie).toContain("Secure");
    expect(session!.cookie).not.toContain(session!.csrfToken);
    expect(auth.getSession(session!.cookie.split(";")[0])).toEqual({
      csrfToken: session!.csrfToken,
      expiresAt: 1_000_000 + 8 * 60 * 60 * 1000,
    });
    expect(auth.authenticate(password)).toBe(true);
  });

  test("expires sessions and rejects tampering and duplicate session cookies", () => {
    let now = 50_000;
    const auth = createWebAuth({ passwordHash, sessionSecret, sessionTtlSeconds: 1 }, {
      now: () => now,
      randomBytes: (size) => new Uint8Array(size).fill(3),
    });
    const session = auth.createSession()!;
    const pair = session.cookie.split(";")[0]!;

    expect(auth.getSession(pair)).not.toBeNull();
    expect(auth.getSession(`${pair}x`)).toBeNull();
    expect(auth.getSession(`${pair}; conveyor_session=other`)).toBeNull();
    now += 1_001;
    expect(auth.getSession(pair)).toBeNull();
  });

  test("validates CSRF tokens in constant-time-safe format and rejects missing or invalid tokens", () => {
    const auth = createWebAuth({ passwordHash, sessionSecret }, {
      randomBytes: (size) => new Uint8Array(size).fill(4),
    });
    const session = auth.createSession()!;
    const pair = session.cookie.split(";")[0]!;

    expect(auth.validateCsrf(pair, session.csrfToken)).toBe(true);
    expect(auth.validateCsrf(pair, `${session.csrfToken}x`)).toBe(false);
    expect(auth.validateCsrf(pair, undefined)).toBe(false);
    expect(auth.validateCsrf("", session.csrfToken)).toBe(false);
  });

  test("fails closed when required environment inputs are missing or malformed", () => {
    const missing = createWebAuth({ passwordHash: undefined, sessionSecret: undefined });
    expect(missing.isConfigured).toBe(false);
    expect(missing.authenticate(password)).toBe(false);
    expect(missing.createSession()).toBeNull();
    expect(missing.getSession(undefined)).toBeNull();

    const invalid = createWebAuth({ passwordHash: "bad", sessionSecret: "short" });
    expect(invalid.isConfigured).toBe(false);
  });

  test("parses cookies without accepting malformed or ambiguous values", () => {
    expect(parseCookie("a=1; conveyor_session=abc.def", "conveyor_session")).toBe("abc.def");
    expect(parseCookie("conveyor_session=first; conveyor_session=second", "conveyor_session")).toBeNull();
    expect(parseCookie("conveyor_session=%0d%0a", "conveyor_session")).toBeNull();
    expect(parseCookie("conveyor_session", "conveyor_session")).toBeNull();
  });
});
