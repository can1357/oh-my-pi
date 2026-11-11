/**
 * Shared helpers for internal-url protocol handlers that resolve IDs against
 * registered agent sessions.
 */

import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { LRUCache } from "@oh-my-pi/pi-utils/lru";
import { isAdvisorTranscriptName } from "../advisor/transcript-recorder";
import { type AgentRef, AgentRegistry, type AgentRegistryApi } from "../registry/agent-registry";

export interface RegisterArtifactsDirOptions {
	readonly sessionId?: string;
	readonly epoch?: number;
}

export interface SessionArtifactEpochOptions {
	readonly epoch?: number;
}

export interface ArtifactsDirsOptions {
	readonly preferredDir?: string;
	readonly sessionId?: string;
	readonly ownedOnly?: boolean;
}

export interface RetainedArtifactsBridge {
	registerArtifactsDir(dir: string, options?: RegisterArtifactsDirOptions): () => void;
	unregisterArtifactsDirsUnder(rootDir: string): void;
	retainTemporaryLeaseForSession(
		sessionId: string,
		artifactsDir: string,
		options?: SessionArtifactEpochOptions,
	): () => void;
	currentSessionArtifactEpoch(sessionId: string): number;
	resolveSessionArtifactOwner(sessionId: string, epoch?: number): string;
	artifactsDirsFromRegistry(options?: ArtifactsDirsOptions): string[];
}

interface SessionArtifactRegistration {
	readonly dir: string;
	sessionId: string;
	epoch: number;
}

interface SessionCleanupRegistration {
	readonly cleanup: () => Promise<void>;
	sessionId: string;
	epoch: number;
}

interface SessionArtifactForward {
	readonly minEpoch: number;
	readonly maxEpoch: number;
	readonly targetId: string;
	readonly targetEpoch: number;
}

const extraArtifactsDirs = new Set<string>();
const sessionArtifactsDirs = new Map<string, Set<SessionArtifactRegistration>>();
const sessionRetainedCleanups = new Map<string, Set<SessionCleanupRegistration>>();
const forwardedSessionEpochs = new LRUCache<string, SessionArtifactForward[]>({ max: 2048 });
const sessionActiveEpochs = new LRUCache<string, number>({ max: 2048 });
const releasedSessionEpochs = new LRUCache<string, number>({ max: 2048 });
const inFlightSessionReleases = new Map<string, Set<Promise<void>>>();
const kRetainedLeaseArtifactsDir = Symbol("retained-lease-artifacts-dir");
let retainedArtifactsBridge: RetainedArtifactsBridge | undefined;
/** Deepest nesting artifact directory walks descend below an artifacts dir. */
const MAX_SCAN_DEPTH = 8;

export function installRetainedArtifactsBridge(bridge: RetainedArtifactsBridge | undefined): void {
	retainedArtifactsBridge = bridge;
}

function localCurrentSessionArtifactEpoch(sessionId: string): number {
	const active = sessionActiveEpochs.get(sessionId);
	if (active !== undefined) return active;
	sessionActiveEpochs.set(sessionId, 1);
	return 1;
}

function resolveSessionOwner(rawSessionId: string, rawEpoch?: number): { sessionId: string; epoch: number } {
	let sessionId = rawSessionId;
	let epoch = rawEpoch ?? localCurrentSessionArtifactEpoch(sessionId);
	for (let hops = 0; hops < 16; hops++) {
		const forwards = forwardedSessionEpochs.get(sessionId);
		const match = forwards?.find(
			entry => epoch >= entry.minEpoch && epoch <= entry.maxEpoch && entry.targetId !== sessionId,
		);
		if (!match) break;
		sessionId = match.targetId;
		epoch = match.targetEpoch;
	}
	return { sessionId, epoch };
}

function isLocalSessionArtifactEpochReleased(sessionId: string, epoch: number): boolean {
	const releasedEpoch = releasedSessionEpochs.get(sessionId) ?? 0;
	return releasedEpoch > 0 && epoch <= releasedEpoch;
}

export function activateRetainedSessionArtifacts(rawSessionId: string): number {
	if (!rawSessionId) return 0;
	const nextEpoch =
		Math.max(sessionActiveEpochs.get(rawSessionId) ?? 0, releasedSessionEpochs.get(rawSessionId) ?? 0) + 1;
	sessionActiveEpochs.set(rawSessionId, nextEpoch);
	return nextEpoch;
}

export function currentSessionArtifactEpoch(rawSessionId: string): number {
	if (!rawSessionId) return 0;
	if (retainedArtifactsBridge) return retainedArtifactsBridge.currentSessionArtifactEpoch(rawSessionId);
	return resolveSessionOwner(rawSessionId).epoch;
}

function resolveRegisteredSubagentRoot(rawSessionId: string): { sessionId: string; epoch?: number } | undefined {
	if (!rawSessionId) return undefined;
	for (const ref of AgentRegistry.global().list()) {
		if (ref.kind === "main" || !ref.rootSessionId || ref.rootSessionId === rawSessionId) continue;
		let childSessionId = ref.sessionId;
		if (!childSessionId) {
			try {
				childSessionId = ref.session?.sessionManager?.getSessionId?.() || undefined;
			} catch {
				childSessionId = undefined;
			}
		}
		if (childSessionId === rawSessionId) {
			return { sessionId: ref.rootSessionId, epoch: ref.rootSessionEpoch };
		}
	}
	return undefined;
}

function localResolveSessionArtifactOwner(rawSessionId: string, rawEpoch?: number): string {
	let sessionId = rawSessionId;
	let epoch = rawEpoch;
	for (let hops = 0; hops < 8; hops++) {
		const parentRoot = resolveRegisteredSubagentRoot(sessionId);
		if (!parentRoot) break;
		sessionId = parentRoot.sessionId;
		epoch ??= parentRoot.epoch;
	}
	return resolveSessionOwner(sessionId, epoch).sessionId;
}

export function resolveSessionArtifactOwner(rawSessionId: string, epoch?: number): string {
	if (!rawSessionId) return "";
	if (retainedArtifactsBridge) return retainedArtifactsBridge.resolveSessionArtifactOwner(rawSessionId, epoch);
	return localResolveSessionArtifactOwner(rawSessionId, epoch);
}

export function resolveAgentRefRootOwner(ref: AgentRef): string | undefined {
	if (ref.kind === "main") {
		const liveSessionId = ref.session?.sessionManager?.getSessionId?.() || undefined;
		if (liveSessionId) return resolveSessionArtifactOwner(liveSessionId);
	}
	if (!ref.rootSessionId) return undefined;
	return resolveSessionArtifactOwner(ref.rootSessionId, ref.kind === "main" ? undefined : ref.rootSessionEpoch);
}

export function isForeignRootAgentRef(ref: AgentRef, callerSessionId?: string): boolean {
	if (!callerSessionId) return false;
	const refOwner = resolveAgentRefRootOwner(ref);
	if (!refOwner) return false;
	const callerOwner = resolveSessionArtifactOwner(callerSessionId);
	return Boolean(callerOwner && callerOwner !== refOwner);
}

export function isSameRootAgentRef(ref: AgentRef, callerSessionId?: string): boolean {
	if (!callerSessionId) return false;
	const refOwner = resolveAgentRefRootOwner(ref);
	if (!refOwner) return false;
	const callerOwner = resolveSessionArtifactOwner(callerSessionId);
	return Boolean(callerOwner && callerOwner === refOwner);
}

export function isPathWithinDirs(targetPath: string | null | undefined, dirs: readonly string[]): boolean {
	if (!targetPath || dirs.length === 0) return false;
	const resolvedTarget = path.resolve(targetPath);
	for (const dir of dirs) {
		if (!dir) continue;
		const resolvedDir = path.resolve(dir);
		const rel = path.relative(resolvedDir, resolvedTarget);
		if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) return true;
	}
	return false;
}

export function agentRefMatchesDirs(ref: AgentRef, dirs: readonly string[]): boolean {
	if (dirs.length === 0) return false;
	if (isPathWithinDirs(ref.sessionFile, dirs)) return true;
	const sessionArtifactsDir = ref.session?.sessionManager?.getArtifactsDir?.();
	return isPathWithinDirs(sessionArtifactsDir, dirs);
}

export function isSessionArtifactEpochReleased(rawSessionId: string, epoch?: number): boolean {
	if (!rawSessionId) return false;
	const candidateEpoch = epoch ?? sessionActiveEpochs.get(rawSessionId) ?? 1;
	return isLocalSessionArtifactEpochReleased(rawSessionId, candidateEpoch);
}

function trackSessionReleasePromise(sessionId: string, pending: Promise<void>): void {
	let active = inFlightSessionReleases.get(sessionId);
	if (!active) {
		active = new Set();
		inFlightSessionReleases.set(sessionId, active);
	}
	const settled = pending
		.catch(() => {})
		.finally(() => {
			const current = inFlightSessionReleases.get(sessionId);
			if (!current) return;
			current.delete(settled);
			if (current.size === 0) inFlightSessionReleases.delete(sessionId);
		});
	active.add(settled);
}

export function registerArtifactsDir(dir: string, options?: RegisterArtifactsDirOptions): () => void {
	if (retainedArtifactsBridge) return retainedArtifactsBridge.registerArtifactsDir(dir, options);
	const rawSessionId = options?.sessionId;
	if (rawSessionId) {
		const { sessionId, epoch } = resolveSessionOwner(rawSessionId, options?.epoch);
		if (isLocalSessionArtifactEpochReleased(sessionId, epoch)) return () => {};
		let dirs = sessionArtifactsDirs.get(sessionId);
		if (!dirs) {
			dirs = new Set();
			sessionArtifactsDirs.set(sessionId, dirs);
		}
		const record: SessionArtifactRegistration = { dir, sessionId, epoch };
		dirs.add(record);
		return () => {
			const current = sessionArtifactsDirs.get(record.sessionId);
			if (!current) return;
			current.delete(record);
			if (current.size === 0) sessionArtifactsDirs.delete(record.sessionId);
		};
	}
	extraArtifactsDirs.add(dir);
	return () => {
		extraArtifactsDirs.delete(dir);
	};
}

function localUnregisterArtifactsDirsUnder(rootDir: string): void {
	const prefix = rootDir.endsWith(path.sep) ? rootDir : `${rootDir}${path.sep}`;
	const matches = (candidate: string) => candidate === rootDir || candidate.startsWith(prefix);
	for (const dir of extraArtifactsDirs) {
		if (matches(dir)) extraArtifactsDirs.delete(dir);
	}
	for (const [sessionId, dirs] of sessionArtifactsDirs) {
		for (const record of dirs) {
			if (matches(record.dir)) dirs.delete(record);
		}
		if (dirs.size === 0) sessionArtifactsDirs.delete(sessionId);
	}
}

export function unregisterArtifactsDirsUnder(rootDir: string): void {
	localUnregisterArtifactsDirsUnder(rootDir);
	retainedArtifactsBridge?.unregisterArtifactsDirsUnder(rootDir);
}

export async function cleanupTemporaryLeaseArtifacts(
	artifactsDir: string,
	registry: Pick<AgentRegistryApi, "list" | "unregister"> = AgentRegistry.global(),
): Promise<void> {
	await fs.rm(artifactsDir, { recursive: true, force: true });
	unregisterArtifactsDirsUnder(artifactsDir);
	const leasePrefix = artifactsDir.endsWith(path.sep) ? artifactsDir : `${artifactsDir}${path.sep}`;
	for (const ref of registry.list()) {
		if (ref.session === null && ref.sessionFile?.startsWith(leasePrefix)) {
			registry.unregister(ref.id, ref);
		}
	}
}

export function markRetainedLeaseCleanup(cleanup: () => Promise<void>, artifactsDir: string): () => Promise<void> {
	Reflect.set(cleanup, kRetainedLeaseArtifactsDir, artifactsDir);
	return cleanup;
}

export function retainedLeaseArtifactsDir(cleanup: (() => Promise<void>) | undefined): string | undefined {
	if (!cleanup) return undefined;
	const value: unknown = Reflect.get(cleanup, kRetainedLeaseArtifactsDir);
	return typeof value === "string" ? value : undefined;
}

export function registerRetainedSessionArtifactCleanup(
	rawSessionId: string,
	cleanup: () => Promise<void>,
	options?: SessionArtifactEpochOptions,
): () => void {
	const { sessionId, epoch } = resolveSessionOwner(rawSessionId, options?.epoch);
	if (isLocalSessionArtifactEpochReleased(sessionId, epoch)) {
		trackSessionReleasePromise(sessionId, cleanup());
		return () => {};
	}
	let cleanups = sessionRetainedCleanups.get(sessionId);
	if (!cleanups) {
		cleanups = new Set();
		sessionRetainedCleanups.set(sessionId, cleanups);
	}
	const record: SessionCleanupRegistration = { cleanup, sessionId, epoch };
	cleanups.add(record);
	return () => {
		const current = sessionRetainedCleanups.get(record.sessionId);
		if (!current) return;
		current.delete(record);
		if (current.size === 0) sessionRetainedCleanups.delete(record.sessionId);
	};
}

export function retainTemporaryLeaseForSession(
	rawSessionId: string,
	artifactsDir: string,
	options?: SessionArtifactEpochOptions,
): () => void {
	if (!rawSessionId) return () => {};
	if (retainedArtifactsBridge) {
		return retainedArtifactsBridge.retainTemporaryLeaseForSession(rawSessionId, artifactsDir, options);
	}
	return registerRetainedSessionArtifactCleanup(
		rawSessionId,
		() => cleanupTemporaryLeaseArtifacts(artifactsDir),
		options,
	);
}

export function transferRetainedSessionArtifacts(fromSessionId: string, toSessionId: string): number {
	if (!fromSessionId || !toSessionId || fromSessionId === toSessionId) {
		return toSessionId ? resolveSessionOwner(toSessionId).epoch : 0;
	}
	const { sessionId: sourceId } = resolveSessionOwner(fromSessionId);
	const { sessionId: targetId } = resolveSessionOwner(toSessionId);
	if (sourceId === targetId) return localCurrentSessionArtifactEpoch(targetId);
	const prevSourceReleased = releasedSessionEpochs.get(sourceId) ?? 0;
	const sourceActive = localCurrentSessionArtifactEpoch(sourceId);
	const targetReleased = releasedSessionEpochs.get(targetId) ?? 0;
	const targetActive = localCurrentSessionArtifactEpoch(targetId);
	const isTargetReleased = targetReleased >= targetActive;
	const targetEpoch = isTargetReleased ? targetActive : Math.max(targetActive, targetReleased + 1);
	if (!isTargetReleased) {
		sessionActiveEpochs.set(targetId, targetEpoch);
	}
	if (sourceActive > prevSourceReleased) {
		releasedSessionEpochs.set(sourceId, sourceActive);
		const existing = forwardedSessionEpochs.get(sourceId) ?? [];
		forwardedSessionEpochs.set(sourceId, [
			...existing,
			{ minEpoch: prevSourceReleased + 1, maxEpoch: sourceActive, targetId, targetEpoch },
		]);
	}
	const dirs = sessionArtifactsDirs.get(sourceId);
	if (dirs) {
		sessionArtifactsDirs.delete(sourceId);
		if (!isTargetReleased) {
			let targetDirs = sessionArtifactsDirs.get(targetId);
			if (!targetDirs) {
				targetDirs = new Set();
				sessionArtifactsDirs.set(targetId, targetDirs);
			}
			for (const record of dirs) {
				record.sessionId = targetId;
				record.epoch = targetEpoch;
				targetDirs.add(record);
			}
		}
	}
	const cleanups = sessionRetainedCleanups.get(sourceId);
	if (cleanups) {
		sessionRetainedCleanups.delete(sourceId);
		if (isTargetReleased) {
			for (const record of cleanups) {
				trackSessionReleasePromise(targetId, record.cleanup());
			}
			return targetEpoch;
		}
		let targetCleanups = sessionRetainedCleanups.get(targetId);
		if (!targetCleanups) {
			targetCleanups = new Set();
			sessionRetainedCleanups.set(targetId, targetCleanups);
		}
		for (const record of cleanups) {
			record.sessionId = targetId;
			record.epoch = targetEpoch;
			targetCleanups.add(record);
		}
	}
	return targetEpoch;
}

export async function releaseRetainedSessionArtifacts(
	rawSessionId: string,
	options?: SessionArtifactEpochOptions,
): Promise<void> {
	if (!rawSessionId) return;
	const sessionId = rawSessionId;
	const currentActive = sessionActiveEpochs.get(sessionId) ?? 1;
	const targetEpoch = options?.epoch ?? currentActive;
	if (targetEpoch <= 0) return;
	if (!sessionActiveEpochs.has(sessionId)) {
		sessionActiveEpochs.set(sessionId, currentActive);
	}
	const prevReleased = releasedSessionEpochs.get(sessionId) ?? 0;
	if (targetEpoch > prevReleased) {
		releasedSessionEpochs.set(sessionId, targetEpoch);
	}
	const cleanups = sessionRetainedCleanups.get(sessionId);
	if (cleanups) {
		for (const record of cleanups) {
			if (record.epoch <= targetEpoch) {
				cleanups.delete(record);
				trackSessionReleasePromise(sessionId, record.cleanup());
			}
		}
		if (cleanups.size === 0) sessionRetainedCleanups.delete(sessionId);
	}
	while (true) {
		const active = inFlightSessionReleases.get(sessionId);
		if (!active || active.size === 0) break;
		await Promise.allSettled(active);
	}
	const dirs = sessionArtifactsDirs.get(sessionId);
	if (dirs) {
		for (const record of dirs) {
			if (record.epoch <= targetEpoch) dirs.delete(record);
		}
		if (dirs.size === 0) sessionArtifactsDirs.delete(sessionId);
	}
}

export function resetRegisteredArtifactDirsForTests(): void {
	extraArtifactsDirs.clear();
	sessionArtifactsDirs.clear();
	sessionRetainedCleanups.clear();
	forwardedSessionEpochs.clear();
	sessionActiveEpochs.clear();
	releasedSessionEpochs.clear();
	inFlightSessionReleases.clear();
}

/**
 * Snapshot of artifacts dirs for every registered session, deduped.
 *
 * Collects TWO candidate dirs per ref, because a subagent reads from its
 * adopted (root-wide) `ArtifactManager.dir` but its own children are written
 * one level deeper, under `sessionFile.slice(0, -6)` (`task/index.ts`). A
 * depth-2+ subagent's output therefore lives in the write-time dir, not the
 * adopted one, so `agent://` must scan both or it 404s a live nested peer.
 * `addDir` dedup collapses the depth-0 case (both formulas agree) back to a
 * single entry.
 *
 * When `options.preferredDir` is supplied — the caller root's canonical
 * artifact directory, derived from the caller's session file — it is inserted
 * FIRST, ahead of every registry-derived dir. When `options.sessionId` is
 * supplied, retained temporary artifact dirs owned by that root session are
 * scanned next (newest-first) and temporary dirs owned by other sessions are
 * excluded, so coexisting in-memory sessions never shadow or leak across one
 * another. Absent `options.sessionId`, all registered dirs remain visible.
 */
export function artifactsDirsFromRegistry(options?: ArtifactsDirsOptions): string[] {
	if (retainedArtifactsBridge) return retainedArtifactsBridge.artifactsDirsFromRegistry(options);
	const dirs: string[] = [];
	const addDir = (dir: string | null | undefined) => {
		if (!dir) return;
		if (!dirs.includes(dir)) dirs.push(dir);
	};
	if (options?.preferredDir) addDir(options.preferredDir);
	const resolvedSessionId = options?.sessionId ? localResolveSessionArtifactOwner(options.sessionId) : undefined;
	if (resolvedSessionId) {
		const owned = sessionArtifactsDirs.get(resolvedSessionId);
		if (owned) {
			const ownedList = [...owned];
			for (let i = ownedList.length - 1; i >= 0; i--) addDir(ownedList[i]!.dir);
		}
	}
	if (options?.ownedOnly) return dirs;
	for (const ref of AgentRegistry.global().list()) {
		if (resolvedSessionId && isForeignRootAgentRef(ref, resolvedSessionId)) continue;
		addDir(ref.session?.sessionManager?.getArtifactsDir());
		if (ref.sessionFile) addDir(ref.sessionFile.slice(0, -6));
	}
	for (const dir of extraArtifactsDirs) addDir(dir);
	if (!resolvedSessionId) {
		for (const owned of sessionArtifactsDirs.values()) {
			for (const record of owned) addDir(record.dir);
		}
	}
	return dirs;
}

/**
 * Recursively scan artifacts dirs for agent session transcripts, keyed by
 * agent id (the `.jsonl` basename). Used by `history://` so transcripts of
 * agents no longer in the registry (unregistered one-shot helpers, released
 * agents, or any agent after session resume) remain reachable — mirroring how
 * `agent://` reads `.md` outputs straight off disk.
 *
 * Layout follows `task/index.ts`: a subagent's transcript is
 * `<artifactsDir>/<AgentId>.jsonl`, and its own children nest one level deeper
 * under `<artifactsDir>/<AgentId>/<AgentId>.<ChildId>.jsonl`. Advisor
 * transcripts (`__advisor.jsonl` / `__advisor.<slug>.jsonl`) are
 * observability-only and excluded; EPERM-rewrite backups (`.bak`) are skipped.
 * When the same id appears in multiple dirs, the first hit wins (registry dirs
 * are scanned first; a `preferredDir` or owning `sessionId` from the caller
 * root is scanned before them). Directory listings are prefetched in parallel;
 * the walk itself stays a sequential depth-first pass so first-hit order is
 * unaffected. In `onlyPreferred` mode, only the supplied directory is scanned,
 * with direct files before descendants. `preserveDuplicates` retains every
 * candidate path per id for ambiguity checks.
 */
export function sessionFilesFromDisk(
	preferredDir: string | undefined,
	options: { onlyPreferred?: boolean; ownedOnly?: boolean; preserveDuplicates: true; sessionId?: string },
): Promise<Map<string, string[]>>;
export function sessionFilesFromDisk(
	preferredDir?: string,
	options?: { onlyPreferred?: boolean; ownedOnly?: boolean; preserveDuplicates?: false; sessionId?: string },
): Promise<Map<string, string>>;
export async function sessionFilesFromDisk(
	preferredDir?: string,
	options?: { onlyPreferred?: boolean; ownedOnly?: boolean; preserveDuplicates?: boolean; sessionId?: string },
): Promise<Map<string, string> | Map<string, string[]>> {
	const dirs = options?.onlyPreferred
		? preferredDir
			? [preferredDir]
			: []
		: artifactsDirsFromRegistry({
				preferredDir,
				sessionId: options?.sessionId,
				ownedOnly: options?.ownedOnly,
			});
	const list = prefetchArtifactTree(dirs, entries => {
		const subdirs: string[] = [];
		for (const entry of entries) {
			if (entry.isDirectory()) subdirs.push(entry.name);
		}
		return subdirs;
	});

	const found = options?.preserveDuplicates ? new Map<string, string[]>() : new Map<string, string>();
	const seenDirs = new Set<string>();
	const recordFile = (dir: string, entry: Dirent): void => {
		if (!entry.isFile() || !entry.name.endsWith(".jsonl")) return;
		if (isAdvisorTranscriptName(entry.name)) return;
		const id = entry.name.slice(0, -".jsonl".length);
		const file = path.join(dir, entry.name);
		if (options?.preserveDuplicates) {
			const files = found as Map<string, string[]>;
			const candidates = files.get(id);
			if (candidates) candidates.push(file);
			else files.set(id, [file]);
		} else {
			const files = found as Map<string, string>;
			if (!files.has(id)) files.set(id, file);
		}
	};
	const scan = async (dir: string, depth: number): Promise<void> => {
		if (depth > MAX_SCAN_DEPTH || seenDirs.has(dir)) return;
		seenDirs.add(dir);
		const entries = await list(dir, depth);
		if (!entries) return;
		if (options?.onlyPreferred) {
			// Prefer a direct transcript over a nested same-id copy.
			for (const entry of entries) recordFile(dir, entry);
			for (const entry of entries) {
				if (entry.isDirectory()) await scan(path.join(dir, entry.name), depth + 1);
			}
			return;
		}
		for (const entry of entries) {
			if (entry.isDirectory()) {
				await scan(path.join(dir, entry.name), depth + 1);
				continue;
			}
			recordFile(dir, entry);
		}
	};
	for (const dir of dirs) await scan(dir, 0);
	return found;
}

export interface AgentOutputScan {
	/** First-hit `<id>.md` path for each discovered agent id. */
	outputs: Map<string, string>;
	/** Same-directory `<id>.json` sidecar for entries in `outputs` that have one. */
	sidecars: Map<string, string>;
	/** True when at least one candidate directory exists on disk. */
	anyDirExists: boolean;
}

/**
 * Recursively scan candidate artifacts dirs (in priority order) for `<id>.md`
 * agent outputs and their same-directory `<id>.json` sidecars.
 *
 * Descends only into subdirectories backed by a sibling agent stem
 * (`<name>.jsonl` or `<name>.md`, excluding advisor transcripts and `.bak`
 * backups), matching `task/index.ts` nesting while skipping non-agent subtrees
 * such as `local/`, `annotation-drafts/`, and `btw-history/`. Within each
 * directory, direct outputs are recorded before descending into child agent
 * directories so a root's entire subtree stays ahead of lower-priority roots.
 */
export async function agentOutputFilesFromDisk(dirs: readonly string[]): Promise<AgentOutputScan> {
	const list = prefetchArtifactTree(dirs, childAgentDirectories);
	const outputs = new Map<string, string>();
	const sidecars = new Map<string, string>();
	const seenDirs = new Set<string>();
	let anyDirExists = false;

	const scan = async (dir: string, depth: number): Promise<void> => {
		if (depth > MAX_SCAN_DEPTH || seenDirs.has(dir)) return;
		seenDirs.add(dir);
		const entries = await list(dir, depth);
		if (!entries) return;
		anyDirExists = true;

		const localSidecars = new Map<string, string>();
		for (const entry of entries) {
			if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
			localSidecars.set(entry.name.slice(0, -".json".length), path.join(dir, entry.name));
		}
		for (const entry of entries) {
			if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
			const id = entry.name.slice(0, -".md".length);
			if (outputs.has(id)) continue;
			outputs.set(id, path.join(dir, entry.name));
			const sidecar = localSidecars.get(id);
			if (sidecar) sidecars.set(id, sidecar);
		}
		if (depth >= MAX_SCAN_DEPTH) return;
		for (const subdir of childAgentDirectories(entries)) {
			await scan(path.join(dir, subdir), depth + 1);
		}
	};
	for (const dir of dirs) await scan(dir, 0);
	return { outputs, sidecars, anyDirExists };
}

function childAgentDirectories(entries: readonly Dirent[]): string[] {
	const stems = new Set<string>();
	for (const entry of entries) {
		if (!entry.isFile() || isAdvisorTranscriptName(entry.name) || entry.name.endsWith(".bak")) continue;
		if (entry.name.endsWith(".jsonl")) {
			stems.add(entry.name.slice(0, -".jsonl".length));
		} else if (entry.name.endsWith(".md")) {
			stems.add(entry.name.slice(0, -".md".length));
		}
	}
	if (stems.size === 0) return [];
	const subdirs: string[] = [];
	for (const entry of entries) {
		if (entry.isDirectory() && stems.has(entry.name)) subdirs.push(entry.name);
	}
	return subdirs;
}

function prefetchArtifactTree(
	dirs: readonly string[],
	nextSubdirs: (entries: readonly Dirent[]) => readonly string[],
): (dir: string, depth: number) => Promise<Dirent[] | null> {
	const listings = new Map<string, Promise<Dirent[] | null>>();
	const list = (dir: string, depth: number): Promise<Dirent[] | null> => {
		let listing = listings.get(dir);
		if (listing) return listing;
		listing = readDirEntries(dir);
		listings.set(dir, listing);
		// Fan out to subdirectories as soon as this listing lands. Rejections
		// are surfaced (in walk order) by the awaiting scan below.
		listing.then(
			entries => {
				if (!entries || depth >= MAX_SCAN_DEPTH) return;
				for (const subdir of nextSubdirs(entries)) {
					list(path.join(dir, subdir), depth + 1);
				}
			},
			() => {},
		);
		return listing;
	};
	for (const dir of dirs) list(dir, 0);
	return list;
}

/** Directory entries of `dir`, or null when it is missing or not a directory. */
async function readDirEntries(dir: string): Promise<Dirent[] | null> {
	try {
		return await fs.readdir(dir, { withFileTypes: true });
	} catch (err) {
		if (isEnoent(err) || (err as NodeJS.ErrnoException).code === "ENOTDIR") return null;
		throw err;
	}
}

/**
 * Availability half of the `history://` resolution semantics: true when a
 * transcript for `agentId` can be served from a registered ref's live session
 * or retained session file, or from an on-disk `.jsonl` under a known
 * artifacts dir. Hint surfaces use this so they only advertise
 * `history://<agentId>` links that `HistoryProtocolHandler` can actually
 * resolve. A retained sessionFile path is verified on disk before it counts,
 * and probing never throws: a stale path or unreadable artifacts subtree
 * reads as unavailable instead of disturbing the caller's delivery path.
 */
export async function hasResolvableTranscript(
	agentId: string,
	options?: { preferredDir?: string; sessionId?: string },
): Promise<boolean> {
	try {
		const registry = AgentRegistry.global();
		const lower = agentId.toLowerCase();
		const sessionId = options?.sessionId;
		let ref = registry.get(agentId);
		if (ref?.kind === "advisor" || (ref && isForeignRootAgentRef(ref, sessionId))) ref = undefined;
		ref ??= registry
			.list()
			.find(
				candidate =>
					candidate.kind !== "advisor" &&
					!isForeignRootAgentRef(candidate, sessionId) &&
					candidate.id.toLowerCase() === lower,
			);
		if (ref?.session) return true;
		// A running worker resolves to a "no transcript yet" note, not an error.
		if (ref?.status === "running") return true;
		if (ref?.sessionFile && (await isReadableFile(ref.sessionFile))) return true;
		const files = await sessionFilesFromDisk(
			options?.preferredDir,
			options?.sessionId ? { sessionId: options.sessionId } : undefined,
		);
		for (const id of files.keys()) {
			if (id.toLowerCase() === lower) return true;
		}
	} catch {
		// Availability probing is advisory; any filesystem failure means the
		// transcript cannot be promised, never that delivery should fail.
	}
	return false;
}

/** True when `dir` contains at least one `<n>.*` spill artifact file; never throws. */
export async function hasSpillArtifacts(dir: string): Promise<boolean> {
	try {
		const entries = await readDirEntries(dir);
		if (!entries) return false;
		return entries.some(entry => entry.isFile() && /^\d+\./.test(entry.name));
	} catch {
		return false;
	}
}

/** True when `file` exists and is a regular file; never throws. */
export async function isReadableFile(file: string): Promise<boolean> {
	try {
		const stat = await fs.stat(file);
		return stat.isFile();
	} catch {
		return false;
	}
}
