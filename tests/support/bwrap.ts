/** Whether `bwrap --unshare-net` works here; sandbox tests skip when it does not (e.g. CI runners without bubblewrap). */
export function bwrapUnavailableReason(): string | null {
  if (!Bun.which("bwrap")) return "bwrap is not installed";
  const probe = Bun.spawnSync(["bwrap", "--unshare-net", "--dev-bind", "/", "/", "true"], { stderr: "pipe" });
  if (probe.exitCode === 0) return null;
  return probe.stderr.toString().trim() || `bwrap exited with ${probe.exitCode}`;
}
