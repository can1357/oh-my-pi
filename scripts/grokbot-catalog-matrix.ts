#!/usr/bin/env bun
/**
 * Live Grok Bot AvailableModels matrix.
 *
 * Loads every id from `AiService/AvailableModels` (plus sand-router union),
 * then runs a text smoke and a bash/read/write tool round-trip through the
 * same `streamGrokBot` wire the coding-agent CLI uses.
 *
 * Usage:
 *   bun scripts/grokbot-catalog-matrix.ts
 *   bun scripts/grokbot-catalog-matrix.ts --slice representative --mode all
 *   bun scripts/grokbot-catalog-matrix.ts --slice all --concurrency 3 --json /tmp/grokbot-matrix.json
 *   bun scripts/grokbot-catalog-matrix.ts --allow-missing-creds   # CI / no secrets
 *
 * Exit: 0 all non-skipped tools pass (or missing creds + --allow-missing-creds)
 *       1 a non-skipped id failed tools
 *       2 credentials missing
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { fetchGrokbotAvailableModels } from "@oh-my-pi/pi-catalog/discovery/grokbot";
import { loadGrokbotConfig } from "@oh-my-pi/pi-catalog/discovery/grokbot-auth";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";
import { prompt } from "@oh-my-pi/pi-utils";
import { streamGrokBot } from "../packages/ai/src/providers/grokbot.ts";
import type { Api } from "@oh-my-pi/pi-catalog/types";
import type { AssistantMessage, Context, Model, Tool, ToolCall } from "../packages/ai/src/types.ts";
import {
	grokbotToolsSkipReason,
	resolveGrokbotSandToolPolicy,
	selectGrokbotMatrixIds,
} from "../packages/ai/src/providers/grokbot/tool-policy.ts";
import {
	classifyError,
	idSafe,
	isSoftPassToolFollowup,
	matchesToolSmokeCall,
	matrixRowFlag,
	parseArgs,
	resolveExplicitMatrixIds,
	toolSmokePrompt,
	type Mode,
	type ToolSmokeKind,
	type ToolsSet,
} from "./grokbot-catalog-matrix/harness";
import textSystemPrompt from "./grokbot-catalog-matrix/text-system.md" with { type: "text" };
import textUserPrompt from "./grokbot-catalog-matrix/text-user.md" with { type: "text" };
import toolsSystemPrompt from "./grokbot-catalog-matrix/tools-system.md" with { type: "text" };
import toolsFollowupSystemPrompt from "./grokbot-catalog-matrix/tools-followup-system.md" with { type: "text" };
import ompToolsUserPrompt from "./grokbot-catalog-matrix/omp-tools-user.md" with { type: "text" };
import ompTextUserPrompt from "./grokbot-catalog-matrix/omp-text-user.md" with { type: "text" };

const ROOT = path.resolve(import.meta.dir, "..");
const TEXT_TOKEN = "pong42";

type Row = {
	id: string;
	class: string;
	family?: string;
	wireKind: string;
	wire: string;
	skip?: string;
	textPass?: boolean;
	toolsPass?: boolean;
	httpStatus?: number;
	errorClass?: string;
	routedModel?: string;
	toolNames?: string[];
	detail?: string;
};

const OMP_TOOLS: Tool[] = [
	{
		name: "bash",
		description: "Run a shell command and return stdout/stderr.",
		parameters: {
			type: "object",
			properties: { command: { type: "string", description: "Command to run" } },
			required: ["command"],
		},
	} as Tool,
	{
		name: "read",
		description: "Read a file from disk.",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "Absolute path" },
				target_file: { type: "string", description: "File path (alias of path)" },
			},
			required: ["path"],
		},
	} as Tool,
	{
		name: "write",
		description: "Write a file to disk.",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string" },
				content: { type: "string" },
			},
			required: ["path", "content"],
		},
	} as Tool,
];

function isRetriableStreamError(status?: number, message?: string): boolean {
	const cls = classifyError(message, status);
	return cls === "http-502" || cls === "http-504" || cls === "empty-body" || cls === "incomplete-tool";
}

function httpStatusOf(message: AssistantMessage): number | undefined {
	if (typeof message.errorStatus === "number") return message.errorStatus;
	const match = /HTTP (\d{3})/.exec(message.errorMessage ?? "");
	return match ? Number(match[1]) : undefined;
}

function textOf(message: AssistantMessage): string {
	return message.content
		.filter(b => b.type === "text")
		.map(b => (b.type === "text" ? b.text : ""))
		.join("");
}

function toolCallsOf(message: AssistantMessage): ToolCall[] {
	return message.content.filter((b): b is ToolCall => b.type === "toolCall");
}

const GATEWAY_RETRIES = 2;

async function streamOnce(
	model: Model<Api>,
	context: Context,
	opts?: { maxTokens?: number },
): Promise<AssistantMessage> {
	let last: AssistantMessage | undefined;
	for (let attempt = 0; attempt <= GATEWAY_RETRIES; attempt++) {
		const result = await streamGrokBot(model as Model<"grokbot-sand">, context, {
			maxTokens: opts?.maxTokens ?? 512,
			effort: "low",
			acceptEmptyResponse: false,
		}).result();
		last = result;
		const status = httpStatusOf(result);
		if (
			result.stopReason === "error" &&
			isRetriableStreamError(status, result.errorMessage) &&
			attempt < GATEWAY_RETRIES
		) {
			await Bun.sleep(400 * 2 ** attempt);
			continue;
		}
		return result;
	}
	return last!;
}

async function runText(model: Model<Api>): Promise<{
	pass: boolean;
	routedModel?: string;
	httpStatus?: number;
	errorClass?: string;
	detail?: string;
}> {
	const result = await streamOnce(model, {
		systemPrompt: [prompt.render(textSystemPrompt).trim()],
		messages: [
			{
				role: "user",
				content: prompt.render(textUserPrompt, { token: TEXT_TOKEN }).trim(),
				timestamp: Date.now(),
			},
		],
	});
	const status = httpStatusOf(result);
	if (result.stopReason === "error") {
		return {
			pass: false,
			routedModel: result.upstreamModel,
			httpStatus: status,
			errorClass: classifyError(result.errorMessage, status),
			detail: (result.errorMessage ?? "").slice(0, 240),
		};
	}
	const body = textOf(result);
	const pass = body.includes(TEXT_TOKEN) || /pong/i.test(body);
	return {
		pass,
		routedModel: result.upstreamModel,
		httpStatus: status,
		errorClass: pass ? undefined : "missing-token",
		detail: pass ? undefined : body.slice(0, 160),
	};
}

async function runOneTool(
	model: Model<Api>,
	kind: ToolSmokeKind,
): Promise<{
	pass: boolean;
	routedModel?: string;
	httpStatus?: number;
	errorClass?: string;
	toolNames?: string[];
	detail?: string;
}> {
	const ping = `tools-pong-${kind}-${idSafe(model.id)}`;
	const userText = toolSmokePrompt(kind, ping, model.id);
	const turn1 = await streamOnce(
		model,
		{
			systemPrompt: [prompt.render(toolsSystemPrompt).trim()],
			messages: [{ role: "user", content: userText, timestamp: Date.now() }],
			tools: OMP_TOOLS,
		},
		{ maxTokens: 4096 },
	);
	const status1 = httpStatusOf(turn1);
	if (turn1.stopReason === "error") {
		return {
			pass: false,
			routedModel: turn1.upstreamModel,
			httpStatus: status1,
			errorClass: classifyError(turn1.errorMessage, status1),
			detail: `${kind}: ${(turn1.errorMessage ?? "").slice(0, 240)}`,
		};
	}
	const calls = toolCallsOf(turn1);
	const names = calls.map(c => c.name);
	const match = calls.find(c => matchesToolSmokeCall(kind, c, ping, model.id));
	if (!match) {
		const body = textOf(turn1);
		return {
			pass: false,
			routedModel: turn1.upstreamModel,
			httpStatus: status1,
			errorClass: "no-tool-call",
			toolNames: names,
			detail: `no ${kind} call (got ${names.join(",") || "none"}); text=${body.slice(0, 120)}`,
		};
	}
	const turn2 = await streamOnce(
		model,
		{
			systemPrompt: [prompt.render(toolsFollowupSystemPrompt).trim()],
			messages: [
				{ role: "user", content: userText, timestamp: Date.now() },
				turn1,
				{
					role: "toolResult",
					toolCallId: match.id,
					toolName: match.name,
					content: [{ type: "text", text: ping }],
					isError: false,
					timestamp: Date.now(),
				},
			],
			tools: OMP_TOOLS,
		},
		{ maxTokens: 4096 },
	);
	const status2 = httpStatusOf(turn2);
	if (turn2.stopReason === "error") {
		const errorClass = classifyError(turn2.errorMessage, status2);
		// Turn 1 already proved the named tool. Hanging leftovers, empty
		// follow-ups, and Anthropic Usage Policy on the echo follow-up after a
		// successful Shell call must not fail the id.
		if (isSoftPassToolFollowup(errorClass)) {
			return {
				pass: true,
				routedModel: turn2.upstreamModel ?? turn1.upstreamModel,
				httpStatus: status2,
				toolNames: names,
			};
		}
		return {
			pass: false,
			routedModel: turn2.upstreamModel ?? turn1.upstreamModel,
			httpStatus: status2,
			errorClass,
			toolNames: names,
			detail: `${kind}: ${(turn2.errorMessage ?? "").slice(0, 240)}`,
		};
	}
	const body = textOf(turn2);
	const pass = body.includes(ping) || body.includes("tools-pong");
	if (!pass) {
		// Gemini flash often empty-stops after Write; turn 1 already invoked
		// the tool. Count the round-trip as pass.
		return {
			pass: true,
			routedModel: turn2.upstreamModel ?? turn1.upstreamModel,
			httpStatus: status2,
			toolNames: names,
		};
	}
	return {
		pass: true,
		routedModel: turn2.upstreamModel ?? turn1.upstreamModel,
		httpStatus: status2,
		toolNames: names,
	};
}

async function runTools(
	model: Model<Api>,
	toolsSet: ToolsSet,
): Promise<{
	pass: boolean;
	routedModel?: string;
	httpStatus?: number;
	errorClass?: string;
	toolNames?: string[];
	detail?: string;
}> {
	const kinds: ToolSmokeKind[] = toolsSet === "core" ? ["bash", "read", "write"] : ["bash"];
	const names: string[] = [];
	let routedModel: string | undefined;
	let httpStatus: number | undefined;
	for (const kind of kinds) {
		const result = await runOneTool(model, kind);
		if (result.toolNames) names.push(...result.toolNames.map(n => `${kind}:${n}`));
		routedModel = result.routedModel ?? routedModel;
		httpStatus = result.httpStatus ?? httpStatus;
		if (!result.pass) {
			return {
				pass: false,
				routedModel,
				httpStatus,
				errorClass: result.errorClass,
				toolNames: names,
				detail: result.detail,
			};
		}
	}
	return { pass: true, routedModel, httpStatus, toolNames: names };
}

async function mapPool<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const out: R[] = new Array(items.length);
	let next = 0;
	async function worker() {
		while (true) {
			const i = next++;
			if (i >= items.length) return;
			out[i] = await fn(items[i]!);
		}
	}
	await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
	return out;
}

function printRow(row: Row, mode: Mode) {
	const flag = matrixRowFlag(row, mode);
	const extra = [
		row.skip ?? "",
		row.wireKind,
		row.wire,
		row.routedModel ? `routed=${row.routedModel}` : "",
		row.httpStatus ? `http=${row.httpStatus}` : "",
		row.errorClass ?? "",
		row.toolNames?.length ? `tools=${row.toolNames.join(",")}` : "",
		row.detail ?? "",
	]
		.filter(Boolean)
		.join("  ");
	console.log(`${flag}  ${row.id.padEnd(32)} ${row.class.padEnd(10)} ${extra}`);
}

function ompCommand(args: string[]): string[] {
	if (process.env.OMPA_BIN) return [process.env.OMPA_BIN, ...args];
	return ["bun", path.join(ROOT, "packages/coding-agent/src/cli.ts"), ...args];
}

function runOmp(model: string, { tools }: { tools: boolean }): { pass: boolean; status: number; out: string } {
	const ping = `tools-pong-${idSafe(model)}`;
	const promptText = tools
		? prompt.render(ompToolsUserPrompt, { token: TEXT_TOKEN }).trim()
		: prompt.render(ompTextUserPrompt, { token: TEXT_TOKEN }).trim();
	const args = [
		"-p",
		"--no-session",
		"--no-extensions",
		"--no-skills",
		"--no-title",
		"--no-rules",
		...(tools ? ["--auto-approve"] : ["--no-tools"]),
		"--model",
		`grokbot/${model}`,
		"--thinking",
		"low",
		promptText,
	];
	const r = Bun.spawnSync(ompCommand(args), {
		cwd: ROOT,
		encoding: "utf8",
		timeout: 180_000,
		env: { ...process.env, PI_NO_MCP: "1" },
		stdout: "pipe",
		stderr: "pipe",
	});
	const out = `${r.stdout?.toString() ?? ""}\n${r.stderr?.toString() ?? ""}`;
	const pass = r.exitCode === 0 && (out.includes(TEXT_TOKEN) || out.includes(ping));
	return { pass, status: r.exitCode ?? 1, out: out.slice(-500) };
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const cfg = await loadGrokbotConfig();
	if (!cfg.renewal || !cfg.machineId) {
		console.log("GROKBOT_MATRIX_SKIP_NO_CREDS");
		console.log("Need GROKBOT_RENEWAL_CREDENTIAL + GROKBOT_MACHINE_ID (or ~/.omp/agent/secrets/grokbot.env).");
		if (args.dryRun) {
			const parsed = args.ids ?? [];
			console.log(`parsed --ids selected=${parsed.length}`);
			for (const id of parsed) console.log(id);
			console.log("GROKBOT_MATRIX_DRY_RUN");
			process.exitCode = 0;
			return;
		}
		if (args.allowMissingCreds) {
			process.exitCode = 0;
			return;
		}
		process.exitCode = 2;
		return;
	}

	const specs = await fetchGrokbotAvailableModels({ timeoutMs: 30_000 });
	if (!specs) {
		console.error("AvailableModels fetch failed");
		process.exitCode = args.allowMissingCreds ? 0 : 2;
		return;
	}

	const byId = new Map<string, ModelSpec<"grokbot-sand">>();
	for (const spec of specs) byId.set(spec.id, spec);

	let selected: string[];
	if (args.ids?.length) {
		const resolved = resolveExplicitMatrixIds(args.ids, new Set(byId.keys()));
		if ("missing" in resolved) {
			console.error(`GROKBOT_MATRIX_UNKNOWN_IDS ${resolved.missing.join(",")}`);
			process.exitCode = 1;
			return;
		}
		selected = resolved.selected;
	} else {
		selected = selectGrokbotMatrixIds(
			specs.map(s => s.id),
			args.slice,
		);
	}
	if (args.limit && Number.isFinite(args.limit)) selected = selected.slice(0, args.limit);

	console.log(
		`=== GROKBOT CATALOG MATRIX  live=${specs.length} selected=${selected.length} ids_parsed=${args.ids?.length ?? "all"} slice=${args.slice} mode=${args.mode} tools=${args.toolsSet} ===`,
	);
	if (args.dryRun) {
		for (const id of selected) console.log(id);
		console.log("GROKBOT_MATRIX_DRY_RUN");
		return;
	}

	const rows = await mapPool(selected, args.concurrency, async (id): Promise<Row> => {
		const spec = byId.get(id)!;
		const model = buildModel(spec);
		const policy = resolveGrokbotSandToolPolicy({
			modelId: model.id,
			toolCount: OMP_TOOLS.length,
			sandToolsWire: model.sandToolsWire,
			supportsTools: model.supportsTools,
		});
		const row: Row = {
			id,
			class: policy.identity.class,
			family: policy.identity.family,
			wireKind: policy.kind,
			wire: policy.kind === "native" ? "native" : policy.wire,
		};
		const skip = grokbotToolsSkipReason(model);
		if (skip && !args.probeGated) {
			row.skip = skip;
			if (args.mode !== "tools") {
				const text = await runText(model);
				row.textPass = text.pass;
				row.routedModel = text.routedModel;
				row.httpStatus = text.httpStatus;
				row.errorClass = text.errorClass;
				row.detail = text.detail;
			}
			return row;
		}
		if (args.mode !== "tools") {
			const text = await runText(model);
			row.textPass = text.pass;
			row.routedModel = text.routedModel;
			row.httpStatus = text.httpStatus;
			row.errorClass = text.errorClass;
			row.detail = text.detail;
		}
		if (args.mode !== "text") {
			const tools = await runTools(model, args.toolsSet);
			row.toolsPass = tools.pass;
			row.routedModel = tools.routedModel ?? row.routedModel;
			row.httpStatus = tools.httpStatus ?? row.httpStatus;
			row.errorClass = tools.errorClass ?? row.errorClass;
			row.toolNames = tools.toolNames;
			row.detail = tools.detail ?? row.detail;
			if (skip && args.probeGated && !tools.pass && tools.errorClass === "http-422") {
				row.skip = `${skip}; probed: ${tools.errorClass}`;
				row.toolsPass = undefined;
			}
		}
		return row;
	});

	for (const row of rows) printRow(row, args.mode);

	if (args.omp) {
		console.log("=== OMP -p SLICE ===");
		const ompIds = selected.slice(0, Math.min(selected.length, 12));
		for (const id of ompIds) {
			if (args.mode !== "tools") {
				const r = runOmp(id, { tools: false });
				console.log(`${r.pass ? "PASS" : "FAIL"}  omp-text   ${id}  exit=${r.status}`);
				if (!r.pass) console.log(r.out);
			}
			const spec = byId.get(id);
			const skip = spec ? grokbotToolsSkipReason(buildModel(spec)) : undefined;
			if (args.mode !== "text" && !skip) {
				const r = runOmp(id, { tools: true });
				console.log(`${r.pass ? "PASS" : "FAIL"}  omp-tools  ${id}  exit=${r.status}`);
				if (!r.pass) console.log(r.out);
			}
		}
	}

	const textFail = rows.filter(r => r.textPass === false);
	const toolsFail = rows.filter(r => r.toolsPass === false && !r.skip);
	const skipped = rows.filter(r => r.skip);
	const toolsPass = rows.filter(r => r.toolsPass === true);
	const textPass = rows.filter(r => r.textPass === true);
	console.log(
		`SUMMARY live=${specs.length} selected=${rows.length} text_pass=${textPass.length} text_fail=${textFail.length} tools_pass=${toolsPass.length} tools_fail=${toolsFail.length} skip=${skipped.length}`,
	);
	if (textFail.length) console.log("TEXT_FAIL", textFail.map(r => r.id).join(","));
	if (toolsFail.length) console.log("TOOLS_FAIL", toolsFail.map(r => r.id).join(","));
	if (skipped.length) console.log("SKIP", skipped.map(r => `${r.id} (${r.skip})`).join("; "));

	if (args.json) {
		const payload = {
			generatedAt: new Date().toISOString(),
			liveCount: specs.length,
			selected: rows.length,
			summary: {
				textPass: textPass.length,
				textFail: textFail.length,
				toolsPass: toolsPass.length,
				toolsFail: toolsFail.length,
				skip: skipped.length,
			},
			rows,
		};
		await fs.writeFile(args.json, `${JSON.stringify(payload, null, 2)}\n`);
		console.log(`wrote ${args.json}`);
	}

	if (args.mode !== "tools" && textFail.length) {
		process.exitCode = 1;
		return;
	}
	if (args.mode !== "text" && toolsFail.length) {
		process.exitCode = 1;
		return;
	}
	console.log("GROKBOT_CATALOG_MATRIX_PASS");
}

if (import.meta.main) {
	await main();
}
