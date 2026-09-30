import type { CodeHost } from "./types";

/** Named CodeHost instances selected by repository configuration. */
export class CodeHostRegistry {
  readonly #hosts = new Map<string, CodeHost>();

  register(name: string, host: CodeHost): this {
    if (this.#hosts.has(name)) throw new Error(`code host "${name}" is already registered`);
    this.#hosts.set(name, host);
    return this;
  }

  get(name: string): CodeHost | undefined {
    return this.#hosts.get(name);
  }
}
