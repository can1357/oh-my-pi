#!/usr/bin/env bun

// Live model behavioral eval for the async-progress policy prompt. It is
// manual and opt-in on purpose: it needs real provider credentials, spends
// tokens on every run, and scores stochastic model behavior, so it is wired
// only as `bun run eval:async-progress` and must never be added to a `ci:*`
// script. Deterministic batching/queue/wake semantics stay in `bun test`.
//
//   bun run eval:async-progress [--surface bash|hub|all] [--model <pattern>] [--runs N]
//   bun run eval:async-progress --case quick [--model <pattern>] [--runs N]

import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { isRecord, prompt } from "@oh-my-pi/pi-utils";
import { closeDaemonClients } from "../src/launch/client";
import bashQuickEvalPrompt from "../src/prompts/evals/async-progress-quick.md" with { type: "text" };
import bashEvalPrompt from "../src/prompts/evals/async-progress-wake.md" with { type: "text" };
import hubEvalPrompt from "../src/prompts/evals/hub-progress-wake.md" with { type: "text" };
import { AgentRegistry, createAgentSession, Settings } from "../src/sdk";
import type { AgentSessionEvent } from "../src/session/agent-session-events";
import { ASYNC_PROGRESS_MESSAGE_TYPE, ASYNC_RESULT_MESSAGE_TYPE } from "../src/session/async-job-delivery";
import { LAUNCH_COMPLETION_MESSAGE_TYPE } from "../src/session/launch-completion";
import { SessionManager } from "../src/session/session-manager";

const DEFAULT_RUNS = 1;
const DEFAULT_TIMEOUT_MS = 90_000;
type EvalSurface = "bash" | "hub";
type EvalCase = "wake" | "quick";

const SURFACES: EvalSurface[] = ["bash", "hub"];
const READY_EVENT: Record<EvalSurface, string> = {
	bash: "MONITOR_READY",
	hub: "HUB_READY",
};
const ACKNOWLEDGEMENT: Record<EvalSurface, string> = {
	bash: "WAKE_ACK MONITOR_READY",
	hub: "WAKE_ACK HUB_READY",
};

interface EvalConfig {
	case: EvalCase;
	model?: string;
	runs: number;
	timeoutMs: number;
	json: boolean;
	surfaces: EvalSurface[];
}

interface BashCall {
	op?: never;
	command?: string;
	async?: boolean | "auto";
	progress?: string;
}

interface HubCall {
	op?: string;
	name?: string;
	application?: string;
	args?: string[];
	progress?: string;
	persist?: boolean;
}

type EvalToolCall = BashCall | HubCall;

interface EvalCriteria {
	selectedWake?: boolean;
	selectedAutoInline?: boolean;
	onlyExpectedTool: boolean;
	selectedPersistentProcess?: boolean;
	singleToolCall?: boolean;
	singleStart?: boolean;
	noProcessPolling?: boolean;
	noAsyncNotification?: boolean;
	reportedQuickResult?: boolean;
	notificationDelivered?: boolean;
	completionObserved?: boolean;
	notificationBeforeCompletion?: boolean;
	acknowledgedAfterNotification?: boolean;
}

interface EvalRunResult {
	run: number;
	case: EvalCase;
	surface: EvalSurface;
	model: string;
	passed: boolean;
	criteria: EvalCriteria;
	toolCalls: EvalToolCall[];
	executedTools: string[];
	assistantMessages: string[];
	error?: string;
}

function parsePositiveInteger(flag: string, value: string | undefined, fallback: number): number {
	if (value === undefined) return fallback;
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${flag} must be a positive integer`);
	return parsed;
}

function parseArgs(argv: string[]): EvalConfig {
	const valueFor = (flag: string): string | undefined => {
		const index = argv.indexOf(flag);
		return index === -1 ? undefined : argv[index + 1];
	};
	const surfaceValue = valueFor("--surface");
	if (argv.includes("--surface") && surfaceValue === undefined) {
		throw new Error("--surface requires bash, hub, or all");
	}
	const surface = surfaceValue ?? "all";
	if (surface !== "bash" && surface !== "hub" && surface !== "all") {
		throw new Error("--surface must be bash, hub, or all");
	}
	const caseValue = valueFor("--case");
	if (argv.includes("--case") && caseValue === undefined) {
		throw new Error("--case requires wake or quick");
	}
	const evalCase = caseValue ?? "wake";
	if (evalCase !== "wake" && evalCase !== "quick") throw new Error("--case must be wake or quick");
	if (evalCase === "quick" && surfaceValue !== undefined && surface !== "bash") {
		throw new Error("--case quick supports only --surface bash");
	}
	const model = valueFor("--model");
	const runs = valueFor("--runs");
	const timeoutMs = valueFor("--timeout-ms");
	if (argv.includes("--model") && model === undefined) throw new Error("--model requires a value");
	if (argv.includes("--runs") && runs === undefined) throw new Error("--runs requires a value");
	if (argv.includes("--timeout-ms") && timeoutMs === undefined) {
		throw new Error("--timeout-ms requires a value");
	}
	return {
		case: evalCase,
		model,
		runs: parsePositiveInteger("--runs", runs, DEFAULT_RUNS),
		timeoutMs: parsePositiveInteger("--timeout-ms", timeoutMs, DEFAULT_TIMEOUT_MS),
		json: argv.includes("--json"),
		surfaces: evalCase === "quick" ? ["bash"] : surface === "all" ? SURFACES : [surface],
	};
}

function parseBashCall(value: unknown): BashCall {
	if (!isRecord(value)) return {};
	return {
		command: typeof value.command === "string" ? value.command : undefined,
		async: typeof value.async === "boolean" || value.async === "auto" ? value.async : undefined,
		progress: typeof value.progress === "string" ? value.progress : undefined,
	};
}

function parseHubCall(value: unknown): HubCall {
	if (!isRecord(value)) return {};
	return {
		op: typeof value.op === "string" ? value.op : undefined,
		name: typeof value.name === "string" ? value.name : undefined,
		application: typeof value.application === "string" ? value.application : undefined,
		args: Array.isArray(value.args) && value.args.every(arg => typeof arg === "string") ? value.args : undefined,
		progress: typeof value.progress === "string" ? value.progress : undefined,
		persist: typeof value.persist === "boolean" ? value.persist : undefined,
	};
}

function messageText(message: unknown): string {
	if (!isRecord(message)) return "";
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	return message.content
		.map(block => {
			if (!isRecord(block)) return "";
			if (block.type === "text" && typeof block.text === "string") return block.text;
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

function isProgressMessage(message: AgentMessage): boolean {
	return isRecord(message) && message.role === "custom" && message.customType === ASYNC_PROGRESS_MESSAGE_TYPE;
}

function isCompletionMessage(message: AgentMessage): boolean {
	return isRecord(message) && message.role === "custom" && message.customType === ASYNC_RESULT_MESSAGE_TYPE;
}

function scoreMessages(
	messages: AgentMessage[],
	evalCase: EvalCase,
	surface: EvalSurface,
	toolCalls: EvalToolCall[],
	executedTools: string[],
): EvalCriteria {
	if (evalCase === "quick") {
		const [call] = toolCalls;
		return {
			// The policy asks for `async: "auto"` + `progress: "wake"` on every
			// finite command; a quick one must then still finish inline with no
			// async notification.
			selectedAutoInline:
				toolCalls.length === 1 &&
				call !== undefined &&
				"async" in call &&
				call.async === "auto" &&
				call.progress === "wake",
			onlyExpectedTool: executedTools.length === 1 && executedTools[0] === "bash",
			singleToolCall: toolCalls.length === 1,
			noAsyncNotification: messages.every(message => !isProgressMessage(message) && !isCompletionMessage(message)),
			reportedQuickResult: messages.some(
				message => message.role === "assistant" && messageText(message).includes("QUICK_RESULT"),
			),
		};
	}
	const progressIndex = messages.findIndex(
		message => isProgressMessage(message) && messageText(message).includes(READY_EVENT[surface]),
	);
	const completionIndex = messages.findIndex(message =>
		surface === "bash"
			? isCompletionMessage(message)
			: isRecord(message) && message.role === "custom" && message.customType === LAUNCH_COMPLETION_MESSAGE_TYPE,
	);
	const acknowledgementIndex = messages.findIndex(
		(message, index) =>
			index > progressIndex &&
			message.role === "assistant" &&
			messageText(message).includes(ACKNOWLEDGEMENT[surface]),
	);
	const selectedWake = toolCalls.some(call => {
		if (surface === "bash") return "async" in call && call.async === "auto" && call.progress === "wake";
		return "op" in call && call.op === "start" && call.progress === "wake";
	});
	const hubCalls = toolCalls.filter((call): call is HubCall => "op" in call);
	return {
		selectedWake,
		onlyExpectedTool: executedTools.length > 0 && executedTools.every(toolName => toolName === surface),
		...(surface === "hub"
			? {
					selectedPersistentProcess: hubCalls.some(call => call.op === "start" && call.persist === true),
					singleStart: hubCalls.filter(call => call.op === "start").length === 1,
					noProcessPolling: hubCalls.every(
						call => call.op !== "logs" && call.op !== "wait" && call.op !== "ps" && call.op !== "describe",
					),
				}
			: { singleToolCall: toolCalls.length === 1, noProcessPolling: toolCalls.length === 1 }),
		notificationDelivered: progressIndex >= 0,
		completionObserved: completionIndex >= 0,
		notificationBeforeCompletion: progressIndex >= 0 && completionIndex >= 0 && progressIndex < completionIndex,
		acknowledgedAfterNotification: progressIndex >= 0 && acknowledgementIndex > progressIndex,
	};
}

function criteriaPass(criteria: EvalCriteria): boolean {
	return Object.values(criteria).every(Boolean);
}

async function runOnce(config: EvalConfig, surface: EvalSurface, run: number): Promise<EvalRunResult> {
	const cwd = process.cwd();
	const deadline = Date.now() + config.timeoutMs;
	const settings = await Settings.loadReadOnly({ cwd });
	settings.override("async.enabled", true);
	settings.override("bash.autoBackground.enabled", false);
	settings.override("launch.enabled", true);
	settings.override("autolearn.enabled", false);
	settings.override("tools.approvalMode", "yolo");

	const { session } = await createAgentSession({
		cwd,
		settings,
		modelPattern: config.model,
		agentRegistry: new AgentRegistry(),
		sessionManager: SessionManager.inMemory(cwd),
		toolNames: [surface],
		restrictToolNames: surface === "bash",
		disableExtensionDiscovery: true,
		enableMCP: false,
		enableLsp: false,
		skipPythonPreflight: true,
		skills: [],
		rules: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		autoApprove: true,
		deadline,
	});
	const toolCalls: EvalToolCall[] = [];
	const executedTools: string[] = [];
	const assistantMessages: string[] = [];
	const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
		if (event.type === "tool_execution_start") {
			executedTools.push(event.toolName);
			if (event.toolName === surface) {
				toolCalls.push(surface === "bash" ? parseBashCall(event.args) : parseHubCall(event.args));
			}
		}
		if (event.type !== "message_end" || event.message.role !== "assistant") return;
		const text = messageText(event.message);
		if (text) assistantMessages.push(text);
	});

	try {
		let error: string | undefined;
		try {
			if (!session.getToolByName(surface)) throw new Error(`Eval session did not expose the ${surface} tool`);
			const evalPrompt =
				config.case === "quick"
					? bashQuickEvalPrompt.trim()
					: surface === "bash"
						? bashEvalPrompt.trim()
						: prompt.render(hubEvalPrompt, { name: `monitor-eval-${process.pid}-${run}` }).trim();
			const timeout = Promise.withResolvers<never>();
			const timer = setTimeout(
				() => timeout.reject(new Error(`Eval timed out after ${config.timeoutMs}ms`)),
				Math.max(1, deadline - Date.now()),
			);
			try {
				await Promise.race([session.prompt(evalPrompt, { expandPromptTemplates: false }), timeout.promise]);
			} finally {
				clearTimeout(timer);
			}
			while (Date.now() < deadline) {
				if (criteriaPass(scoreMessages(session.messages, config.case, surface, toolCalls, executedTools))) break;
				await Bun.sleep(100);
			}
		} catch (cause) {
			error = cause instanceof Error ? cause.message : String(cause);
			await session
				.abort({ goalReason: "internal", reason: "Async progress eval timed out" })
				.catch(() => undefined);
		}

		const criteria = scoreMessages(session.messages, config.case, surface, toolCalls, executedTools);
		const model = session.model ? `${session.model.provider}/${session.model.id}` : (config.model ?? "unresolved");
		return {
			run,
			case: config.case,
			surface,
			model,
			passed: !error && criteriaPass(criteria),
			criteria,
			toolCalls,
			executedTools,
			assistantMessages,
			...(error ? { error } : {}),
		};
	} finally {
		unsubscribe();
		if (surface === "hub") {
			const hub = session.getToolByName("hub");
			const names = new Set(
				toolCalls
					.filter(
						(call): call is HubCall & { name: string } => call.op === "start" && typeof call.name === "string",
					)
					.map(call => call.name),
			);
			if (hub) {
				await Promise.allSettled(
					Array.from(names, (name, index) => hub.execute(`eval-cleanup-${run}-${index}`, { op: "stop", name })),
				);
			}
		}
		session.beginDispose();
		await session.dispose();
	}
}

function printRun(result: EvalRunResult): void {
	process.stdout.write(`${result.surface} run ${result.run} — ${result.model}: ${result.passed ? "PASS" : "FAIL"}\n`);
	for (const [criterion, passed] of Object.entries(result.criteria)) {
		process.stdout.write(`  ${passed ? "✓" : "✗"} ${criterion}\n`);
	}
	process.stdout.write(`  tool calls: ${JSON.stringify(result.toolCalls)}\n`);
	process.stdout.write(`  executed tools: ${JSON.stringify(result.executedTools)}\n`);
	if (!result.passed) process.stdout.write(`  assistant messages: ${JSON.stringify(result.assistantMessages)}\n`);
	if (result.error) process.stdout.write(`  error: ${result.error}\n`);
}

async function main(): Promise<void> {
	try {
		const config = parseArgs(Bun.argv.slice(2));
		const results: EvalRunResult[] = [];
		for (const surface of config.surfaces) {
			for (let run = 1; run <= config.runs; run += 1) {
				results.push(await runOnce(config, surface, run));
			}
		}
		const passed = results.filter(result => result.passed).length;
		if (config.json) {
			process.stdout.write(`${JSON.stringify({ passed, runs: results.length, results }, null, 2)}\n`);
		} else {
			for (const result of results) printRun(result);
			process.stdout.write(`summary: ${passed}/${results.length} runs passed\n`);
		}
		if (passed !== results.length) process.exitCode = 1;
	} finally {
		await closeDaemonClients();
	}
}

await main();
