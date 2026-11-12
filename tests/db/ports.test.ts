import { describe, expect, test } from "bun:test";

import type {
  AccountStore,
  ConversationStore,
  DatabaseStore,
  DeliveryLogStore,
  EventStore,
  EvidenceStore,
  ItemStore,
  JournalStore,
  MirrorStore,
  ReportStore,
  RunLogStore,
} from "../../src/db/ports";
import type { ConveyorStore } from "../../src/db/store";

type Ports = [ItemStore, JournalStore, EvidenceStore, EventStore, RunLogStore, ConversationStore, MirrorStore, DeliveryLogStore, AccountStore, ReportStore, DatabaseStore];
type KeysOf<Rest extends unknown[]> = Rest extends [infer Head, ...infer Tail] ? keyof Head | KeysOf<Tail> : never;
type Assigned = KeysOf<Ports>;
type Unassigned = Exclude<keyof ConveyorStore, Assigned>;

/** Method names that appear in more than one port. */
type Shared<Rest extends unknown[]> = Rest extends [infer Head, ...infer Tail]
  ? (keyof Head & KeysOf<Tail>) | Shared<Tail>
  : never;

describe("store ports", () => {
  test("every public store method belongs to exactly one domain port", () => {
    // Both checks are compile-time: a new store method fails `bun run typecheck` until a port names it.
    const unassigned: [Unassigned] extends [never] ? [] : [Unassigned] = [];
    const shared: [Shared<Ports>] extends [never] ? [] : [Shared<Ports>] = [];
    expect(unassigned).toEqual([]);
    expect(shared).toEqual([]);
  });
});

