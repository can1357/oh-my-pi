#!/usr/bin/env bun

// Live model behavioral eval for the async-progress policy prompt. It is
// manual and opt-in on purpose: it needs real provider credentials, spends
// tokens on every run, and scores stochastic model behavior, so it is wired
// only as `bun run eval:async-progress` and must never be added to a `ci:*`
// script. Deterministic batching/queue/wake semantics stay in `bun test`.
//
//   bun run eval:async-progress [--surface bash|service|all] [--model <pattern>] [--runs N]
//   bun run eval:async-progress --case quick [--model <pattern>] [--runs N]

import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { isRecord, prompt } from "@oh-my-pi/pi-utils";
import { closeDaemonClients } from "../src/launch/client";
import bashQuickEvalPrompt from "../src/prompts/evals/async-progress-quick.md" with { type: "text" };
import bashEvalPrompt from "../src/prompts/evals/async-progress-wake.md" with { type: "text" };
import serviceEvalPrompt from "../src/prompts/evals/service-progress-wake.md" with { type: "text" };
import { AgentRegistry, createAgentSession, Settings } from "../src/sdk";
import type { AgentSessionEvent } from "../src/session/agent-session-events";
import { ASYNC_PROGRESS_MESSAGE_TYPE, ASYNC_RESULT_MESSAGE_TYPE } from "../src/session/async-job-delivery";
import { LAUNCH_COMPLETION_MESSAGE_TYPE } from "../src/session/launch-completion";
import { SessionManager } from "../src/session/session-manager";
import { cfgAutolearnEnabled } from "../src/autolearn/settings";
import { cfgBashAutoBackgroundEnabled } from "../src/exec/settings";
import { cfgAsyncEnabled, cfgLaunchEnabled, cfgToolsApprovalMode } from "../src/tools/settings";

const DEFAULT_RUNS = 1;
const DEFAULT_TIMEOUT_MS = 90_000;
type EvalSurface = "bash" | "service";
type EvalCase = "wake" | "quick";

const SURFACES: EvalSurface[] = ["bash", "service"];
const READY_EVENT: Record<EvalSurface, string> = {
	bash: "MONITOR_READY",
	service: "SERVICE_READY",
};
const ACKNOWLEDGEMENT: Record<EvalSurface, string> = {
	bash: "WAKE_ACK MONITOR_READY",
	service: "WAKE_ACK SERVICE_READY",
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
	name?: string;
	command?: string;
	async?: boolean | "auto";
	progress?: string;
}

interface EvalCriteria {
	selectedWake?: boolean;
	selectedAutoInline?: boolean;
	onlyExpectedTool: boolean;
	selectedService?: boolean;
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
	toolCalls: BashCall[];
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
		throw new Error("--surface requires bash, service, or all");
	}
	const surface = surfaceValue ?? "all";
	if (surface !== "bash" && surface !== "service" && surface !== "all") {
		throw new Error("--surface must be bash, service, or all");
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
		name: typeof value.name === "string" ? value.name : undefined,
		command: typeof value.command === "string" ? value.command : undefined,
		async: typeof value.async === "boolean" || value.async === "auto" ? value.async : undefined,
		progress: typeof value.progress === "string" ? value.progress : undefined,
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
	toolCalls: BashCall[],
	executedTools: string[],
): EvalCriteria {
	if (evalCase === "quick") {
		const [call] = toolCalls;
		return {
			selectedAutoInline:
				toolCalls.length === 1 &&
				call !== undefined &&
				call.name === undefined &&
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
		if (surface === "bash") return call.name === undefined && call.async === "auto" && call.progress === "wake";
		return call.name !== undefined && call.async === undefined && call.progress === "wake";
	});
	const serviceCalls = toolCalls.filter(call => call.name !== undefined);
	return {
		selectedWake,
		onlyExpectedTool: executedTools.length > 0 && executedTools.every(toolName => toolName === "bash"),
		...(surface === "service"
			? {
					selectedService: serviceCalls.length > 0,
					singleStart: serviceCalls.length === 1,
					noProcessPolling: toolCalls.length === 1,
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
	cfgAsyncEnabled.set(settings, true);
	cfgBashAutoBackgroundEnabled.set(settings, false);
	cfgLaunchEnabled.set(settings, true);
	cfgAutolearnEnabled.set(settings, false);
	cfgToolsApprovalMode.set(settings, "yolo");

	const { session } = await createAgentSession({
		cwd,
		settings,
		modelPattern: config.model,
		agentRegistry: new AgentRegistry(),
		sessionManager: SessionManager.inMemory(cwd),
		toolNames: surface === "bash" ? ["bash"] : ["bash", "write"],
		restrictToolNames: true,
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
	const toolCalls: BashCall[] = [];
	const executedTools: string[] = [];
	const assistantMessages: string[] = [];
	const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
		if (event.type === "tool_execution_start") {
			executedTools.push(event.toolName);
			if (event.toolName === "bash") {
				toolCalls.push(parseBashCall(event.args));
			}
		}
		if (event.type !== "message_end" || event.message.role !== "assistant") return;
		const text = messageText(event.message);
		if (text) assistantMessages.push(text);
	});

	try {
		let error: string | undefined;
		try {
			if (!session.getToolByName("bash")) throw new Error("Eval session did not expose the bash tool");
			const evalPrompt =
				config.case === "quick"
					? bashQuickEvalPrompt.trim()
					: surface === "bash"
						? bashEvalPrompt.trim()
						: prompt.render(serviceEvalPrompt, { name: `monitor-eval-${process.pid}-${run}` }).trim();
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
		if (surface === "service") {
			const write = session.getToolByName("write");
			const names = new Set(toolCalls.flatMap(call => (call.name === undefined ? [] : [call.name])));
			if (write) {
				await Promise.allSettled(
					Array.from(names, (name, index) =>
						write.execute(`eval-cleanup-${run}-${index}`, { path: `proc://${name}/kill` }),
					),
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
