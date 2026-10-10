/** A tool request was understood but cannot be fulfilled from its configured contract. */
export class ToolRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolRequestError";
  }
}
