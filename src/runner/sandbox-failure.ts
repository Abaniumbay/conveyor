/**
 * Bubblewrap's own setup errors, as printed when a command inside an agent's sandbox cannot start
 * (`bwrap: No permissions to create a new namespace`, `bwrap: Can't mount …`, `error building bubblewrap command`).
 * An ordinary command failure (a test failure, a missing file, `bwrap: execvp x: No such file`) does not match.
 */
const SANDBOX_SETUP_ERROR =
  /bwrap: (?:No permissions[^\n]*|Can't [^\n]*|Creating new namespace failed[^\n]*|setting up uid map[^\n]*|Failed [^\n]*)|error building bubblewrap command[^\n]*/i;

/** The first sandbox setup error in a failed command's output, or null. */
export function sandboxSetupError(output: unknown): string | null {
  if (typeof output !== "string") return null;
  return SANDBOX_SETUP_ERROR.exec(output)?.[0].trim() ?? null;
}
