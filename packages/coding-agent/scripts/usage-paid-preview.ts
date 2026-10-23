#!/usr/bin/env bun
/**
 * Runnable preview of paid extra usage on every usage surface, built from the
 * usage-screen spec's case matrix: eight Claude accounts (A1-A8) and five
 * Codex accounts (C1-C5) with their floors, budgets and one provider refusal.
 *
 *   bun scripts/usage-paid-preview.ts                                   the /usage dashboard: Enter details, r refresh, Esc back/exit
 *   bun scripts/usage-paid-preview.ts --frame overview --width 100      the dashboard's ANSI frame
 *   bun scripts/usage-paid-preview.ts --frame detail --width 60 --html detail-60.html
 *   bun scripts/usage-paid-preview.ts --cli | --acp | --native          `omp usage`, ACP `/usage`, the native describe tree
 *
 * Everything runs in memory: an in-memory credential store, Claude reports
 * parsed from canned `/usage` payloads, and the real Codex usage provider over
 * a fake `fetch` that answers `/wham/usage` per bearer token and 404s the
 * rest. It makes no network calls. This launcher only imports Node builtins
 * and runs the preview in a child whose home is a throwaway directory, because
 * importing omp's packages reads `.env` files under the home directory: the
 * preview never touches the real `~/.omp`.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Variables that point omp at a real config, profile or XDG location. */
const REDIRECTING_ENV = /^(PI_|OMP_|XDG_)/;

const home = fs.mkdtempSync(path.join(os.tmpdir(), "omp-usage-paid-preview-"));
const env: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) {
	if (value !== undefined && !REDIRECTING_ENV.test(key)) env[key] = value;
}
env.HOME = home;
env.USERPROFILE = home;

const child = Bun.spawn(
	[process.execPath, path.join(import.meta.dir, "usage-paid-preview", "preview.ts"), ...process.argv.slice(2)],
	{
		env,
		stdio: ["inherit", "inherit", "inherit"],
	},
);
// The child owns the terminal; Ctrl+C reaches it directly.
process.on("SIGINT", () => {});
const code = await child.exited;
fs.rmSync(home, { recursive: true, force: true });
process.exit(code);
