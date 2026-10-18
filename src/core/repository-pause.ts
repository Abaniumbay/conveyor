/** Signals that a durable repository pause deferred a source write. */
export class RepositoryPausedError extends Error {
  override readonly name = "RepositoryPausedError";

  constructor() {
    super("Repository is paused; its recorded work will continue when it resumes.");
  }
}
