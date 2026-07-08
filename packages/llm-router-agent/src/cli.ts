#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { LLMRouter } from "./agent.js";
import { extractFeatures } from "./features.js";
import { summarizeTelemetry } from "./telemetry.js";
import {
	exportToolRoutingExamplesFromTelemetry,
	formatToolUseRecord,
	normalizeToolCaptureConfig,
	summarizeToolUseTelemetry,
} from "./tool-capture.js";
import type { JsonSchemaLike, RequestInput, ToolUseCaptureInput, ToolUsePhase, ValidationPlan } from "./types.js";
import { validateOutput } from "./validation.js";

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const command = argv[0] ?? "help";
	const args = parseArgs(argv.slice(1));
	if (command === "help" || args.help) {
		printHelp();
		return;
	}
	const configPath = typeof args.config === "string" ? args.config : undefined;
	const router = await LLMRouter.load({ path: configPath });
	if (command === "decide") {
		const request = await requestFromArgs(args);
		const decision = args.log ? await router.decideAndLog(request, { surface: "cli" }) : router.decide(request);
		printJson(decision);
		return;
	}
	if (command === "features") {
		const request = await requestFromArgs(args);
		printJson(extractFeatures(request));
		return;
	}
	if (command === "validate") {
		const output = typeof args.output === "string" ? args.output : await readStdin();
		const schemaPath = typeof args.schema === "string" ? args.schema : undefined;
		const schema = schemaPath ? (JSON.parse(await readFile(schemaPath, "utf8")) as JsonSchemaLike) : undefined;
		const plan: ValidationPlan = {
			requirements: [
				{ type: "non_empty" },
				...(schema || args.requireJson ? ([{ type: "json", schema }] as const) : []),
			],
			onFailure:
				args.onFailure === "escalate" || args.onFailure === "block" || args.onFailure === "repair"
					? args.onFailure
					: "retry-same",
			maxAttempts: Number(args.maxAttempts ?? 1),
		};
		printJson(validateOutput(output, plan, router.config.validation?.unsafePatternHints ?? []));
		return;
	}
	if (command === "telemetry") {
		const path =
			typeof args.path === "string" ? args.path : (router.config.telemetry?.path ?? ".llm-router/telemetry.jsonl");
		printJson(await summarizeTelemetry(path));
		return;
	}
	if (command === "tool-capture") {
		const input = await toolCaptureInputFromArgs(args);
		const record = await router.captureTool(input, { surface: "cli" });
		if (args.pretty && record) console.log(formatToolUseRecord(record));
		else printJson(record ?? { skipped: true, reason: "tool capture disabled or ignored" });
		return;
	}
	if (command === "tool-summary") {
		const captureConfig = normalizeToolCaptureConfig(router.config);
		const path = typeof args.path === "string" ? args.path : captureConfig.path;
		printJson(await summarizeToolUseTelemetry(path));
		return;
	}
	if (command === "tool-export") {
		const captureConfig = normalizeToolCaptureConfig(router.config);
		const inputPath =
			typeof args.input === "string" ? args.input : typeof args.path === "string" ? args.path : captureConfig.path;
		const outputPath = typeof args.output === "string" ? args.output : ".llm-router/tool-routing-training.jsonl";
		const minSavedContextTokens = args.minSavedContextTokens !== undefined ? Number(args.minSavedContextTokens) : 0;
		const summary = await exportToolRoutingExamplesFromTelemetry(inputPath, {
			outputPath,
			includeFailures: args.includeFailures === true,
			minSavedContextTokens,
		});
		printJson({ read: summary.read, exported: summary.exported, outputPath });
		return;
	}
	throw new Error(`Unknown command: ${command}`);
}

function parseArgs(argv: string[]): Record<string, string | boolean | undefined> {
	const args: Record<string, string | boolean | undefined> = {};
	for (let i = 0; i < argv.length; i++) {
		const token = argv[i];
		if (!token) continue;
		if (token.startsWith("--")) {
			const eq = token.indexOf("=");
			if (eq > 0) {
				args[token.slice(2, eq)] = token.slice(eq + 1);
			} else {
				const key = token.slice(2);
				const next = argv[i + 1];
				if (next && !next.startsWith("--")) {
					args[key] = next;
					i += 1;
				} else {
					args[key] = true;
				}
			}
		} else {
			args._ = args._ ? `${String(args._)} ${token}` : token;
		}
	}
	return args;
}

async function requestFromArgs(args: Record<string, string | boolean | undefined>): Promise<RequestInput> {
	if (args.json) {
		const raw = args.message ? String(args.message) : await readStdin();
		return JSON.parse(raw) as RequestInput;
	}
	const message = String(args.message ?? args._ ?? (await readStdin())).trim();
	return {
		message,
		user: {
			tier: typeof args.tier === "string" ? args.tier : undefined,
			preference:
				args.preference === "speed" ||
				args.preference === "quality" ||
				args.preference === "cost" ||
				args.preference === "safety" ||
				args.preference === "balanced"
					? args.preference
					: "balanced",
		},
		expectedOutput: isOutputFormat(args.format) ? { format: args.format } : undefined,
	};
}

async function toolCaptureInputFromArgs(
	args: Record<string, string | boolean | undefined>,
): Promise<ToolUseCaptureInput> {
	if (args.json) {
		const raw = args.message ? String(args.message) : await readStdin();
		return JSON.parse(raw) as ToolUseCaptureInput;
	}
	const toolName = String(args.tool ?? args.toolName ?? args.name ?? "").trim();
	if (!toolName) throw new Error("tool-capture requires --tool <name>");
	const phase = toToolUsePhase(args.phase) ?? undefined;
	return {
		toolName,
		namespace: typeof args.namespace === "string" ? args.namespace : undefined,
		phase,
		requestId: typeof args.requestId === "string" ? args.requestId : undefined,
		conversationId: typeof args.conversationId === "string" ? args.conversationId : undefined,
		turnId: typeof args.turnId === "string" ? args.turnId : undefined,
		toolCallId: typeof args.toolCallId === "string" ? args.toolCallId : undefined,
		args: parseJsonOption(args.argsJson ?? args.args),
		result: parseJsonOption(args.resultJson ?? args.result),
		error: parseJsonOption(args.errorJson ?? args.error),
		promptPreview: typeof args.promptPreview === "string" ? args.promptPreview : undefined,
		latencyMs: args.latencyMs !== undefined ? Number(args.latencyMs) : undefined,
		metadata: { cli: true },
	};
}

function parseJsonOption(value: unknown): unknown {
	if (value === undefined || value === true || value === false) return undefined;
	const text = String(value);
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

function toToolUsePhase(value: unknown): ToolUsePhase | undefined {
	if (
		value === "requested" ||
		value === "started" ||
		value === "completed" ||
		value === "failed" ||
		value === "skipped"
	)
		return value;
	return undefined;
}

function isOutputFormat(value: unknown): value is "text" | "json" | "markdown" | "code" | "csv" | "xml" {
	return (
		value === "text" ||
		value === "json" ||
		value === "markdown" ||
		value === "code" ||
		value === "csv" ||
		value === "xml"
	);
}

async function readStdin(): Promise<string> {
	if (process.stdin.isTTY) return "";
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	return Buffer.concat(chunks).toString("utf8");
}

function printJson(value: unknown): void {
	console.log(JSON.stringify(value, null, 2));
}

function printHelp(): void {
	console.log(`LLM Router Agent

Commands:
  decide      Choose a route for a request
  features    Extract routing features
  validate    Validate an output
  telemetry   Summarize routing telemetry JSONL
  tool-capture Capture a tool call/result/error for tool-routing training
  tool-summary Summarize tool-use telemetry JSONL
  tool-export  Export tool-use telemetry to supervised training JSONL

Examples:
  llm-router-agent decide --message "Debug this stack trace" --preference quality
  llm-router-agent features --message "Translate this to Spanish"
  llm-router-agent validate --output '{"ok":true}' --requireJson
  llm-router-agent telemetry --path .llm-router/telemetry.jsonl
  llm-router-agent tool-capture --tool file_search.msearch --phase completed --args '{"queries":["lease"]}' --result '{"hits":3}'
  llm-router-agent tool-export --output .llm-router/tool-routing-training.jsonl

Options:
  --config <path>       JSON config path
  --message <text>      Request text or JSON when --json is set
  --json                Parse request from JSON
  --log                 Write decision telemetry
  --preference <value>  speed | quality | cost | safety | balanced
  --tier <value>        free | paid | internal | enterprise | custom
  --tool <name>         Tool name for tool-capture
  --phase <value>       requested | started | completed | failed | skipped
  --args <json/text>    Tool arguments for tool-capture
  --result <json/text>  Tool result for tool-capture
  --output <path>       Export path for tool-export
`);
}

main().catch(error => {
	console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
	process.exitCode = 1;
});
