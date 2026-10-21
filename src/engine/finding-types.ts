/** The fixed classification taxonomy for durable review findings. */
export const FINDING_TYPES = [
  "criterion-not-met",
  "test-missing-case",
  "test-not-real",
  "test-not-discriminating",
  "test-not-run",
  "bug",
  "concurrency",
  "security",
  "error-handling",
  "performance",
  "design",
  "docs",
  "style",
  "general",
] as const;

export type FindingType = (typeof FINDING_TYPES)[number];

export const DEFAULT_FINDING_TYPE: FindingType = "general";

export function isFindingType(value: string): value is FindingType {
  return FINDING_TYPES.some((type) => type === value);
}
