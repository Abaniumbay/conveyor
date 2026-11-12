// Every plugin this build ships. The composition root (src/cli/commands/serve.ts) registers them;
// nothing else imports a plugin.

import type { Plugin } from "../core/plugins";
import { claudeCodePlugin } from "./claude-code";
import { codexPlugin } from "./codex";
import { dashboardPlugin } from "./dashboard";
import { githubActions } from "./github/ci";
import { githubCode } from "./github/code";
import { githubItemsPlugin } from "./github/items";

export { githubItems } from "./github/items";

export const PLUGINS: readonly Plugin[] = [githubItemsPlugin, githubCode, githubActions, codexPlugin, claudeCodePlugin, dashboardPlugin];
