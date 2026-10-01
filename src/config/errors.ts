export class ConfigError extends Error {
  override readonly name = "ConfigError";

  constructor(message: string) {
    super(message);
  }
}
