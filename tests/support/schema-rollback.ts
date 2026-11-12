/**
 * Undoes migration 49 (event class, source and cause). A test that simulates a database from before it,
 * by deleting newer migration records while keeping the events table, runs this first so the
 * migration can apply again.
 */
export const UNDO_EVENT_CLASSES =
  "DROP INDEX events_causation; DROP INDEX events_class_occurred_at; ALTER TABLE events DROP COLUMN class; ALTER TABLE events DROP COLUMN source; ALTER TABLE events DROP COLUMN causation_seq;";
