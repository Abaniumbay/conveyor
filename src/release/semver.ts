// Semantic version ordering (https://semver.org, section 11), shared by upgrade and the release script.

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

export function parseVersion(version: string): [number, number, number, string | null] | null {
  const match = SEMVER.exec(version);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3]), match[4] ?? null] : null;
}

/** Pre-release suffixes: dot-separated, numeric identifiers as numbers and before alphanumeric ones. */
function comparePrerelease(left: string, right: string): number {
  const [a, b] = [left.split("."), right.split(".")];
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    const [x, y] = [a[index]!, b[index]!];
    if (x === y) continue;
    const [xNumeric, yNumeric] = [/^\d+$/.test(x), /^\d+$/.test(y)];
    if (xNumeric && yNumeric) return Number(x) - Number(y);
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return a.length - b.length;
}

/** Negative, zero or positive as `left` sorts before, equal to, or after `right`; throws on a non-version. */
export function compareVersions(left: string, right: string): number {
  const [a, b] = [parseVersion(left), parseVersion(right)];
  if (!a) throw new Error(`${left} is not a semantic version (X.Y.Z or X.Y.Z-pre)`);
  if (!b) throw new Error(`${right} is not a semantic version (X.Y.Z or X.Y.Z-pre)`);
  for (let index = 0; index < 3; index += 1) if (a[index] !== b[index]) return (a[index] as number) - (b[index] as number);
  if (a[3] === b[3]) return 0;
  if (a[3] === null) return 1;
  if (b[3] === null) return -1;
  return comparePrerelease(a[3], b[3]);
}
