/**
 * Does the packaged app come up healthy?
 *
 * Nothing covered this, and the gap was expensive: a capability that granted a
 * command with no scope, a plugin whose Rust half was never registered, and a
 * content security policy tightened without anything to say whether it broke the
 * window — all of them shipped, and all of them are invisible to `bun test`,
 * which never launches anything.
 *
 * This does not click. It answers the narrower question that has been going
 * unasked: launch the real bundle, and see whether the process stays up, the
 * PAGE loads, the relay spawns a sidecar, and nothing in the output says
 * something was refused.
 *
 * "The page loads" is the part that took two tries. A sidecar appearing proves
 * nothing about the webview — Rust pre-warms one during `setup`, before a
 * webview exists — so this script's original check passed with a dead window
 * while its failure message claimed the opposite. What proves it is a line only
 * the page can emit, which `src/shell/diagnostics.ts` sends to the host on boot.
 * That same channel carries the page's CSP violations and uncaught errors out to
 * stderr, which is what makes the refusal patterns below reachable at all.
 *
 *   bun run smoke            # against the existing debug bundle
 *   bun run smoke --build    # build it first
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { WEBVIEW_READY } from "../src/shell/webview-marker";

const ROOT = path.resolve(import.meta.dir, "..");
const APP = path.join(ROOT, "src-tauri/target/debug/bundle/macos/omp Desktop.app/Contents/MacOS/omp-desktop");

/** Long enough for a sidecar to reach `ready`, which was measured at ~3.8s. */
const BOOT_BUDGET_MS = 45_000;
const SETTLE_MS = 4_000;

/**
 * Lines that mean something was refused rather than merely logged. Deliberately
 * broad: silence is the failure mode this exists to break, so a false positive
 * that makes someone read the output is cheaper than a miss.
 */
const REFUSALS = [
	/Content Security Policy/i,
	/Refused to (load|execute|connect|apply)/i,
	/\bForbiddenPath\b/,
	/\bForbiddenUrl\b/,
	/unknown field/i,
	/failed to (parse|deserialize|initialize)/i,
	/not allowed by the scope/i,
	/panicked at/,
];

async function run(command: string, args: string[]): Promise<number> {
	// `Bun.spawn` with the parent's stdio, and its own `exited` promise — the
	// same APIs the rest of this file already uses for `pgrep`, rather than
	// wrapping a node event in a promise by hand.
	const proc = Bun.spawn([command, ...args], { cwd: ROOT, stdout: "inherit", stderr: "inherit" });
	return await proc.exited;
}

async function sidecarCount(): Promise<number> {
	// `pgrep -c` is a GNU flag; macOS rejects it and prints usage to stderr, which
	// silently counted as zero and failed this check every time. Count the lines.
	const proc = Bun.spawn(["pgrep", "-f", "mode rpc-ui"], { stdout: "pipe", stderr: "ignore" });
	const out = await new Response(proc.stdout).text();
	return out.split("\n").filter(line => line.trim()).length;
}

function fail(message: string, detail?: string): never {
	console.error(`\n✗ ${message}`);
	if (detail) console.error(detail);
	process.exit(1);
}

const shouldBuild = process.argv.includes("--build");
if (shouldBuild) {
	console.log("building the debug bundle…");
	if ((await run("bun", ["run", "tauri", "build", "--debug"])) !== 0) fail("the bundle did not build");
}

if (!(await fs.exists(APP))) {
	fail("no debug bundle found", `Expected ${APP}\nRun with --build, or \`bun run tauri build --debug\` first.`);
}

// Only sidecars this run spawns should be counted; the dev app may be running.
const before = await sidecarCount();

console.log("launching the packaged app…");
const child = Bun.spawn([APP], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
/*
 * Both streams into one buffer, because the checks below ask questions of the
 * output as a whole: the page's own diagnostics arrive on stderr through
 * `webview_log`, while a refusal Tauri prints can land on either.
 */
let output = "";
const drain = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
	const decoder = new TextDecoder();
	for await (const chunk of stream) output += decoder.decode(chunk);
};
void drain(child.stdout).catch(() => {});
void drain(child.stderr).catch(() => {});

let exited: number | null = null;
void child.exited.then(code => {
	exited = code;
});

const deadline = Date.now() + BOOT_BUDGET_MS;
let spawned = false;
let loaded = false;
while (Date.now() < deadline && exited === null) {
	await Bun.sleep(1_000);
	if (!spawned && (await sidecarCount()) > before) spawned = true;
	if (!loaded && output.includes(WEBVIEW_READY)) loaded = true;
	// Both, not either: they answer different questions and each has been the
	// one that was broken.
	if (spawned && loaded) break;
}

// Let anything that was going to go wrong go wrong.
if (exited === null) await Bun.sleep(SETTLE_MS);

const refusal = REFUSALS.map(pattern => output.match(pattern)).find(Boolean);
const alive = exited === null;
if (alive) child.kill();

if (exited !== null) fail(`the app exited on its own with code ${exited}`, output.trim() || "(no output)");
if (!loaded) {
	fail(
		"the window never reported itself loaded",
		`Nothing printed "${WEBVIEW_READY}", so the page did not run: the bundle failed to load, the CSP blocked its\n` +
			"script, or it threw before `installDiagnostics`. The process staying up says nothing here — the window\n" +
			"can be blank and alive.\n" +
			(output.trim() || "(no output)"),
	);
}
if (!spawned) {
	fail(
		"the relay never spawned a sidecar",
		"`setup` pre-warms one, so not even that ran: the sidecar binary is missing, or the shell plugin was refused.\n" +
			(output.trim() || "(no output)"),
	);
}
if (refusal) fail(`something was refused: ${refusal[0]}`, output.trim());

console.log("\n✓ the packaged app starts, its window loads, the relay spawns a sidecar, and nothing was refused");
