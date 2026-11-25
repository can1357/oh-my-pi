/**
 * Decides which discovered extensions may bind after the interactive composer
 * accepts input instead of before the session exists.
 *
 * Only a previous load can tell whether an extension's factory registers state
 * that must exist before the first frame: model providers (startup model
 * resolution), keyboard shortcuts (bound once at editor setup), composer shapes
 * (installed at UI init), file-mutation fallbacks (installed at runner init), or
 * custom message renderers, assistant reply renderers and link schemes (the
 * first frame replays the transcript with them, and the schemes reach the
 * markdown renderer at UI init), internal URL schemes (their promptDoc enters
 * the first system prompt, and the composer completes them from the first
 * keystroke), or the todo backend `todo.backend` selects
 * (a resumed session's list goes to it at `session_start`; an extension whose
 * backends are all unselected may defer). Each load records that verdict in agent.db,
 * keyed by the module's resolved path and fingerprinted by its size and mtime.
 * A source with no verdict for its current fingerprint loads eagerly and
 * records one, so a changed module is never deferred on stale knowledge.
 */
import * as fs from "node:fs/promises";
import { isRecord, logger } from "@oh-my-pi/pi-utils";
import type { AgentStorageApi } from "../../session/agent-storage";
import { resolvePath } from "../utils";
import type { Extension } from "./types";

// Bumped whenever canBindAfterStartup counts a new registration, so verdicts recorded without it
// are not trusted.
const CACHE_PREFIX = "extension_startup:v4:";
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

interface StartupVerdict {
	fingerprint: string;
	deferrable: boolean;
	/** Todo backend ids the extension registered: selecting one keeps it eager. */
	todoBackends: string[];
}

/** Discovered extension paths split by whether they must bind before the session is created. */
export interface StartupExtensionPartition {
	eager: string[];
	deferred: string[];
}

async function fingerprintSource(resolvedPath: string): Promise<string | undefined> {
	try {
		const stat = await fs.stat(resolvedPath);
		return `${stat.size}:${stat.mtimeMs}`;
	} catch {
		return undefined;
	}
}

function readVerdict(storage: AgentStorageApi, resolvedPath: string): StartupVerdict | undefined {
	const raw = storage.getCache(`${CACHE_PREFIX}${resolvedPath}`);
	if (!raw) return undefined;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (
			!isRecord(parsed) ||
			typeof parsed.fingerprint !== "string" ||
			typeof parsed.deferrable !== "boolean" ||
			!Array.isArray(parsed.todoBackends) ||
			!parsed.todoBackends.every(id => typeof id === "string")
		) {
			return undefined;
		}
		return { fingerprint: parsed.fingerprint, deferrable: parsed.deferrable, todoBackends: parsed.todoBackends };
	} catch {
		return undefined;
	}
}

/**
 * Whether a bound extension registered nothing that has to exist before the first frame. Todo
 * backends are left out: whether one is needed depends on `todo.backend`, which
 * {@link partitionStartupExtensions} checks against the recorded ids.
 */
export function canBindAfterStartup(extension: Extension): boolean {
	return (
		extension.registersProviders !== true &&
		extension.shortcuts.size === 0 &&
		extension.composerShapes.size === 0 &&
		extension.fileWriteFallbackHandlers.length === 0 &&
		extension.fileDeleteFallbackHandlers.length === 0 &&
		extension.assistantTextRenderers.length === 0 &&
		extension.assistantThinkingRenderers.length === 0 &&
		extension.linkSchemes.length === 0 &&
		extension.urlSchemes.size === 0 &&
		extension.messageRenderers.size === 0
	);
}

/**
 * Split extension paths into those that must load before session creation and
 * those a recorded verdict for their current source proves safe to bind later.
 * A source that registers the `todoBackend` id (the `todo.backend` setting)
 * stays eager. Order within each list follows `paths`.
 */
export async function partitionStartupExtensions(
	storage: AgentStorageApi,
	paths: readonly string[],
	cwd: string,
	todoBackend: string,
): Promise<StartupExtensionPartition> {
	const deferrable = await Promise.all(
		paths.map(async extensionPath => {
			const resolvedPath = resolvePath(extensionPath, cwd);
			const verdict = readVerdict(storage, resolvedPath);
			if (!verdict?.deferrable || verdict.todoBackends.includes(todoBackend)) return false;
			return verdict.fingerprint === (await fingerprintSource(resolvedPath));
		}),
	);
	const partition: StartupExtensionPartition = { eager: [], deferred: [] };
	for (let index = 0; index < paths.length; index++) {
		(deferrable[index] ? partition.deferred : partition.eager).push(paths[index]);
	}
	return partition;
}

/**
 * Record each freshly bound file-backed extension's startup verdict. Call right
 * after binding: registrations made later (session_start) never affect startup.
 */
export async function recordStartupVerdicts(storage: AgentStorageApi, extensions: readonly Extension[]): Promise<void> {
	const expiresAtSec = Math.floor((Date.now() + CACHE_TTL_MS) / 1000);
	await Promise.all(
		extensions.map(async extension => {
			if (extension.resolvedPath.startsWith("<inline")) return;
			const fingerprint = await fingerprintSource(extension.resolvedPath);
			if (fingerprint === undefined) return;
			const verdict: StartupVerdict = {
				fingerprint,
				deferrable: canBindAfterStartup(extension),
				todoBackends: [...(extension.todoBackends?.keys() ?? [])],
			};
			try {
				storage.setCache(`${CACHE_PREFIX}${extension.resolvedPath}`, JSON.stringify(verdict), expiresAtSec);
			} catch (error) {
				logger.warn("Failed to record extension startup verdict", {
					path: extension.resolvedPath,
					error: String(error),
				});
			}
		}),
	);
}
