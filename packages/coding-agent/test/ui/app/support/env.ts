/**
 * App-corpus environment, imported right after `./pin-env` and before any app
 * module: a fixed HOME (so no user config, keybindings, themes, extensions or
 * sessions leak in), a fixed project directory as cwd, no network (every
 * `fetch` rejects, so side requests such as title generation fail fast and
 * the scripted model is the only model), and an environment reduced to a
 * whitelist (no credentials or provider config to detect, no PI_* knobs).
 *
 * This module has no app imports on purpose so its body runs before theirs.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * This process's own temp directory (`TMPDIR` below): concurrent replays (other test runs) never
 * share the scratch tree, and the app still shows it as `omp-corpus-app/home/project`, relative to
 * the temp root as captured. `TMPDIR` keeps the form the app standardizes its project dir to
 * (macOS: `/var/…`); the tree itself is used by its realpath (`/private/var/…`) so cwd and HOME agree.
 */
const TEMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "omp-corpus-"));
const SCRATCH = fs.realpathSync(TEMP_ROOT);
process.on("exit", () => fs.rmSync(SCRATCH, { recursive: true, force: true }));
export const APP_ROOT = path.join(SCRATCH, "omp-corpus-app");
export const APP_HOME = path.join(APP_ROOT, "home");
/** The project the app runs in (cwd). */
export const APP_PROJECT = path.join(APP_HOME, "project");

/** Environment kept from the caller; everything else (credentials, cloud/provider config, PI_ and OMP_ knobs) goes. */
const KEEP = new Set([
	"PATH",
	"TMPDIR",
	"LANG",
	"LC_ALL",
	"LC_CTYPE",
	// Set by pin-env.
	"TERM",
	"COLORTERM",
	"TZ",
	"FORCE_COLOR",
	"PI_FORCE_IMAGE_PROTOCOL",
	"PI_NO_HYPERLINKS",
]);
for (const key of Object.keys(process.env)) {
	if (!KEEP.has(key)) delete process.env[key];
}
process.env.TMPDIR = TEMP_ROOT;
process.env.HOME = APP_HOME;
process.env.USER = "corpus";
process.env.SHELL = "/bin/bash";

/** Fresh scratch tree: an empty HOME and a small project the scripted tool calls read and edit. */
export function resetAppRoot(): void {
	fs.rmSync(APP_ROOT, { recursive: true, force: true });
	fs.mkdirSync(path.join(APP_PROJECT, "src"), { recursive: true });
	fs.writeFileSync(
		path.join(APP_PROJECT, "src", "greet.ts"),
		[
			"export function greet(name: string): string {",
			"\treturn `Hello, ${name}`;",
			"}",
			"",
			"export function farewell(name: string): string {",
			"\treturn `Goodbye, ${name}`;",
			"}",
			"",
		].join("\n"),
	);
	fs.writeFileSync(path.join(APP_PROJECT, "README.md"), "# demo\n\nA tiny project for the app corpus.\n");
}

resetAppRoot();
process.chdir(APP_PROJECT);

globalThis.fetch = (async (input: unknown) => {
	throw new Error(`network disabled in corpus capture: ${String(input instanceof Request ? input.url : input)}`);
}) as unknown as typeof fetch;
