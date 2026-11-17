/** What the walk up an item's parent links reads. */
export interface InheritanceReads {
  issue: (issueId: string) => { id: string; parentId?: string | null } | null;
  dependencies: (issueId: string) => readonly string[];
}

/** A dependency of an ancestor that also holds back its descendants. */
export interface InheritedDependency {
  /** The blocking issue. */
  dependencyId: string;
  /** The ancestor that declares it. */
  ancestorId: string;
  /** 1 for the parent, 2 for the grandparent, and so on. */
  depth: number;
}

/**
 * The dependencies of every ancestor of an item, nearest ancestor first, read from the stored parent
 * links when asked, so a link added later applies at once. A dependency the item lists itself is not
 * repeated.
 */
export function inheritedDependencies(issueId: string, reads: InheritanceReads): InheritedDependency[] {
  const own = new Set(reads.dependencies(issueId));
  const seen = new Set<string>([issueId]);
  const inherited: InheritedDependency[] = [];
  let current = reads.issue(issueId);
  for (let depth = 1; current?.parentId; depth += 1) {
    const ancestorId = current.parentId;
    if (seen.has(ancestorId)) break;
    seen.add(ancestorId);
    for (const dependencyId of reads.dependencies(ancestorId)) {
      if (own.has(dependencyId) || inherited.some((entry) => entry.dependencyId === dependencyId)) continue;
      inherited.push({ dependencyId, ancestorId, depth });
    }
    current = reads.issue(ancestorId);
  }
  return inherited;
}
