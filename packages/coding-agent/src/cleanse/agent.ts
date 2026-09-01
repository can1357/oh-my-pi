import { getProjectDir, isRecord, prompt } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../config/model-registry";
import { formatModelString, resolveCliModel } from "../config/model-resolver";
import { Settings } from "../config/settings";
import { IrcBus } from "../irc/bus";
import { MAIN_AGENT_ID } from "../registry/agent-registry";
import { discoverAuthStorage } from "../sdk";
import { SessionManager } from "../session/session-manager";
import { reserveStructuredSubagentId, runStructuredSubagent } from "../task/structured-subagent";
import type { AgentProgress } from "../task/types";
import type { ToolSession } from "../tools";
import { EventBus } from "../utils/event-bus";
import type { CleanseCheckerDescriptor, CustomCleanseCheckerSpec } from "./checkers";
import { CLEANSE_PARSER_KINDS } from "./parsers";
import assignmentPrompt from "./prompts/assignment.md" with { type: "text" };
import discoveryPrompt from "./prompts/discovery.md" with { type: "text" };
import followUpPrompt from "./prompts/follow-up.md" with { type: "text" };
import type { CleanseAgentOutcome, CleanseAssignment, CleanseDiagnostic, CleanseLoopResult } from "./types";

const MAX_DIAGNOSTIC_MESSAGE = 4_000;

/** Structured output contract for the prompted checker-discovery agent. */
const DISCOVERY_SCHEMA = {
	type: "object",
	required: ["checkers"],
	properties: {
		checkers: {
			type: "array",
			items: {
				type: "object",
				required: ["label", "command"],
				properties: {
					label: { type: "string" },
					language: { type: "string" },
					cwd: { type: "string" },
					command: { type: "array", items: { type: "string" }, minItems: 1 },
					parser: { type: "string", enum: [...CLEANSE_PARSER_KINDS] },
				},
			},
		},
	},
};

/** Hooks used by the standalone command to render subagent lifecycle progress. */
export interface CleanseAgentHooks {
	onStart?(name: string, assignment: CleanseAssignment): void;
	/** Streaming progress snapshots from a running repair subagent. */
	onProgress?(name: string, assignment: CleanseAssignment, progress: AgentProgress): void;
	onFinish?(outcome: CleanseAgentOutcome, assignment: CleanseAssignment): void;
}

/** Persisted parent session that dispatches file-disjoint cleanse workers. */
export interface CleanseAgentRuntime {
	readonly model: string;
	readonly sessionFile: string;
	/** Run one discovery subagent that translates a user request into runnable checker specs. */
	discoverCheckers(request: string, signal?: AbortSignal): Promise<CustomCleanseCheckerSpec[]>;
	/** Run one repair subagent to completion; the scheduler bounds concurrency. */
	dispatchWorker(
		assignment: CleanseAssignment,
		context: {
			worker: number;
			peers: readonly CleanseAssignment[];
			checkers: readonly CleanseCheckerDescriptor[];
		},
		signal?: AbortSignal,
	): Promise<CleanseAgentOutcome>;
	/** Steer late diagnostics into a running worker's chat; false when undeliverable. */
	followUp(worker: number, diagnostics: readonly CleanseDiagnostic[]): Promise<boolean>;
	close(result?: CleanseLoopResult): Promise<void>;
}

/** Resolve the requested model and create a fresh persisted cleanse session. */
export async function createCleanseAgentRuntime(options: {
	cwd?: string;
	model: string;
	hooks?: CleanseAgentHooks;
}): Promise<CleanseAgentRuntime> {
	const cwd = options.cwd ?? getProjectDir();
	const [settings, authStorage] = await Promise.all([Settings.init({ cwd }), discoverAuthStorage()]);
	const modelRegistry = new ModelRegistry(authStorage);
	await modelRegistry.refresh();
	const resolved = resolveCliModel({ cliModel: options.model, modelRegistry, settings });
	if (resolved.error || !resolved.model) {
		throw new Error(resolved.error ?? `Model "${options.model}" not found`);
	}
	const modelSelector = resolved.selector ?? formatModelString(resolved.model);
	const modelDisplay = formatModelString(resolved.model);
	const sessionManager = SessionManager.create(cwd);
	await sessionManager.setSessionName("Cleanse", "auto");
	sessionManager.appendCustomEntry("cleanse", {
		status: "running",
		model: modelDisplay,
		selector: options.model,
	});
	await sessionManager.ensureOnDisk();
	const sessionFile = sessionManager.getSessionFile();
	if (!sessionFile) throw new Error("Cleanse session could not be persisted");
	const eventBus = new EventBus();
	const toolSession: ToolSession = {
		cwd,
		hasUI: false,
		suppressSpawnAdvisory: true,
		enableLsp: true,
		enableIrc: true,
		enableMCP: false,
		eventBus,
		getSessionFile: () => sessionFile,
		getSessionId: () => sessionManager.getSessionId(),
		getArtifactsDir: () => sessionManager.getArtifactsDir(),
		getArtifactManager: () => sessionManager.getArtifactManager(),
		getAgentId: () => MAIN_AGENT_ID,
		getSessionSpawns: () => "sonic,task",
		getModelString: () => modelSelector,
		getActiveModelString: () => modelSelector,
		getActiveModel: () => resolved.model,
		sessionManager,
		settings,
		authStorage,
		modelRegistry,
	};
	let closed = false;
	/** Live worker number → reserved registry agent id, for follow-up steering. */
	const workerAgentIds = new Map<number, string>();

	return {
		model: modelDisplay,
		sessionFile,
		async discoverCheckers(request: string, signal?: AbortSignal): Promise<CustomCleanseCheckerSpec[]> {
			sessionManager.appendCustomEntry("cleanse_discovery", { request });
			const result = await runStructuredSubagent({
				session: toolSession,
				invocationKind: "task",
				assignment: prompt.render(discoveryPrompt, { request }),
				agent: "task",
				model: modelSelector,
				outputSchema: DISCOVERY_SCHEMA,
				identity: { label: "CleanseDiscovery" },
				enableLsp: true,
				enableIrc: false,
				signal,
			});
			if (result.result.error) throw new Error(`Checker discovery failed: ${result.result.error}`);
			return parseDiscoverySpecs(result.result.structuredOutput?.data);
		},
		async dispatchWorker(
			assignment: CleanseAssignment,
			context: {
				worker: number;
				peers: readonly CleanseAssignment[];
				checkers: readonly CleanseCheckerDescriptor[];
			},
			signal?: AbortSignal,
		): Promise<CleanseAgentOutcome> {
			sessionManager.appendCustomEntry("cleanse_dispatch", {
				worker: context.worker,
				weight: assignment.weight,
				files: assignment.groups.map(group => group.file ?? "<project>"),
			});
			const name = `CleanseA${context.worker}`;
			options.hooks?.onStart?.(name, assignment);
			const agentId = await reserveStructuredSubagentId(toolSession, { label: name });
			workerAgentIds.set(context.worker, agentId);
			try {
				const result = await runStructuredSubagent({
					session: toolSession,
					invocationKind: "task",
					assignment: renderAssignment(assignment, context.peers, context.worker, context.checkers),
					agent: "sonic",
					model: modelSelector,
					identity: { id: agentId, label: name },
					index: assignment.index,
					enableLsp: true,
					enableIrc: true,
					signal,
					onProgress: progress => options.hooks?.onProgress?.(name, assignment, progress),
				});
				const outcome: CleanseAgentOutcome = {
					name,
					success: result.result.exitCode === 0 && !result.result.error && result.result.aborted !== true,
					output: result.result.output,
					error: result.result.error ?? (result.result.stderr || undefined),
					resolvedModel: result.result.resolvedModel,
				};
				options.hooks?.onFinish?.(outcome, assignment);
				return outcome;
			} catch (error) {
				const outcome: CleanseAgentOutcome = {
					name,
					success: false,
					output: "",
					error: signal?.aborted ? "Cancelled" : error instanceof Error ? error.message : String(error),
				};
				options.hooks?.onFinish?.(outcome, assignment);
				return outcome;
			} finally {
				workerAgentIds.delete(context.worker);
			}
		},
		async followUp(worker: number, diagnostics: readonly CleanseDiagnostic[]): Promise<boolean> {
			const agentId = workerAgentIds.get(worker);
			if (!agentId) return false;
			const receipt = await IrcBus.global().send({
				from: MAIN_AGENT_ID,
				to: agentId,
				body: prompt.render(followUpPrompt, { diagnostics: formatDiagnostics(diagnostics) }),
			});
			if (receipt.outcome === "failed") return false;
			sessionManager.appendCustomEntry("cleanse_follow_up", { worker, count: diagnostics.length });
			return true;
		},
		async close(result?: CleanseLoopResult): Promise<void> {
			if (closed) return;
			closed = true;
			sessionManager.appendCustomEntry("cleanse", {
				status: result?.status ?? "interrupted",
				workers: result?.workers ?? 0,
				remaining: result?.report.diagnostics.length,
			});
			await sessionManager.close();
		},
	};
}

/** Defensively validate discovery-agent output into runnable checker specs. */
function parseDiscoverySpecs(data: unknown): CustomCleanseCheckerSpec[] {
	if (!isRecord(data) || !Array.isArray(data.checkers)) return [];
	const specs: CustomCleanseCheckerSpec[] = [];
	for (const value of data.checkers) {
		if (!isRecord(value)) continue;
		const command = Array.isArray(value.command)
			? value.command.filter((part): part is string => typeof part === "string" && part.length > 0)
			: [];
		if (typeof value.label !== "string" || !value.label.trim() || command.length === 0) continue;
		specs.push({
			label: value.label.trim(),
			language: typeof value.language === "string" ? value.language : undefined,
			cwd: typeof value.cwd === "string" ? value.cwd : undefined,
			command,
			parser: typeof value.parser === "string" ? value.parser : undefined,
		});
	}
	return specs;
}

function renderAssignment(
	assignment: CleanseAssignment,
	peers: readonly CleanseAssignment[],
	worker: number,
	checkers: readonly CleanseCheckerDescriptor[],
): string {
	const hasProjectIssues = assignment.groups.some(group => group.file === undefined);
	const files = assignment.groups.flatMap(group => (group.file ? [group.file] : []));
	const writeScope = [
		...(files.length > 0 ? files.map(file => `- ${file}`) : ["- No file is named by the project-level diagnostic."]),
		...(hasProjectIssues ? ["- Minimal additional files strictly required by project-level diagnostics."] : []),
	].join("\n");
	return prompt.render(assignmentPrompt, {
		worker,
		write_scope: writeScope,
		diagnostics: formatDiagnostics(assignment.groups.flatMap(group => group.diagnostics)),
		checker_commands: formatCheckerCommands(checkers),
		peer_assignments: formatPeerAssignments(assignment, peers),
	});
}

function formatDiagnostics(diagnostics: readonly CleanseDiagnostic[]): string {
	return diagnostics
		.map(diagnostic => {
			const location = diagnostic.file
				? `${diagnostic.file}${diagnostic.line ? `:${diagnostic.line}${diagnostic.column ? `:${diagnostic.column}` : ""}` : ""}`
				: "<project>";
			const code = diagnostic.code ? ` ${diagnostic.code}` : "";
			const message = diagnostic.message.slice(0, MAX_DIAGNOSTIC_MESSAGE);
			const suggestion = diagnostic.suggestion ? `\n  Suggested fix: ${diagnostic.suggestion}` : "";
			return `- [${diagnostic.severity}] ${location} — ${diagnostic.checker}${code}: ${message}${suggestion}`;
		})
		.join("\n");
}

function formatCheckerCommands(checkers: readonly CleanseCheckerDescriptor[]): string {
	const seen = new Set<string>();
	const lines: string[] = [];
	for (const checker of checkers) {
		const key = `${checker.cwd}\u0000${checker.command}`;
		if (seen.has(key)) continue;
		seen.add(key);
		lines.push(`- [${checker.cwd}] ${checker.command}`);
	}
	return lines.join("\n") || "- No command metadata available.";
}

function formatPeerAssignments(current: CleanseAssignment, peers: readonly CleanseAssignment[]): string {
	const lines: string[] = [];
	for (const assignment of peers) {
		if (assignment.index === current.index) continue;
		const files = assignment.groups.map(group => group.file ?? "<project-level>").join(", ");
		lines.push(`- Worker ${assignment.index + 1}: ${files}`);
	}
	return lines.join("\n") || "- None.";
}
