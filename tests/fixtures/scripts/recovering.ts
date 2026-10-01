// Test fixture: logs each phase it is called with to ./calls.log and prints ./control.json[phase] as its stdout.
import { appendFileSync, readFileSync } from "node:fs";

const input = JSON.parse(await new Response(Bun.stdin.stream()).text());
appendFileSync("calls.log", `${JSON.stringify(input)}\n`);
const control = JSON.parse(readFileSync("control.json", "utf8"));
console.log(JSON.stringify(control[input.phase ?? "legacy"]));
