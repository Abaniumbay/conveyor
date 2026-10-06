// Reads credentials without putting them in command arguments: from a file (`-` is stdin) or, on a
// terminal, from a prompt with echo turned off.

import { readFile } from "node:fs/promises";

import { CliError, EXIT } from "./args";

async function readLine(): Promise<string> {
  const reader = Bun.stdin.stream().getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (!text.includes("\n")) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
  return text.split(/\r?\n/)[0] ?? "";
}

async function stty(...args: string[]): Promise<void> {
  await Bun.spawn(["stty", ...args], { stdin: "inherit", stdout: "ignore", stderr: "ignore" }).exited;
}

/** Whether this process runs on a terminal it may prompt on (the CLI's default for CliIo.interactive). */
export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stderr.isTTY);
}

/** Prompts on stderr when `interactive`; with `secret`, the typed text is not echoed. */
export async function prompt(question: string, interactive: boolean, secret = false): Promise<string> {
  if (!interactive) throw new CliError(`${question.replace(/:\s*$/, "")} is required; this is not an interactive terminal`, EXIT.usage);
  process.stderr.write(question);
  if (!secret) return (await readLine()).trim();
  await stty("-echo");
  try {
    return await readLine();
  } finally {
    await stty("echo");
    process.stderr.write("\n");
  }
}

/** The first line of a file, or of stdin for `-`; a trailing newline is not part of the secret. */
export async function readSecretFile(file: string): Promise<string> {
  const text = file === "-" ? await Bun.stdin.text() : await readFile(file, "utf8").catch((error: unknown) => {
    throw new CliError(`cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`);
  });
  const value = text.split(/\r?\n/)[0] ?? "";
  if (!value) throw new CliError(`${file === "-" ? "stdin" : file} is empty`, EXIT.usage);
  return value;
}

export const MIN_PASSWORD_LENGTH = 12;

/** A new password from a file, or prompted twice on a terminal. */
export async function newPassword(file: string | undefined, interactive: boolean): Promise<string> {
  const password = file ? await readSecretFile(file) : await prompt("New password: ", interactive, true);
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new CliError(`the password must be at least ${MIN_PASSWORD_LENGTH} characters`, EXIT.usage);
  }
  if (!file && (await prompt("Repeat the password: ", interactive, true)) !== password) {
    throw new CliError("the passwords do not match", EXIT.usage);
  }
  return password;
}
