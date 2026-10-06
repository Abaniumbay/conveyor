import { ConveyorStore } from "../../db/store";
import { hashPassword } from "../../web/auth";
import { CliError, EXIT } from "../args";
import { loadCommandConfig, positional, printJson, stringOption, type Command, type CommandContext } from "../command";
import { newPassword } from "../secret-input";

const USERNAME = /^[\p{L}\p{N}_.@-]{1,64}$/u;

export function validUsername(username: string): string {
  if (!USERNAME.test(username)) throw new CliError("the username must be 1-64 letters, numbers, or ._@-", EXIT.usage);
  return username;
}

/** Opens the configured database for one account operation. */
export async function withStore<T>(context: CommandContext, operation: (store: ConveyorStore) => T | Promise<T>): Promise<T> {
  const config = await loadCommandConfig(context, null);
  const store = await ConveyorStore.open(config.settings.database);
  try {
    return await operation(store);
  } finally {
    store.close();
  }
}

export const adminResetPassword: Command = {
  name: "admin reset-password",
  usage: "<username>",
  summary: "set a dashboard account's password and sign out its sessions",
  options: {
    "password-file": { type: "string", value: "<file|->", description: "read the new password from a file (- for stdin) instead of prompting" },
  },
  details: "Works whether or not the service is running: it uses the same account store the dashboard does.",
  async run(context) {
    const username = positional(context, 0, "username");
    const password = await newPassword(stringOption(context, "password-file"), context.interactive);
    const changed = await withStore(context, (store) => {
      const account = store.dashboardAccountByUsername(username);
      if (!account) return null;
      store.changeDashboardPassword(account.id, hashPassword(password));
      return account;
    });
    if (!changed) throw new CliError(`no dashboard account is named ${username}`, EXIT.failure);
    if (context.json) printJson(context, { username: changed.username, passwordChanged: true });
    else context.out(`Password changed for ${changed.username}; their existing sessions are signed out.`);
  },
};
