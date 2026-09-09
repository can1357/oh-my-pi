#!/usr/bin/env bun
// PTY proof for the chat key semantics: the Escape ladder, double-Esc
// selector, prefix-mode Esc, Ctrl+C clear/quit, dequeue, clipboard chords,
// Alt+A / Ctrl+S overlays, space-hold push-to-talk, and the hard-abort exit.
// No provider is contacted: every step is observer-local.
//
//   cd /tmp/omp-parity-keys && OMP_DATA_DIR=$PWD/data bun /work/omp/scripts/qa/smoke-keys.ts

import { symlinkSync } from "node:fs";
import { resolve } from "node:path";
import tuiFactory, { type TuiParams } from "../../.omp/tools/tui.ts";

const repo = resolve(import.meta.dir, "../..");
const fixture = process.cwd();
process.env.OMP_DATA_DIR ??= resolve(fixture, "data");

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
				// Already linked.
			}
		}
		return { stdout, stderr, code };
	},
});

const NAME = "keys";

async function op(params: TuiParams): Promise<string> {
	const result = await tool.execute("smoke", params);
	return result.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

type Values = {
	composer?: string;
	overlay?: string;
	overlay_open?: boolean;
	overlay_depth?: number;
	notice?: string;
	turn_active?: boolean;
	recording?: boolean;
	prefix_mode?: string;
	focused_agent?: string;
};

async function values(): Promise<Values> {
	const parsed = JSON.parse(await op({ op: "values", name: NAME })) as { values?: Values };
	return parsed.values ?? {};
}

async function keys(spec: string): Promise<void> {
	await op({ op: "keys", name: NAME, keys: spec, quiet: true });
}

async function screen(label: string): Promise<string> {
	const value = await op({ op: "text", name: NAME });
	console.log(`\n===== ${label} =====\n${value}`);
	return value;
}

function check(label: string, ok: boolean, detail?: unknown): void {
	if (!ok) throw new Error(`${label}: ${JSON.stringify(detail)}`);
	console.log(`ok - ${label}`);
}

async function until(label: string, predicate: (v: Values) => boolean, timeoutMs = 5_000): Promise<Values> {
	const deadline = Date.now() + timeoutMs;
	let last: Values = {};
	while (Date.now() < deadline) {
		last = await values();
		if (predicate(last)) return last;
		await Bun.sleep(50);
	}
	throw new Error(`${label}: timed out; last ${JSON.stringify(last)}`);
}

const args = ["chat", "--no-ext", "--model", process.env.OMP_SMOKE_MODEL ?? "anthropic/claude-sonnet-4-5"];
let started = false;
try {
	console.log(await op({ op: "start", name: NAME, bin: "omp", build: process.env.OMP_SMOKE_BUILD !== "0", args, rows: 40, cols: 120, timeout: 60 }));
	started = true;
	await screen("boot");

	// esc-layer-10: Esc never destroys a draft.
	await keys("'draft'");
	await keys("esc");
	let v = await values();
	check("esc keeps the draft", v.composer === "draft", v);

	// key-clear: Ctrl+C clears the draft first.
	await keys("C-c");
	v = await values();
	check("ctrl+c clears the draft", v.composer === "", v);

	// esc-layer-11 / key-esc-double-rewind: two Esc within 500ms open the selector.
	await keys("esc");
	await Bun.sleep(700);
	v = await values();
	check("a lone esc opens nothing", !v.overlay, v);
	await keys("esc esc");
	v = await until("double esc runs `branch`", (v) => Boolean(v.overlay) || Boolean(v.notice));
	await screen("after double esc");
	console.log(`double esc → overlay=${JSON.stringify(v.overlay)} notice=${JSON.stringify(v.notice)}`);
	while ((await values()).overlay) await keys("esc");

	// esc-layer-8: prefix mode.
	await keys("'!ls -la'");
	v = await values();
	check("`!` enters bash prefix mode", v.prefix_mode === "bash", v);
	await keys("esc");
	v = await values();
	check("esc in bash mode clears the draft", v.composer === "" && !v.prefix_mode, v);
	await keys("'$1+1'");
	v = await values();
	check("`$` enters eval prefix mode", v.prefix_mode === "eval", v);
	await keys("esc");
	v = await values();
	check("esc in eval mode clears the draft", v.composer === "", v);

	// key-message-dequeue.
	await keys("alt-up");
	v = await values();
	check("alt+up with nothing queued reports", v.notice === "No queued messages to restore", v);

	// key-clipboard-copy-line / copy-prompt.
	await keys("'one'");
	await keys("copy-line");
	v = await values();
	check("alt+shift+l copies the line", v.notice === "Copied line", v);
	await keys("copy-prompt");
	v = await values();
	check("alt+shift+c copies the prompt", v.notice === "Copied prompt", v);
	await keys("C-c");

	// key-clipboard-paste-raw: the read runs in the background and lands
	// verbatim (or reports an empty clipboard); never a crash.
	await keys("paste-raw");
	await Bun.sleep(1500);
	v = await values();
	check("ctrl+shift+v completed", v.composer !== undefined, v);
	await screen("after raw paste");
	await keys("C-c");

	// key-agents-hub / key-session-observe: the bound console words run.
	await keys("M-a");
	v = await until("alt+a reaches `agents`", (v) => Boolean(v.overlay) || Boolean(v.notice));
	console.log(`alt+a → overlay=${JSON.stringify(v.overlay)} notice=${JSON.stringify(v.notice)}`);
	await screen("after alt+a");
	while ((await values()).overlay) await keys("esc");
	await keys("C-s");
	v = await until("ctrl+s reaches `hub`", (v) => Boolean(v.overlay) || Boolean(v.notice));
	console.log(`ctrl+s → overlay=${JSON.stringify(v.overlay)} notice=${JSON.stringify(v.notice)}`);
	while ((await values()).overlay) await keys("esc");

	// key-stt-space-hold: a metronomic space repeat starts push-to-talk; the
	// 250ms idle gap releases it. Sampled over time.
	await keys("'hi'");
	for (let i = 0; i < 6; i++) {
		await keys("space");
		await Bun.sleep(30);
	}
	v = await until("held space starts recording", (v) => v.recording === true, 2_000);
	check("pre-burst spaces are tracked back", v.composer === "hi", v);
	await screen("recording");
	v = await until("release ends recording", (v) => v.recording === false, 2_000);
	await screen("released");
	await keys("C-c");

	// key-clear-hard-abort: Ctrl+C on an empty idle composer quits; the tty
	// is restored and a further SIGINT during teardown exits 130 at once.
	await keys("C-c");
	const deadline = Date.now() + 15_000;
	let listing = "";
	while (Date.now() < deadline) {
		listing = await op({ op: "list" });
		if (listing.includes("exited(")) break;
		await Bun.sleep(100);
	}
	check("chat exited", listing.includes("exited(0)"), listing);
	const raw = await op({ op: "raw", name: NAME, peek: 0 });
	const stats = JSON.parse(raw.split("\n", 1)[0]) as Record<string, number>;
	check("mouse tracking restored", (stats.mouse_on ?? 0) <= (stats.mouse_off ?? 0), stats);
	console.log("\nkeys PTY smoke passed");
} finally {
	if (started) {
		try {
			await op({ op: "stop", name: NAME });
		} catch {
			// Already gone.
		}
	}
}
