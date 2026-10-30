import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { prompt } from "@oh-my-pi/pi-utils";
import { resolveModelOverrideWithAuthFallback, resolveSessionModelSelector } from "../config/model-resolver";
import { sessionFilesFromDisk } from "../internal-urls/registry-helpers";
import seanceAssignmentTemplate from "../prompts/system/seance-assignment.md" with { type: "text" };
import seanceTaskGuidanceTemplate from "../prompts/tools/seance-task-guidance.md" with { type: "text" };
import { buildSessionContext, getRestorableSessionModels } from "../session/session-context";
import { listSessionsReadOnly } from "../session/session-listing";
import { sessionDirForCwd } from "../session/session-paths";
import { resolveSessionLeafId, type SessionEntry } from "../session/session-entries";
import { FileSessionStorage, type SessionStorage } from "../session/session-storage";
import { SessionManager, type PersistedSessionInit } from "../session/session-manager";
import { loadSessionFile } from "../session/session-loader";
import type { ModelRegistry } from "../config/model-registry";
import type { TaskItem, TaskParams } from "@oh-my-pi/pi-tui/tools/task";
import type { ToolSession } from "../tools";
import { resolveToCwd } from "../tools/path-utils";
import { getBundledAgent } from "./agents";
import { SEANCE_AGENT_NAME } from "./seance-policy";
import type { AgentDefinition, SeanceTaskSchemaFields } from "./types";

export interface ResolvedSeanceSource {
	file: string;
	id: string;
	/** Active saved model-role selector, then the saved default fallback. */
	modelSelectors: string[];
}

export interface PreparedSeanceSession {
	fork: {
		sourceFile: string;
	};
	promptSuffix: (resolvedModel?: string) => string;
}

export interface RestoredSeanceSession {
	cwd: string;
	modelPattern: string;
	toolNames: string[];
}

export function isBundledSeance(agent: AgentDefinition): boolean {
	return agent.name === SEANCE_AGENT_NAME && agent.source === "bundled";
}

function safeSourceLabel(source: string): string {
	return source
		.replace(/[\p{Cc}\p{Cf}\s]+/gu, " ")
		.trim()
		.slice(0, 100);
}

function chooseId<T extends { id: string }>(matches: T[], selector: string): T | undefined {
	const normalized = selector.toLowerCase();
	const exact = matches.filter(match => match.id.toLowerCase() === normalized);
	const candidates = exact.length > 0 ? exact : matches.filter(match => match.id.toLowerCase().startsWith(normalized));
	if (candidates.length > 1) throw new Error(`Session selector "${safeSourceLabel(selector)}" is ambiguous.`);
	return candidates[0];
}

function savedModelSelectors(entries: SessionEntry[]): string[] {
	const leafId = resolveSessionLeafId(entries);
	if (leafId === null) return [];
	const byId = new Map(entries.map(entry => [entry.id, entry]));
	const leaf = byId.get(leafId);
	if (!leaf) return [];
	const branch: SessionEntry[] = [];
	const seen = new Set<string>();
	let current: SessionEntry | undefined = leaf;
	while (current && !seen.has(current.id)) {
		seen.add(current.id);
		branch.push(current);
		current = current.parentId ? byId.get(current.parentId) : undefined;
	}
	branch.reverse();
	let lastModelChangeRole: string | undefined;
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i]!;
		if (entry.type === "model_change") {
			lastModelChangeRole = entry.role;
			break;
		}
	}
	const context = buildSessionContext(entries, leaf.id, byId);
	return getRestorableSessionModels(context.models, lastModelChangeRole);
}

async function validateSourceFile(file: string, storage: SessionStorage): Promise<ResolvedSeanceSource> {
	let loaded;
	try {
		loaded = await loadSessionFile(file, storage, { throwIfMissing: true });
	} catch {
		throw new Error("Unable to read the selected session.");
	}
	const header = loaded.entries[0];
	if (loaded.invalidHeader || !header || header.type !== "session" || !header.id) {
		throw new Error("The selected file does not contain a valid session header.");
	}
	const entries = loaded.entries.filter((entry): entry is SessionEntry => entry.type !== "session");
	return { file, id: header.id, modelSelectors: savedModelSelectors(entries) };
}

/**
 * Resolve an explicit session path or an unambiguous stored session id without opening its writer.
 * Ids search the caller's artifact tree, then the current project; `includeGlobal` (user-typed
 * `/seance` ids) also searches every project's sessions.
 */
export async function resolveSeanceSource(
	selector: string,
	options: {
		cwd: string;
		sessionDirHint?: string;
		artifactsDirHint?: string;
		includeGlobal?: boolean;
		storage?: SessionStorage;
	},
): Promise<ResolvedSeanceSource> {
	const source = selector.trim();
	if (!source) throw new Error("A source session is required.");
	const storage = options.storage ?? new FileSessionStorage();
	if (source.includes("/") || source.includes("\\") || source.endsWith(".jsonl")) {
		const file = resolveToCwd(source, options.cwd);
		try {
			const stat = await fs.stat(file);
			if (!stat.isFile()) throw new Error("The selected path is not a session file.");
		} catch (error) {
			if (error instanceof Error && error.message === "The selected path is not a session file.") throw error;
			throw new Error("The selected session file was not found or could not be accessed.");
		}
		return validateSourceFile(file, storage);
	}

	const label = safeSourceLabel(source);
	if (options.artifactsDirHint) {
		const preferredDir = path.resolve(options.artifactsDirHint);
		const files = await sessionFilesFromDisk(options.artifactsDirHint, {
			onlyPreferred: true,
			preserveDuplicates: true,
		});
		const matches = [...files].flatMap(([id, candidates]) => {
			const direct = candidates.filter(file => path.resolve(path.dirname(file)) === preferredDir);
			return (direct.length > 0 ? direct : candidates).map(file => ({ id, path: file }));
		});
		const match = chooseId(matches, source);
		if (match) return validateSourceFile(match.path, storage);
	}
	const sessionDir = options.sessionDirHint ?? sessionDirForCwd(options.cwd);
	const local = await listSessionsReadOnly(sessionDir, storage);
	const localMatch = chooseId(local, source);
	if (localMatch) return validateSourceFile(localMatch.path, storage);
	if (options.includeGlobal) {
		const matchGlobal = chooseId(await SessionManager.listAll(storage), source);
		if (matchGlobal) return validateSourceFile(matchGlobal.path, storage);
	}
	throw new Error(`Session "${label}" was not found.`);
}
const modelSelectorInputSchema = type("string | string[]");
export const seanceTaskSchemaFields = {
	"sourceSession?": type("string"),
	"model?": modelSelectorInputSchema,
} satisfies Required<SeanceTaskSchemaFields>;
export const seanceTaskGuidance = seanceTaskGuidanceTemplate;

function validateSeanceFields(
	item: TaskItem | TaskParams,
	agent: string,
	label: string,
	seanceAdvertised: boolean,
): string | undefined {
	if (agent !== SEANCE_AGENT_NAME) {
		if (item.sourceSession !== undefined)
			return `\`sourceSession\` is only accepted for the \`${SEANCE_AGENT_NAME}\` agent.`;
		if (item.model !== undefined) return `\`model\` is only accepted for the \`${SEANCE_AGENT_NAME}\` agent.`;
		return undefined;
	}
	// Hidden bundled seance (plan mode, policy) is rejected at spawn; a custom shadow is an ordinary agent.
	if (!seanceAdvertised) return undefined;
	if (typeof item.sourceSession !== "string" || item.sourceSession.trim().length === 0) {
		return `${label} selects the \`${SEANCE_AGENT_NAME}\` agent and requires a non-empty \`sourceSession\`.`;
	}
	if ("tools" in item && item.tools?.length)
		return `${label} cannot pass custom tools to the read-only \`${SEANCE_AGENT_NAME}\` agent.`;
	const model: unknown = item.model;
	if (
		model !== undefined &&
		!(
			(typeof model === "string" && model.trim().length > 0) ||
			(Array.isArray(model) &&
				model.length > 0 &&
				model.every(value => typeof value === "string" && value.trim().length > 0))
		)
	) {
		return `${label} has an invalid \`model\` selector. Provide a non-empty selector or selector array.`;
	}
	return undefined;
}

export function validateSeanceParams(context: {
	params: TaskParams;
	batchEnabled: boolean;
	defaultAgent: string;
	seanceAdvertised: boolean;
}): string | undefined {
	const { params, batchEnabled, defaultAgent, seanceAdvertised } = context;
	if (batchEnabled && params.tasks !== undefined) {
		if (params.sourceSession !== undefined || params.model !== undefined) {
			return `Put \`sourceSession\` and \`model\` on the individual \`${SEANCE_AGENT_NAME}\` item inside \`tasks[]\`.`;
		}
		for (let index = 0; index < params.tasks.length; index++) {
			const item = params.tasks[index]!;
			const label = `Task ${index + 1}${item.name ? ` (\`${item.name}\`)` : ""}`;
			const error = validateSeanceFields(item, item.agent?.trim() || defaultAgent, label, seanceAdvertised);
			if (error) return error;
		}
		return undefined;
	}
	return validateSeanceFields(params, params.agent?.trim() || defaultAgent, "The call", seanceAdvertised);
}

export async function prepareSeance(context: {
	session: ToolSession;
	invocationKind: "task" | "eval";
	agent: AgentDefinition;
	sourceSession?: string;
	model?: string | string[];
	planMode: boolean;
	isolationRequested: boolean;
	hasCustomTools: boolean;
}): Promise<{ modelPatterns: string[]; session: PreparedSeanceSession }> {
	if (context.invocationKind !== "task" || !isBundledSeance(context.agent)) {
		throw new Error("Seance requires the bundled task agent.");
	}
	const sourceSelector = context.sourceSession;
	if (!sourceSelector?.trim()) throw new Error("The `seance` agent requires a source session.");
	if (context.planMode || context.isolationRequested || context.hasCustomTools) {
		throw new Error("Seance does not support plan mode, isolated execution, or custom tools.");
	}
	const sessionFile = context.session.getSessionFile();
	const source = await resolveSeanceSource(sourceSelector, {
		cwd: context.session.cwd,
		sessionDirHint: sessionFile ? path.dirname(sessionFile) : undefined,
		artifactsDirHint: context.session.getArtifactsDir?.() ?? undefined,
	});
	const modelRegistry = context.session.modelRegistry;
	if (!modelRegistry) throw new Error("Seance cannot resolve a model in this session.");
	await modelRegistry.awaitBackgroundRefresh().catch(() => {});
	const requestedModel = context.model;
	const requestedModels =
		requestedModel === undefined
			? source.modelSelectors
			: typeof requestedModel === "string"
				? [requestedModel]
				: requestedModel;
	if (requestedModels.length === 0) {
		throw new Error("The source session has no saved model. Select a model explicitly with `--model`.");
	}
	const modelPatterns: string[] = [];
	for (const selector of requestedModels) {
		if (requestedModel === undefined) {
			if (resolveSessionModelSelector(modelRegistry, selector)) modelPatterns.push(selector);
			continue;
		}
		const resolved = await resolveModelOverrideWithAuthFallback(
			[selector],
			undefined,
			modelRegistry,
			context.session.settings,
			context.session.getSessionId?.() ?? undefined,
		);
		if (resolved.model && modelRegistry.hasConfiguredAuth(resolved.model)) modelPatterns.push(selector);
	}
	if (modelPatterns.length === 0) {
		throw new Error(
			"No available saved model can serve this source. Select an available model explicitly with `--model`.",
		);
	}
	return {
		modelPatterns,
		session: {
			fork: {
				sourceFile: source.file,
			},
			promptSuffix: resolvedModel =>
				prompt.render(seanceAssignmentTemplate, {
					sourceSession: safeSourceLabel(source.id),
					model: resolvedModel ?? "",
				}),
		},
	};
}

export async function restoreSeanceSession(context: {
	init: PersistedSessionInit;
	cwd: string;
	modelRegistry: ModelRegistry;
}): Promise<RestoredSeanceSession | undefined> {
	const { init, cwd, modelRegistry } = context;
	const readOnlyTools = new Set([...(getBundledAgent(SEANCE_AGENT_NAME)?.tools ?? []), "yield"]);
	if (
		!init ||
		typeof init !== "object" ||
		init.agent !== SEANCE_AGENT_NAME ||
		init.restrictToolNames !== true ||
		!Array.isArray(init.systemPrompt) ||
		init.systemPrompt.length === 0 ||
		!init.systemPrompt.every(block => typeof block === "string") ||
		!init.systemPrompt.some(block => typeof block === "string" && block.trim().length > 0) ||
		typeof init.task !== "string" ||
		init.task.trim().length === 0 ||
		typeof init.resolvedModel !== "string" ||
		init.resolvedModel.trim().length === 0 ||
		!Array.isArray(init.tools) ||
		!init.tools.every(tool => typeof tool === "string") ||
		// `grep.enabled`/`glob.enabled` may have trimmed the spawn's list; `read` is the minimum.
		!init.tools.includes("read") ||
		typeof cwd !== "string" ||
		cwd.trim().length === 0
	) {
		return undefined;
	}
	const modelPattern = init.resolvedModel.trim();
	await modelRegistry.awaitBackgroundRefresh().catch(() => {});
	if (!resolveSessionModelSelector(modelRegistry, modelPattern)) return undefined;
	return {
		cwd,
		modelPattern,
		toolNames: init.tools.filter(name => readOnlyTools.has(name)),
	};
}
