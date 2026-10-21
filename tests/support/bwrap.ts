/**
 * Whether `bwrap --unshare-net` works here; sandbox tests skip when it does not (e.g. a developer machine without
 * bubblewrap). Under CI an unavailable bwrap throws instead, so the isolation suites can never be skipped there.
 */
export function bwrapUnavailableReason(): string | null {
  const reason = probeBwrap();
  if (reason && process.env.CI) throw new Error(`bwrap is required in CI but unavailable: ${reason}`);
  return reason;
}

function probeBwrap(): string | null {
  if (!Bun.which("bwrap")) return "bwrap is not installed";
  const probe = Bun.spawnSync(["bwrap", "--unshare-net", "--dev-bind", "/", "/", "true"], { stderr: "pipe" });
  if (probe.exitCode === 0) return null;
  return probe.stderr.toString().trim() || `bwrap exited with ${probe.exitCode}`;
}
