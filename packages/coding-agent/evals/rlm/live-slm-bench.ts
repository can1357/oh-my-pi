#!/usr/bin/env bun
/**
 * Live SLM A/B for RLM (needs GPU + tools-capable local model).
 *
 *   bun evals/rlm/live-slm-bench.ts --model ollama/qwen2.5:3b
 *
 * Headless RPC only — no TUI.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";

const ROOT = import.meta.dir;
const OUT_DIR = path.join(ROOT, "results");
const OUT = path.join(OUT_DIR, "live-slm.jsonl");
const WORK_DIR = fs.mkdtempSync("/tmp/rlm-live-");
const CORPUS = path.join(WORK_DIR, "fat-corpus.txt");
const NEEDLE = `NEEDLE_LIVE_${createHash("sha256").update("rlm-live").digest("hex").slice(0, 8)}`;

const modelArg =
	process.argv.find(a => a.startsWith("--model="))?.slice("--model=".length) ??
	(process.argv.includes("--model") ? process.argv[process.argv.indexOf("--model") + 1] : undefined) ??
	"vllm/Qwen/Qwen2.5-0.5B";

const CORPUS_BYTES = 120_000;

type RpcMsg = Record<string, unknown>;

function isRecord(v: unknown): v is RpcMsg {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function buildCorpus(): void {
	const pad = CORPUS_BYTES - NEEDLE.length;
	const left = Math.floor(pad / 2);
	const right = pad - left;
	fs.writeFileSync(CORPUS, `${"x".repeat(left)}${NEEDLE}${"y".repeat(right)}`);
	console.log(`corpus ${CORPUS} bytes=${CORPUS_BYTES} needle=${NEEDLE}`);
}

type RpcProc = {
	send: (frame: RpcMsg) => void;
	wait: (pred: (msg: RpcMsg) => boolean, ms?: number) => Promise<RpcMsg>;
	close: () => void;
	log: string[];
};

function startRpc(cwd: string, model: string): RpcProc {
	const cli = path.join(ROOT, "../../src/cli.ts");
	const log: string[] = [];
	const proc = spawn(
		"bun",
		[
			cli,
			"--profile",
			"rlm-smoke",
			"--mode",
			"rpc",
			"--no-session",
			"--no-extensions",
			"--no-skills",
			"--no-lsp",
			"--cwd",
			cwd,
			"--model",
			model,
		],
		{ stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, NO_COLOR: "1" } },
	);

	let buf = "";
	const queue: RpcMsg[] = [];
	const waiters: Array<{
		pred: (m: RpcMsg) => boolean;
		resolve: (m: RpcMsg) => void;
		reject: (e: Error) => void;
		t: ReturnType<typeof setTimeout>;
	}> = [];

	const feed = (line: string) => {
		try {
			const msg = JSON.parse(line) as unknown;
			if (!isRecord(msg)) return;
			log.push(line.slice(0, 800));
			for (let i = 0; i < waiters.length; i++) {
				if (waiters[i]!.pred(msg)) {
					const w = waiters.splice(i, 1)[0]!;
					clearTimeout(w.t);
					w.resolve(msg);
					return;
				}
			}
			queue.push(msg);
		} catch {
			/* non-json */
		}
	};

	proc.stdout?.on("data", (chunk: Buffer) => {
		buf += chunk.toString("utf8");
		let idx: number;
		while ((idx = buf.indexOf("\n")) >= 0) {
			const line = buf.slice(0, idx);
			buf = buf.slice(idx + 1);
			if (line.trim()) feed(line);
		}
	});
	proc.stderr?.on("data", (chunk: Buffer) => {
		log.push(`ERR ${chunk.toString("utf8").slice(0, 400)}`);
	});

	let id = 0;
	const send = (frame: RpcMsg) => {
		proc.stdin?.write(`${JSON.stringify({ id: `c${++id}`, ...frame })}\n`);
	};

	const wait = (pred: (m: RpcMsg) => boolean, ms = 120_000) =>
		new Promise<RpcMsg>((resolve, reject) => {
			for (let i = 0; i < queue.length; i++) {
				if (pred(queue[i]!)) {
					resolve(queue.splice(i, 1)[0]!);
					return;
				}
			}
			const t = setTimeout(() => {
				const idx = waiters.findIndex(w => w.t === t);
				if (idx >= 0) waiters.splice(idx, 1);
				reject(new Error(`timeout ${ms}ms`));
			}, ms);
			waiters.push({ pred, resolve, reject, t });
		});

	const close = () => {
		try {
			proc.stdin?.end();
		} catch {
			/* */
		}
		proc.kill("SIGTERM");
	};

	return { send, wait, close, log };
}

async function waitReady(rpc: RpcProc): Promise<void> {
	for (let i = 0; i < 60; i++) {
		rpc.send({ type: "get_state" });
		try {
			const resp = await rpc.wait(
				m => m.type === "response" && m.command === "get_state" && m.success === true,
				4_000,
			);
			if (resp.data) return;
		} catch {
			await Bun.sleep(300);
		}
	}
	throw new Error("RPC never ready");
}

async function getState(rpc: RpcProc): Promise<RpcMsg> {
	rpc.send({ type: "get_state" });
	const resp = await rpc.wait(m => m.type === "response" && m.command === "get_state", 20_000);
	return isRecord(resp.data) ? resp.data : {};
}

function toolNames(state: RpcMsg): string[] {
	const tools = state.dumpTools ?? state.tools;
	if (!Array.isArray(tools)) return [];
	return tools
		.map(t => (typeof t === "string" ? t : isRecord(t) && typeof t.name === "string" ? t.name : null))
		.filter((n): n is string => typeof n === "string");
}

/** Slash/local prompts return promptly; model turns need agent_end. */
async function runPrompt(rpc: RpcProc, message: string, opts: { waitAgent?: boolean; ms?: number } = {}): Promise<{
	events: RpcMsg[];
	elapsedMs: number;
	ttftMs: number | null;
}> {
	const waitAgent = opts.waitAgent ?? true;
	const budget = opts.ms ?? 300_000;
	const events: RpcMsg[] = [];
	const t0 = performance.now();
	let firstDelta: number | null = null;
	rpc.send({ type: "prompt", message });

	const deadline = Date.now() + budget;
	let sawPromptResponse = false;
	let sawAgentStart = false;
	let sawAgentEnd = false;

	while (Date.now() < deadline) {
		const remaining = Math.max(500, deadline - Date.now());
		let m: RpcMsg;
		try {
			m = await rpc.wait(() => true, Math.min(remaining, 60_000));
		} catch {
			break;
		}
		events.push(m);
		const t = m.type;
		if (t === "message_update" || t === "message_start" || t === "turn_start") {
			if (firstDelta === null) firstDelta = performance.now();
		}
		if (t === "response" && m.command === "prompt") sawPromptResponse = true;
		if (t === "prompt_result") sawPromptResponse = true;
		if (t === "agent_start") sawAgentStart = true;
		if (t === "agent_end") {
			sawAgentEnd = true;
			await Bun.sleep(300);
			break;
		}
		// Local slash: prompt_result agentInvoked false and no agent_start
		if (!waitAgent && sawPromptResponse) break;
		if (waitAgent && sawPromptResponse && !sawAgentStart) {
			// give agent_start a moment
			try {
				const maybe = await rpc.wait(x => x.type === "agent_start" || x.type === "agent_end", 2_000);
				events.push(maybe);
				if (maybe.type === "agent_start") sawAgentStart = true;
				if (maybe.type === "agent_end") {
					sawAgentEnd = true;
					break;
				}
			} catch {
				// truly local
				break;
			}
		}
	}

	return {
		events,
		elapsedMs: performance.now() - t0,
		ttftMs: firstDelta !== null ? firstDelta - t0 : null,
	};
}

function blobOf(events: RpcMsg[]): string {
	return events.map(e => JSON.stringify(e)).join("\n");
}

function assistantTexts(events: RpcMsg[]): string {
	const texts: string[] = [];
	for (const e of events) {
		if (e.type === "message_end" || e.type === "message_start") {
			const msg = e.message;
			if (isRecord(msg) && msg.role === "assistant" && Array.isArray(msg.content)) {
				for (const part of msg.content) {
					if (isRecord(part) && part.type === "text" && typeof part.text === "string") texts.push(part.text);
				}
			}
		}
		if (e.type === "message_update" && isRecord(e.assistantMessageEvent)) {
			const ev = e.assistantMessageEvent;
			if (ev.type === "text_delta" && typeof ev.delta === "string") texts.push(ev.delta);
		}
	}
	return texts.join("");
}

function countToolCalls(events: RpcMsg[], name: string): number {
	let n = 0;
	const re = new RegExp(`"name"\\s*:\\s*"${name}"`);
	for (const e of events) {
		const s = JSON.stringify(e);
		if (re.test(s) && (s.includes("toolCall") || s.includes("tool_use") || s.includes('"type":"toolCall"'))) n++;
	}
	return n;
}

async function runArm(arm: "off" | "on", model: string): Promise<Record<string, unknown>> {
	const rpc = startRpc(WORK_DIR, model);
	const row: Record<string, unknown> = {
		ts: Date.now(),
		arm,
		model,
		needle: NEEDLE,
		corpusBytes: CORPUS_BYTES,
		corpusPath: CORPUS,
		ok: false,
	};
	try {
		await waitReady(rpc);
		await runPrompt(rpc, arm === "on" ? "/rlm on" : "/rlm off", { waitAgent: false, ms: 30_000 });
		if (arm === "on") {
			await runPrompt(rpc, "/rlm status", { waitAgent: false, ms: 15_000 });
		}
		const mid = await getState(rpc);
		row.toolsAfterToggle = toolNames(mid);
		row.hasRlmTool = toolNames(mid).includes("rlm");
		row.contextUsageBefore = mid.contextUsage ?? null;
		row.modelInfo = mid.model ?? null;

		const instruction =
			arm === "on"
				? `Use tools. Read file ${CORPUS}. If the result is an rlm:// stub, call rlm search with pattern NEEDLE_LIVE_ on that handle. Print the exact NEEDLE_LIVE_… token as your final answer alone.`
				: `Use tools. Read file ${CORPUS}. Find the exact NEEDLE_LIVE_… token inside it. Print only that token as your final answer.`;

		const turn = await runPrompt(rpc, instruction, { waitAgent: true, ms: 300_000 });
		row.elapsedMs = turn.elapsedMs;
		row.ttftMs = turn.ttftMs;
		row.eventCount = turn.events.length;

		const blob = blobOf(turn.events);
		const assistant = assistantTexts(turn.events);
		row.assistantText = assistant.slice(0, 2000);
		row.needleInAssistant = assistant.includes(NEEDLE);
		row.needleInEvents = blob.includes(NEEDLE);
		row.readCalls = countToolCalls(turn.events, "read");
		row.rlmCalls = countToolCalls(turn.events, "rlm");
		row.sawSpillStub = blob.includes("[rlm spilled") || blob.includes("rlm://h/");
		row.pass_M5_live = assistant.includes(NEEDLE) || (arm === "off" && blob.includes(NEEDLE) && row.readCalls as number > 0);

		const after = await getState(rpc);
		row.contextUsageAfter = after.contextUsage ?? null;
		row.sessionStats = after.sessionStats ?? after.stats ?? null;
		row.ok = row.pass_M5_live === true;
		row.logTail = rpc.log.slice(-25);
	} catch (error) {
		row.error = error instanceof Error ? error.message : String(error);
		row.logTail = rpc.log.slice(-40);
	} finally {
		rpc.close();
		await Bun.sleep(400);
	}
	return row;
}

async function main(): Promise<void> {
	fs.mkdirSync(OUT_DIR, { recursive: true });
	if (fs.existsSync(OUT)) fs.unlinkSync(OUT);
	buildCorpus();
	console.log(`model=${modelArg} work=${WORK_DIR}`);

	const rows: Record<string, unknown>[] = [];
	for (const arm of ["off", "on"] as const) {
		console.log(`\n=== arm=${arm} ===`);
		const row = await runArm(arm, modelArg);
		rows.push(row);
		fs.appendFileSync(OUT, `${JSON.stringify(row)}\n`);
		console.log(
			JSON.stringify(
				{
					arm: row.arm,
					ok: row.ok,
					pass_M5_live: row.pass_M5_live,
					hasRlmTool: row.hasRlmTool,
					readCalls: row.readCalls,
					rlmCalls: row.rlmCalls,
					sawSpillStub: row.sawSpillStub,
					elapsedMs: row.elapsedMs,
					ttftMs: row.ttftMs,
					contextUsageAfter: row.contextUsageAfter,
					assistantText: typeof row.assistantText === "string" ? row.assistantText.slice(0, 300) : null,
					error: row.error,
				},
				null,
				2,
			),
		);
	}

	console.log(`\nwrote ${OUT}`);
	const off = rows.find(r => r.arm === "off");
	const on = rows.find(r => r.arm === "on");
	if (off && on) {
		console.log(
			`summary: off M5=${off.pass_M5_live} tok=${JSON.stringify(off.contextUsageAfter)} ${off.elapsedMs}ms | on M5=${on.pass_M5_live} rlm=${on.hasRlmTool} spill=${on.sawSpillStub} rlmCalls=${on.rlmCalls} tok=${JSON.stringify(on.contextUsageAfter)} ${on.elapsedMs}ms`,
		);
	}
}

await main();
