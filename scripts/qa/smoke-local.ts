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

const args = ["chat", "--no-ext", "--no-session", "--model", process.env.OMP_SMOKE_MODEL ?? "anthropic/claude-sonnet-4-5"];
let started = false;
try {
	console.log(await op({ op: "start", name: "phase5", bin: "omp", build: false, args, rows: 40, cols: 120, timeout: 30 }));
	started = true;
	await waitFor("╰─ ");
	await op({ op: "type", name: "phase5", text: "!echo hi" });
	await op({ op: "keys", name: "phase5", keys: "enter" });
	const bash = await waitFor((s) => s.includes("hi") && s.includes("echo hi") && !s.includes("· 0s") , 60_000);
	await waitIdle();
	console.log("\n===== bash card =====\n" + await screen("after !echo hi"));
	await op({ op: "type", name: "phase5", text: "$ 1+1" });
	await op({ op: "keys", name: "phase5", keys: "enter" });
	await Bun.sleep(1500);
	await waitIdle(120_000);
	console.log("\n===== eval card =====\n" + await screen("after $ 1+1"));
} finally {
	if (started) console.log(await op({ op: "stop", name: "phase5" }));
}
