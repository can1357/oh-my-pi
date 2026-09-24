import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir, isEnoent } from "@oh-my-pi/pi-utils";
import { getMemoryRoot } from "../memories";
import { getMnemopiSessionState, type MnemopiScopedMemoryHit, type MnemopiSessionState } from "../mnemopi/state";
import memoryDoc from "../prompts/internal-urls/memory.md" with { type: "text" };
import { AgentRegistry } from "../registry/agent-registry";
import type { AgentSession } from "../session/agent-session";
import {
	buildDirectoryResource,
	containedRealPath,
	contentTypeForPath,
	validateRelativePath,
} from "./filesystem-resource";
import type {
	InternalResource,
	InternalUrl,
	LocateOptions,
	ProtocolHandler,
	ResolveContext,
	SchemeHost,
	SchemeSpec,
	UrlCompletion,
} from "./types";

import { cfgMemoryBackend } from "../memory-backend/settings";

const DEFAULT_MEMORY_FILE = "memory_summary.md";
const MEMORY_NAMESPACE = "root";

/**
 * Hindsight keeps memories server-side and exposes no `memory://<id>`
 * addressing, yet the shared `recall` tool description still steers a
 * follow-up `read memory://<id>`. This corrective pointer lets that stray read
 * self-correct in one turn instead of derailing on the generic namespace
 * error (issue #7587).
 */
const HINDSIGHT_UNADDRESSABLE =
	"Hindsight memories are not addressable via memory://. Recall results are final — use `recall` to search or `reflect` to synthesize. `read memory://<id>` is only available with memory.backend=mnemopi.";

/**
 * Snapshot of memory roots for every registered session, deduped.
 * Each session has its own cwd (possibly a worktree), so subagents and main
 * may see different roots.
 */
function memoryRootsFromRegistry(): string[] {
	const agentDir = getAgentDir();
	const roots: string[] = [];
	for (const ref of AgentRegistry.global().list()) {
		const sm = ref.session?.sessionManager;
		if (!sm) continue;
		const root = getMemoryRoot(agentDir, sm.getCwd());
		if (root && !roots.includes(root)) roots.push(root);
	}
	return roots;
}

/**
 * File-backed memory roots visible to one caller. A context that names a cwd
 * pins the root to it; otherwise the bound caller's own cwd is used, so a
 * session-id-only caller never reads a peer project's summary. Contextless
 * legacy callers keep the registry-wide sweep.
 */
function memoryRootsForContext(context: ResolveContext | undefined, caller: AgentSession | undefined): string[] {
	const cwd = context?.cwd ?? caller?.sessionManager.getCwd();
	if (cwd) return [getMemoryRoot(getAgentDir(), cwd)];
	return memoryRootsFromRegistry();
}

/**
 * Resolve a memory:// URL to an absolute filesystem path under memory root.
 */
function resolveMemoryUrlToPath(url: InternalUrl, memoryRoot: string): string {
	const namespace = url.rawHost || url.hostname;
	if (!namespace) {
		throw new Error("memory:// URL requires a namespace: memory://root");
	}
	if (namespace !== MEMORY_NAMESPACE) {
		throw new Error(`Unknown memory namespace: ${namespace}. Supported: ${MEMORY_NAMESPACE}`);
	}

	const rawPathname = url.rawPathname ?? url.pathname;
	const hasPath = rawPathname && rawPathname !== "/" && rawPathname !== "";
	if (!hasPath) {
		return path.resolve(memoryRoot, DEFAULT_MEMORY_FILE);
	}
	let relativePath: string;
	try {
		relativePath = decodeURIComponent(rawPathname.slice(1));
	} catch {
		throw new Error(`Invalid URL encoding in memory:// path: ${url.href}`);
	}

	validateRelativePath(relativePath, "memory");

	return path.resolve(memoryRoot, relativePath);
}

/**
 * Contained location of a `memory://root` URL under one memory root: `real` is
 * the realpath of an existing target, `target` the would-be path. A bare
 * `memory://root` addresses the summary file, or the root itself when
 * `directory` is set. Undefined when the root itself does not exist.
 */
async function locateInRoot(
	url: InternalUrl,
	memoryRoot: string,
	directory: boolean,
): Promise<{ target: string; real: string | undefined } | undefined> {
	let resolvedRoot: string;
	try {
		resolvedRoot = await fs.realpath(path.resolve(memoryRoot));
	} catch (error) {
		if (isEnoent(error)) return undefined;
		throw error;
	}
	const target = directory && isBareMemoryUrl(url) ? resolvedRoot : resolveMemoryUrlToPath(url, resolvedRoot);
	return { target, real: await containedRealPath(target, resolvedRoot, "memory") };
}

/** True for `memory://root` with no path, which reads the default summary file. */
function isBareMemoryUrl(url: InternalUrl): boolean {
	const rawPathname = url.rawPathname ?? url.pathname;
	return !rawPathname || rawPathname === "/";
}

async function tryResolveInRoot(url: InternalUrl, memoryRoot: string): Promise<InternalResource | undefined> {
	const realTargetPath = (await locateInRoot(url, memoryRoot, false))?.real;
	if (realTargetPath === undefined) return undefined;

	const stat = await fs.stat(realTargetPath);
	if (stat.isDirectory()) {
		return buildDirectoryResource(url.href, realTargetPath);
	}
	if (!stat.isFile()) {
		throw new Error(`memory:// URL must resolve to a file or directory: ${url.href}`);
	}

	const content = await Bun.file(realTargetPath).text();

	return {
		url: url.href,
		content,
		contentType: contentTypeForPath(realTargetPath),
		size: Buffer.byteLength(content, "utf-8"),
		sourcePath: realTargetPath,
		notes: [],
	};
}

/**
 * Snapshot of live mnemopi session states, deduplicated. A mnemopi backend
 * always keeps its state on the {@link AgentSession} it was initialised for;
 * subagents alias their parent's state, so different `session` objects can
 * point at the same underlying banks. The dedupe below picks the
 * canonical (non-aliased) state per bank set so `memory://<id>` resolves in
 * one pass regardless of how many subagents are alive.
 */
function mnemopiSessionStatesFromRegistry(): MnemopiSessionState[] {
	const seen = new Set<unknown>();
	const states: MnemopiSessionState[] = [];
	for (const ref of AgentRegistry.global().list()) {
		const session = ref.session;
		if (!session) continue;
		const state = getMnemopiSessionState(session);
		if (!state) continue;
		const primary = state.aliasOf ?? state;
		if (seen.has(primary)) continue;
		seen.add(primary);
		states.push(primary);
	}
	return states;
}

function memoryBackendFromContext(context?: ResolveContext): string | undefined {
	return context?.settings ? cfgMemoryBackend.get(context.settings) : undefined;
}

/**
 * Memory identity of the session that issued a `memory://` URL.
 *
 * `session` is the live caller once it is bound. `legacy` marks the callers
 * that named no identity at all — contextless reads and settings-only
 * contexts — which keep the historical registry-wide lookup; a context that
 * names a cwd is scoped even when no single live session sits in it.
 */
interface MemoryCallerBinding {
	readonly session: AgentSession | undefined;
	readonly backend: string | undefined;
	readonly legacy: boolean;
}

/**
 * Live session that issued the URL. `sessionFile` and `sessionId` are exact
 * identities and win; a shared cwd only binds when exactly one live session
 * sits in it, so two sessions in one worktree never impersonate each other.
 */
function findCallerSession(context: ResolveContext): AgentSession | undefined {
	const refs = (context.agentRegistry ?? AgentRegistry.global()).list();
	if (context.sessionFile !== undefined) {
		const byFile = refs.find(ref => ref.session?.sessionFile === context.sessionFile)?.session;
		if (byFile) return byFile;
	}
	if (context.sessionId !== undefined) {
		const byId = refs.find(ref => ref.session?.sessionManager.getSessionId() === context.sessionId)?.session;
		if (byId) return byId;
	}
	// An exact identity that matches no live session is a stale caller, never a
	// cue to fall back to whoever else shares its cwd.
	if (context.sessionFile !== undefined || context.sessionId !== undefined) return undefined;
	if (context.cwd === undefined) return undefined;
	const sameCwd = refs.filter(ref => ref.session?.sessionManager.getCwd() === context.cwd);
	return sameCwd.length === 1 ? (sameCwd[0]?.session ?? undefined) : undefined;
}

function resolveMemoryCaller(context?: ResolveContext): MemoryCallerBinding {
	if (!context) return { session: undefined, backend: undefined, legacy: true };
	const session = findCallerSession(context);
	// The caller's own session owns the backend decision: not every tool threads
	// its settings blob, and a same-cwd peer's backend is not an answer.
	if (session) return { session, backend: cfgMemoryBackend.get(session.settings), legacy: false };
	if (context.sessionFile !== undefined || context.sessionId !== undefined) {
		// The named caller is gone; a surviving peer may not answer for it.
		return { session: undefined, backend: "off", legacy: false };
	}
	// A cwd that names no single live session still scopes the file-backed root,
	// but it identifies no bank: peer memory ids stay unreachable.
	return { session: undefined, backend: memoryBackendFromContext(context), legacy: context.cwd === undefined };
}

/**
 * Canonical mnemopi state of one session. Subagents alias their parent's
 * state, so the alias is resolved to the state that owns the banks.
 */
function callerMnemopiState(session: AgentSession): MnemopiSessionState | undefined {
	const state = getMnemopiSessionState(session);
	return state?.aliasOf ?? state;
}

function unknownNamespaceError(namespace: string): Error {
	return new Error(
		`Unknown memory namespace: ${namespace}. Supported: ${MEMORY_NAMESPACE} (file-backed memory summary), or a mnemopi memory id when memory.backend=mnemopi is active.`,
	);
}

/**
 * Error for the file-backed `memory://root` namespace when it is unavailable.
 * Only `memory.backend=local` owns this namespace; hindsight keeps memory
 * server-side and mnemopi in SQLite banks. Non-local callers must not see
 * potentially stale files left by an earlier local session. The backend-aware
 * message points at the tools that can actually answer instead of prescribing
 * "enable memories" to a caller whose backend is already healthy.
 */
function fileBackedRootUnavailableError(backend: string | undefined): Error {
	if (backend === undefined || backend === "local") {
		return new Error(
			"Memory artifacts are not available for this project yet. Run a session with memories enabled first.",
		);
	}
	const searchHint =
		backend === "mnemopi"
			? " Use `recall`/`reflect` to search Mnemopi memories, or `read memory://<memory-id>` for a full row."
			: backend === "hindsight"
				? " Use `recall`/`reflect` to search Hindsight memories."
				: "";
	return new Error(
		`File-backed memory artifacts only exist with memory.backend=local (active backend: ${backend}).${searchHint}`,
	);
}

/**
 * Look up a mnemopi memory row by id across every live session's scoped banks.
 * First hit wins; returns `null` when the id is not stored anywhere in scope.
 */
function tryResolveMnemopiMemory(id: string): MnemopiScopedMemoryHit | null {
	for (const state of mnemopiSessionStatesFromRegistry()) {
		const hit = state?.getScopedMemory(id);
		if (hit) return hit;
	}
	return null;
}

/**
 * Render a mnemopi memory row as text/markdown with a small YAML-front-matter
 * header. The frontmatter carries the metadata an agent needs to reason about
 * a working vs episodic memory (bank, store, timestamps, importance) without
 * having to reconstruct it from the recall preview.
 */
function renderMnemopiMemory(url: InternalUrl, hit: MnemopiScopedMemoryHit): InternalResource {
	const { row, bank, store } = hit;
	const meta = row.metadata == null ? "" : `metadata: ${JSON.stringify(row.metadata)}\n`;
	const header =
		"---\n" +
		`id: ${row.id}\n` +
		`bank: ${bank}\n` +
		`store: ${store}\n` +
		(row.memory_type ? `memory_type: ${row.memory_type}\n` : "") +
		(row.source ? `source: ${row.source}\n` : "") +
		(row.timestamp ? `timestamp: ${row.timestamp}\n` : "") +
		(row.created_at ? `created_at: ${row.created_at}\n` : "") +
		(row.importance != null ? `importance: ${row.importance}\n` : "") +
		(row.veracity ? `veracity: ${row.veracity}\n` : "") +
		(row.session_id ? `session_id: ${row.session_id}\n` : "") +
		meta +
		"---\n\n";
	const content = `${header}${row.content}`;
	return {
		url: url.href,
		content,
		contentType: "text/markdown",
		size: Buffer.byteLength(content, "utf-8"),
		notes: [],
	};
}

/**
 * Protocol handler for memory:// URLs.
 * Binds the URL to the session that issued it: the caller's own memory
 * backend decides how `memory://<id>` is answered, and its cwd decides which
 * file-backed root is read. Callers that name no identity keep the legacy
 * registry-wide lookup.
 */
export class MemoryProtocolHandler implements ProtocolHandler {
	readonly scheme = "memory";
	readonly spec: SchemeSpec = { backing: "file", selectors: "lines", immutable: true, linkable: true };

	/** Advertised only when the session's memory backend owns the file-backed `memory://root` namespace. */
	promptDoc(host: SchemeHost): string | undefined {
		return host.memoryBackend === "local" ? memoryDoc.trim() : undefined;
	}

	/**
	 * File backing `memory://root[/<path>]` for a local-backend caller; null for
	 * mnemopi ids, non-local backends, and missing entries without `create`.
	 */
	async locate(url: InternalUrl, context?: ResolveContext, options?: LocateOptions): Promise<string | null> {
		const caller = resolveMemoryCaller(context);
		if (caller.backend === "off") return null;
		const namespace = url.rawHost || url.hostname;
		if (!namespace) {
			throw new Error("memory:// URL requires a namespace: memory://root or memory://<memory-id>");
		}
		if (namespace !== MEMORY_NAMESPACE) return null;
		if (caller.backend !== undefined && caller.backend !== "local") return null;

		const directory = options?.directory === true;
		let wouldBe: string | undefined;
		for (const root of memoryRootsForContext(context, caller.session)) {
			const located = await locateInRoot(url, root, directory);
			if (located?.real !== undefined) return located.real;
			wouldBe ??=
				located?.target ??
				(directory && isBareMemoryUrl(url) ? path.resolve(root) : resolveMemoryUrlToPath(url, path.resolve(root)));
		}
		return options?.create ? (wouldBe ?? null) : null;
	}

	locateSync(url: InternalUrl): string | undefined {
		try {
			for (const root of memoryRootsFromRegistry()) {
				try {
					return resolveMemoryUrlToPath(url, root);
				} catch {
					// Try the next root; some sessions may not have this namespace mounted.
				}
			}
		} catch {
			return undefined;
		}
		return undefined;
	}

	async resolve(url: InternalUrl, context?: ResolveContext): Promise<InternalResource> {
		const caller = resolveMemoryCaller(context);
		const backend = caller.backend;
		if (backend === "off") {
			throw new Error("Unknown protocol: memory://");
		}
		const namespace = url.rawHost || url.hostname;
		if (!namespace) {
			throw new Error("memory:// URL requires a namespace: memory://root or memory://<memory-id>");
		}

		// Mnemopi rows live in SQLite banks per session, keyed by memory id.
		// Any host other than the file-backed `root` namespace is treated as a
		// mnemopi memory id lookup. This is the read counterpart to
		// `memory_edit update` and lets agents inspect the full content of a
		// clipped recall preview before overwriting it (issue #4443).
		if (namespace !== MEMORY_NAMESPACE) {
			if (!caller.legacy) {
				if (backend === "hindsight") throw new Error(HINDSIGHT_UNADDRESSABLE);
				if (backend === "mnemopi") {
					const hit = caller.session ? callerMnemopiState(caller.session)?.getScopedMemory(namespace) : undefined;
					if (hit) return renderMnemopiMemory(url, hit);
					throw new Error(
						`Mnemopi memory ${namespace} not found in the calling session's scoped bank. Use \`recall\` to list available ids.`,
					);
				}
				throw unknownNamespaceError(namespace);
			}

			const mnemopiStates = mnemopiSessionStatesFromRegistry();
			const hindsightActive =
				backend === "hindsight" ||
				(mnemopiStates.length === 0 &&
					AgentRegistry.global()
						.list()
						.some(ref => ref.session?.getHindsightSessionState?.()));
			if (hindsightActive) {
				throw new Error(HINDSIGHT_UNADDRESSABLE);
			}
			if (mnemopiStates.length === 0) {
				throw unknownNamespaceError(namespace);
			}
			const hit = tryResolveMnemopiMemory(namespace);
			if (hit) return renderMnemopiMemory(url, hit);
			throw new Error(
				`Mnemopi memory ${namespace} not found in any scoped bank. Use \`recall\` to list available ids.`,
			);
		}

		// A project may retain files from an earlier local session. Reject known
		// non-local callers before probing the filesystem so those stale
		// artifacts cannot leak across backend changes. Contextless legacy
		// callers have no active backend to gate and retain the registry sweep.
		if (backend !== undefined && backend !== "local") {
			throw fileBackedRootUnavailableError(backend);
		}

		const roots = memoryRootsForContext(context, caller.session);
		if (roots.length === 0) {
			throw fileBackedRootUnavailableError(backend);
		}

		let anyExists = false;
		for (const root of roots) {
			try {
				await fs.stat(root);
				anyExists = true;
			} catch (error) {
				if (isEnoent(error)) continue;
				throw error;
			}
			const result = await tryResolveInRoot(url, root);
			if (result) return result;
		}

		if (!anyExists) {
			throw fileBackedRootUnavailableError(backend);
		}

		throw new Error(`Memory file not found: ${url.href}`);
	}

	async complete(_query?: string, context?: ResolveContext): Promise<UrlCompletion[]> {
		const caller = resolveMemoryCaller(context);
		if (caller.backend === "off") return [];
		const completions: UrlCompletion[] = [];
		if (caller.backend === "local") {
			completions.push({ value: MEMORY_NAMESPACE, description: "Project memory summary" });
		}
		const mnemopiAvailable = caller.legacy
			? mnemopiSessionStatesFromRegistry().length > 0
			: caller.backend === "mnemopi" &&
				caller.session !== undefined &&
				callerMnemopiState(caller.session) !== undefined;
		if (mnemopiAvailable) {
			completions.push({
				value: "<memory-id>",
				description: "Full mnemopi memory by id (from recall)",
			});
		}
		return completions;
	}
}
