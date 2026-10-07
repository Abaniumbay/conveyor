#!/usr/bin/env bun
// Regenerate dashboard screenshots with isolated demo data.
// Usage: bun run scripts/regenerate-screenshots.ts
// Output: docs/screenshots/{board,item,reports,operator,team}.png

import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { ConveyorStore } from "../src/db/store";

const DEMO_HOME = path.join(tmpdir(), `conveyor-screenshots-${Date.now()}`);
const DEMO_LISTEN = "127.0.0.1:9876";
const DEMO_USERNAME = "demo";
const DEMO_PASSWORD = "demo-password-12chars";
const DEMO_TIMEOUT = 30_000;

let serverProcess: ReturnType<typeof Bun.spawn> | null = null;
let browserProcess: Awaited<ReturnType<typeof chromium.launch>> | null = null;

async function cleanup() {
  if (serverProcess) {
    serverProcess.kill("SIGTERM");
    await serverProcess.exited.catch(() => {});
  }
  if (browserProcess) await browserProcess.close();
  try {
    await rm(DEMO_HOME, { recursive: true, force: true });
  } catch {}
}

function exit(message: string, code = 1) {
  console.error(`Error: ${message}`);
  void cleanup();
  process.exit(code);
}

async function waitForServer(url: string, timeout: number) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try {
      const resp = await fetch(url, { redirect: "manual" });
      if (resp.status === 200 || resp.status === 302) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Server did not respond within ${timeout}ms`);
}

async function main() {
  try {
    console.log("Setting up demo environment...");
    await mkdir(DEMO_HOME, { recursive: true });

    // Initialize with the init command
    console.log("Initializing Conveyor home...");
    await writeFile("/tmp/demo-password.txt", DEMO_PASSWORD);
    const initProcess = Bun.spawn(
      [
        "bun",
        "run",
        "src/cli.ts",
        "init",
        "--home",
        DEMO_HOME,
        "--admin-username",
        DEMO_USERNAME,
        "--admin-password-file",
        "/tmp/demo-password.txt",
      ],
      {
        cwd: process.cwd(),
        stdout: "inherit",
        stderr: "inherit",
      }
    );

    const exitCode = await initProcess.exited;
    if (exitCode !== 0) throw new Error(`Init failed with exit code ${exitCode}`);
    await rm("/tmp/demo-password.txt", { force: true });

    // Modify the configuration to set the listen address
    const configPath = path.join(DEMO_HOME, "config", "conveyor.yaml");
    let config = await readFile(configPath, "utf8");
    config = config.replace("listen: 127.0.0.1:7788", `listen: ${DEMO_LISTEN}`);
    await writeFile(configPath, config);

    // Seed database with demo data
    console.log("Seeding demo data...");
    const dbPath = path.join(DEMO_HOME, "data", "conveyor.sqlite");
    const now = new Date().toISOString();
    const store = await ConveyorStore.open(dbPath);

    // Create demo repository
    store.upsertRepository({
      id: "demo",
      configName: "demo",
      source: "github",
      address: "demo/demo-repo",
      folder: "/tmp/demo-repo",
      configHash: "demo-config-hash",
    });

    // Create demo issues in different stages
    const demoIssues = [
      {
        id: "demo#1",
        repositoryId: "demo",
        sourceNumber: 1,
        sourceUrl: "https://github.com/demo/demo-repo/issues/1",
        title: "Setup authentication system",
        body: "Implement user authentication for the dashboard",
        sourceState: "open",
        sourceStateReason: null,
        labels: ["conveyor", "backend"],
        sourceUpdatedAt: now,
      },
      {
        id: "demo#2",
        repositoryId: "demo",
        sourceNumber: 2,
        sourceUrl: "https://github.com/demo/demo-repo/issues/2",
        title: "Add dashboard notifications",
        body: "Enable real-time notifications for dashboard events",
        sourceState: "open",
        sourceStateReason: null,
        labels: ["conveyor", "web"],
        sourceUpdatedAt: now,
      },
    ];

    for (const issue of demoIssues) {
      store.upsertIssue(issue as any);
    }

    store.close();

    // Start demo server
    console.log("Starting demo server...");
    serverProcess = Bun.spawn(
      [
        "bun",
        "run",
        "src/cli.ts",
        "serve",
        "--home",
        DEMO_HOME,
      ],
      {
        cwd: process.cwd(),
        env: process.env,
        stdout: "inherit",
        stderr: "inherit",
      }
    );

    // Wait for server to be ready
    console.log("Waiting for server...");
    await waitForServer(`http://${DEMO_LISTEN}/health/live`, DEMO_TIMEOUT);

    // Launch browser
    console.log("Launching browser...");
    browserProcess = await chromium.launch({ headless: true });
    const ctx = await browserProcess.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1,
      colorScheme: "light",
    });

    const page = await ctx.newPage();

    // Sign in
    console.log("Signing in...");
    await page.goto(`http://${DEMO_LISTEN}/login`);
    await page.waitForLoadState("networkidle");

    // Fill login form
    await page.fill("input[name=username]", DEMO_USERNAME);
    await page.fill("input[name=password]", DEMO_PASSWORD);

    // Submit and wait for redirect to board
    await Promise.all([
      page.waitForNavigation({ url: /\/(board|attention|\/)?$/, timeout: 10_000 }),
      page.click("button[type=submit]"),
    ]);

    // Capture board screenshot
    console.log("Capturing board...");
    await page.goto(`http://${DEMO_LISTEN}/board`);
    await page.waitForLoadState("networkidle");
    await page.screenshot({ path: "docs/screenshots/board.png" });

    // Capture team screenshot
    console.log("Capturing team...");
    await page.goto(`http://${DEMO_LISTEN}/team`);
    await page.waitForLoadState("networkidle");
    await page.screenshot({ path: "docs/screenshots/team.png" });

    // Capture operator screenshot
    console.log("Capturing operator...");
    await page.goto(`http://${DEMO_LISTEN}/operator`);
    await page.waitForLoadState("networkidle");
    await page.screenshot({ path: "docs/screenshots/operator.png" });

    // Capture reports screenshot
    console.log("Capturing reports...");
    await page.goto(`http://${DEMO_LISTEN}/reports`);
    await page.waitForLoadState("networkidle");
    await page.screenshot({ path: "docs/screenshots/reports.png" });

    // Capture item screenshot
    console.log("Capturing item...");
    await page.goto(`http://${DEMO_LISTEN}/issues/demo/1`);
    await page.waitForLoadState("networkidle");
    await page.screenshot({ path: "docs/screenshots/item.png" });

    console.log("Screenshots generated successfully");
  } catch (error) {
    exit(error instanceof Error ? error.message : String(error), 1);
  } finally {
    await cleanup();
  }
}

main();
