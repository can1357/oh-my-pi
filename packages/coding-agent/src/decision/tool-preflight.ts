/**
 * Tool contract preflight: before the main model's first request of a user task, find the mounted
 * `xd://` tools the task needs (omp's own discoverable tools and the MCP server tools omp connects
 * and mounts) and deliver their authoritative docs with the request. It never changes the native tool array, hides tools, generates arguments, or runs
 * anything. Local BM25 retrieval bounds the candidates; the native judge answers one independent
 * relevance Noul per candidate plus a shortlist-sufficiency Noul. Thresholds are experimental
 * policy constants.
 */
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { judgeQuestions, type NoulQuestion, renderQuestion, toolWireSchema } from "@oh-my-pi/pi-ai";
import { isRecord, prompt } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import questionFile from "../prompts/judge/tool-preflight.json" with { type: "json" };
import contractPrompt from "../prompts/system/tool-preflight-contract.md" with { type: "text" };
import hintPrompt from "../prompts/system/tool-preflight-hint.md" with { type: "text" };
import { listXdevTools, type XdevState, xdevDocs } from "../tools/xdev";
import { askDecisionJudge, type DecisionJudgeDeps } from "./judge";
import { lexicalRank } from "./lexical";
import type { DecisionRecord } from "./records";
import { resolveDecisionFeature } from "./resolve";
import { decisionState, isGreeting } from "./skills";
import type { TaskContext } from "./task-context";

export const TOOL_CONTRACT_MESSAGE_TYPE = "decision-tool-contract";
export const TOOL_HINT_MESSAGE_TYPE = "decision-tool-hint";

export const TOOL_PREFLIGHT_POLICY = {
	/** Most candidates one judgment evaluates. */
	candidates: 64,
	/** Most contracts selected per turn. */
	contracts: 8,
	/** One contract, framing included; a larger one is omitted, never truncated. */
	contractBytes: 16 * 1024,
	/** Whether the task needs any device's docs at all must reach this before anything is judged further. */
	gateThreshold: 0.35,
	relevance: 0.7,
	sufficiency: 0.7,
} as const;

const QUESTIONS = judgeQuestions(questionFile);

/** What tool preflight reads from the session: its mounted devices and enabled tool names. */
export interface ToolPreflightSource {
	xdev?: XdevState;
	enabledNames: readonly string[];
}

export interface ToolContract {
	id: string;
	/** Changes whenever the contract body would; a repeated `id`/`revision` is not delivered again. */
	revision: string;
	body: string;
}

interface ToolCandidate {
	name: string;
	/** MCP server that provides the tool, or `omp` for omp's own tools. */
	server: string;
	description: string;
	parameters: string[];
	revision: string;
	body: () => string;
}

/**
 * Enabled `xd://` devices: omp's discoverable tools and the MCP server tools it mounts. Top-level
 * tools are skipped; their schemas are already in every request. Needs `read` and `write`, through
 * which devices are documented and dispatched.
 */
function snapshotCandidates(source: ToolPreflightSource): ToolCandidate[] {
	const xdev = source.xdev;
	const enabled = new Set(source.enabledNames);
	if (!xdev || !enabled.has("read") || !enabled.has("write")) return [];
	return listXdevTools(xdev)
		.filter(tool => enabled.has(tool.name))
		.map(tool => {
			const schema = toolWireSchema(tool);
			const description = tool.description ?? "";
			return {
				name: tool.name,
				server: "mcpServerName" in tool && typeof tool.mcpServerName === "string" ? tool.mcpServerName : "omp",
				description: description.slice(0, 1024),
				parameters: Array.isArray(schema.required) ? schema.required.slice(0, 32).map(String) : [],
				revision: Bun.hash(JSON.stringify([tool.name, description, schema])).toString(16),
				body: () => xdevDocs(xdev, tool.name),
			};
		})
		.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Whether the request names `name` unambiguously: as `xd://<name>` or as a backticked exact name.
 * Device names are ordinary words (`debug`), so a bare word never pins a tool past the judge.
 */
function explicitlyNamed(query: string, name: string): boolean {
	if (query.includes(`\`${name}\``)) return true;
	const url = `xd://${name}`;
	for (let at = query.indexOf(url); at !== -1; at = query.indexOf(url, at + 1)) {
		if (!/[\w-]/u.test(query[at + url.length] ?? "")) return true;
	}
	return false;
}

/** Explicitly named tools first, then lexical matches for the request interleaved with its follow-up context. */
function retrieveCandidates(candidates: readonly ToolCandidate[], query: string, taskContext?: TaskContext) {
	const texts = candidates.map(
		candidate => `${candidate.name} ${candidate.description} ${candidate.parameters.join(" ")}`,
	);
	const rank = (text: string) =>
		lexicalRank(text, texts, { maxDocumentFrequency: Math.max(5, Math.floor(texts.length * 0.25)) }).filter(
			item => item.score > 0,
		);
	const current = rank(query);
	const earlier = taskContext ? rank(taskContext.messages.map(message => message.text).join("\n")) : [];
	const selected = new Set(candidates.filter(candidate => explicitlyNamed(query, candidate.name)));
	for (let index = 0; index < Math.max(current.length, earlier.length); index++) {
		for (const item of [current[index], earlier[index]]) {
			if (item && selected.size < TOOL_PREFLIGHT_POLICY.candidates) selected.add(candidates[item.index]!);
		}
	}
	return [...selected];
}

export interface ToolPreflightInput {
	settings: Settings;
	source: ToolPreflightSource;
	request: string;
	taskContext?: TaskContext;
	isCurrent: () => boolean;
	judge: DecisionJudgeDeps;
	onRecord: (record: DecisionRecord) => void;
}

export interface ToolPreflight {
	/** Tool names to name in the hint. */
	selected: string[];
	contracts: ToolContract[];
}

const NONE: ToolPreflight = { selected: [], contracts: [] };

/** Select tools for one user task; never throws. `shadow` ranks after returning and only records. */
export async function prepareToolPreflight(input: ToolPreflightInput): Promise<ToolPreflight> {
	const { settings, request, isCurrent } = input;
	const config = resolveDecisionFeature(settings, "tools");
	if (config.mode === "off" || isGreeting(request)) return NONE;
	const started = performance.now();
	const candidates = retrieveCandidates(snapshotCandidates(input.source), request, input.taskContext);
	const pinned = candidates
		.filter(candidate => explicitlyNamed(request, candidate.name))
		.map(candidate => candidate.name);

	const rank = async (deps: DecisionJudgeDeps): Promise<{ selected: string[]; reason: string }> => {
		if (config.backend !== "judge" || candidates.length === pinned.length) {
			return { selected: pinned, reason: pinned.length > 0 ? "explicit" : "no_candidates" };
		}
		const questions: Record<string, NoulQuestion> = {
			needsTools: QUESTIONS.needsTools,
			sufficient: QUESTIONS.sufficient,
		};
		candidates.forEach((_, index) => {
			questions[`r${index}`] = renderQuestion(QUESTIONS.relevance, { index });
		});
		const judged = await askDecisionJudge(
			"decision-tools",
			{
				state: decisionState(
					request,
					{
						candidates: candidates.map(({ name, server, description, parameters }) => ({
							name,
							server,
							description,
							parameters,
						})),
					},
					input.taskContext,
				),
				questions,
			},
			deps,
			Date.now() + config.deadlineMs,
		);
		if (judged.status === "unavailable") return { selected: pinned, reason: "judge_unavailable" };
		const answers = judged.result.answers;
		const needsTools = answers.needsTools;
		if (needsTools?.type !== "noul" || needsTools.noul < TOOL_PREFLIGHT_POLICY.gateThreshold) {
			return { selected: pinned, reason: "not_needed" };
		}
		const sufficient = answers.sufficient;
		if (sufficient?.type !== "noul" || sufficient.noul < TOOL_PREFLIGHT_POLICY.sufficiency) {
			return { selected: pinned, reason: "insufficient" };
		}
		const ranked = candidates
			.flatMap((candidate, index) => {
				const answer = answers[`r${index}`];
				return answer?.type === "noul" && answer.noul >= TOOL_PREFLIGHT_POLICY.relevance
					? [{ name: candidate.name, score: answer.noul }]
					: [];
			})
			.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
			.map(item => item.name);
		const selected = [...new Set([...pinned, ...ranked])].slice(0, TOOL_PREFLIGHT_POLICY.contracts);
		return { selected, reason: selected.length > 0 ? "selected" : "none_relevant" };
	};
	const record = (selected: string[], reason: string): void =>
		input.onRecord({
			feature: "tools",
			mode: config.mode,
			backend: config.backend,
			reason,
			selected,
			candidates: candidates.length,
			durationMs: Math.round(performance.now() - started),
			timestamp: Date.now(),
		});

	if (config.mode === "shadow") {
		// Off the turn's critical path: the request is never delayed for a result nobody sees.
		void rank({ ...input.judge, signal: AbortSignal.timeout(config.deadlineMs) }).then(ranked =>
			record(ranked.selected, `shadow: ${ranked.reason}`),
		);
		return NONE;
	}
	const signal = AbortSignal.any([
		...(input.judge.signal ? [input.judge.signal] : []),
		AbortSignal.timeout(config.deadlineMs),
	]);
	const { selected, reason } = await rank({ ...input.judge, signal });
	if (!isCurrent()) return NONE;
	record(selected, reason);
	if (config.mode !== "automatic") return { selected, contracts: [] };
	const contracts: ToolContract[] = [];
	for (const name of selected) {
		const candidate = candidates.find(item => item.name === name);
		if (!candidate) continue;
		try {
			contracts.push({ id: name, revision: candidate.revision, body: candidate.body() });
		} catch {
			// A tool removed since the snapshot stays discoverable; it just is not preloaded.
		}
	}
	return { selected, contracts };
}

/** Contract identities already delivered in `history`. */
function deliveredContracts(history: readonly AgentMessage[]): Set<string> {
	const delivered = new Set<string>();
	for (const message of history) {
		if (message.role === "custom" && message.customType === TOOL_CONTRACT_MESSAGE_TYPE && isRecord(message.details)) {
			delivered.add(`${message.details.id}\0${message.details.revision}`);
		}
	}
	return delivered;
}

/**
 * Messages for a preflight, within `budgetBytes`: contracts not already in `history` (same id and
 * revision), then the hint naming the selection in `suggest` mode or when a contract was omitted.
 */
export function toolPreflightMessages(
	preflight: ToolPreflight,
	history: readonly AgentMessage[],
	budgetBytes: number,
): AgentMessage[] {
	const delivered = deliveredContracts(history);
	const messages: AgentMessage[] = [];
	let bytes = 0;
	let omitted = false;
	for (const contract of preflight.contracts) {
		if (delivered.has(`${contract.id}\0${contract.revision}`)) continue;
		const content = prompt.render(contractPrompt, { ...contract }).trim();
		const size = Buffer.byteLength(content);
		if (size > TOOL_PREFLIGHT_POLICY.contractBytes || bytes + size > budgetBytes) {
			omitted = true;
			continue;
		}
		bytes += size;
		messages.push({
			role: "custom",
			customType: TOOL_CONTRACT_MESSAGE_TYPE,
			content,
			details: { id: contract.id, revision: contract.revision },
			display: false,
			attribution: "agent",
			timestamp: Date.now(),
		});
	}
	if (preflight.selected.length > 0 && (preflight.contracts.length === 0 || omitted)) {
		const content = prompt.render(hintPrompt, { names: preflight.selected.join(", ") }).trim();
		if (bytes + Buffer.byteLength(content) <= budgetBytes) {
			messages.push({
				role: "custom",
				customType: TOOL_HINT_MESSAGE_TYPE,
				content,
				display: false,
				attribution: "agent",
				timestamp: Date.now(),
			});
		}
	}
	return messages;
}
