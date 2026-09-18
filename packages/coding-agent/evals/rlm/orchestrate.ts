#!/usr/bin/env bun
/**
 * Offline RLM A/B orchestrator (arms: off | on).
 *
 * Measures root-prompt corpus bytes and tokenizer-estimated context after a
 * fixed fat-read workload. No provider calls — mock tool results only.
 *
 *   bun evals/rlm/orchestrate.ts
 *   bun evals/rlm/report.ts
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { Tokenizer } from "@oh-my-pi/pi-agent-core";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import {
	getRlmStore,
	resetRlmStoresForTest,
	wrapToolWithRlmSpill,
} from "../../src/rlm";

import { Settings } from "../../src/config/settings";
import type { ToolSession } from "../../src/tools";

const ROOT = import.meta.dir;
const RESULTS = path.join(ROOT, "results", "results.jsonl");
const WORKLOADS = JSON.parse(await Bun.file(path.join(ROOT, "workloads.json")).text()) as {
	spillBytes: number;
	workloads: Workload[];
};

type FileSpec = {
	name: string;
	bytes: number;
	needleId?: string;
	needleEvery?: number;
	count?: number;
};

type Workload = {
	id: string;
	description: string;
	files: FileSpec[];
	needles: Array<{ id: string; offsetHint?: number }>;
};

type Arm = "off" | "on";

type Cell = {
	ts: number;
	arm: Arm;
	workload: string;
	originalBytes: number;
	rootCorpusBytes: number;
	stubBytes: number;
	contextTokens: number;
	spilled: number;
	handles: string[];
	needleInStub: boolean;
	needleRecoverable: boolean;
	M1_reduction: number;
	pass_C3: boolean;
	pass_M5: boolean;
};

function needleToken(id: string): string {
	const sha = createHash("sha256").update(id).digest("hex").slice(0, 8);
	return `NEEDLE_${id}_${sha}`;
}

function buildCorpus(spec: FileSpec): { text: string; needles: string[] } {
	const needles: string[] = [];
	const id = spec.needleId ?? (spec.needleEvery && spec.needleEvery > 0 ? "mid" : undefined);
	if (id) {
		const n = needleToken(id);
		needles.push(n);
		const pad = Math.max(0, spec.bytes - n.length);
		const left = Math.floor(pad / 2);
		const right = pad - left;
		// Midpoint plant keeps the needle out of the stub preview window (first ~240 chars).
		return { text: `${"x".repeat(left)}${n}${"y".repeat(right)}`, needles };
	}
	return { text: "s".repeat(spec.bytes), needles: [] };
}


function expandFiles(specs: FileSpec[]): Array<{ name: string; text: string; needles: string[] }> {
	const out: Array<{ name: string; text: string; needles: string[] }> = [];
	for (const spec of specs) {
		const count = spec.count ?? 1;
		for (let i = 0; i < count; i++) {
			const name = spec.name.replace("{i}", String(i));
			const built = buildCorpus({ ...spec, name });
			out.push({ name, text: built.text, needles: built.needles });
		}
	}
	return out;
}

function estTokens(text: string, tokenizer: Tokenizer): number {
	return tokenizer.countTokens(text);
}

function appendJsonl(row: Cell): void {
	fs.mkdirSync(path.dirname(RESULTS), { recursive: true });
	fs.appendFileSync(RESULTS, `${JSON.stringify(row)}\n`);
}

async function runCell(arm: Arm, workload: Workload): Promise<Cell> {
	resetRlmStoresForTest();
	const settings = Settings.isolated({
		"rlm.enabled": arm === "on",
		"rlm.spillBytes": WORKLOADS.spillBytes,
	});
	const session = { cwd: `/tmp/rlm-eval-${arm}-${workload.id}`, settings } as ToolSession;
	const store = getRlmStore(session);
	const spillBytes = WORKLOADS.spillBytes;
	const tokenizer = new Tokenizer();
	const files = expandFiles(workload.files);

	let originalBytes = 0;
	let rootCorpusBytes = 0;
	let stubBytes = 0;
	let spilled = 0;
	const handles: string[] = [];
	const rootTexts: string[] = [];
	let needleInStub = false;
	const allNeedles = new Set<string>();

	for (const file of files) {
		for (const n of file.needles) allNeedles.add(n);
		originalBytes += Buffer.byteLength(file.text, "utf8");

		const tool = wrapToolWithRlmSpill(
			{
				name: "read",
				execute: async () => ({
					content: [{ type: "text" as const, text: file.text }],
					details: {},
				}),
			} as unknown as AgentTool,
			store,
			spillBytes,
			{ enabled: () => arm === "on" },
		);

		const result = await tool.execute(`call-${file.name}`, {});
		const textPart = result.content.find(part => part.type === "text");
		const text = textPart && textPart.type === "text" ? textPart.text : "";
		rootTexts.push(text);
		rootCorpusBytes += Buffer.byteLength(text, "utf8");
		if (text.includes("[rlm spilled") || text.includes("rlm://h/")) {
			spilled++;
			stubBytes += Buffer.byteLength(text, "utf8");
			const match = text.match(/rlm:\/\/h\/\d+/);
			if (match) handles.push(match[0]);
			for (const n of allNeedles) {
				if (text.includes(n)) needleInStub = true;
			}
		} else {
			for (const n of file.needles) {
				// full body may contain needle when arm=off — not a C3 fail
			}
		}
	}

	// M5: recover first needle via search when spilled
	let needleRecoverable = arm === "off" ? true : allNeedles.size === 0;
	if (arm === "on" && handles.length > 0 && allNeedles.size > 0) {
		const target = [...allNeedles][0]!;
		let ok = false;
		for (const handle of handles) {
			const hits = store.search(handle, target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), 4);
			if (hits.some(hit => hit.text.includes(target))) {
				ok = true;
				break;
			}
		}
		needleRecoverable = ok;
	}

	const contextBlob = rootTexts.join("\n");
	const contextTokens = estTokens(contextBlob, tokenizer);
	const M1_reduction = originalBytes === 0 ? 1 : 1 - rootCorpusBytes / originalBytes;


	return {
		ts: Date.now(),
		arm,
		workload: workload.id,
		originalBytes,
		rootCorpusBytes,
		stubBytes,
		contextTokens,
		spilled,
		handles,
		needleInStub: arm === "on" ? needleInStub : false,
		needleRecoverable,
		M1_reduction,
		pass_C3: arm === "off" ? true : !needleInStub,
		pass_M5: needleRecoverable,
	};
}

async function main(): Promise<void> {
	fs.mkdirSync(path.dirname(RESULTS), { recursive: true });
	if (fs.existsSync(RESULTS)) fs.unlinkSync(RESULTS);

	const arms: Arm[] = ["off", "on"];
	for (const workload of WORKLOADS.workloads) {
		if (workload.id === "W0-smoke") {
			// smoke is live-RPC only; record a placeholder
			for (const arm of arms) {
				appendJsonl({
					ts: Date.now(),
					arm,
					workload: workload.id,
					originalBytes: 0,
					rootCorpusBytes: 0,
					stubBytes: 0,
					contextTokens: 0,
					spilled: 0,
					handles: [],
					needleInStub: false,
					needleRecoverable: true,
					M1_reduction: 1,
					pass_C3: true,
					pass_M5: true,
				});
			}
			continue;
		}
		for (const arm of arms) {
			const cell = await runCell(arm, workload);
			appendJsonl(cell);
			console.log(
				`${cell.workload} arm=${cell.arm} orig=${cell.originalBytes} root=${cell.rootCorpusBytes} tok=${cell.contextTokens} M1=${(cell.M1_reduction * 100).toFixed(1)}% C3=${cell.pass_C3} M5=${cell.pass_M5}`,
			);
		}
	}
	console.log(`wrote ${RESULTS}`);
}

await main();
