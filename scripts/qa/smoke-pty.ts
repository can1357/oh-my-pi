#!/usr/bin/env bun

import { symlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import tuiFactory, { type TuiParams } from "../../.omp/tools/tui.ts";

const repo = resolve(import.meta.dir, "../..");
const fixture = process.cwd();
// The document authority is one per project root (ADR 0006): every smoke
// script that uses this fixture must share one data dir, or the daemon left by
// the previous script blocks attachment. Matches smoke-spine.sh / smoke-tools.sh.
process.env.OMP_DATA_DIR ??= resolve(fixture, "data");
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
			const target = resolve(fixture, "target");
			try {
				symlinkSync(resolve(repo, "target"), target, "dir");
			} catch {
				// An existing fixture target already points at the shared build.
			}
		}
		return { stdout, stderr, code };
	},
});

async function op(params: TuiParams): Promise<string> {
	const result = await tool.execute("smoke", params);
	return result.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

async function screen(label: string): Promise<string> {
	const value = await op({ op: "text", name: "phase5" });
	console.log(`\n===== ${label} =====\n${value}`);
	return value;
}

async function waitFor(needle: string | ((screen: string) => boolean), timeoutMs = 180_000): Promise<string> {
	const deadline = Date.now() + timeoutMs;
	let current = "";
	const matches = typeof needle === "string" ? (screen: string) => screen.includes(needle) : needle;
	while (Date.now() < deadline) {
		current = await op({ op: "text", name: "phase5" });
		if (matches(current)) return current;
		await Bun.sleep(250);
	}
	throw new Error(`timed out waiting for ${JSON.stringify(String(needle))}\n${current}`);
}

/** Blocks until the host reports no active turn (spinner off, receipt journaled). */
async function waitIdle(timeoutMs = 60_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const values = JSON.parse(await op({ op: "values", name: "phase5" })) as {
			values?: { turn_active?: boolean };
		};
		if (values.values?.turn_active === false) return;
		await Bun.sleep(200);
	}
	throw new Error("turn did not settle");
}

/** Whether some screenshot row is exactly `text` once its `│` prefix and padding go. */
function hasRow(screen: string, text: string): boolean {
	return screen.split("\n").some((line) => line.replace(/^│/, "").trim() === text);
}

const args = ["chat", "--no-ext"];
const model = process.env.OMP_SMOKE_MODEL ?? "anthropic/claude-sonnet-4-5";
args.push("--model", model);
if (model.startsWith("anthropic/") && process.env.ANTHROPIC_API_KEY) {
	args.push("--api-key", process.env.ANTHROPIC_API_KEY);
}
let started = false;
try {
	console.log(
		await op({
			op: "start",
			name: "phase5",
			bin: "omp",
			build: true,
			args,
			rows: 40,
			cols: 120,
			timeout: 30,
		}),
	);
	started = true;
	const welcome = await screen("welcome + composer");
	// Screenshot rows are `│`-prefixed after a one-line viewport header.
	const welcomeRows = welcome
		.split("\n")
		.filter((row) => row.startsWith("│"))
		.map((row) => row.slice(1));
	if (!welcome.includes("Welcome back!") || !welcome.includes("omp v")) {
		throw new Error("welcome banner was not painted");
	}
	const promptRow = welcomeRows.findIndex((row) => row.startsWith("╰─ "));
	if (promptRow < 0) throw new Error("composer prompt glyph `╰─ ` was not painted");
	if (!welcomeRows[promptRow].includes("Ask anything")) {
		throw new Error("composer placeholder was not painted");
	}
	const cursorAt = async (label: string, expected: [number, number]) => {
		const info = JSON.parse(await op({ op: "info", name: "phase5" })) as { cursor?: number[] };
		const cursor = info.cursor ?? [];
		if (cursor[0] !== expected[0] || cursor[1] !== expected[1]) {
			throw new Error(`${label}: cursor at ${JSON.stringify(cursor)}, expected ${JSON.stringify(expected)}`);
		}
		console.log(`${label}: cursor at [${cursor.join(", ")}]`);
	};
	// Prompt gutter `╰─ ` is three cells: the caret sits at column 3 of the prompt row.
	await cursorAt("boot caret", [promptRow, 3]);

	const prompt = "Reply with exactly the word pong";
	await op({ op: "type", name: "phase5", text: prompt, quiet: true });
	await cursorAt("caret after typing", [promptRow, 3 + prompt.length]);
	await op({ op: "keys", name: "phase5", keys: "enter", quiet: true });
	await waitFor((current) => hasRow(current, "pong"));
	await waitIdle();
	const assistantScreen = await screen("assistant response");
	if (!hasRow(assistantScreen, "pong")) {
		throw new Error("assistant did not render the requested pong response");
	}

	await op({
		op: "type",
		name: "phase5",
		text: "Use the read tool to read note.txt and reply with only its contents.",
		quiet: true,
	});
	await op({ op: "keys", name: "phase5", keys: "enter", quiet: true });
	await waitFor("hello from fixture");
	await waitIdle();
	const toolScreen = await screen("settled read card");
	if (!toolScreen.includes("read") || !toolScreen.includes("hello from fixture")) {
		throw new Error("live read card did not settle with fixture output");
	}

	await op({ op: "resize", name: "phase5", rows: 30, cols: 100, quiet: true });
	const resized = await screen("resized 100x30");
	const resizedFrame = await op({ op: "frame", name: "phase5" });
	console.log(`\n===== resized logical frame =====\n${resizedFrame}`);
	if (
		!resizedFrame.includes("pong") ||
		!resizedFrame.includes("hello from fixture") ||
		!resized.includes("╰─ Ask anything")
	) {
		throw new Error("resize lost transcript rows or composer");
	}

	await op({ op: "keys", name: "phase5", keys: "C-c", quiet: true });
	const deadline = Date.now() + 15_000;
	let listing = "";
	while (Date.now() < deadline) {
		listing = await op({ op: "list" });
		if (listing.includes("exited(0)")) break;
		await Bun.sleep(100);
	}
	if (!listing.includes("exited(0)")) throw new Error(`chat did not exit cleanly: ${listing}`);
	const raw = await op({ op: "raw", name: "phase5", peek: 0 });
	console.log(`\n===== terminal restore =====\n${raw}`);
	const stats = JSON.parse(raw.split("\n", 1)[0]) as Record<string, number>;
	if ((stats.mouse_on ?? 0) > (stats.mouse_off ?? 0)) {
		throw new Error(`mouse tracking was not restored: ${raw}`);
	}
	console.log("\nPhase 5 PTY smoke passed");
} finally {
	if (started) {
		try {
			await op({ op: "stop", name: "phase5" });
		} catch {
			// The clean-exit path may already have closed the PTY.
		}
	}
}
