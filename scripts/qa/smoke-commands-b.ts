#!/usr/bin/env bun
// PTY proof for the dashboard/account/git/misc slash commands: every command
// runs through the composer's `/` popup on the real binary, and each panel
// or notice is sampled from the terminal. No provider is contacted.

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import tuiFactory, { type TuiParams } from "../../.omp/tools/tui.ts";

const repo = resolve(import.meta.dir, "../..");
const fixture = process.cwd();
process.env.OMP_DATA_DIR ??= resolve(fixture, "data");
mkdirSync(resolve(fixture, "data"), { recursive: true });
writeFileSync(resolve(fixture, "note.txt"), "hello from fixture\n");

const schema = {
	describe() {
		return this;
	},
	optional() {
		return this;
	},
};
const zod = {
	object: () => schema,
	string: () => schema,
	boolean: () => schema,
	number: () => schema,
	array: () => schema,
};
const tool = tuiFactory({
	cwd: fixture,
	zod,
	async exec(command: string, args: string[], options?: { cwd?: string; signal?: AbortSignal }) {
		const child = Bun.spawn([command, ...args], {
			cwd: command === "cargo" ? repo : options?.cwd,
			env: process.env,
			stdout: "pipe",
			stderr: "pipe",
			signal: options?.signal,
		});
		const [stdout, stderr, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		return { stdout, stderr, code };
	},
});

const NAME = "commands-b";

async function op(params: TuiParams): Promise<string> {
	const result = await tool.execute(NAME, params);
	return result.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

async function screen(label: string): Promise<string> {
	const text = await op({ op: "text", name: NAME });
	console.log(`\n===== ${label} =====\n${text}`);
	return text;
}

async function waitFor(needles: string[], timeoutMs = 20_000): Promise<string> {
	const deadline = Date.now() + timeoutMs;
	let last = "";
	while (Date.now() < deadline) {
		last = await op({ op: "text", name: NAME });
		if (needles.some((needle) => last.includes(needle))) return last;
		await Bun.sleep(150);
	}
	throw new Error(`timed out waiting for ${JSON.stringify(needles)}:\n${last}`);
}

/** Types `/command`, submits it, and waits for one of the expected fragments. */
async function slash(line: string, expect: string[], label = line): Promise<string> {
	await op({ op: "type", name: NAME, text: line, quiet: true });
	await op({ op: "keys", name: NAME, keys: "enter", quiet: true });
	const text = await waitFor(expect);
	console.log(`\n===== ${label} =====\n${text}`);
	return text;
}

async function esc(times = 1): Promise<void> {
	for (let index = 0; index < times; index += 1) {
		await op({ op: "keys", name: NAME, keys: "escape", quiet: true });
		await Bun.sleep(120);
	}
}

const args = ["chat", "--no-ext", "--no-session", "--model", process.env.OMP_SMOKE_MODEL ?? "anthropic/claude-sonnet-4-5"];
let started = false;
try {
	console.log(await op({ op: "start", name: NAME, bin: "omp", args, rows: 40, cols: 120, timeout: 30 }));
	started = true;
	await waitFor(["Ask anything"]);

	// Palette: the registry projects every declared command with its doc line.
	await op({ op: "type", name: NAME, text: "/ext", quiet: true });
	const palette = await waitFor(["extensions", "extended-context"]);
	if (!palette.includes("extended-context")) throw new Error("palette lacks extended-context");
	await op({ op: "keys", name: NAME, keys: "C-u", quiet: true });
	await esc();

	await slash("/extended-context on", ["Extended context: on"]);
	await slash("/browser visible", ["Browser mode: visible"]);
	await slash("/computer", ["Computer use:"]);
	await slash("/security", ["Security posture", "sv_approval_mode"]);
	await esc();
	await slash("/tools", ["Tools", "read"]);
	await esc();
	await slash("/hotkeys", ["Hotkeys", "bind"]);
	await esc();
	await slash("/context", ["Context", "Compaction threshold"]);
	await esc();
	await slash("/debug", ["Session and data paths", "Debug"]);
	await esc();
	await slash("/status", ["Extension Control Center"]);
	await esc();
	await slash("/usage", ["Usage"]);
	await esc();
	await slash("/agents", ["Agents"]);
	await esc();
	await slash("/hub", ["Agent Hub"]);
	await esc(2);
	await slash("/setup", ["Login", "Esc"]);
	await esc();
	await slash("/git", ["Not a git repository", "Unstaged", "Staged", "commit"]);
	await esc();
	await slash("/export", ["Session exported to:", "Failed to export"]);
	await slash("/ssh", ["No SSH hosts configured", "SSH hosts"]);
	await esc();
	await slash("/memory stats", ["Memory", "unavailable", "backend"]);
	await esc();
	await slash("/join wss://relay.example/room", ["7546bcfa06"]);
	await slash("/prewalk on", ["Director"]);
	await slash("/stats", ["Stats dashboard is not available"]);
	await slash("/copy code", ["No code block to copy."]);
	await slash("/marketplace help", ["Marketplace commands"]);
	await esc();
	await slash("/plugins", ["No plugins installed", "Plugins"]);
	await esc();
	await slash("/changelog", ["No changelog entries found."]);
	await slash("/vision", ["Vision override is unavailable"]);
	await screen("after commands");

	await op({ op: "keys", name: NAME, keys: "C-c", quiet: true });
	const deadline = Date.now() + 15_000;
	let listing = "";
	while (Date.now() < deadline) {
		listing = await op({ op: "list" });
		if (listing.includes("exited(0)")) break;
		await Bun.sleep(100);
	}
	if (!listing.includes("exited(0)")) throw new Error(`chat did not exit cleanly: ${listing}`);
	console.log("\nCommandsB PTY smoke passed");
} finally {
	if (started) {
		try {
			await op({ op: "stop", name: NAME });
		} catch {
			// clean exit already closed the PTY
		}
	}
}
