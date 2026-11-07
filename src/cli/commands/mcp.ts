import { hashOperatorToken, newOperatorToken } from "../../operator-mcp/tokens";
import { CliError, EXIT } from "../args";
import { positional, printJson, type Command } from "../command";
import { withStore } from "./admin";

export const mcpTokenCreate: Command = {
  name: "mcp token create",
  usage: "<name>",
  summary: "create an operator MCP token and print it once",
  details: "Only a hash of the token is stored: copy it now. Works whether or not the service is running.",
  async run(context) {
    const name = positional(context, 0, "name").trim();
    if (!name || name.length > 100) throw new CliError("the token name must be 1-100 characters", EXIT.usage);
    const token = newOperatorToken();
    const record = await withStore(context, (store) => store.createOperatorMcpToken(name, hashOperatorToken(token)));
    if (context.json) printJson(context, { ...record, token });
    else context.out(`Created token ${record.name} (id ${record.id}). It is shown only once:\n${token}`);
  },
};

export const mcpTokenList: Command = {
  name: "mcp token list",
  summary: "list operator MCP tokens (never their values)",
  async run(context) {
    const tokens = await withStore(context, (store) => store.listOperatorMcpTokens());
    if (context.json) return printJson(context, tokens);
    if (tokens.length === 0) return context.out("No operator MCP tokens.");
    for (const token of tokens) context.out(`${token.name}  ${token.id}  created ${token.createdAt}  ${token.revokedAt ? `revoked ${token.revokedAt}` : "active"}`);
  },
};

export const mcpTokenRevoke: Command = {
  name: "mcp token revoke",
  usage: "<id>",
  summary: "revoke an operator MCP token; its next request fails with 401",
  async run(context) {
    const id = positional(context, 0, "id");
    const found = await withStore(context, (store) => store.revokeOperatorMcpToken(id));
    if (!found) throw new CliError(`no operator MCP token has the id ${id}`, EXIT.failure);
    if (context.json) printJson(context, { id, revoked: true });
    else context.out(`Revoked token ${id}.`);
  },
};
