import * as path from "node:path";

import { escapeXmlText, prompt } from "@oh-my-pi/pi-utils";
import evalStateContextPrompt from "../prompts/system/eval-state-context.md" with { type: "text" };
import type { ToolSession } from "../tools";
import { defaultEvalSessionId } from "./session-id";

const MAX_SESSION_BUCKETS = 256;
const MAX_LOADED_PATHS = 12;
const MAX_FIELD_CHARS = 512;

/** Language identifiers used by retained-kernel lifecycle notifications. */
export type EvalStateLanguage = "python" | "js";

/** A backend's observed kernel lifecycle or successful script-load event. */
export interface EvalStateUpdate {
	language: EvalStateLanguage;
	kernelId?: string;
	alive: boolean;
	environment?: string;
	interpreter?: string;
	loadedPath?: string;
}

/** Runtime identity and bounded load history; never contains user values. */
export interface EvalRuntimeState {
	language: EvalStateLanguage;
	kernelId?: string;
	generation: number;
	alive: boolean;
	environment?: string;
	interpreter?: string;
	cwd: string;
	loadedPaths: readonly string[];
	loadedPathsOmitted: number;
	updatedAt: number;
}

/** Live-host runtime state visible to a session and its shared-kernel owners. */
export interface EvalStateSnapshot {
	sessionId: string;
	cwd: string;
	runtimes: readonly EvalRuntimeState[];
}

const FALLBACK_OWNER = "\0unscoped";

interface MutableEvalRuntimeState extends Omit<EvalRuntimeState, "loadedPaths"> {
	configKey: string;
	shared: boolean;
	ownerIds: Set<string>;
	loadedPaths: string[];
}

interface EvalSessionBucket {
	sessionId: string;
	runtimes: Map<string, MutableEvalRuntimeState>;
	updatedAt: number;
}

const registry = new Map<string, EvalSessionBucket>();

function evalSessionId(session: ToolSession): string {
	const explicit = session.getEvalSessionId?.();
	return explicit && explicit.length > 0 ? explicit : defaultEvalSessionId(session);
}

function evalOwnerId(session: ToolSession): string {
	return normalizeOptional(session.getEvalKernelOwnerId?.()) ?? FALLBACK_OWNER;
}

function normalizeCwd(cwd: string): string {
	return path.resolve(cwd);
}

function normalizeOptional(value: string | null | undefined): string | undefined {
	const normalized = value?.trim();
	return normalized ? normalized : undefined;
}

function runtimeConfigKey(language: EvalStateLanguage, cwd: string, interpreter: string | undefined): string {
	if (language === "js") return language;
	return `${language}\0${cwd}\0${interpreter ?? ""}`;
}

function runtimeRecordKey(
	language: EvalStateLanguage,
	configKey: string,
	kernelId: string | undefined,
	ownerId: string,
): string {
	return kernelId ? `${language}\0kernel\0${kernelId}` : `${configKey}\0owner\0${ownerId}`;
}

function touchBucket(sessionId: string): EvalSessionBucket {
	let bucket = registry.get(sessionId);
	if (!bucket) {
		bucket = { sessionId, runtimes: new Map(), updatedAt: Date.now() };
		registry.set(sessionId, bucket);
	} else {
		registry.delete(sessionId);
		registry.set(sessionId, bucket);
	}
	while (registry.size > MAX_SESSION_BUCKETS) {
		const stale = Array.from(registry.entries()).find(
			([candidateId, candidate]) =>
				candidateId !== sessionId && Array.from(candidate.runtimes.values()).every(runtime => !runtime.alive),
		);
		if (!stale) break;
		registry.delete(stale[0]);
	}
	return bucket;
}

function appendLoadedPath(runtime: MutableEvalRuntimeState, loadedPath: string): void {
	const normalized = path.resolve(runtime.cwd, loadedPath);
	const existing = runtime.loadedPaths.indexOf(normalized);
	if (existing >= 0) runtime.loadedPaths.splice(existing, 1);
	runtime.loadedPaths.push(normalized);
	if (runtime.loadedPaths.length > MAX_LOADED_PATHS) {
		runtime.loadedPaths.shift();
		runtime.loadedPathsOmitted++;
	}
}

function runtimeEntryByKernel(
	bucket: EvalSessionBucket,
	language: EvalStateLanguage,
	kernelId: string,
): [string, MutableEvalRuntimeState] | undefined {
	for (const entry of bucket.runtimes) {
		if (entry[1].language === language && entry[1].kernelId === kernelId) return entry;
	}
	return undefined;
}

function newestRuntime(
	entries: Array<[string, MutableEvalRuntimeState]>,
	predicate: (runtime: MutableEvalRuntimeState) => boolean,
): [string, MutableEvalRuntimeState] | undefined {
	let selected: [string, MutableEvalRuntimeState] | undefined;
	for (const entry of entries) {
		if (predicate(entry[1]) && (!selected || entry[1].updatedAt > selected[1].updatedAt)) selected = entry;
	}
	return selected;
}

function newestRuntimeValue(
	runtimes: MutableEvalRuntimeState[],
	predicate: (runtime: MutableEvalRuntimeState) => boolean,
): MutableEvalRuntimeState | undefined {
	let selected: MutableEvalRuntimeState | undefined;
	for (const runtime of runtimes) {
		if (predicate(runtime) && (!selected || runtime.updatedAt > selected.updatedAt)) selected = runtime;
	}
	return selected;
}

/**
 * Records a real retained-runtime lifecycle transition.
 *
 * Actual kernel identities are retained separately. Owner membership keeps a
 * shared base kernel visible to parent and child sessions while an owner-scoped
 * reset fork remains private to its requester. A new identity in the same
 * lineage starts a generation with empty file-load history.
 */
export function updateEvalState(session: ToolSession, update: EvalStateUpdate): void {
	const sessionId = evalSessionId(session);
	const ownerId = evalOwnerId(session);
	const cwd = normalizeCwd(session.cwd);
	const interpreter = normalizeOptional(update.interpreter);
	const environment = normalizeOptional(update.environment);
	const kernelId = normalizeOptional(update.kernelId);
	const configKey = runtimeConfigKey(update.language, cwd, interpreter);
	const bucket = touchBucket(sessionId);
	const exact = kernelId ? runtimeEntryByKernel(bucket, update.language, kernelId) : undefined;
	let runtime = exact?.[1];

	if (!update.alive) {
		if (!runtime && !kernelId) {
			const candidates = Array.from(bucket.runtimes.entries()).filter(
				([, candidate]) => candidate.configKey === configKey,
			);
			runtime =
				newestRuntime(candidates, candidate => !candidate.shared && candidate.ownerIds.has(ownerId))?.[1] ??
				newestRuntime(candidates, candidate => candidate.shared)?.[1];
		}
		if (!runtime) return;
		runtime.alive = false;
		runtime.environment = environment ?? runtime.environment;
		runtime.interpreter = interpreter ?? runtime.interpreter;
		runtime.updatedAt = Date.now();
		bucket.updatedAt = runtime.updatedAt;
		return;
	}

	if (!runtime) {
		const candidates = Array.from(bucket.runtimes.entries()).filter(
			([, candidate]) => candidate.configKey === configKey,
		);
		const ownedPrivate = newestRuntime(candidates, candidate => !candidate.shared && candidate.ownerIds.has(ownerId));
		const shared = newestRuntime(candidates, candidate => candidate.shared);
		const predecessor = ownedPrivate ?? shared;
		let sharedRuntime = true;
		if (ownedPrivate) {
			sharedRuntime = false;
			bucket.runtimes.delete(ownedPrivate[0]);
		} else if (shared) {
			const [, previous] = shared;
			const requesterExclusivelyOwnedShared = previous.ownerIds.has(ownerId) && previous.ownerIds.size === 1;
			if (previous.alive && !requesterExclusivelyOwnedShared) {
				sharedRuntime = false;
				previous.ownerIds.delete(ownerId);
			} else {
				bucket.runtimes.delete(shared[0]);
			}
		}

		const now = Date.now();
		runtime = {
			language: update.language,
			kernelId,
			generation: predecessor ? predecessor[1].generation + 1 : 1,
			alive: true,
			environment,
			interpreter,
			cwd,
			configKey,
			shared: sharedRuntime,
			ownerIds:
				sharedRuntime && predecessor?.[1].shared
					? new Set([...predecessor[1].ownerIds, ownerId])
					: new Set([ownerId]),
			loadedPaths: [],
			loadedPathsOmitted: 0,
			updatedAt: now,
		};
		bucket.runtimes.set(runtimeRecordKey(update.language, configKey, kernelId, ownerId), runtime);
	} else {
		runtime.ownerIds.add(ownerId);
		runtime.alive = true;
		runtime.environment = environment ?? runtime.environment;
		runtime.interpreter = interpreter ?? runtime.interpreter;
		runtime.cwd = cwd;
		runtime.updatedAt = Date.now();
	}
	if (update.loadedPath) appendLoadedPath(runtime, update.loadedPath);
	bucket.updatedAt = runtime.updatedAt;
}

function cloneRuntime(runtime: MutableEvalRuntimeState): EvalRuntimeState {
	return {
		language: runtime.language,
		kernelId: runtime.kernelId,
		generation: runtime.generation,
		alive: runtime.alive,
		environment: runtime.environment,
		interpreter: runtime.interpreter,
		cwd: runtime.cwd,
		loadedPaths: [...runtime.loadedPaths],
		loadedPathsOmitted: runtime.loadedPathsOmitted,
		updatedAt: runtime.updatedAt,
	};
}

/** Returns the current process's retained runtimes relevant to this tool session. */
export function getEvalState(session: ToolSession): EvalStateSnapshot | undefined {
	const sessionId = evalSessionId(session);
	const ownerId = evalOwnerId(session);
	const cwd = normalizeCwd(session.cwd);
	const bucket = registry.get(sessionId);
	if (!bucket) return undefined;
	const relevant = Array.from(bucket.runtimes.values()).filter(
		runtime => runtime.language === "js" || runtime.cwd === cwd,
	);
	const byConfig = new Map<string, MutableEvalRuntimeState[]>();
	for (const runtime of relevant) {
		const group = byConfig.get(runtime.configKey);
		if (group) group.push(runtime);
		else byConfig.set(runtime.configKey, [runtime]);
	}
	const visible: MutableEvalRuntimeState[] = [];
	for (const runtimes of byConfig.values()) {
		const selected =
			newestRuntimeValue(runtimes, runtime => !runtime.shared && runtime.ownerIds.has(ownerId) && runtime.alive) ??
			newestRuntimeValue(runtimes, runtime => runtime.shared && runtime.alive) ??
			newestRuntimeValue(runtimes, runtime => !runtime.shared && runtime.ownerIds.has(ownerId)) ??
			newestRuntimeValue(runtimes, runtime => runtime.shared);
		if (selected) visible.push(selected);
	}
	const runtimes = visible
		.sort((left, right) => left.language.localeCompare(right.language) || left.updatedAt - right.updatedAt)
		.map(cloneRuntime);
	if (runtimes.length === 0) return undefined;
	return { sessionId, cwd, runtimes };
}

function safeField(value: string): string {
	const bounded = value.length > MAX_FIELD_CHARS ? `${value.slice(0, MAX_FIELD_CHARS - 1)}…` : value;
	return escapeXmlText(bounded.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " "));
}

function formatRuntime(runtime: EvalRuntimeState, index: number, languageCount: number): string[] {
	const language = runtime.language === "python" ? "Python" : "JavaScript";
	const label = languageCount > 1 ? `${language} ${index + 1}` : language;
	const status = runtime.alive ? "alive" : "dead; state is unavailable";
	const metadata = [
		`generation=${runtime.generation}`,
		runtime.kernelId ? `kernel=${safeField(runtime.kernelId)}` : undefined,
		runtime.environment ? `environment=${safeField(runtime.environment)}` : undefined,
		runtime.interpreter ? `runtime=${safeField(runtime.interpreter)}` : undefined,
	].filter((value): value is string => value !== undefined);
	const lines = [`- ${label}: ${status}; ${metadata.join("; ")}`];
	if (runtime.loadedPaths.length > 0) {
		lines.push("  Successfully loaded scripts (newest last):");
		for (const loadedPath of runtime.loadedPaths) lines.push(`  - ${safeField(loadedPath)}`);
		if (runtime.loadedPathsOmitted > 0) lines.push(`  - … ${runtime.loadedPathsOmitted} older path(s) omitted`);
	}
	return lines;
}

/**
 * Formats a compact, model-visible snapshot without inspecting runtime values.
 * Set historyHasEval when a resumed transcript contains eval activity: an empty
 * fresh-process registry then explicitly states that the historical state was
 * not restored.
 */
export function formatEvalStateContext(
	session: ToolSession,
	options?: { historyHasEval?: boolean },
): string | undefined {
	const snapshot = getEvalState(session);
	if (!snapshot && options?.historyHasEval !== true) return undefined;
	let stateSummary: string | undefined;
	if (snapshot) {
		const languageCounts: Record<EvalStateLanguage, number> = { python: 0, js: 0 };
		for (const runtime of snapshot.runtimes) languageCounts[runtime.language]++;
		const languageIndexes: Record<EvalStateLanguage, number> = { python: 0, js: 0 };
		const lines: string[] = [];
		for (const runtime of snapshot.runtimes) {
			const index = languageIndexes[runtime.language];
			lines.push(...formatRuntime(runtime, index, languageCounts[runtime.language]));
			languageIndexes[runtime.language]++;
		}
		stateSummary = `Current host registry:\n${lines.join("\n")}`;
	}
	return prompt.render(evalStateContextPrompt, { stateSummary }).trim();
}
