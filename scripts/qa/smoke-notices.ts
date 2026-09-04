#!/usr/bin/env bun
// PTY proof for the host-mounted notice surfaces (ERR-04/06/09): the pinned
// error banner above the editor after a provider failure, its dismissal on
// the next send, and the idle `<key> to Retry` hint after a turn dies on an
// interrupted tool call.
//
// Phase A runs with a bogus Anthropic key (an auth failure is terminal: no
// retry, so the error banner pins at once). Phase B, only when
// `ANTHROPIC_API_KEY` is set, spends one live prompt on a slow `bash` call
// and interrupts it with Esc so the retry hint row appears once idle.

import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import tuiFactory, { type TuiParams } from "../../.omp/tools/tui.ts";

const repo = resolve(import.meta.dir, "../..");
const fixture = process.cwd();
process.env.OMP_DATA_DIR ??= resolve(fixture, "data");
mkdirSync(process.env.OMP_DATA_DIR, { recursive: true });
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
		if (command === "cargo" && code === 0) {
			try {
				symlinkSync(resolve(repo, "target"), resolve(fixture, "target"), "dir");
			} catch {
				// An existing fixture target already points at the shared build.
			}
		}
		return { stdout, stderr, code };
	},
});

const NAME = "notices";

async function op(params: TuiParams): Promise<string> {
	const result = await tool.execute("smoke", params);
	return result.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

async function screen(label: string): Promise<string> {
	const value = await op({ op: "text", name: NAME });
	console.log(`\n===== ${label} =====\n${value}`);
	return value;
}

async function waitFor(needle: string | ((screen: string) => boolean), timeoutMs = 120_000): Promise<string> {
	const deadline = Date.now() + timeoutMs;
	let current = "";
	const matches = typeof needle === "string" ? (screen: string) => screen.includes(needle) : needle;
	while (Date.now() < deadline) {
		current = await op({ op: "text", name: NAME });
		if (matches(current)) return current;
		await Bun.sleep(200);
	}
	throw new Error(`timed out waiting for ${JSON.stringify(String(needle))}\n${current}`);
}

async function waitIdle(timeoutMs = 60_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const values = JSON.parse(await op({ op: "values", name: NAME })) as {
			values?: { turn_active?: boolean };
		};
		if (values.values?.turn_active === false) return;
		await Bun.sleep(200);
	}
	throw new Error("turn did not settle");
}

/** Row index of the composer prompt glyph, in screenshot rows. */
function promptRow(screen: string): number {
	return screen
		.split("\n")
		.filter((row) => row.startsWith("│"))
		.findIndex((row) => row.slice(1).startsWith("╰─ "));
}

const DISMISSAL = "Dismissed when you send your next message.";
const model = process.env.OMP_SMOKE_MODEL ?? "anthropic/claude-sonnet-4-5";

async function start(apiKey: string): Promise<void> {
	console.log(
		await op({
			op: "start",
			name: NAME,
			bin: "omp",
			build: true,
			args: ["chat", "--no-ext", "--model", model, "--api-key", apiKey],
			rows: 40,
			cols: 120,
			timeout: 30,
		}),
	);
	await waitFor("Ask anything");
}

async function stop(): Promise<void> {
	try {
		await op({ op: "keys", name: NAME, keys: "C-c", quiet: true });
		await Bun.sleep(300);
		await op({ op: "stop", name: NAME });
	} catch {
		// Already gone.
	}
}

let started = false;
const phases = process.env.OMP_SMOKE_PHASE ?? "AB";
try {
	// Phase A: terminal provider error → pinned banner, dismissed on next send.
	if (phases.includes("A")) {
	await start("sk-ant-bogus");
	started = true;
	await op({ op: "type", name: NAME, text: "Reply with exactly the word pong", quiet: true });
	await op({ op: "keys", name: NAME, keys: "enter", quiet: true });
	const bannerScreen = await waitFor(DISMISSAL);
	await waitIdle();
	await screen("pinned error banner");
	const rows = bannerScreen.split("\n").filter((row) => row.startsWith("│"));
	const dismissalRow = rows.findIndex((row) => row.includes(DISMISSAL));
	const prompt = promptRow(bannerScreen);
	if (dismissalRow < 0 || prompt < 0 || dismissalRow >= prompt) {
		throw new Error(`banner must sit above the editor (banner row ${dismissalRow}, prompt row ${prompt})`);
	}
	const inlineErrors = rows.filter((row) => row.includes("Error:")).length;
	if (inlineErrors !== 0) {
		throw new Error("the inline error card must be suppressed while the banner pins it (ERR-06)");
	}
	await op({ op: "type", name: NAME, text: "again", quiet: true });
	await op({ op: "keys", name: NAME, keys: "enter", quiet: true });
	// The banner drops on the send itself; the next failure re-pins a new one.
	const afterSend = await op({ op: "text", name: NAME });
	if (afterSend.includes(DISMISSAL)) {
		// The second failure may already have landed: distinguish by the error
		// count in the transcript (two turns errored → two error notices).
		const values = JSON.parse(await op({ op: "values", name: NAME })) as {
			values?: { turn_active?: boolean };
		};
		if (values.values?.turn_active !== false) {
			throw new Error("banner did not clear on the next send");
		}
	}
	await waitIdle();
	await screen("after second send");
	await stop();
	started = false;
	}

	// Phase B: one live prompt whose tool call is interrupted → retry hint.
	const key = process.env.ANTHROPIC_API_KEY;
	if (phases.includes("B") && key && model.startsWith("anthropic/")) {
		await start(key);
		started = true;
		await op({
			op: "type",
			name: NAME,
			text: "Use the bash tool to run exactly `sleep 25` and then reply done.",
			quiet: true,
		});
		await op({ op: "keys", name: NAME, keys: "enter", quiet: true });
		// The running bash card paints the command with a `$ ` lead.
		await waitFor("$ sleep 25");
		await Bun.sleep(1_000);
		await screen("running bash card");
		await op({ op: "keys", name: NAME, keys: "escape", quiet: true });
		await waitIdle();
		console.log(`\n===== blocks after interrupt =====\n${await op({ op: "frame", name: NAME })}`);
		const hint = await waitFor((current) => current.includes("to Retry"), 20_000);
		await screen("idle retry hint");
		const hintRow = hint.split("\n").filter((row) => row.startsWith("│")).findIndex((row) => row.includes("to Retry"));
		const promptAt = promptRow(hint);
		if (hintRow < 0 || promptAt < 0 || hintRow >= promptAt) {
			throw new Error(`retry hint must sit above the editor (hint row ${hintRow}, prompt row ${promptAt})`);
		}
		await stop();
		started = false;
	} else {
		console.log("\n(no ANTHROPIC_API_KEY: retry-hint phase skipped)");
	}
	console.log("\nNotices PTY smoke passed");
} finally {
	if (started) await stop();
}
