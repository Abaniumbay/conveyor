export class ConfigError extends Error {
  override readonly name = "ConfigError";

  constructor(message: string) {
    super(message);
  }
}

/** Formats a parser position without retaining any YAML source text. */
export function safeYamlDiagnostic(position?: { line: number; col: number }): string {
  return position ? `invalid YAML at line ${position.line}, column ${position.col}` : "invalid YAML";
}
