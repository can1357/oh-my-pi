import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	isEnoent,
	logger,
	postmortem,
	ptree,
	resolveEquivalentPath,
	stableStringifyJson,
	untilAborted,
} from "@oh-my-pi/pi-utils";
import { MessageFramer } from "../jsonrpc/message-framing";
import {
	isLexicallyWithin,
	normalizeSessionWorkspace,
	workspaceContainsPath,
	workspaceRootForPath,
} from "../session/session-workspace";
import { ToolAbortError, throwIfAborted } from "../tools/tool-errors";
import { configCache, findServerRoot, loadConfig, resolveCommand, type LspConfig } from "./config";
import { applyWorkspaceEdit, type ExecutedWorkspaceChange } from "./edits";
import { getLspmuxCommand, isLspmuxSupported } from "./lspmux";
import { connectSharedLspTransport } from "./mux/daemon";
import type {
	LspClient,
	LspJsonRpcId,
	LspJsonRpcNotification,
	LspJsonRpcRequest,
	LspJsonRpcResponse,
	LspTransport,
	LspWriteSink,
	PublishDiagnosticsParams,
	ServerConfig,
	WorkspaceEdit,
} from "./types";
import { detectLanguageId, equivalentDocumentUri, EquivalentUriMap, fileToUri, uriToFile } from "./utils";

// =============================================================================
// Client State
// =============================================================================

const clients = new Map<string, LspClient>();
interface PendingClient {
	promise: Promise<LspClient>;
	cwd: string;
	config: ServerConfig;
	token: symbol;
	owners: Set<LspClientOwner>;
}
const clientLocks = new Map<string, PendingClient>();
const invalidatedClientKeys = new Set<string>();
const clientReloadBarriers = new Map<string, Promise<unknown>>();
const clientIdentityReloadBarriers = new Map<string, Promise<unknown>>();
export type LspClientOwner = symbol;
const clientOwners = new Map<string, Set<LspClientOwner>>();
const ownerClientKeys = new Map<LspClientOwner, Set<string>>();
const ownerClientRoots = new Map<LspClientOwner, Map<string, Set<string>>>();
const ownerClientRouting = new Map<LspClientOwner, Map<string, { command: string; fileTypes: string[] }>>();
const ownerReloadGeneration = new Map<LspClientOwner, number>();
const configReloadGenerations = new Map<LspClientOwner, WeakMap<ServerConfig, number>>();
const ownerReleasedKeyGenerations = new Map<LspClientOwner, Map<string, number>>();
const ownerReloadRootGenerations = new Map<LspClientOwner, Map<string, number>>();

export function createLspClientOwner(): LspClientOwner {
	return Symbol("lsp-client-owner");
}

const releasedLspClientOwners = new WeakSet<LspClientOwner>();

const sessionFallbackOwners = new WeakMap<object, LspClientOwner>();

/** Reuse one fallback owner for public ToolSession callers that omit both ownership fields. */
export function fallbackLspClientOwner(session: object): LspClientOwner {
	const existing = sessionFallbackOwners.get(session);
	if (existing) return existing;
	const owner = createLspClientOwner();
	sessionFallbackOwners.set(session, owner);
	if ("registerDisposeCallback" in session && typeof session.registerDisposeCallback === "function") {
		session.registerDisposeCallback(() => releaseLspClientOwner(owner));
	}
	return owner;
}

function addOwnerRoutedRoot(key: string, owner: LspClientOwner, routedRoot: string): void {
	const root = path.resolve(routedRoot);
	let byKey = ownerClientRoots.get(owner);
	if (!byKey) {
		byKey = new Map();
		ownerClientRoots.set(owner, byKey);
	}
	let roots = byKey.get(key);
	if (!roots) {
		roots = new Set();
		byKey.set(key, roots);
	}
	roots.add(root);
}

function registerClientOwner(
	key: string,
	owner: LspClientOwner | undefined,
	routedRoot?: string | readonly string[],
): void {
	if (!owner) return;
	let owners = clientOwners.get(key);
	if (!owners) {
		owners = new Set();
		clientOwners.set(key, owners);
	}
	owners.add(owner);
	let keys = ownerClientKeys.get(owner);
	if (!keys) {
		keys = new Set();
		ownerClientKeys.set(owner, keys);
	}
	keys.add(key);
	if (!routedRoot) return;
	const roots = typeof routedRoot === "string" ? [routedRoot] : routedRoot;
	for (const root of roots) addOwnerRoutedRoot(key, owner, root);
}

function setOwnerClientRouting(
	owner: LspClientOwner,
	key: string,
	routing: { command: string; fileTypes: string[] },
): void {
	let byKey = ownerClientRouting.get(owner);
	if (!byKey) {
		byKey = new Map();
		ownerClientRouting.set(owner, byKey);
	}
	byKey.set(key, { command: routing.command, fileTypes: [...routing.fileTypes] });
}

function forgetOwnerClientRouting(owner: LspClientOwner, key: string): void {
	const byKey = ownerClientRouting.get(owner);
	byKey?.delete(key);
	if (byKey?.size === 0) ownerClientRouting.delete(owner);
}

function ownerClientFileTypes(owner: LspClientOwner | undefined, key: string, fallback: string[]): string[] {
	if (!owner) return fallback;
	return ownerClientRouting.get(owner)?.get(key)?.fileTypes ?? fallback;
}

function ownerClientCommand(owner: LspClientOwner | undefined, key: string, fallback: string): string {
	if (!owner) return fallback;
	return ownerClientRouting.get(owner)?.get(key)?.command ?? fallback;
}

function releaseClientOwnerKey(key: string, owner: LspClientOwner): boolean {
	const owners = clientOwners.get(key);
	owners?.delete(owner);
	if (owners?.size === 0) clientOwners.delete(key);
	const keys = ownerClientKeys.get(owner);
	keys?.delete(key);
	if (keys?.size === 0) ownerClientKeys.delete(owner);
	const byKey = ownerClientRoots.get(owner);
	byKey?.delete(key);
	if (byKey?.size === 0) ownerClientRoots.delete(owner);
	forgetOwnerClientRouting(owner, key);
	forgetIdleTimeoutOwner(key, owner);
	reconcileIdleChecker();
	return !clientOwners.has(key);
}
function dropClientOwnership(key: string): void {
	const owners = clientOwners.get(key);
	if (!owners) {
		dropIdleTimeoutOrigins(key);
		return;
	}
	for (const owner of owners) {
		const keys = ownerClientKeys.get(owner);
		keys?.delete(key);
		if (keys?.size === 0) ownerClientKeys.delete(owner);
		const byKey = ownerClientRoots.get(owner);
		byKey?.delete(key);
		if (byKey?.size === 0) ownerClientRoots.delete(owner);
		forgetOwnerClientRouting(owner, key);
	}
	clientOwners.delete(key);
	dropIdleTimeoutOrigins(key);
}

const OWNERLESS_IDLE_ORIGIN: unique symbol = Symbol("ownerless-idle-origin");
type IdleOriginOwner = LspClientOwner | typeof OWNERLESS_IDLE_ORIGIN;

interface UnpublishedClientOwnership {
	owners: LspClientOwner[];
	roots: Map<LspClientOwner, string[]>;
	routing: Map<LspClientOwner, { command: string; fileTypes: string[] }>;
	idleOrigins: Map<IdleOriginOwner, string[]>;
}

const unpublishedClientOwnership = new WeakMap<LspClient, UnpublishedClientOwnership>();

function snapshotIdleTimeoutOrigins(key: string): Map<IdleOriginOwner, string[]> {
	const origins = clientIdleTimeoutOrigins.get(key);
	if (!origins) return new Map();
	return new Map(Array.from(origins, ([owner, cwds]) => [owner, Array.from(cwds)]));
}

function restoreIdleTimeoutOrigins(key: string, snapshot: Map<IdleOriginOwner, string[]>): void {
	if (snapshot.size === 0) {
		clientIdleTimeoutOrigins.delete(key);
		return;
	}
	clientIdleTimeoutOrigins.set(key, new Map(Array.from(snapshot, ([owner, cwds]) => [owner, new Set(cwds)])));
}

function dropIdleTimeoutOrigins(key: string): void {
	clientIdleTimeoutOrigins.delete(key);
}

function forgetIdleTimeoutOwner(key: string, owner: LspClientOwner): void {
	const origins = clientIdleTimeoutOrigins.get(key);
	if (!origins) return;
	origins.delete(owner);
	if (origins.size === 0) clientIdleTimeoutOrigins.delete(key);
}

function snapshotClientOwnership(key: string): UnpublishedClientOwnership {
	const owners = Array.from(clientOwners.get(key) ?? []);
	return {
		owners,
		roots: new Map(owners.map(owner => [owner, Array.from(ownerClientRoots.get(owner)?.get(key) ?? [])])),
		routing: new Map(
			owners.flatMap(owner => {
				const routing = ownerClientRouting.get(owner)?.get(key);
				return routing ? [[owner, { command: routing.command, fileTypes: [...routing.fileTypes] }] as const] : [];
			}),
		),
		idleOrigins: snapshotIdleTimeoutOrigins(key),
	};
}

function restoreClientOwnership(key: string, snapshot: UnpublishedClientOwnership): void {
	const owners = snapshot.owners.filter(owner => !releasedLspClientOwners.has(owner));
	const idleOrigins = new Map(
		Array.from(snapshot.idleOrigins).filter(
			([origin]) => origin === OWNERLESS_IDLE_ORIGIN || !releasedLspClientOwners.has(origin),
		),
	);
	restoreIdleTimeoutOrigins(key, idleOrigins);
	for (const owner of owners) {
		registerClientOwner(key, owner, snapshot.roots.get(owner));
		const routing = snapshot.routing.get(owner);
		if (routing) setOwnerClientRouting(owner, key, routing);
	}
}

function unpublishClient(key: string, client: LspClient): boolean {
	if (clients.get(key) !== client) return false;
	unpublishedClientOwnership.set(client, snapshotClientOwnership(key));
	clients.delete(key);
	dropClientOwnership(key);
	return true;
}

function releaseOwnerIfUnpublished(key: string, owner: LspClientOwner | undefined): void {
	if (!owner || clients.has(key)) return;
	releaseClientOwnerKey(key, owner);
}

/**
 * Release this session's ownership of language servers started under a
 * workspace root that is no longer in the session. `/remove-dir` calls this
 * even when the model-facing LSP tool is not registered, so write/edit
 * writethrough clients do not remain owned after the root is removed.
 *
 * Clients still covered by `sessionCwd` or `remainingWorkspaceRoots` are left
 * alone: an additional root may be nested under, an ancestor of, or a symlink
 * alias of a retained workspace. Tearing those clients down would drop a
 * still-valid nested server or tombstone the primary root. Owner route
 * spellings under the removed root are still pruned so `lsp status` reports
 * a remaining alias instead of the vanished extra-root path.
 */
export async function releaseRemovedWorkspaceRoots(
	sessionCwd: string,
	removedRoot: string,
	owner: LspClientOwner | undefined,
	signal?: AbortSignal,
	remainingWorkspaceRoots: readonly string[] = [sessionCwd],
): Promise<string[]> {
	if (!owner) return [];
	const roots = [path.resolve(removedRoot)];
	const retainClient = (clientCwd: string) =>
		clientCoveredByRemainingWorkspace(clientCwd, sessionCwd, remainingWorkspaceRoots);
	try {
		const stopped = await shutdownStaleClients(sessionCwd, [], signal, roots, owner, retainClient);
		pruneUncoveredOwnerRoots(owner, sessionCwd, remainingWorkspaceRoots, removedRoot);
		clearWorkspaceInitializationFailures(roots, owner, retainClient);
		return stopped;
	} catch (error) {
		// The directory is already gone. Keep this session from remaining a
		// phantom owner of a process it can no longer clean up, even when
		// force-kill could not confirm exit.
		for (const key of Array.from(ownerClientKeys.get(owner) ?? [])) {
			const live = clients.get(key);
			const pending = clientLocks.get(key);
			const cwds = live
				? clientWorkspaceCwds(key, live, owner)
				: pending
					? clientWorkspaceCwds(key, pending, owner)
					: Array.from(ownerClientRoots.get(owner)?.get(key) ?? []);
			if (cwds.length > 0) {
				if (cwds.some(cwd => retainClient(cwd))) continue;
				if (!roots.some(root => cwds.some(cwd => workspaceContainsPath(root, cwd)))) continue;
			}
			releaseClientOwnerKey(key, owner);
		}
		pruneUncoveredOwnerRoots(owner, sessionCwd, remainingWorkspaceRoots, removedRoot);
		clearWorkspaceInitializationFailures(roots, owner, retainClient);
		throw error;
	}
}

/** True when a remaining workspace root still contains this client. */
function clientCoveredByRemainingWorkspace(
	clientCwd: string,
	sessionCwd: string,
	remainingWorkspaceRoots: readonly string[],
): boolean {
	const remaining = normalizeSessionWorkspace({
		cwd: sessionCwd,
		directories: remainingWorkspaceRoots.filter(root => path.resolve(root) !== path.resolve(sessionCwd)),
	});
	return workspaceRootForPath(clientCwd, remaining) !== null;
}

/** Drop owner aliases that remaining workspace roots no longer cover.
 *  Equivalent-path containment keeps an extra-root symlink of a retained
 *  workspace, so also drop aliases spelled under `removedRoot` unless a
 *  remaining root still contains that spelling. If that was the last route
 *  and the client is still covered, register a remaining workspace path so
 *  status/reload do not fall back to the vanished extra-root `resolvedRoot`. */
function pruneUncoveredOwnerRoots(
	owner: LspClientOwner,
	sessionCwd: string,
	remainingWorkspaceRoots: readonly string[],
	removedRoot?: string,
): void {
	const byKey = ownerClientRoots.get(owner);
	if (!byKey) return;
	const removed = removedRoot ? path.resolve(removedRoot) : undefined;
	const remaining = remainingWorkspaceRoots.map(root => path.resolve(root));
	for (const [key, roots] of byKey) {
		for (const root of Array.from(roots)) {
			const remainingLexical = remaining.some(workspace => isLexicallyWithin(workspace, root));
			if (removed && isLexicallyWithin(removed, root) && !remainingLexical) {
				if (clientCoveredByRemainingWorkspace(root, sessionCwd, remainingWorkspaceRoots)) {
					const covering = workspaceRootForPath(
						root,
						normalizeSessionWorkspace({
							cwd: sessionCwd,
							directories: remainingWorkspaceRoots.filter(
								workspace => path.resolve(workspace) !== path.resolve(sessionCwd),
							),
						}),
					);
					roots.add(path.resolve(covering ?? sessionCwd));
				}
				roots.delete(root);
				continue;
			}
			if (!clientCoveredByRemainingWorkspace(root, sessionCwd, remainingWorkspaceRoots)) {
				roots.delete(root);
			}
		}
		if (roots.size === 0) byKey.delete(key);
	}
	if (byKey.size === 0) ownerClientRoots.delete(owner);
}

/**
 * Release this session's ownership of language servers that the current
 * workspace no longer covers. `/move`, `/wt`, and interactive `!cd` keep
 * additional roots that still exist, but the previous cwd is otherwise a
 * dropped workspace.
 *
 * Equivalent-path containment treats a previous symlink alias of the new
 * cwd as still covered, so also process previous roots that remaining
 * workspaces do not contain lexically. `releaseRemovedWorkspaceRoots()`
 * keeps those clients running and rebinds owner routes onto a remaining
 * spelling; otherwise status and reload keep the vanished alias.
 *
 * Retained extra-root clients rebind idle-timeout origins to the settled
 * workspace and retire identities absent from the new session catalog, so a
 * previous cwd timeout or command/args/settings cannot leak onto the move.
 */
export async function releaseUncoveredWorkspaceRoots(
	previousWorkspaceRoots: readonly string[],
	remainingWorkspaceRoots: readonly string[],
	owner: LspClientOwner | undefined,
	signal?: AbortSignal,
): Promise<void> {
	if (!owner) return;
	const remainingCwd = remainingWorkspaceRoots[0];
	if (!remainingCwd) return;
	const remainingResolved = remainingWorkspaceRoots.map(root => path.resolve(root));
	const droppedRoots = previousWorkspaceRoots.filter(
		root => !remainingResolved.some(workspace => isLexicallyWithin(workspace, path.resolve(root))),
	);
	for (const removedRoot of droppedRoots) {
		try {
			await releaseRemovedWorkspaceRoots(remainingCwd, removedRoot, owner, signal, remainingWorkspaceRoots);
		} catch (error) {
			logger.warn("Failed to stop language servers for a dropped workspace root", {
				removedRoot,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	rebindIdleTimeoutOrigins(owner, [remainingCwd]);
	try {
		await retireRetainedClientsAbsentFromSessionConfig(
			remainingCwd,
			remainingResolved,
			previousWorkspaceRoots,
			owner,
			signal,
		);
	} catch (error) {
		logger.warn("Failed to stop language servers whose identity left the session catalog", {
			remainingCwd,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

/**
 * Shut down language servers whose routed root was moved or recursively
 * deleted. `rename_file` and generic workspace edits both use this: remaining
 * session workspace roots still contain the old path string, so `/remove-dir`
 * retention would keep the vanished-root process alive.
 *
 * `movedRootIdentity` is the equivalent path captured before the filesystem
 * mutation. A workspace symlink is keyed by its canonical target, and after
 * the alias moves `movedRoot` no longer resolves to that identity, so failure
 * cache lookup still needs the pre-move root. When `owner` is omitted, every
 * session's matching client is retired — workspace edits do not send
 * `didRenameFiles` to overlapping owners. A moved directory symlink is an
 * exception: only routes through that alias are pruned, so a session that
 * still reaches the unchanged physical target — including the same owner
 * through another equivalent route — keeps its live client. Ordinary
 * directories reached through a symlink parent still physically move, so
 * they take the full retirement path even when lexical and canonical paths
 * differ.
 */
export async function releaseMovedWorkspaceRoots(
	sessionCwd: string,
	movedRoot: string,
	owner: LspClientOwner | undefined,
	signal?: AbortSignal,
	movedRootIdentity = movedRoot,
	leafSymlink = false,
): Promise<string[]> {
	const lexical = path.resolve(movedRoot);
	const equivalent = path.resolve(movedRootIdentity);
	const roots = [lexical];
	if (!leafSymlink && !roots.includes(equivalent)) roots.push(equivalent);
	const failureRoots = roots.includes(equivalent) ? roots : [...roots, equivalent];
	if (leafSymlink) {
		const stopped = await releaseMovedSymlinkAlias(lexical, signal, owner);
		if (owner) clearWorkspaceInitializationFailures(failureRoots, owner);
		return stopped;
	}
	try {
		const stopped = await shutdownStaleClients(sessionCwd, [], signal, roots, owner);
		clearWorkspaceInitializationFailures(failureRoots, owner);
		return stopped;
	} catch (error) {
		if (owner) {
			for (const key of Array.from(ownerClientKeys.get(owner) ?? [])) {
				const live = clients.get(key);
				const pending = clientLocks.get(key);
				const cwds = live
					? clientWorkspaceCwds(key, live, owner)
					: pending
						? clientWorkspaceCwds(key, pending, owner)
						: Array.from(ownerClientRoots.get(owner)?.get(key) ?? []);
				if (cwds.length > 0 && !roots.some(root => cwds.some(cwd => workspaceContainsPath(root, cwd)))) {
					continue;
				}
				releaseClientOwnerKey(key, owner);
			}
		}
		clearWorkspaceInitializationFailures(failureRoots, owner);
		throw error;
	}
}

/** Drop routes through a vanished directory symlink without tearing down
 *  sessions that still reach the same physical client through another path.
 *  Pass `owner` to prune only that session; omit it for workspace-edit
 *  retirement across every owner. */
async function releaseMovedSymlinkAlias(
	movedRoot: string,
	signal?: AbortSignal,
	owner?: LspClientOwner,
): Promise<string[]> {
	const staleKeys = new Set<string>();
	const pruneOwner = (key: string, item: LspClientOwner): void => {
		const routes = ownerClientRoots.get(item)?.get(key);
		if (!routes) return;
		let moved = false;
		for (const route of Array.from(routes)) {
			if (!isLexicallyWithin(movedRoot, route)) continue;
			routes.delete(route);
			moved = true;
		}
		if (!moved) return;
		staleKeys.add(key);
		if (routes.size === 0) {
			releaseClientOwnerKey(key, item);
			clientLocks.get(key)?.owners.delete(item);
		}
	};
	if (owner) {
		const keys = new Set(ownerClientKeys.get(owner) ?? []);
		for (const [key, pending] of clientLocks) {
			if (pending.owners.has(owner)) keys.add(key);
		}
		for (const key of keys) pruneOwner(key, owner);
		const generation = (ownerReloadGeneration.get(owner) ?? 0) + 1;
		ownerReloadGeneration.set(owner, generation);
		let coveredRoots = ownerReloadRootGenerations.get(owner);
		if (!coveredRoots) {
			coveredRoots = new Map();
			ownerReloadRootGenerations.set(owner, coveredRoots);
		}
		coveredRoots.set(path.resolve(movedRoot), generation);
		let released = ownerReleasedKeyGenerations.get(owner);
		if (!released) {
			released = new Map();
			ownerReleasedKeyGenerations.set(owner, released);
		}
		for (const key of staleKeys) {
			if (clientOwners.get(key)?.has(owner)) continue;
			released.set(key, generation);
		}
	} else {
		for (const [key, owners] of clientOwners) {
			for (const item of Array.from(owners)) pruneOwner(key, item);
		}
		for (const [key, pending] of clientLocks) {
			for (const item of Array.from(pending.owners)) pruneOwner(key, item);
		}
	}
	const stopped: string[] = [];
	for (const key of staleKeys) {
		if (clientOwners.has(key)) continue;
		const live = clients.get(key);
		if (live) {
			if (await shutdownClientInstance(live)) stopped.push(live.config.command);
			continue;
		}
		const pending = clientLocks.get(key);
		if (!pending) continue;
		try {
			await untilAborted(signal, pending.promise);
		} catch {
			throwIfAborted(signal);
		}
		const started = clients.get(key);
		if (started && !clientOwners.has(key) && (await shutdownClientInstance(started))) {
			stopped.push(started.config.command);
		}
	}
	return stopped;
}

/** Release all client identities associated with a disposed tool session. */
export function releaseLspClientOwner(owner: LspClientOwner): void {
	releasedLspClientOwners.add(owner);
	for (const key of Array.from(ownerClientKeys.get(owner) ?? [])) releaseClientOwnerKey(key, owner);
	ownerReloadGeneration.delete(owner);
	ownerReleasedKeyGenerations.delete(owner);
	ownerReloadRootGenerations.delete(owner);
	configReloadGenerations.delete(owner);
}
const fileOperationLocks = new Map<string, Promise<void>>();

/** Negative cache of recent init failures so a broken server fails fast instead of re-spawning per call. */
const INIT_FAILURE_BACKOFF_MS = 3 * 60 * 1000;
const initFailures = new Map<string, { at: number; message: string; cwd: string; owners?: Set<LspClientOwner> }>();
const READER_EXIT_GRACE_MS = 100;

// Idle timeout configuration (disabled by default)
let idleTimeoutMs: number | null = null;
let idleCheckInterval: NodeJS.Timeout | null = null;
const IDLE_CHECK_INTERVAL_MS = 60 * 1000;
/** Live-acquisition session/request cwds whose config may supply idleTimeoutMs after nested-root rewrite. */
const clientIdleTimeoutOrigins = new Map<string, Map<IdleOriginOwner, Set<string>>>();

// Broker-shared server mode (one language server per project shared by every
// omp instance through the LSP mux daemon). Off by default so embedders and
// tests that drive getOrCreateClient directly never touch the daemon broker;
// the SDK turns it on from the `lsp.shared` setting at session creation.
let sharedLspEnabled = false;

/** Enable or disable attaching to broker-shared language servers. */
export function setSharedLspEnabled(enabled: boolean): void {
	sharedLspEnabled = enabled;
}

/**
 * Configure the global fallback idle timeout for LSP clients (used in tests/overrides).
 * When unset, each client evaluates against its spawn cwd and any originating
 * session/request cwds recorded before nested-root rewrite.
 * @param ms - Timeout in milliseconds, or null/undefined to disable global override
 */
export function setIdleTimeout(ms: number | null | undefined): void {
	idleTimeoutMs = ms ?? null;
	reconcileIdleChecker();
}

function rebindIdleTimeoutOrigins(owner: LspClientOwner, cwds: readonly string[]): void {
	const rebound = new Set(cwds.map(cwd => path.resolve(cwd)));
	for (const origins of clientIdleTimeoutOrigins.values()) {
		if (!origins.has(owner)) continue;
		origins.set(owner, new Set(rebound));
	}
	reconcileIdleChecker();
}

function peekCachedConfig(cwd: string): LspConfig | undefined {
	return configCache.get(cwd) ?? configCache.get(path.resolve(cwd));
}

function sessionCatalogConfigs(cwd: string): ServerConfig[] {
	const catalog = peekCachedConfig(cwd) ?? loadConfig(cwd);
	if (!catalog) return [];
	return Object.values(catalog.definitions ?? catalog.servers);
}

function withResolvedCatalogCommand(definition: ServerConfig, cwd: string): ServerConfig {
	const resolvedCommand = resolveCommand(definition.command, cwd) ?? definition.resolvedCommand;
	return resolvedCommand ? { ...definition, resolvedCommand } : definition;
}

function isEquivalentWorkspaceRoot(left: string, right: string): boolean {
	return workspaceContainsPath(left, right) && workspaceContainsPath(right, left);
}

async function retireRetainedClientsAbsentFromSessionConfig(
	remainingCwd: string,
	remainingWorkspaceRoots: readonly string[],
	previousWorkspaceRoots: readonly string[],
	owner: LspClientOwner,
	signal?: AbortSignal,
): Promise<void> {
	const extraRemaining = remainingWorkspaceRoots.filter(root => !isEquivalentWorkspaceRoot(remainingCwd, root));
	const previousCwd = previousWorkspaceRoots[0];
	const promotedRemaining = remainingWorkspaceRoots.filter(root => {
		if (!isEquivalentWorkspaceRoot(remainingCwd, root)) return false;
		return !previousCwd || !isEquivalentWorkspaceRoot(previousCwd, root);
	});
	const catalogRoots = [...extraRemaining, ...promotedRemaining];
	if (catalogRoots.length === 0) return;
	const catalog = sessionCatalogConfigs(remainingCwd);
	const freshConfigs: ServerConfig[] = [];
	const consider = (key: string, entry: { cwd: string; config: ServerConfig }): void => {
		const owners = clientOwners.get(key);
		if (!owners?.has(owner) && clientLocks.get(key)?.owners.has(owner) !== true) return;
		const cwds = clientWorkspaceCwds(key, entry, owner);
		if (!catalogRoots.some(root => cwds.some(clientCwd => workspaceContainsPath(root, clientCwd)))) {
			return;
		}
		const match = catalog.find(definition => {
			const resolved = withResolvedCatalogCommand(definition, entry.cwd);
			const selectedRoot = selectedRootForCatalogDefinition(resolved, entry.cwd, remainingWorkspaceRoots);
			if (!selectedRoot || !isEquivalentWorkspaceRoot(selectedRoot, entry.cwd)) return false;
			return clientKey({ ...resolved, resolvedRoot: selectedRoot }, selectedRoot) === key;
		});
		if (match) {
			freshConfigs.push({ ...withResolvedCatalogCommand(match, entry.cwd), resolvedRoot: entry.cwd });
		}
	};
	for (const [key, client] of clients) consider(key, client);
	for (const [key, pending] of clientLocks) consider(key, pending);
	await shutdownStaleClients(remainingCwd, freshConfigs, signal, catalogRoots, owner, () => false);
}

function selectedRootForCatalogDefinition(
	definition: ServerConfig,
	clientCwd: string,
	workspaceRoots: readonly string[],
): string | null {
	const markers = definition.rootMarkers;
	if (markers.length === 0 || markers.includes(".")) return clientCwd;
	return findServerRoot(path.join(clientCwd, "file"), markers, workspaceRoots);
}

function rememberIdleTimeoutOrigins(key: string, owner: LspClientOwner | undefined, ...cwds: string[]): void {
	const originOwner: IdleOriginOwner = owner ?? OWNERLESS_IDLE_ORIGIN;
	let origins = clientIdleTimeoutOrigins.get(key);
	if (!origins) {
		origins = new Map();
		clientIdleTimeoutOrigins.set(key, origins);
	}
	let cwdsForOwner = origins.get(originOwner);
	if (!cwdsForOwner) {
		cwdsForOwner = new Set();
		origins.set(originOwner, cwdsForOwner);
	}
	for (const cwd of cwds) cwdsForOwner.add(path.resolve(cwd));
}

function configuredIdleTimeoutMs(cwd: string): number | undefined {
	const timeoutMs = peekCachedConfig(cwd)?.idleTimeoutMs;
	return timeoutMs && timeoutMs > 0 ? timeoutMs : undefined;
}

function idleTimeoutOriginCwds(client: LspClient): string[] {
	const origins = clientIdleTimeoutOrigins.get(client.name);
	const owners = clientOwners.get(client.name);
	const cwds = new Set<string>();
	if (owners && owners.size > 0) {
		for (const owner of owners) {
			const ownerCwds = origins?.get(owner);
			if (ownerCwds) for (const cwd of ownerCwds) cwds.add(cwd);
		}
	}
	const ownerless = origins?.get(OWNERLESS_IDLE_ORIGIN);
	if (ownerless) for (const cwd of ownerless) cwds.add(cwd);
	// Spawn cwd is an origin only for ownerless processes (or an explicit
	// ownerless stamp). Remaining owners use the session/request cwds they
	// recorded; a released nested owner must not leave its spawn-root
	// timeout on a sibling that never configured one.
	if (!owners || owners.size === 0 || ownerless) {
		cwds.add(client.cwd);
	}
	return Array.from(cwds);
}

function idleTimeoutForClient(client: LspClient): number | undefined {
	if (idleTimeoutMs && idleTimeoutMs > 0) return idleTimeoutMs;
	let found: number | undefined;
	for (const cwd of idleTimeoutOriginCwds(client)) {
		const timeoutMs = configuredIdleTimeoutMs(cwd);
		if (timeoutMs === undefined) continue;
		found = found === undefined ? timeoutMs : Math.min(found, timeoutMs);
	}
	return found;
}

/**
 * Whether a client may be reaped by the idle checker.
 *
 * A client with in-flight requests is *busy*, never idle. `lastActivity` is
 * stamped when a request is written, not while it is outstanding, so a single
 * request that runs longer than the idle timeout used to look like silence:
 * the checker tore the client down mid-flight and `shutdownClientInstance`
 * rejected the caller's still-pending promise with "LSP client shutdown"
 * (issue #8390). Requests that settle refresh `lastActivity`, so a client
 * becomes eligible again only after the final one lands and the full idle
 * window then elapses.
 *
 * Exported for tests; the idle checker is the only production caller.
 */
export function isIdleClient(client: LspClient, now: number, timeoutMs: number): boolean {
	if (client.pendingRequests.size > 0) return false;
	return now - client.lastActivity > timeoutMs;
}

function hasConfiguredIdleTimeout(client?: LspClient): boolean {
	if (idleTimeoutMs && idleTimeoutMs > 0) return true;
	if (client && idleTimeoutForClient(client)) return true;
	for (const c of clients.values()) {
		if (idleTimeoutForClient(c)) return true;
	}
	return false;
}

function maybeStartIdleChecker(client?: LspClient): void {
	if (hasConfiguredIdleTimeout(client)) {
		startIdleChecker();
	}
}

/**
 * Whether the background idle checker interval is currently active.
 * Exported for tests.
 */
export function isIdleCheckerRunning(): boolean {
	return idleCheckInterval !== null;
}

/**
 * Reconcile the background idle checker interval against currently configured timeouts.
 * Starts the checker if any registered client or workspace has a positive timeout,
 * or stops it if none do.
 */
export function reconcileIdleChecker(): void {
	if (hasConfiguredIdleTimeout()) {
		startIdleChecker();
	} else {
		stopIdleChecker();
	}
}

function maybeStopIdleChecker(): void {
	if (!hasConfiguredIdleTimeout()) {
		stopIdleChecker();
	}
}

/**
 * Sweeps all registered LSP clients against their workspace idle timeout.
 * Exported for tests.
 */
export async function checkIdleClients(): Promise<void> {
	const now = Date.now();
	for (const [key, client] of Array.from(clients.entries())) {
		const timeoutMs = idleTimeoutForClient(client);
		if (timeoutMs && timeoutMs > 0 && isIdleClient(client, now, timeoutMs)) {
			await shutdownClient(key);
		}
	}
}

function startIdleChecker(): void {
	if (idleCheckInterval) return;
	idleCheckInterval = setInterval(() => {
		void checkIdleClients();
	}, IDLE_CHECK_INTERVAL_MS);
}

function stopIdleChecker(): void {
	if (idleCheckInterval) {
		clearInterval(idleCheckInterval);
		idleCheckInterval = null;
	}
}

// =============================================================================
// Client Capabilities
// =============================================================================

const CLIENT_CAPABILITIES = {
	textDocument: {
		synchronization: {
			didSave: true,
			dynamicRegistration: false,
			willSave: false,
			willSaveWaitUntil: false,
		},
		hover: {
			contentFormat: ["markdown", "plaintext"],
			dynamicRegistration: false,
		},
		definition: {
			dynamicRegistration: false,
			linkSupport: true,
		},
		typeDefinition: {
			dynamicRegistration: false,
			linkSupport: true,
		},
		implementation: {
			dynamicRegistration: false,
			linkSupport: true,
		},
		references: {
			dynamicRegistration: false,
		},
		documentSymbol: {
			dynamicRegistration: false,
			hierarchicalDocumentSymbolSupport: true,
			symbolKind: {
				valueSet: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26],
			},
		},
		rename: {
			dynamicRegistration: false,
			prepareSupport: true,
		},
		codeAction: {
			dynamicRegistration: false,
			codeActionLiteralSupport: {
				codeActionKind: {
					valueSet: [
						"quickfix",
						"refactor",
						"refactor.extract",
						"refactor.inline",
						"refactor.rewrite",
						"source",
						"source.organizeImports",
						"source.fixAll",
					],
				},
			},
			resolveSupport: {
				properties: ["edit"],
			},
		},
		formatting: {
			dynamicRegistration: false,
		},
		rangeFormatting: {
			dynamicRegistration: false,
		},
		publishDiagnostics: {
			relatedInformation: true,
			versionSupport: true,
			tagSupport: { valueSet: [1, 2] },
			codeDescriptionSupport: true,
			dataSupport: true,
		},
		diagnostic: {
			dynamicRegistration: true,
		},
	},
	window: {
		workDoneProgress: true,
	},
	workspace: {
		applyEdit: true,
		workspaceEdit: {
			documentChanges: true,
			resourceOperations: ["create", "rename", "delete"],
			failureHandling: "abort",
		},
		configuration: true,
		workspaceFolders: true,
		symbol: {
			dynamicRegistration: false,
			symbolKind: {
				valueSet: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26],
			},
		},
		fileOperations: {
			dynamicRegistration: false,
			willCreate: false,
			didCreate: false,
			willRename: true,
			didRename: true,
			willDelete: false,
			didDelete: false,
		},
	},
};

/** LSP `FileChangeType` values for workspace/didChangeWatchedFiles notifications. */
export enum FileChangeType {
	Created = 1,
	Changed = 2,
	Deleted = 3,
}

/** Filesystem change authored by the harness and announced to active LSP clients. */
export interface WatchedFileChange {
	filePath: string;
	type: FileChangeType;
}

// =============================================================================
// LSP Message Protocol
// =============================================================================

function abortReason(signal: AbortSignal): Error {
	return signal.reason instanceof Error ? signal.reason : new ToolAbortError();
}

class LspDrainAbortError extends Error {
	constructor(readonly reason: Error) {
		super(reason.message);
		this.name = "LspDrainAbortError";
	}
}

async function writeMessage(
	sink: LspWriteSink,
	message: LspJsonRpcRequest | LspJsonRpcNotification | LspJsonRpcResponse,
	signal?: AbortSignal,
): Promise<void> {
	if (signal?.aborted) {
		throw abortReason(signal);
	}
	const content = JSON.stringify(message);
	const write = Promise.resolve(
		sink.write(`Content-Length: ${Buffer.byteLength(content, "utf-8")}\r\n\r\n${content}`),
	);
	// Attach before flush(): it may throw synchronously after write() returned a
	// rejected Promise, and leaving that rejection unobserved kills the host.
	void write.catch(() => {});
	const drain = Promise.all([write, Promise.resolve(sink.flush())]).then(() => {});
	if (!signal) {
		await drain;
		return;
	}
	// Either sink operation can block on the OS-level pipe drain when a live
	// server stops reading stdin. Race the combined drain against the caller's
	// signal so a wedged server surfaces as the tool's normal timeout/cancel.
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	const onAbort = () => {
		signal.removeEventListener("abort", onAbort);
		// The underlying drain stays pending in the background; suppress its
		// eventual settlement so we do not surface an unhandled rejection.
		drain.catch(() => {});
		reject(new LspDrainAbortError(abortReason(signal)));
	};
	signal.addEventListener("abort", onAbort, { once: true });
	drain.then(
		() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		},
		(err: unknown) => {
			signal.removeEventListener("abort", onAbort);
			reject(err);
		},
	);
	await promise;
}

/**
 * Kill a client whose write queue is stuck (an aborted drain left a sink
 * operation pending, so subsequent writes queue behind the wedge forever).
 * Remove it from `clients` immediately so concurrent `getOrCreateClient`
 * callers do not grab the corpse before `proc.exited` cleans up.
 */
function teardownWedgedClient(client: LspClient): void {
	unpublishClient(client.name, client);
	try {
		client.proc.kill();
	} catch {
		// process already gone or unkillable — the exit handler will finish cleanup.
	}
}

function queueWriteMessage(
	client: LspClient,
	message: LspJsonRpcRequest | LspJsonRpcNotification | LspJsonRpcResponse,
	signal?: AbortSignal,
): Promise<void> {
	const write = client.writeQueue.catch(() => {}).then(() => writeMessage(client.proc.stdin, message, signal));
	const result = write.catch((err: unknown) => {
		if (err instanceof LspDrainAbortError) {
			// Only an abort that raced this write's in-flight drain leaves
			// the sink pending. Pre-write aborts and queued caller timeouts
			// must not kill a healthy shared client.
			teardownWedgedClient(client);
			throw err.reason;
		}
		throw err;
	});
	client.writeQueue = result.catch(() => {});
	return result;
}

// =============================================================================
// Message Reader
// =============================================================================

/**
 * Start background message reader for a client.
 * Routes responses to pending requests and handles notifications.
 */
async function startMessageReader(client: LspClient): Promise<void> {
	if (client.isReading) return;
	client.isReading = true;

	const reader = (client.proc.stdout as ReadableStream<Uint8Array>).getReader();

	const framer = new MessageFramer(Buffer.from(client.messageBuffer));

	let readerFailed = false;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;

			framer.push(Buffer.from(value));

			// Drain every complete message currently buffered.
			for (const messageText of framer.drain(headerText => {
				// Non-protocol bytes on stdout (e.g. a wrapper script printing).
				// Drop past the bogus terminator and resync instead of stalling
				// on the same junk header forever.
				logger.warn("LSP framing resync: header block without Content-Length", {
					server: client.name,
					header: headerText.slice(0, 200),
				});
			})) {
				// A malformed message or a throwing server-request handler must not
				// kill the reader — later messages are still well-framed.
				try {
					const message: LspJsonRpcResponse | LspJsonRpcNotification = JSON.parse(messageText);

					// Route message. A JSON-RPC message carrying a `method` is always
					// server-originated: a request when it also has an `id`, a
					// notification otherwise. A message with only an `id` is a response
					// to one of our requests. Disambiguate on `method` FIRST: a
					// server's request ids live in its own id space and routinely
					// collide with our in-flight client request ids (e.g. a
					// basedpyright `workspace/configuration` pull arriving while a
					// `documentSymbol` request with the same id is pending). Matching
					// pending requests first would swallow that pull as a bogus
					// response -- dropping the config answer the server blocks on and
					// resolving our request with `undefined`, wedging the lazy
					// cold-start handshake (#3001).
					if ("method" in message) {
						if ("id" in message && message.id !== undefined) {
							// Server-initiated request: must be answered.
							await handleServerRequest(client, message as LspJsonRpcRequest);
						} else {
							// Server notification
							if (message.method === "textDocument/publishDiagnostics" && message.params) {
								const params = message.params as PublishDiagnosticsParams;
								client.diagnostics.set(params.uri, {
									diagnostics: params.diagnostics,
									version: params.version ?? null,
								});
								client.diagnosticsVersion += 1;
							} else if (message.method === "$/progress" && message.params) {
								const params = message.params as { token: string | number; value?: { kind?: string } };
								if (params.value?.kind === "begin") {
									client.activeProgressTokens.add(params.token);
								} else if (params.value?.kind === "end") {
									client.activeProgressTokens.delete(params.token);
									if (client.activeProgressTokens.size === 0) {
										client.resolveProjectLoaded();
									}
								}
							}
						}
					} else if ("id" in message && message.id !== undefined) {
						// Response to one of our requests.
						const pending = client.pendingRequests.get(message.id);
						if (pending) {
							client.pendingRequests.delete(message.id);
							if ("error" in message && message.error) {
								// Include the JSON-RPC error code: `isMethodNotFoundError` matches
								// `-32601` by substring, so method-not-found is recognized even when
								// the server's message text is nonstandard (e.g. "Unknown request").
								const code = message.error.code;
								pending.reject(
									new Error(
										`LSP error${typeof code === "number" ? ` ${code}` : ""}: ${message.error.message}`,
									),
								);
							} else {
								pending.resolve(message.result);
							}
						}
					}
				} catch (err) {
					logger.warn("LSP message handling failed", {
						server: client.name,
						error: err instanceof Error ? err.message : String(err),
					});
				}
			}
		}
	} catch (err) {
		readerFailed = true;
		// Connection closed or error - reject all pending requests
		for (const pending of Array.from(client.pendingRequests.values())) {
			pending.reject(new Error(`LSP connection closed: ${err}`));
		}
		client.pendingRequests.clear();
	} finally {
		// Persist any unparsed remainder so a restarted reader resumes mid-message.
		client.messageBuffer = framer.remainder();
		reader.releaseLock();
		client.isReading = false;
		if (!readerFailed && client.proc.exitCode === null) {
			await waitForExit(client, READER_EXIT_GRACE_MS);
		}
		// Reader exited while the server process is still alive (unrecoverable
		// read error or bad stream state): nothing will route responses anymore,
		// so tear the client down — the next call respawns instead of timing out.
		if (client.proc.exitCode === null) {
			client.status = "error";
			unpublishClient(client.name, client);
			const teardownErr = new Error("LSP reader stopped; client torn down");
			for (const pending of client.pendingRequests.values()) {
				pending.reject(teardownErr);
			}
			client.pendingRequests.clear();
			client.resolveProjectLoaded();
			client.proc.kill();
		}
	}
}

/**
 * Build the workspace folder list advertised to the server. Identical shape
 * for `initialize` params and `workspace/workspaceFolders` server requests.
 */
function currentWorkspaceFolders(client: LspClient): Array<{ uri: string; name: string }> {
	return [{ uri: fileToUri(client.cwd, client.cwd), name: path.basename(client.cwd) || "workspace" }];
}

/**
 * Handle workspace/workspaceFolders requests from the server.
 */
async function handleWorkspaceFoldersRequest(client: LspClient, message: LspJsonRpcRequest): Promise<void> {
	await sendResponse(client, message.id, currentWorkspaceFolders(client), "workspace/workspaceFolders");
}

/**
 * Handle workspace/configuration requests from the server.
 */
async function handleConfigurationRequest(client: LspClient, message: LspJsonRpcRequest): Promise<void> {
	const params = message.params as { items?: Array<{ section?: string }> };
	const items = params?.items ?? [];
	const result = items.map(item => {
		const section = item.section ?? "";
		return client.config.settings?.[section] ?? null;
	});
	await sendResponse(client, message.id, result, "workspace/configuration");
}

/**
 * Handle workspace/applyEdit requests from the server.
 */
async function handleApplyEditRequest(client: LspClient, message: LspJsonRpcRequest): Promise<void> {
	const params = message.params as { edit?: WorkspaceEdit };
	if (!params?.edit) {
		await sendResponse(
			client,
			message.id,
			{ applied: false, failureReason: "No edit provided" },
			"workspace/applyEdit",
		);
		return;
	}
	try {
		const result = await applyAndReconcileWorkspaceEdit(params.edit, client.cwd);
		if (result.error && !result.committed) {
			await sendResponse(
				client,
				message.id,
				{ applied: false, failureReason: String(result.error) },
				"workspace/applyEdit",
			);
		} else {
			await sendResponse(client, message.id, { applied: true }, "workspace/applyEdit");
		}
		// Retirement sends `shutdown` and waits for the reply. That reply can only
		// be read after this handler returns to `startMessageReader()`, so do not
		// await teardown here.
		void releaseExecutedMovedDirectoryRoots(
			result.executed,
			result.capturedMovedRoots,
			result.cwd,
			undefined,
			result.deferredOverwriteDestinationClients,
		);
	} catch (err) {
		await sendResponse(client, message.id, { applied: false, failureReason: String(err) }, "workspace/applyEdit");
	}
}

function workspaceEditChanges(executed: ExecutedWorkspaceChange[]): {
	finalUris: Set<string>;
	deletedRoots: Set<string>;
	watchedFiles: WatchedFileChange[];
} {
	const finalUris = new Set<string>();
	const deletedRoots = new Set<string>();
	const watchedFiles: WatchedFileChange[] = [];
	const watch = (uri: string, type: FileChangeType) => {
		watchedFiles.push({ filePath: uriToFile(uri), type });
	};

	for (const change of executed) {
		if (change.kind === "edit") {
			finalUris.add(change.uri);
			watch(change.uri, FileChangeType.Changed);
		} else if (change.kind === "create") {
			finalUris.add(change.uri);
			watch(change.uri, FileChangeType.Created);
		} else if (change.kind === "rename") {
			deletedRoots.add(change.oldUri);
			finalUris.add(change.newUri);
			watch(change.oldUri, FileChangeType.Deleted);
			watch(change.newUri, FileChangeType.Created);
		} else {
			deletedRoots.add(change.uri);
			watch(change.uri, FileChangeType.Deleted);
		}
	}

	return { finalUris, deletedRoots, watchedFiles };
}

function uriIsWithin(uri: string, root: string): boolean {
	return uri === root || uri.startsWith(root.endsWith("/") ? root : `${root}/`);
}

/** Open overlay URIs for an edit URI, including every equivalent symlink alias. */
function openDocumentUrisForChange(client: LspClient, uri: string): string[] {
	const matches: string[] = [];
	const seen = new Set<string>();
	const add = (candidate: string | undefined) => {
		if (!candidate || seen.has(candidate) || !client.openFiles.has(candidate)) return;
		seen.add(candidate);
		matches.push(candidate);
	};
	add(uri);
	add(fileToUri(uriToFile(uri), client.cwd));
	for (const openUri of client.openFiles.keys()) {
		if (equivalentDocumentUri(openUri, uri)) add(openUri);
	}
	return matches;
}

function openDocumentMatchesDeletedRoot(uri: string, deletedRoot: string): boolean {
	if (uriIsWithin(uri, deletedRoot)) return true;
	return workspaceContainsPath(uriToFile(deletedRoot), uriToFile(uri));
}

type CapturedMovedDirectoryRoot = {
	root: string;
	identity: string;
	leafSymlink: boolean;
	overwriteDestination?: boolean;
};

/** Directory roots a workspace edit may move or delete, captured before apply. */
async function captureDirectoryRoot(
	uri: string,
	captured: Array<CapturedMovedDirectoryRoot>,
	seen: Set<string>,
	overwriteDestination = false,
): Promise<void> {
	const root = path.resolve(uriToFile(uri));
	if (seen.has(root)) {
		if (overwriteDestination) {
			const existing = captured.find(item => item.root === root);
			if (existing) existing.overwriteDestination = true;
		}
		return;
	}
	try {
		const st = await fs.lstat(root);
		const leafSymlink = st.isSymbolicLink();
		const isDirectory = st.isDirectory() || (leafSymlink && (await fs.stat(root)).isDirectory());
		if (!isDirectory) return;
		seen.add(root);
		captured.push({ root, identity: resolveEquivalentPath(root), leafSymlink, overwriteDestination });
	} catch {
		// Missing paths are not live project roots.
	}
}

async function captureMovedDirectoryRoots(edit: WorkspaceEdit): Promise<CapturedMovedDirectoryRoot[]> {
	const captured: CapturedMovedDirectoryRoot[] = [];
	const seen = new Set<string>();
	for (const change of edit.documentChanges ?? []) {
		if (!("kind" in change)) continue;
		if (change.kind === "rename") {
			await captureDirectoryRoot(change.oldUri, captured, seen);
			// overwrite:true displaces and deletes the destination inode
			// before the source moves onto that path.
			if (change.options?.overwrite) {
				await captureDirectoryRoot(change.newUri, captured, seen, true);
			}
			continue;
		}
		if (change.kind === "delete") {
			await captureDirectoryRoot(change.uri, captured, seen);
		}
	}
	return captured;
}

function executedMovedDirectoryRoots(
	executed: ExecutedWorkspaceChange[],
	captured: ReadonlyArray<CapturedMovedDirectoryRoot>,
): CapturedMovedDirectoryRoot[] {
	if (captured.length === 0 || executed.length === 0) return [];
	const executedPaths = new Set<string>();
	for (const change of executed) {
		if (change.kind === "rename") {
			executedPaths.add(path.resolve(uriToFile(change.oldUri)));
			executedPaths.add(path.resolve(uriToFile(change.newUri)));
		} else if (change.kind === "delete") executedPaths.add(path.resolve(uriToFile(change.uri)));
	}
	return captured.filter(item => executedPaths.has(path.resolve(item.root)));
}

function overwriteDestinationMatchesEntry(
	item: CapturedMovedDirectoryRoot,
	key: string,
	entry: { cwd: string; config: ServerConfig },
): boolean {
	const cwds = clientWorkspaceCwds(key, entry);
	const lexical = path.resolve(item.root);
	if (item.leafSymlink) return cwds.some(cwd => isLexicallyWithin(lexical, cwd));
	const roots = [lexical];
	const equivalent = path.resolve(item.identity);
	if (!roots.includes(equivalent)) roots.push(equivalent);
	return roots.some(root => cwds.some(cwd => workspaceContainsPath(root, cwd)));
}

/** Drop owner routes spelled under an overwritten destination symlink.
 *  Returns true when no owner still reaches the identity, so the displaced
 *  alias process can be unpublished without touching a physical-target session. */
function pruneOverwriteDestinationAliasOwners(item: CapturedMovedDirectoryRoot, key: string): boolean {
	const lexical = path.resolve(item.root);
	const owners = new Set<LspClientOwner>([
		...Array.from(clientOwners.get(key) ?? []),
		...Array.from(clientLocks.get(key)?.owners ?? []),
	]);
	for (const owner of owners) {
		const routes = ownerClientRoots.get(owner)?.get(key);
		if (!routes) continue;
		for (const route of Array.from(routes)) {
			if (!isLexicallyWithin(lexical, route)) continue;
			routes.delete(route);
		}
		if (routes.size === 0) {
			releaseClientOwnerKey(key, owner);
			clientLocks.get(key)?.owners.delete(owner);
		}
	}
	return !clientOwners.has(key) && (clientLocks.get(key)?.owners.size ?? 0) === 0;
}

const OVERWRITE_DESTINATION_WAIT_MS = 2_000;

/** Unpublish overwritten destination clients so another session cannot reuse
 *  the displaced process, but keep the instance alive until the originating
 *  applyEdit / code-action command finishes. Pending initializers at that
 *  destination are tombstoned immediately so they cannot publish during
 *  overlay reconciliation. Overwriting a directory symlink only retires
 *  alias routes; a session using the unchanged physical target keeps the process. */
async function unpublishExecutedOverwriteDestinationClients(
	executed: ExecutedWorkspaceChange[],
	captured: ReadonlyArray<CapturedMovedDirectoryRoot>,
): Promise<LspClient[]> {
	const deferred: LspClient[] = [];
	const seen = new Set<LspClient>();
	const pending = new Map<string, PendingClient>();
	for (const item of executedMovedDirectoryRoots(executed, captured)) {
		if (!item.overwriteDestination) continue;
		if (captured.some(other => other !== item && !other.overwriteDestination && other.identity === item.identity)) {
			continue;
		}
		for (const [key, lock] of clientLocks) {
			if (!overwriteDestinationMatchesEntry(item, key, lock)) continue;
			if (item.leafSymlink && !pruneOverwriteDestinationAliasOwners(item, key)) continue;
			invalidatedClientKeys.add(key);
			pending.set(key, lock);
			clientLocks.delete(key);
		}
		for (const [key, client] of clients) {
			if (seen.has(client)) continue;
			if (!overwriteDestinationMatchesEntry(item, key, client)) continue;
			if (item.leafSymlink && !pruneOverwriteDestinationAliasOwners(item, key)) continue;
			if (!unpublishClient(key, client)) continue;
			seen.add(client);
			deferred.push(client);
		}
	}
	for (const [key, lock] of pending) {
		const tracked = lock.promise.finally(() => {
			invalidatedClientKeys.delete(key);
		});
		try {
			await untilAborted(AbortSignal.timeout(OVERWRITE_DESTINATION_WAIT_MS), tracked);
		} catch {
			// Init may fail or exceed the independent cleanup budget. Still
			// unpublish if it published; never inherit the caller's expired
			// tool signal or skip later moved-root retirement. The tombstone
			// stays until this initializer settles so a late publish still
			// throws superseded, then drops so a replacement can start.
		}
		const started = clients.get(key);
		if (!started || seen.has(started)) continue;
		if (!unpublishClient(key, started)) continue;
		seen.add(started);
		deferred.push(started);
	}
	return deferred;
}

export async function releaseExecutedMovedDirectoryRoots(
	executed: ExecutedWorkspaceChange[],
	captured: ReadonlyArray<CapturedMovedDirectoryRoot>,
	sessionCwd: string,
	signal?: AbortSignal,
	deferredOverwriteDestinationClients: readonly LspClient[] = [],
): Promise<void> {
	for (const item of executedMovedDirectoryRoots(executed, captured)) {
		if (item.overwriteDestination) continue;
		try {
			await releaseMovedWorkspaceRoots(sessionCwd, item.root, undefined, signal, item.identity, item.leafSymlink);
		} catch (error) {
			logger.warn("Failed to stop language servers for a renamed project root", {
				movedRoot: item.root,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	for (const client of deferredOverwriteDestinationClients) {
		try {
			await shutdownClientInstance(client);
		} catch (error) {
			logger.warn("Failed to stop language servers for an overwritten project root", {
				movedRoot: client.cwd,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
}

/** Reconcile open overlays and file watchers with the ops a workspace edit actually performed. */
export async function reconcileExecutedChanges(
	executed: ExecutedWorkspaceChange[],
	workspace: string | readonly string[],
	signal?: AbortSignal,
	deferredClients: readonly LspClient[] = [],
): Promise<void> {
	if (executed.length === 0) return;
	const { finalUris, deletedRoots, watchedFiles } = workspaceEditChanges(executed);
	const workspaceRoots = (typeof workspace === "string" ? [workspace] : workspace).map(root => path.resolve(root));
	const seenClients = new Set<LspClient>();
	const candidateClients: LspClient[] = [];
	for (const client of [...clients.values(), ...deferredClients]) {
		if (seenClients.has(client)) continue;
		seenClients.add(client);
		candidateClients.push(client);
	}
	const activeClients = candidateClients.filter(client => {
		if (client.status !== "ready") return false;
		if (workspaceRoots.some(root => clientIsInsideWorkspace(client.name, client, root))) return true;
		if (
			watchedFiles.some(change =>
				clientWorkspaceCwds(client.name, client).some(cwd => workspaceContainsPath(cwd, change.filePath)),
			)
		) {
			return true;
		}
		if (Array.from(finalUris).some(uri => openDocumentUrisForChange(client, uri).length > 0)) return true;
		for (const uri of client.openFiles.keys()) {
			for (const root of deletedRoots) {
				if (openDocumentMatchesDeletedRoot(uri, root)) return true;
			}
		}
		return false;
	});

	for (const activeClient of activeClients) {
		for (const uri of Array.from(activeClient.openFiles.keys())) {
			let deleted = false;
			for (const root of deletedRoots) {
				if (openDocumentMatchesDeletedRoot(uri, root)) {
					deleted = true;
					break;
				}
			}
			if (!deleted) {
				try {
					await fs.stat(uriToFile(uri));
				} catch (err) {
					if (isEnoent(err)) deleted = true;
				}
			}
			if (!deleted) continue;
			await sendNotification(activeClient, "textDocument/didClose", { textDocument: { uri } }, signal);
			activeClient.openFiles.delete(uri);
			activeClient.diagnostics.delete(uri);
		}
		for (const uri of finalUris) {
			for (const openUri of openDocumentUrisForChange(activeClient, uri)) {
				await refreshOpenDocument(activeClient, openUri, signal);
			}
		}
	}
	const notifyRoots = Array.from(
		new Set([...workspaceRoots, ...activeClients.flatMap(client => clientWorkspaceCwds(client.name, client))]),
	);
	await notifyWorkspaceWatchedFiles(notifyRoots, watchedFiles, signal, deferredClients);
}

/**
 * Apply a server-provided workspace edit and reconcile every affected open LSP document.
 * Runtime callers use this wrapper so later semantic requests observe the committed files.
 * Reconciliation is derived from the ops that actually ran — an op skipped via
 * `ignoreIfExists`/`ignoreIfNotExists` neither closes overlays nor notifies watchers, and
 * when the edit fails partway the already-executed prefix is still reconciled before the
 * error propagates so mutated files never keep stale overlays.
 *
 * `workspace` is the session cwd or the full session workspace-root list. Relative edit
 * paths resolve against the first root. Overlay and watcher reconciliation covers every
 * ready client inside those roots, plus any ready client that owns an overlay or watched
 * path the edit actually touched, so a nested `workspace/applyEdit` still refreshes
 * sibling and session-root clients. Directory rename/delete ops then retire nested
 * clients whose routed root vanished, matching `rename_file`. Overwrite
 * destinations are unpublished after a committed apply and before overlay
 * reconciliation, so another session cannot reuse the displaced-root process,
 * while the originating client stays alive through a follow-up command or
 * applyEdit response. Overlay reconciliation failures after a successful apply
 * still return the executed prefix so remaining moved-root retirement can run.
 */
export async function applyWorkspaceEditWithLsp(
	edit: WorkspaceEdit,
	workspace: string | readonly string[],
	signal?: AbortSignal,
): Promise<string[]> {
	const { applied, executed, capturedMovedRoots, cwd, error, deferredOverwriteDestinationClients } =
		await applyAndReconcileWorkspaceEdit(edit, workspace, signal);
	await releaseExecutedMovedDirectoryRoots(
		executed,
		capturedMovedRoots,
		cwd,
		undefined,
		deferredOverwriteDestinationClients,
	);
	if (error) throw error;
	return applied;
}

export async function applyAndReconcileWorkspaceEdit(
	edit: WorkspaceEdit,
	workspace: string | readonly string[],
	signal?: AbortSignal,
): Promise<{
	applied: string[];
	executed: ExecutedWorkspaceChange[];
	capturedMovedRoots: CapturedMovedDirectoryRoot[];
	cwd: string;
	deferredOverwriteDestinationClients: LspClient[];
	committed: boolean;
	error?: unknown;
}> {
	const workspaceRoots = (typeof workspace === "string" ? [workspace] : workspace).map(root => path.resolve(root));
	const cwd = workspaceRoots[0] ?? path.resolve(".");
	const capturedMovedRoots = await captureMovedDirectoryRoots(edit);
	const executed: ExecutedWorkspaceChange[] = [];
	let applied: string[] = [];
	try {
		({ applied } = await applyWorkspaceEdit(edit, cwd, change => executed.push(change)));
	} catch (err) {
		// Best-effort: overlays for the mutated prefix must not stay stale, but
		// reconciliation problems must not mask the original apply failure.
		const deferredOverwriteDestinationClients = await unpublishExecutedOverwriteDestinationClients(
			executed,
			capturedMovedRoots,
		);
		try {
			await reconcileExecutedChanges(executed, workspaceRoots, signal, deferredOverwriteDestinationClients);
		} catch (reconcileErr) {
			logger.warn("LSP overlay reconciliation after failed workspace edit failed", {
				error: reconcileErr instanceof Error ? reconcileErr.message : String(reconcileErr),
			});
		}
		return {
			applied,
			executed,
			capturedMovedRoots,
			cwd,
			committed: false,
			deferredOverwriteDestinationClients,
			error: err,
		};
	}
	const deferredOverwriteDestinationClients = await unpublishExecutedOverwriteDestinationClients(
		executed,
		capturedMovedRoots,
	);
	try {
		await reconcileExecutedChanges(executed, workspaceRoots, signal, deferredOverwriteDestinationClients);
	} catch (reconcileErr) {
		logger.warn("LSP overlay reconciliation after workspace edit failed", {
			error: reconcileErr instanceof Error ? reconcileErr.message : String(reconcileErr),
		});
		return {
			applied,
			executed,
			capturedMovedRoots,
			cwd,
			committed: true,
			deferredOverwriteDestinationClients,
			error: reconcileErr,
		};
	}
	return { applied, executed, capturedMovedRoots, cwd, committed: true, deferredOverwriteDestinationClients };
}

interface DynamicCapabilityRegistration {
	id?: unknown;
	method?: unknown;
}

interface DynamicCapabilityParams {
	registrations?: DynamicCapabilityRegistration[];
	unregisterations?: DynamicCapabilityRegistration[];
	unregistrations?: DynamicCapabilityRegistration[];
}

function updateDynamicCapabilities(client: LspClient, message: LspJsonRpcRequest): void {
	const params = message.params as DynamicCapabilityParams;
	if (message.method === "client/registerCapability") {
		if (!Array.isArray(params.registrations)) return;
		let registrations = client.dynamicCapabilityRegistrations;
		if (!registrations) {
			registrations = new Map();
			client.dynamicCapabilityRegistrations = registrations;
		}
		for (const registration of params.registrations) {
			if (typeof registration.id === "string" && typeof registration.method === "string") {
				registrations.set(registration.id, registration.method);
			}
		}
		return;
	}

	const registrations = client.dynamicCapabilityRegistrations;
	if (!registrations) return;
	const unregistrations = params.unregisterations ?? params.unregistrations;
	if (!Array.isArray(unregistrations)) return;
	for (const registration of unregistrations) {
		if (typeof registration.id === "string") {
			registrations.delete(registration.id);
		}
	}
}

/** Whether the server advertised LSP 3.17 document diagnostic pulls statically or through registration. */
export function supportsDocumentDiagnostics(client: LspClient): boolean {
	const staticProvider = client.serverCapabilities?.diagnosticProvider;
	if (staticProvider) return true;

	const registrations = client.dynamicCapabilityRegistrations;
	if (!registrations) return false;
	for (const method of registrations.values()) {
		if (method === "textDocument/diagnostic") return true;
	}
	return false;
}

/**
 * Respond to a server-initiated request.
 */
async function handleServerRequest(client: LspClient, message: LspJsonRpcRequest): Promise<void> {
	if (message.method === "workspace/configuration") {
		await handleConfigurationRequest(client, message);
		return;
	}
	if (message.method === "workspace/workspaceFolders") {
		await handleWorkspaceFoldersRequest(client, message);
		return;
	}
	if (message.method === "workspace/applyEdit") {
		await handleApplyEditRequest(client, message);
		return;
	}
	if (message.method === "window/workDoneProgress/create") {
		// Accept progress token registration from the server.
		await sendResponse(client, message.id, null, message.method);
		return;
	}
	if (message.method === "client/registerCapability" || message.method === "client/unregisterCapability") {
		updateDynamicCapabilities(client, message);
		// Some servers block semantic requests until dynamic registration succeeds.
		await sendResponse(client, message.id, null, message.method);
		return;
	}
	if (message.method === "window/showMessageRequest") {
		// Headless: no UI to surface the prompt. Spec says null = "no action selected".
		await sendResponse(client, message.id, null, message.method);
		return;
	}
	if (message.method === "window/showDocument") {
		// Headless: nothing to display. Spec result is `{ success: boolean }`.
		await sendResponse(client, message.id, { success: false }, message.method);
		return;
	}
	if (
		message.method === "workspace/semanticTokens/refresh" ||
		message.method === "workspace/inlayHint/refresh" ||
		message.method === "workspace/codeLens/refresh" ||
		message.method === "workspace/codeAction/refresh" ||
		message.method === "workspace/inlineValue/refresh" ||
		message.method === "workspace/foldingRange/refresh" ||
		message.method === "workspace/diagnostic/refresh"
	) {
		// Void acknowledgement per spec; servers that stall waiting for a reply
		// (same failure mode as the dynamic-registration hang in #3029) move on.
		await sendResponse(client, message.id, null, message.method);
		return;
	}
	await sendResponse(client, message.id, null, message.method, {
		code: -32601,
		message: `Method not found: ${message.method}`,
	});
}

/**
 * Send an LSP response to the server.
 */
async function sendResponse(
	client: LspClient,
	id: LspJsonRpcId,
	result: unknown,
	method: string,
	error?: { code: number; message: string; data?: unknown },
): Promise<void> {
	const response: LspJsonRpcResponse = {
		jsonrpc: "2.0",
		id,
		...(error ? { error } : { result }),
	};

	try {
		await queueWriteMessage(client, response);
	} catch (err) {
		logger.error("LSP failed to respond.", { method, error: String(err) });
	}
}

// =============================================================================
// Client Management
// =============================================================================

/** Timeout for warmup initialize requests (5 seconds) */
export const WARMUP_TIMEOUT_MS = 5000;

/** Max time to poll rust-analyzer after progress ends but before Cargo workspaces are ready. */
const RUST_ANALYZER_WORKSPACE_READY_TIMEOUT_MS = 5_000;
const RUST_ANALYZER_WORKSPACE_READY_POLL_MS = 100;
const RUST_ANALYZER_WORKSPACE_READY_SETTLE_MS = 2_000;
const RUST_ANALYZER_STATUS_REQUEST_TIMEOUT_MS = 1_000;
const rustAnalyzerReadyClients = new WeakSet<LspClient>();

function commandBasename(command: string): string {
	const slash = command.lastIndexOf("/");
	const backslash = command.lastIndexOf("\\");
	const separator = Math.max(slash, backslash);
	return separator === -1 ? command : command.slice(separator + 1);
}

/**
 * True when this client speaks the rust-analyzer protocol, detected by the
 * command basename (`rust-analyzer[.exe]`) of the configured or resolved
 * binary. Callers use it to gate rust-analyzer-only requests such as
 * `rust-analyzer/reloadWorkspace` (see {@link reloadServer}).
 */
export function isRustAnalyzerClient(client: LspClient): boolean {
	return (
		commandBasename(client.config.command) === "rust-analyzer" ||
		(client.config.resolvedCommand ? commandBasename(client.config.resolvedCommand) === "rust-analyzer" : false)
	);
}

function isRustAnalyzerStatusTimeout(err: unknown): boolean {
	return err instanceof Error && err.message.startsWith("LSP request rust-analyzer/analyzerStatus timed out after ");
}

async function waitForRustAnalyzerWorkspace(client: LspClient, signal?: AbortSignal): Promise<void> {
	if (rustAnalyzerReadyClients.has(client)) {
		return;
	}
	const timings = client.config.workspaceReadyTimings;
	const timeoutMs = timings?.timeoutMs ?? RUST_ANALYZER_WORKSPACE_READY_TIMEOUT_MS;
	const pollMs = timings?.pollMs ?? RUST_ANALYZER_WORKSPACE_READY_POLL_MS;
	const settleMs = timings?.settleMs ?? RUST_ANALYZER_WORKSPACE_READY_SETTLE_MS;
	const statusRequestTimeoutMs = timings?.statusRequestTimeoutMs ?? RUST_ANALYZER_STATUS_REQUEST_TIMEOUT_MS;
	const started = Date.now();
	const deadline = started + timeoutMs;
	while (true) {
		throwIfAborted(signal);
		let status: unknown;
		try {
			status = await sendRequest(client, "rust-analyzer/analyzerStatus", {}, signal, statusRequestTimeoutMs);
		} catch (err) {
			if (!isRustAnalyzerStatusTimeout(err) || Date.now() >= deadline) {
				return;
			}
			await Bun.sleep(pollMs);
			continue;
		}
		const ready = typeof status === "string" && !status.startsWith("No workspaces");
		if (ready && Date.now() - started >= settleMs) {
			rustAnalyzerReadyClients.add(client);
			return;
		}
		if (Date.now() >= deadline) {
			return;
		}
		await Bun.sleep(pollMs);
	}
}

const PROJECT_LOAD_TIMEOUT_MS = 15_000;

/** Max time to wait for graceful LSP shutdown and process exit. */
const SHUTDOWN_TIMEOUT_MS = 5_000;
const EXIT_TIMEOUT_MS = 1_000;

/**
 * Identity of a server process *and* its initialization: everything that makes
 * two configs unsafe to share one client. `command` + `cwd` alone handed a
 * config with different args/settings the client another config had spawned
 * (#8382), and left a changed config resolving to the stale client after
 * `reload *` (#8384). The command component mirrors the spawn site
 * (`resolvedCommand ?? command`), so two configs naming the same binary
 * differently still share, while the same name resolving to different binaries
 * does not. JSON-encoded so no value can forge the separator.
 *
 * Path-like executables are canonicalized: a nested `.venv/bin/server` reached
 * through a symlink workspace must not mint a second client beside the same
 * physical binary addressed by its real path. Bare PATH names stay as names.
 */
export function canonicalSpawnCommand(config: Pick<ServerConfig, "command" | "resolvedCommand">): string {
	const spawnCommand = config.resolvedCommand ?? config.command;
	return spawnCommand.includes("/") || spawnCommand.includes("\\") || path.isAbsolute(spawnCommand)
		? resolveEquivalentPath(spawnCommand)
		: spawnCommand;
}

/** Workspace membership paths for a live or pending client, including per-owner aliases. */
function clientWorkspaceCwds(
	key: string,
	entry: { cwd: string; config: ServerConfig },
	owner?: LspClientOwner,
): string[] {
	const roots = new Set<string>([path.resolve(entry.config.resolvedRoot ?? entry.cwd)]);
	const owners = owner ? [owner] : Array.from(clientOwners.get(key) ?? []);
	for (const item of owners) {
		for (const root of ownerClientRoots.get(item)?.get(key) ?? []) roots.add(root);
	}
	return Array.from(roots);
}

function clientIsInsideWorkspace(
	key: string,
	entry: { cwd: string; config: ServerConfig },
	workspace: string,
	owner?: LspClientOwner,
): boolean {
	return clientWorkspaceCwds(key, entry, owner).some(cwd => workspaceContainsPath(workspace, cwd));
}

function clientKey(config: ServerConfig, cwd: string): string {
	const identity = stableStringifyJson([
		config.args ?? [],
		config.initOptions ?? null,
		config.settings ?? null,
		config.languageId ?? null,
	]);
	return `${canonicalSpawnCommand(config)}:${resolveEquivalentPath(cwd)}:${identity}`;
}

/**
 * `clientKey()` omits routing-only fields such as `fileTypes` and the raw
 * `command` spelling so a process is reused when only those change. Store them
 * per owner so overlapping sessions with different catalogs keep their own
 * status matching, and copy onto the live client only when no sibling owner
 * already published routing metadata.
 */
function refreshReusableClientRouting(
	key: string,
	entry: { config: ServerConfig },
	config: ServerConfig,
	owner?: LspClientOwner,
): void {
	if (owner) setOwnerClientRouting(owner, key, { command: config.command, fileTypes: config.fileTypes });
	const siblings = clientOwners.get(key);
	if (owner && siblings && Array.from(siblings).some(item => item !== owner)) {
		return;
	}
	entry.config.fileTypes = config.fileTypes;
	entry.config.command = config.command;
	if (config.resolvedCommand !== undefined) {
		entry.config.resolvedCommand = config.resolvedCommand;
	}
}

function clientServerRootKey(config: ServerConfig, cwd: string): string {
	return `${canonicalSpawnCommand(config)}:${resolveEquivalentPath(cwd)}`;
}

/**
 * Shut down clients in `workspaceRoots` whose identity is absent from `configs`,
 * and return the server commands torn down.
 *
 * `reload *` re-reads config from disk. Identity-aware keys make a changed
 * server resolve to a fresh client, but the process spawned from the old
 * config would stay registered and running — the idle checker that would
 * eventually reap it is opt-in and off by default. Nested clients discovered
 * lazily are part of the session lifecycle even though they are absent from
 * cwd-only startup discovery, so workspace reload tears them down too.
 */
export function shutdownStaleClients(
	cwd: string,
	configs: readonly ServerConfig[],
	signal?: AbortSignal,
	workspaceRoots: readonly string[] = [cwd],
	owner?: LspClientOwner,
	retainClient?: (clientCwd: string) => boolean,
	contains: (root: string, cwd: string) => boolean = workspaceContainsPath,
): Promise<string[]> {
	const fresh = new Set(configs.map(config => clientKey(config, config.resolvedRoot ?? cwd)));
	const roots = workspaceRoots.map(root => path.resolve(root));
	const isRelevant = (key: string, entry: { cwd: string; config: ServerConfig }) => {
		const cwds = clientWorkspaceCwds(key, entry, owner);
		return (
			roots.some(root => cwds.some(clientCwd => contains(root, clientCwd))) &&
			!cwds.some(clientCwd => retainClient?.(clientCwd))
		);
	};
	const collectRelevantEntries = () => {
		const nextPending = Array.from(clientLocks.entries()).filter(([key, pending]) => {
			const owners = clientOwners.get(key);
			return (!owner || !owners || owners.has(owner)) && isRelevant(key, pending);
		});
		const nextClients = Array.from(clients.entries()).filter(([key, client]) => {
			const owners = clientOwners.get(key);
			return (!owner || !owners || owners.has(owner)) && isRelevant(key, client);
		});
		return { relevantPending: nextPending, relevantClients: nextClients };
	};
	let { relevantPending, relevantClients } = collectRelevantEntries();
	const refreshFreshRouting = (key: string, entry: { cwd: string; config: ServerConfig }): void => {
		if (!fresh.has(key)) return;
		const match = configs.find(definition => clientKey(definition, definition.resolvedRoot ?? cwd) === key);
		if (match) refreshReusableClientRouting(key, entry, match, owner);
	};
	for (const [key, pending] of relevantPending) refreshFreshRouting(key, pending);
	for (const [key, client] of relevantClients) refreshFreshRouting(key, client);
	const staleOwnedKeys = new Set([
		...relevantPending.filter(([key]) => !fresh.has(key)).map(([key]) => key),
		...relevantClients.filter(([key]) => !fresh.has(key)).map(([key]) => key),
	]);
	const releasedOwnerRoots = new Map<string, string[]>();
	const previousReleasedGenerations = new Map<string, number | undefined>();
	const previousCoveredRootGenerations = new Map<string, number | undefined>();
	const previousConfigStamps = new Map<ServerConfig, number | undefined>();
	let previousOwnerGeneration: number | undefined;
	let thisReloadGeneration: number | undefined;
	if (owner) {
		for (const key of staleOwnedKeys) {
			releasedOwnerRoots.set(key, Array.from(ownerClientRoots.get(owner)?.get(key) ?? []));
		}
		// `/remove-dir` passes `retainClient` for leftover workspace coverage.
		// Advancing unused-identity generations there would reject captured
		// configs still inside a remaining root. `reload *` and moved-root
		// teardown omit that callback, so unused nested identities captured
		// before reload cannot start after barriers drop.
		const invalidateUnusedIdentities = retainClient === undefined;
		if (invalidateUnusedIdentities || staleOwnedKeys.size > 0) {
			previousOwnerGeneration = ownerReloadGeneration.get(owner);
			const generation = (previousOwnerGeneration ?? 0) + 1;
			thisReloadGeneration = generation;
			ownerReloadGeneration.set(owner, generation);
			let released = ownerReleasedKeyGenerations.get(owner);
			if (!released) {
				released = new Map();
				ownerReleasedKeyGenerations.set(owner, released);
			}
			for (const key of staleOwnedKeys) {
				previousReleasedGenerations.set(key, released.get(key));
				released.set(key, generation);
			}
			const stamps = ownerConfigStamps(owner);
			for (const config of configs) {
				previousConfigStamps.set(config, stamps.get(config));
				stamps.set(config, generation);
			}
			if (invalidateUnusedIdentities) {
				let coveredRoots = ownerReloadRootGenerations.get(owner);
				if (!coveredRoots) {
					coveredRoots = new Map();
					ownerReloadRootGenerations.set(owner, coveredRoots);
				}
				for (const root of roots) {
					previousCoveredRootGenerations.set(root, coveredRoots.get(root));
					coveredRoots.set(root, generation);
				}
			}
		}
	}
	const unownedStaleKeys = owner
		? new Set(Array.from(staleOwnedKeys).filter(key => releaseClientOwnerKey(key, owner)))
		: staleOwnedKeys;
	const retainedOwnedKeys = owner
		? new Set(Array.from(staleOwnedKeys).filter(key => !unownedStaleKeys.has(key)))
		: new Set<string>();
	let stalePending = relevantPending.filter(([key]) => unownedStaleKeys.has(key));
	let staleClients = relevantClients.filter(([key]) => unownedStaleKeys.has(key));
	// Barrier the roots this cleanup actually covers while teardown is in
	// flight. `/remove-dir` passes the retained session cwd as `cwd` while
	// `workspaceRoots` is the removed directory; including `cwd` here would
	// block unrelated clients under the remaining workspace. After a mixed
	// failure, leftover barriers stay on command+cwd identities that did not
	// exit so a sibling server at the same root is not stuck behind that
	// teardown, while a replacement for the stuck command still waits.
	const barrierRoots = new Set([
		...roots,
		...stalePending.flatMap(([key, pending]) => clientWorkspaceCwds(key, pending, owner)),
		...staleClients.flatMap(([key, client]) => clientWorkspaceCwds(key, client, owner)),
	]);
	const leftoverKeys = new Set([
		...stalePending.map(([, pending]) => clientServerRootKey(pending.config, pending.cwd)),
		...staleClients.map(([, client]) => clientServerRootKey(client.config, client.cwd)),
	]);
	const previousBarriers: Promise<unknown>[] = [];
	const rememberPreviousBarrier = (barrier?: Promise<unknown>): void => {
		if (barrier && !previousBarriers.includes(barrier)) previousBarriers.push(barrier);
	};
	for (const root of barrierRoots) rememberPreviousBarrier(clientReloadBarriers.get(root));
	for (const leftoverKey of leftoverKeys) rememberPreviousBarrier(clientIdentityReloadBarriers.get(leftoverKey));
	const cleanupHolder: { promise?: Promise<string[]> } = {};
	const dropThisCleanupBarriers = (keepIdentityKeys?: ReadonlySet<string>): void => {
		const cleanupPromise = cleanupHolder.promise;
		for (const root of barrierRoots) {
			if (clientReloadBarriers.get(root) === cleanupPromise) clientReloadBarriers.delete(root);
		}
		for (const leftoverKey of leftoverKeys) {
			if (clientIdentityReloadBarriers.get(leftoverKey) !== cleanupPromise) continue;
			if (keepIdentityKeys?.has(leftoverKey)) continue;
			clientIdentityReloadBarriers.delete(leftoverKey);
		}
	};
	const cleanup = (async (): Promise<string[]> => {
		const restoreReleasedOwners = (): void => {
			if (!owner) return;
			for (const key of staleOwnedKeys) {
				if (clients.has(key) || clientLocks.has(key)) {
					registerClientOwner(key, owner, releasedOwnerRoots.get(key));
				}
			}
		};
		const clearTemporaryNestedTombstones = (entries: Iterable<[string, { cwd: string }]>): void => {
			const primaryCwd = path.resolve(cwd);
			for (const [key, entry] of entries) {
				if (path.resolve(entry.cwd) !== primaryCwd) invalidatedClientKeys.delete(key);
			}
		};
		try {
			for (const previousBarrier of previousBarriers) {
				try {
					await untilAborted(signal, previousBarrier);
				} catch {
					throwIfAborted(signal);
					// A later explicit reload retries teardown after an earlier one
					// failed; ordinary client creation remains blocked in between.
				}
			}
			// An earlier overlapping reload can restore this owner after this
			// cleanup snapshotted relevance. Re-evaluate before teardown so a
			// cancelled predecessor cannot leave us attached to a superseded
			// client while we start the replacement.
			if (owner) {
				({ relevantPending, relevantClients } = collectRelevantEntries());
				for (const key of [
					...relevantPending.filter(([ownedKey]) => !fresh.has(ownedKey)).map(([ownedKey]) => ownedKey),
					...relevantClients.filter(([ownedKey]) => !fresh.has(ownedKey)).map(([ownedKey]) => ownedKey),
				]) {
					if (staleOwnedKeys.has(key)) continue;
					staleOwnedKeys.add(key);
					releasedOwnerRoots.set(key, Array.from(ownerClientRoots.get(owner)?.get(key) ?? []));
					if (thisReloadGeneration !== undefined) {
						let released = ownerReleasedKeyGenerations.get(owner);
						if (!released) {
							released = new Map();
							ownerReleasedKeyGenerations.set(owner, released);
						}
						previousReleasedGenerations.set(key, released.get(key));
						released.set(key, thisReloadGeneration);
					}
					if (releaseClientOwnerKey(key, owner)) unownedStaleKeys.add(key);
					else retainedOwnedKeys.add(key);
				}
				stalePending = relevantPending.filter(([key]) => unownedStaleKeys.has(key));
				staleClients = relevantClients.filter(([key]) => unownedStaleKeys.has(key));
				const cleanupPromise = cleanupHolder.promise;
				for (const [key, pending] of stalePending) {
					for (const workspaceCwd of clientWorkspaceCwds(key, pending, owner)) barrierRoots.add(workspaceCwd);
					leftoverKeys.add(clientServerRootKey(pending.config, pending.cwd));
				}
				for (const [key, client] of staleClients) {
					for (const workspaceCwd of clientWorkspaceCwds(key, client, owner)) barrierRoots.add(workspaceCwd);
					leftoverKeys.add(clientServerRootKey(client.config, client.cwd));
				}
				if (cleanupPromise) {
					for (const root of barrierRoots) {
						if (!clientReloadBarriers.has(root)) clientReloadBarriers.set(root, cleanupPromise);
					}
					for (const leftoverKey of leftoverKeys) {
						if (!clientIdentityReloadBarriers.has(leftoverKey)) {
							clientIdentityReloadBarriers.set(leftoverKey, cleanupPromise);
						}
					}
				}
			}
			for (const key of fresh) invalidatedClientKeys.delete(key);
			// Tombstone stale identities before awaiting initialization. Existing
			// callers keep sharing their in-flight promise; later callers cannot spawn
			// another stale process while reload is blocked on teardown.
			for (const [key] of stalePending) invalidatedClientKeys.add(key);
			for (const [key] of staleClients) invalidatedClientKeys.add(key);
			await Promise.all(
				stalePending.map(async ([, pending]) => {
					try {
						await untilAborted(signal, pending.promise);
					} catch {
						throwIfAborted(signal);
					}
				}),
			);
			for (const key of unownedStaleKeys) initFailures.delete(key);

			const stale = Array.from(clients.entries()).filter(
				([key, client]) => unownedStaleKeys.has(key) && isRelevant(key, client),
			);
			const results = await Promise.all(stale.map(([, client]) => shutdownClientInstance(client)));
			const failed = stale.filter((_entry, index) => results[index] !== true);
			if (failed.length > 0) {
				restoreReleasedOwners();
				// Confirmed-exited identities are gone from the registry.
				// Drop their tombstones even at the shared primary root, and drop
				// this cleanup's root barriers, so a later start of that identity
				// or another server in the same project is not stuck behind the
				// survivor. Identities that did not exit keep a tombstone plus an
				// identity-scoped leftover barrier until teardown succeeds.
				const gone = [
					...stale.filter(([key]) => !clients.has(key) && !clientLocks.has(key)),
					...stalePending.filter(([key]) => !clients.has(key) && !clientLocks.has(key)),
				];
				for (const [key] of gone) invalidatedClientKeys.delete(key);
				const failedLeftoverKeys = new Set(
					failed.map(([, client]) => clientServerRootKey(client.config, client.cwd)),
				);
				dropThisCleanupBarriers(failedLeftoverKeys);
				throw new Error(
					"Failed to stop LSP server(s) with superseded configuration: " +
						failed.map(([, client]) => client.config.command).join(", "),
				);
			}
			for (const key of retainedOwnedKeys) invalidatedClientKeys.delete(key);
			// Nested identities are rediscovered lazily from a concrete file after
			// reload. Their temporary tombstones prevent reuse during teardown, but
			// must not permanently block the same valid identity from starting again.
			clearTemporaryNestedTombstones(stalePending);
			clearTemporaryNestedTombstones(stale);
			return stale.map(([, client]) => client.config.command);
		} catch (error) {
			if (signal?.aborted) {
				restoreReleasedOwners();
				clearTemporaryNestedTombstones(stalePending);
				clearTemporaryNestedTombstones(staleClients);
				if (owner && thisReloadGeneration !== undefined) {
					const currentGeneration = ownerReloadGeneration.get(owner);
					if (currentGeneration === thisReloadGeneration) {
						if (previousOwnerGeneration === undefined) ownerReloadGeneration.delete(owner);
						else ownerReloadGeneration.set(owner, previousOwnerGeneration);
					}
					const released = ownerReleasedKeyGenerations.get(owner);
					if (released) {
						for (const [key, previous] of previousReleasedGenerations) {
							if (released.get(key) !== thisReloadGeneration) continue;
							if (previous === undefined) released.delete(key);
							else released.set(key, previous);
						}
						if (released.size === 0) ownerReleasedKeyGenerations.delete(owner);
					}
					const stamps = ownerConfigStamps(owner);
					for (const [config, previous] of previousConfigStamps) {
						if (stamps.get(config) !== thisReloadGeneration) continue;
						if (previous === undefined) stamps.delete(config);
						else stamps.set(config, previous);
					}
					const coveredRoots = ownerReloadRootGenerations.get(owner);
					if (coveredRoots) {
						for (const [root, previous] of previousCoveredRootGenerations) {
							if (coveredRoots.get(root) !== thisReloadGeneration) continue;
							if (previous === undefined) coveredRoots.delete(root);
							else coveredRoots.set(root, previous);
						}
						if (coveredRoots.size === 0) ownerReloadRootGenerations.delete(owner);
					}
				}
				// Cancellation rolls the owner and tombstones back, so this
				// cleanup's rejected barriers must not remain. A later unused
				// nested identity under the same workspace would otherwise
				// collect the aborted promise and fail until another reload.
				dropThisCleanupBarriers();
			}
			throw error;
		}
	})();
	cleanupHolder.promise = cleanup;
	for (const root of barrierRoots) clientReloadBarriers.set(root, cleanup);
	for (const leftoverKey of leftoverKeys) clientIdentityReloadBarriers.set(leftoverKey, cleanup);
	void cleanup.then(
		() => {
			dropThisCleanupBarriers();
		},
		() => {},
	);
	return cleanup;
}

/** Allow an explicit user reload to retry a matching initialization failure immediately. */
export function clearInitializationFailure(config: ServerConfig, cwd: string): void {
	initFailures.delete(clientKey(config, config.resolvedRoot ?? cwd));
}

export function clearWorkspaceInitializationFailures(
	workspaceRoots: readonly string[],
	owner?: LspClientOwner,
	retainFailure?: (cwd: string) => boolean,
): void {
	const roots = workspaceRoots.map(root => path.resolve(root));
	const ownedKeys = owner ? ownerClientKeys.get(owner) : undefined;
	for (const [key, failure] of initFailures) {
		if (owner && !ownedKeys?.has(key) && !failure.owners?.has(owner)) continue;
		if (retainFailure?.(failure.cwd)) continue;
		if (roots.some(root => workspaceContainsPath(root, failure.cwd))) initFailures.delete(key);
	}
}

function collectReloadBarriers(config: ServerConfig, cwd: string): Promise<unknown>[] {
	const reloadBarriers: Promise<unknown>[] = [];
	const leftoverBarrier = clientIdentityReloadBarriers.get(clientServerRootKey(config, cwd));
	if (leftoverBarrier) reloadBarriers.push(leftoverBarrier);
	const membershipCwd = config.resolvedRoot ?? cwd;
	for (const [root, barrier] of clientReloadBarriers) {
		if (!workspaceContainsPath(root, membershipCwd) || reloadBarriers.includes(barrier)) continue;
		reloadBarriers.push(barrier);
	}
	return reloadBarriers;
}

export function ownerConfigGeneration(owner?: LspClientOwner): number {
	return owner ? (ownerReloadGeneration.get(owner) ?? 0) : 0;
}

function ownerConfigStamps(owner: LspClientOwner): WeakMap<ServerConfig, number> {
	let stamps = configReloadGenerations.get(owner);
	if (!stamps) {
		stamps = new WeakMap();
		configReloadGenerations.set(owner, stamps);
	}
	return stamps;
}

export function stampOwnerConfigGeneration(config: ServerConfig, owner?: LspClientOwner, generation?: number): number {
	if (!owner) return generation ?? 0;
	const stamps = ownerConfigStamps(owner);
	const stamped = stamps.get(config);
	if (stamped !== undefined) return stamped;
	const resolved = generation ?? ownerConfigGeneration(owner);
	stamps.set(config, resolved);
	return resolved;
}

function capturedBeforeOwnerReload(config: ServerConfig, key: string, cwd: string, owner?: LspClientOwner): boolean {
	if (!owner) return false;
	const stamp = stampOwnerConfigGeneration(config, owner);
	const releasedAt = ownerReleasedKeyGenerations.get(owner)?.get(key);
	if (releasedAt !== undefined && stamp < releasedAt) return true;
	const coveredRoots = ownerReloadRootGenerations.get(owner);
	if (!coveredRoots) return false;
	for (const [root, generation] of coveredRoots) {
		if (stamp < generation && workspaceContainsPath(root, cwd)) return true;
	}
	return false;
}

function canReuseClientDuringReload(
	key: string,
	owner: LspClientOwner | undefined,
	reloadBarriers: readonly Promise<unknown>[],
	config: ServerConfig,
	cwd: string,
): boolean {
	if (!owner) return true;
	if (clientOwners.get(key)?.has(owner) === true) return true;
	if (capturedBeforeOwnerReload(config, key, cwd, owner)) return false;
	return reloadBarriers.length === 0;
}

/**
 * Get or create an LSP client for the given server configuration and working directory.
 * @param config - Server configuration
 * @param cwd - Working directory
 * @param initTimeoutMs - Optional hard deadline for the initialize handshake (warmup / other
 *   short-lived callers). When set it takes precedence over `signal` inside `sendRequest`.
 * @param signal - Optional caller abort signal. Threaded into the initialize `sendRequest`
 *   and the `initialized` notification so a wedged server surfaces the caller's
 *   timeout/cancel instead of falling back to the internal 30s default.
 */
export async function getOrCreateClient(
	config: ServerConfig,
	cwd: string,
	initTimeoutMs?: number,
	signal?: AbortSignal,
	owner?: LspClientOwner,
): Promise<LspClient> {
	stampOwnerConfigGeneration(config, owner);
	const originCwd = path.resolve(cwd);
	const routedRoot = config.resolvedRoot ?? cwd;
	cwd = resolveEquivalentPath(routedRoot);
	const key = clientKey(config, cwd);
	const reloadBarriers = collectReloadBarriers(config, cwd);
	const rememberAcquiredIdleTimeout = (client?: LspClient): void => {
		rememberIdleTimeoutOrigins(key, owner, originCwd);
		if (client) maybeStartIdleChecker(client);
	};
	// Check if client already exists
	const existingClient = clients.get(key);
	if (
		existingClient &&
		!invalidatedClientKeys.has(key) &&
		canReuseClientDuringReload(key, owner, reloadBarriers, config, cwd)
	) {
		registerClientOwner(key, owner, routedRoot);
		existingClient.lastActivity = Date.now();
		refreshReusableClientRouting(key, existingClient, config, owner);
		rememberAcquiredIdleTimeout(existingClient);
		return existingClient;
	}

	// Check if another coroutine is already creating this client
	const existingLock = clientLocks.get(key);
	if (existingLock && canReuseClientDuringReload(key, owner, reloadBarriers, config, cwd)) {
		registerClientOwner(key, owner, routedRoot);
		if (owner) existingLock.owners.add(owner);
		try {
			const client = await existingLock.promise;
			refreshReusableClientRouting(key, client, config, owner);
			rememberAcquiredIdleTimeout(client);
			return client;
		} catch (error) {
			releaseOwnerIfUnpublished(key, owner);
			throw error;
		}
	}
	if (invalidatedClientKeys.has(key)) {
		throw new Error(`LSP configuration was superseded during reload: ${config.command}`);
	}
	if (capturedBeforeOwnerReload(config, key, cwd, owner)) {
		throw new Error(`LSP configuration was superseded during reload: ${config.command}`);
	}
	// Do not start a fresh identity until superseded processes are confirmed stopped.
	// In-flight workspace reload barriers are keyed by known roots, so a nested
	// client that was not in the snapshot must still wait on any ancestor
	// workspace barrier. After a mixed teardown failure, leftover barriers stay
	// on the command+cwd identities that did not exit rather than their shared
	// root. After that wait, the captured `config`/`key` may itself be stale —
	// reject it so the caller re-resolves from the reloaded definition instead
	// of spawning the pre-reload command/args/settings. Owner-scoped reload
	// advances this owner's generation even when no client was owned yet, so a
	// sequential `rename_file` server list captured before `reload *` cannot
	// start an unused nested identity after barriers drop. Cached reuse above
	// is also barrier-aware: a reloading owner cannot reattach to a client kept
	// alive by another session until this wait finishes, and both the post-wait
	// lookup and a request that arrives after barrier removal still require that
	// owner to hold the published identity. Otherwise a concurrent old-config
	// request would rejoin the overlapping process and leave this session
	// attached to both the superseded client and its replacement.
	if (reloadBarriers.length > 0) {
		try {
			for (const reloadBarrier of reloadBarriers) {
				await untilAborted(signal, reloadBarrier);
			}
		} catch (error) {
			throwIfAborted(signal);
			throw error;
		}
		const clientAfterReload = clients.get(key);
		if (
			clientAfterReload &&
			!invalidatedClientKeys.has(key) &&
			canReuseClientDuringReload(key, owner, reloadBarriers, config, cwd)
		) {
			registerClientOwner(key, owner, routedRoot);
			clientAfterReload.lastActivity = Date.now();
			refreshReusableClientRouting(key, clientAfterReload, config, owner);
			rememberAcquiredIdleTimeout(clientAfterReload);
			return clientAfterReload;
		}
		const lockAfterReload = clientLocks.get(key);
		if (lockAfterReload && canReuseClientDuringReload(key, owner, reloadBarriers, config, cwd)) {
			registerClientOwner(key, owner, routedRoot);
			if (owner) lockAfterReload.owners.add(owner);
			try {
				const client = await lockAfterReload.promise;
				refreshReusableClientRouting(key, client, config, owner);
				rememberAcquiredIdleTimeout(client);
				return client;
			} catch (error) {
				releaseOwnerIfUnpublished(key, owner);
				throw error;
			}
		}
		throw new Error(`LSP configuration was superseded during reload: ${config.command}`);
	}

	// Fail fast on a recent deterministic init failure instead of re-spawning
	// a broken server (and paying its full init wait) on every call.
	const recentFailure = initFailures.get(key);
	if (recentFailure) {
		if (Date.now() - recentFailure.at < INIT_FAILURE_BACKOFF_MS) {
			if (owner) {
				if (!recentFailure.owners) recentFailure.owners = new Set();
				recentFailure.owners.add(owner);
			}
			throw new Error(`LSP server ${config.command} failed to initialize recently: ${recentFailure.message}`);
		}
		initFailures.delete(key);
	}

	// Create new client with lock
	const lockToken = Symbol();
	const pendingOwners = new Set<LspClientOwner>();
	if (owner) pendingOwners.add(owner);
	const clientPromise = (async () => {
		const baseCommand = config.resolvedCommand ?? config.command;
		const baseArgs = config.args ?? [];

		// Wrap with lspmux if available and supported
		const { command, args, env } = isLspmuxSupported(baseCommand)
			? await getLspmuxCommand(baseCommand, baseArgs)
			: { command: baseCommand, args: baseArgs };

		// Prefer the broker-shared server unless an external lspmux wrapper is
		// already multiplexing this command. Any shared-path failure falls back
		// to a private spawn so LSP never regresses on broker trouble.
		let proc: LspTransport | null = null;
		if (sharedLspEnabled && command === baseCommand) {
			proc = await connectSharedLspTransport({ command, args, cwd, env, signal });
		}
		proc ??= ptree.spawn([command, ...args], {
			cwd,
			stdin: "pipe",
			env: env ? { ...Bun.env, ...env } : undefined,
		});

		let resolveProjectLoaded!: () => void;
		const projectLoaded = new Promise<void>(resolve => {
			resolveProjectLoaded = resolve;
		});
		// Auto-resolve after timeout in case server doesn't use progress tokens
		const projectLoadTimeout = setTimeout(resolveProjectLoaded, PROJECT_LOAD_TIMEOUT_MS);
		const originalResolve = resolveProjectLoaded;
		resolveProjectLoaded = () => {
			clearTimeout(projectLoadTimeout);
			originalResolve();
		};

		const client: LspClient = {
			name: key,
			cwd,
			proc,
			config,
			requestId: 0,
			diagnostics: new EquivalentUriMap(cwd),
			diagnosticsVersion: 0,
			dynamicCapabilityRegistrations: new Map(),
			openFiles: new Map(),
			pendingRequests: new Map(),
			messageBuffer: new Uint8Array(0),
			isReading: false,
			status: "connecting",
			lastActivity: Date.now(),
			writeQueue: Promise.resolve(),
			activeProgressTokens: new Set(),
			projectLoaded,
			resolveProjectLoaded,
		};

		// Register crash recovery - remove client on process exit
		proc.exited.then(() => {
			if (clients.get(key) === client) {
				clients.delete(key);
				dropClientOwnership(key);
			}
			maybeStopIdleChecker();
			if (clientLocks.get(key)?.token === lockToken) clientLocks.delete(key);
			client.resolveProjectLoaded();

			// Reject any pending requests — the server is gone, they will never complete.
			if (client.pendingRequests.size > 0) {
				// Strip informational log lines (e.g. marksman's [INF]/[DBG] prefix)
				// — they are startup noise, not actionable errors.
				const rawStderr = proc.peekStderr().trim();
				const stderr = rawStderr
					.split("\n")
					.filter(line => !/^\[\d{2}:\d{2}:\d{2} (?:INF|DBG|VRB)\]/.test(line))
					.join("\n")
					.trim();
				const code = proc.exitCode;
				const err = new Error(
					stderr ? `LSP server exited (code ${code}): ${stderr}` : `LSP server exited unexpectedly (code ${code})`,
				);
				for (const pending of client.pendingRequests.values()) {
					pending.reject(err);
				}
				client.pendingRequests.clear();
			}
		});

		// Start background message reader
		startMessageReader(client);

		try {
			// Send initialize request
			const initResult = (await sendRequest(
				client,
				"initialize",
				{
					processId: process.pid,
					rootUri: fileToUri(cwd, cwd),
					rootPath: cwd,
					capabilities: CLIENT_CAPABILITIES,
					initializationOptions: config.initOptions ?? {},
					workspaceFolders: currentWorkspaceFolders(client),
				},
				signal,
				initTimeoutMs,
			)) as { capabilities?: unknown };

			if (!initResult) {
				throw new Error("Failed to initialize LSP: no response");
			}

			client.serverCapabilities = initResult.capabilities as LspClient["serverCapabilities"];

			// Finish the initialize handshake before publishing the client as ready.
			await sendNotification(client, "initialized", {}, signal);
			await sendNotification(
				client,
				"workspace/didChangeConfiguration",
				{ settings: config.settings ?? {} },
				signal,
			);

			client.status = "ready";
			// Publish only after init succeeds: pre-init clients are reachable
			// solely through clientLocks, so concurrent callers (warmup vs first
			// tool call) wait for init instead of using an unacknowledged client.
			if (invalidatedClientKeys.has(key)) {
				throw new Error(`LSP configuration was superseded during initialization: ${config.command}`);
			}
			clients.set(key, client);
			rememberAcquiredIdleTimeout(client);
			initFailures.delete(key);
			return client;
		} catch (err) {
			// Clean up on initialization failure
			client.status = "error";
			const waitingOwners = pendingOwners.size > 0 ? pendingOwners : clientOwners.get(key);
			unpublishClient(key, client);
			proc.kill();
			const message = err instanceof Error ? err.message : String(err);
			// Negative-cache deterministic failures. Timeouts under a
			// caller-shortened deadline (warmup/writethrough) and caller-signal
			// aborts are transient — the server may simply be slow or the user may
			// have cancelled, so a later call with a fresh deadline should retry.
			if (
				!signal?.aborted &&
				!message.includes("configuration was superseded") &&
				!(initTimeoutMs !== undefined && message.includes("timed out"))
			) {
				initFailures.set(key, {
					at: Date.now(),
					message,
					cwd,
					owners:
						waitingOwners && waitingOwners.size > 0
							? new Set(waitingOwners)
							: owner
								? new Set([owner])
								: undefined,
				});
			}
			releaseOwnerIfUnpublished(key, owner);
			throw err;
		} finally {
			if (clientLocks.get(key)?.token === lockToken) clientLocks.delete(key);
		}
	})();
	registerClientOwner(key, owner, routedRoot);
	if (owner) setOwnerClientRouting(owner, key, { command: config.command, fileTypes: config.fileTypes });
	clientLocks.set(key, { promise: clientPromise, cwd, config, token: lockToken, owners: pendingOwners });
	return clientPromise;
}

/** Return an active or already-starting client without starting a language server. */
export async function getActiveOrPendingClient(
	config: ServerConfig,
	cwd: string,
	signal?: AbortSignal,
	owner?: LspClientOwner,
): Promise<LspClient | undefined> {
	const originCwd = path.resolve(cwd);
	const routedRoot = config.resolvedRoot ?? cwd;
	stampOwnerConfigGeneration(config, owner);
	cwd = resolveEquivalentPath(routedRoot);
	throwIfAborted(signal);
	const key = clientKey(config, cwd);
	const reloadBarriers = collectReloadBarriers(config, cwd);
	const rememberAcquiredIdleTimeout = (acquired: LspClient): void => {
		rememberIdleTimeoutOrigins(key, owner, originCwd);
		maybeStartIdleChecker(acquired);
	};
	const client = clients.get(key);
	if (client && canReuseClientDuringReload(key, owner, reloadBarriers, config, cwd)) {
		registerClientOwner(key, owner, routedRoot);
		client.lastActivity = Date.now();
		refreshReusableClientRouting(key, client, config, owner);
		rememberAcquiredIdleTimeout(client);
		return client;
	}

	const pending = clientLocks.get(key);
	if (!pending || !canReuseClientDuringReload(key, owner, reloadBarriers, config, cwd)) return undefined;
	registerClientOwner(key, owner, routedRoot);
	if (owner) pending.owners.add(owner);
	try {
		const acquired = await untilAborted(signal, pending.promise);
		refreshReusableClientRouting(key, acquired, config, owner);
		rememberAcquiredIdleTimeout(acquired);
		return acquired;
	} catch {
		releaseOwnerIfUnpublished(key, owner);
		throwIfAborted(signal);
		return undefined;
	}
}

/**
 * Ensure a file is opened in the LSP client.
 * Sends didOpen notification if the file is not already tracked.
 */
export async function ensureFileOpen(client: LspClient, filePath: string, signal?: AbortSignal): Promise<void> {
	throwIfAborted(signal);
	const uri = fileToUri(filePath, client.cwd);
	const lockKey = `${client.name}:${uri}`;

	// Check if file is already open
	if (client.openFiles.has(uri)) {
		return;
	}

	// Check if another operation is already opening this file
	const existingLock = fileOperationLocks.get(lockKey);
	if (existingLock) {
		await untilAborted(signal, () => existingLock);
		return;
	}

	// Lock and open file
	const openPromise = (async () => {
		throwIfAborted(signal);
		// Double-check after acquiring lock
		if (client.openFiles.has(uri)) {
			return;
		}

		let content: string;
		try {
			content = await Bun.file(filePath).text();
			throwIfAborted(signal);
		} catch (err) {
			if (isEnoent(err)) return;
			throw err;
		}
		const languageId = client.config.languageId ?? detectLanguageId(filePath);
		throwIfAborted(signal);

		await sendNotification(
			client,
			"textDocument/didOpen",
			{
				textDocument: {
					uri,
					languageId,
					version: 1,
					text: content,
				},
			},
			signal,
		);

		client.openFiles.set(uri, { version: 1, languageId });
		client.lastActivity = Date.now();
	})();

	fileOperationLocks.set(lockKey, openPromise);
	try {
		await openPromise;
	} finally {
		fileOperationLocks.delete(lockKey);
	}
}

/**
 * Wait for the server's initial project loading to complete.
 * Races the server's $/progress tracking against the abort signal.
 * Returns immediately if loading already completed or timed out.
 */
export async function waitForProjectLoaded(client: LspClient, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return;
	await Promise.race([
		client.projectLoaded,
		...(signal
			? [new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }))]
			: []),
	]);
	if (isRustAnalyzerClient(client)) {
		await waitForRustAnalyzerWorkspace(client, signal);
	}
}

/**
 * Sync in-memory content to the LSP client without reading from disk.
 * Use this to provide instant feedback during edits before the file is saved.
 */
export async function syncContent(
	client: LspClient,
	filePath: string,
	content: string,
	signal?: AbortSignal,
): Promise<void> {
	const uri = fileToUri(filePath, client.cwd);
	const lockKey = `${client.name}:${uri}`;
	throwIfAborted(signal);

	const existingLock = fileOperationLocks.get(lockKey);
	if (existingLock) {
		await untilAborted(signal, () => existingLock);
	}

	const syncPromise = (async () => {
		// Clear stale diagnostics before syncing new content
		client.diagnostics.delete(uri);

		const info = client.openFiles.get(uri);

		if (!info) {
			// Open file with provided content instead of reading from disk
			const languageId = client.config.languageId ?? detectLanguageId(filePath);
			throwIfAborted(signal);
			await sendNotification(
				client,
				"textDocument/didOpen",
				{
					textDocument: {
						uri,
						languageId,
						version: 1,
						text: content,
					},
				},
				signal,
			);
			client.openFiles.set(uri, { version: 1, languageId });
			client.lastActivity = Date.now();
			return;
		}

		const version = ++info.version;
		throwIfAborted(signal);
		await sendNotification(
			client,
			"textDocument/didChange",
			{
				textDocument: { uri, version },
				contentChanges: [{ text: content }],
			},
			signal,
		);
		client.lastActivity = Date.now();
	})();

	fileOperationLocks.set(lockKey, syncPromise);
	try {
		await syncPromise;
	} finally {
		fileOperationLocks.delete(lockKey);
	}
}

/**
 * Notify LSP that a file was saved.
 * Assumes content was already synced via syncContent - just sends didSave.
 */
export async function notifySaved(client: LspClient, filePath: string, signal?: AbortSignal): Promise<void> {
	const uri = fileToUri(filePath, client.cwd);
	const info = client.openFiles.get(uri);
	if (!info) return; // File not open, nothing to notify

	throwIfAborted(signal);
	await sendNotification(
		client,
		"textDocument/didSave",
		{
			textDocument: { uri },
		},
		signal,
	);
	client.lastActivity = Date.now();
}

/** Budget for the one-way watched-files notification: a wedged server that
 *  stops draining stdin must never hang the filesystem mutation that
 *  triggered it. Failures degrade to a debug log below. */
const WATCHED_FILES_NOTIFY_TIMEOUT_MS = 2_000;

/**
 * Announce harness-authored filesystem changes to active LSP clients for `cwd`.
 *
 * This covers sibling files that are not open text documents, such as generated
 * CSS modules or type files that another edited document imports immediately.
 * Unpublished overwrite-destination clients stay off the live map but still
 * receive these notifications when passed as `deferredClients`.
 *
 * The underlying stdin write drain is self-bounded by
 * {@link WATCHED_FILES_NOTIFY_TIMEOUT_MS}; only an abort of the caller's
 * `signal` rejects.
 */
export async function notifyWorkspaceWatchedFiles(
	workspace: string | readonly string[],
	changes: readonly WatchedFileChange[],
	signal?: AbortSignal,
	deferredClients: readonly LspClient[] = [],
): Promise<void> {
	throwIfAborted(signal);
	if (changes.length === 0) return;

	const workspaceRoots = (typeof workspace === "string" ? [workspace] : workspace).map(root => path.resolve(root));
	const seenClients = new Set<LspClient>();
	const candidateClients: LspClient[] = [];
	for (const client of [...clients.values(), ...deferredClients]) {
		if (seenClients.has(client)) continue;
		seenClients.add(client);
		candidateClients.push(client);
	}
	const activeClients = candidateClients.filter(
		client =>
			client.status === "ready" && workspaceRoots.some(root => clientIsInsideWorkspace(client.name, client, root)),
	);
	if (activeClients.length === 0) return;

	const timeoutSignal = AbortSignal.timeout(WATCHED_FILES_NOTIFY_TIMEOUT_MS);
	const sendSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
	const results = await Promise.allSettled(
		activeClients.map(async client => {
			const clientRoots = clientWorkspaceCwds(client.name, client);
			const clientChanges = changes.flatMap(change => {
				const documentUri = fileToUri(change.filePath, client.cwd);
				const openUris = openDocumentUrisForChange(client, documentUri);
				if (!clientRoots.some(root => workspaceContainsPath(root, change.filePath)) && openUris.length === 0) {
					return [];
				}
				const uris = openUris.length > 0 ? openUris : [documentUri];
				return uris.map(uri => {
					client.diagnostics.delete(uri);
					return { uri, type: change.type };
				});
			});
			if (clientChanges.length === 0) return;
			await sendNotification(client, "workspace/didChangeWatchedFiles", { changes: clientChanges }, sendSignal);
		}),
	);
	throwIfAborted(signal);
	for (const result of results) {
		if (result.status === "rejected") {
			logger.debug("LSP watched-files notification failed", {
				workspace: workspaceRoots.join(", "),
				error: String(result.reason),
			});
		}
	}
}

/**
 * Refresh a file in the LSP client.
 * Increments version, sends didChange and didSave notifications.
 */
export async function refreshFile(client: LspClient, filePath: string, signal?: AbortSignal): Promise<void> {
	await refreshOpenDocument(client, fileToUri(filePath, client.cwd), signal, filePath);
}

async function refreshOpenDocument(
	client: LspClient,
	uri: string,
	signal?: AbortSignal,
	filePath = uriToFile(uri),
): Promise<void> {
	throwIfAborted(signal);
	const lockKey = `${client.name}:${uri}`;

	const existingLock = fileOperationLocks.get(lockKey);
	if (existingLock) {
		await untilAborted(signal, () => existingLock);
	}

	const refreshPromise = (async () => {
		throwIfAborted(signal);
		// Drop cached diagnostics for this URI before asking the server to recompute.
		// Otherwise an unrelated publishDiagnostics notification can advance the global
		// diagnostics version and cause waiters to accept stale unversioned diagnostics.
		client.diagnostics.delete(uri);
		const info = client.openFiles.get(uri);

		if (!info) {
			await ensureFileOpen(client, filePath, signal);
			return;
		}

		let content: string;
		try {
			content = await Bun.file(filePath).text();
			throwIfAborted(signal);
		} catch (err) {
			if (isEnoent(err)) return;
			throw err;
		}
		const version = ++info.version;
		throwIfAborted(signal);

		await sendNotification(
			client,
			"textDocument/didChange",
			{
				textDocument: { uri, version },
				contentChanges: [{ text: content }],
			},
			signal,
		);
		throwIfAborted(signal);

		await sendNotification(
			client,
			"textDocument/didSave",
			{
				textDocument: { uri },
				text: content,
			},
			signal,
		);

		client.lastActivity = Date.now();
	})();

	fileOperationLocks.set(lockKey, refreshPromise);
	try {
		await refreshPromise;
	} finally {
		fileOperationLocks.delete(lockKey);
	}
}

async function waitForExit(client: LspClient, timeoutMs: number): Promise<boolean> {
	return await Promise.race([
		client.proc.exited.then(
			() => true,
			() => true,
		),
		Bun.sleep(timeoutMs).then(() => false),
	]);
}

/**
 * Tear down a specific client instance using the LSP shutdown/exit handshake.
 *
 * Removes the client from the registry by identity first (never evicting a
 * newer client already republished under the same key), then performs a bounded
 * graceful shutdown, force-killing and awaiting confirmed process exit.
 *
 * @returns `true` once the process is confirmed exited, `false` if it outlived
 * the shutdown budget — callers reporting a restart must treat `false` as a
 * failed teardown, not a completed restart.
 */
export async function shutdownClientInstance(client: LspClient): Promise<boolean> {
	const unpublished = clients.get(client.name) === client;
	const snapshot = unpublished ? snapshotClientOwnership(client.name) : unpublishedClientOwnership.get(client);
	if (unpublished) {
		if (snapshot) unpublishedClientOwnership.set(client, snapshot);
		clients.delete(client.name);
		dropClientOwnership(client.name);
	}
	maybeStopIdleChecker();

	const err = new Error("LSP client shutdown");
	for (const pending of Array.from(client.pendingRequests.values())) {
		pending.reject(err);
	}
	client.pendingRequests.clear();

	const dropIfStillThisInstance = (): void => {
		if (clients.get(client.name) === client) dropClientOwnership(client.name);
		else if (unpublished && !clients.has(client.name)) dropClientOwnership(client.name);
	};

	const shutdownCompleted = await sendRequest(client, "shutdown", null, undefined, SHUTDOWN_TIMEOUT_MS).then(
		() => true,
		() => false,
	);
	if (shutdownCompleted) {
		await sendNotification(client, "exit", undefined).catch(() => {});
		if (await waitForExit(client, EXIT_TIMEOUT_MS)) {
			dropIfStillThisInstance();
			return true;
		}
	}

	client.proc.kill();
	const exited = await waitForExit(client, EXIT_TIMEOUT_MS);
	if (!exited) {
		unpublishedClientOwnership.delete(client);
		if (!clients.has(client.name)) {
			clients.set(client.name, client);
			if (snapshot) restoreClientOwnership(client.name, snapshot);
			maybeStartIdleChecker(client);
		}
		return false;
	}
	unpublishedClientOwnership.delete(client);
	dropIfStillThisInstance();
	return true;
}

/**
 * Shutdown a specific client by key.
 *
 * @returns `true` when the client is gone (already absent or confirmed exited),
 * `false` if a live process outlived the shutdown budget.
 */
export async function shutdownClient(key: string): Promise<boolean> {
	const client = clients.get(key);
	if (!client) return true;
	return await shutdownClientInstance(client);
}

// =============================================================================
// LSP Protocol Methods
// =============================================================================

/** Default timeout for LSP requests when no abort signal is provided (30 seconds) */
const DEFAULT_REQUEST_TIMEOUT_MS = 30000;

/**
 * Send an LSP request and wait for response.
 *
 * Timeout policy:
 * - If `timeoutMs` is explicitly provided, that value is used.
 * - Else, if `signal` is provided, no internal timer is installed (the caller
 *   owns the deadline via the signal — typically a wall-clock `AbortSignal.timeout`
 *   from the LSP tool). Installing a second hard-coded 30s timer here used to
 *   cause "timed out after 30000ms" errors even when the caller had requested
 *   `timeout: 60`.
 * - Else (no signal, no explicit timeout), fall back to `DEFAULT_REQUEST_TIMEOUT_MS`
 *   to avoid leaking pending requests forever.
 */
export async function sendRequest(
	client: LspClient,
	method: string,
	params: unknown,
	signal?: AbortSignal,
	timeoutMs?: number,
): Promise<unknown> {
	// Atomically increment and capture request ID
	const id = ++client.requestId;
	if (signal?.aborted) {
		const reason = signal.reason instanceof Error ? signal.reason : new ToolAbortError();
		return Promise.reject(reason);
	}

	const request: LspJsonRpcRequest = {
		jsonrpc: "2.0",
		id,
		method,
		params,
	};

	client.lastActivity = Date.now();

	const { promise, resolve, reject } = Promise.withResolvers<unknown>();
	let timeout: NodeJS.Timeout | undefined;
	const cleanup = () => {
		if (signal) {
			signal.removeEventListener("abort", abortHandler);
		}
	};
	const abortHandler = () => {
		if (client.pendingRequests.has(id)) {
			client.pendingRequests.delete(id);
		}
		void sendNotification(client, "$/cancelRequest", { id }).catch(() => {});
		if (timeout) clearTimeout(timeout);
		cleanup();
		const reason = signal?.reason instanceof Error ? signal.reason : new ToolAbortError();
		reject(reason);
	};

	const effectiveTimeoutMs = timeoutMs ?? (signal ? undefined : DEFAULT_REQUEST_TIMEOUT_MS);
	if (effectiveTimeoutMs !== undefined) {
		timeout = setTimeout(() => {
			if (client.pendingRequests.has(id)) {
				client.pendingRequests.delete(id);
				void sendNotification(client, "$/cancelRequest", { id }).catch(() => {});
				const err = new Error(`LSP request ${method} timed out after ${effectiveTimeoutMs}ms`);
				cleanup();
				reject(err);
			}
		}, effectiveTimeoutMs);
	}
	if (signal) {
		signal.addEventListener("abort", abortHandler, { once: true });
		if (signal.aborted) {
			abortHandler();
			return promise;
		}
	}

	// Register pending request with timeout wrapper.
	// Settling stamps `lastActivity`: the idle window must be measured from when
	// the exchange finished, not from when it started. Without this a request
	// that outlives the timeout would leave the client instantly reapable the
	// moment it lands, so the next idle sweep would kill a server that had just
	// answered (issue #8390).
	client.pendingRequests.set(id, {
		resolve: result => {
			if (timeout) clearTimeout(timeout);
			client.lastActivity = Date.now();
			cleanup();
			resolve(result);
		},
		reject: err => {
			if (timeout) clearTimeout(timeout);
			client.lastActivity = Date.now();
			cleanup();
			reject(err);
		},
		method,
	});

	// Write request. `queueWriteMessage(..., signal)` bounds the sink flush
	// so a wedged server does not stall the write queue past the signal's
	// deadline; the write-queue teardown kills the client on abort.
	queueWriteMessage(client, request, signal).catch(err => {
		if (timeout) clearTimeout(timeout);
		client.pendingRequests.delete(id);
		cleanup();
		reject(err);
	});
	return promise;
}

/**
 * Send an LSP notification (no response expected).
 * `signal` bounds the underlying `sink.flush()` — without it a server that
 * stops draining stdin blocks every future write on the client's write queue.
 */
export async function sendNotification(
	client: LspClient,
	method: string,
	params: unknown,
	signal?: AbortSignal,
): Promise<void> {
	const notification: LspJsonRpcNotification = {
		jsonrpc: "2.0",
		method,
		params,
	};

	client.lastActivity = Date.now();
	await queueWriteMessage(client, notification, signal);
}

/**
 * Shutdown all LSP clients.
 *
 * Ownership stays on each live process until `shutdownClientInstance` confirms
 * exit. Clearing those maps first leaves a force-kill survivor ownerless, so
 * status hides it and an overlapping reload can tear it down.
 *
 * Owner reload generations stay monotonic: per-owner config stamps live in
 * WeakMaps that cannot be reset with the live clients, so zeroing these
 * counters would let a pre-shutdown stamp survive the next reload.
 */
export async function shutdownAll(): Promise<void> {
	stopIdleChecker();
	invalidatedClientKeys.clear();
	clientReloadBarriers.clear();
	clientIdentityReloadBarriers.clear();
	initFailures.clear();
	const clientsToShutdown = Array.from(clients.values());
	// Mid-initialize clients live only in clientLocks (publication is deferred
	// until init succeeds) — without this, their server processes outlive
	// shutdown. Failed init promises already cleaned up after themselves.
	const pendingClients = Array.from(clientLocks.values(), pending => pending.promise);
	clientLocks.clear();
	const seen = new Set<LspClient>(clientsToShutdown);
	await Promise.allSettled([
		...clientsToShutdown.map(client => shutdownClientInstance(client)),
		...pendingClients.map(pending =>
			pending.then(client => {
				if (seen.has(client)) return;
				seen.add(client);
				return shutdownClientInstance(client);
			}),
		),
	]);
}

/** Status of an LSP server */
export interface LspServerStatus {
	name: string;
	status: "connecting" | "ready" | "error";
	fileTypes: string[];
	cwd?: string;
	/** Routed project root before client-cwd canonicalization. */
	resolvedRoot?: string;
	resolvedCommand?: string;
	args?: string[];
	initOptions?: Record<string, unknown>;
	settings?: Record<string, unknown>;
	languageId?: string;
	error?: string;
}

/**
 * Get status of all active LSP clients.
 */
export function getActiveClients(owner?: LspClientOwner): LspServerStatus[] {
	return Array.from(clients.entries())
		.filter(([key]) => !owner || clientOwners.get(key)?.has(owner) === true)
		.map(([key, client]) => ({
			name: ownerClientCommand(owner, key, client.config.command),
			status: client.status,
			fileTypes: ownerClientFileTypes(owner, key, client.config.fileTypes),
			cwd: client.cwd,
			resolvedRoot:
				(owner ? ownerClientRoots.get(owner)?.get(key)?.values().next().value : undefined) ??
				client.config.resolvedRoot,
			resolvedCommand: client.config.resolvedCommand,
			args: client.config.args,
			initOptions: client.config.initOptions,
			settings: client.config.settings,
			languageId: client.config.languageId,
		}));
}

// =============================================================================
// Process Cleanup
// =============================================================================

// Route signal-triggered LSP cleanup through the shared `postmortem` cleanup
// list so it runs alongside every other session teardown (draft save,
// `session.dispose()`, kernels, MCP) instead of racing them via a
// module-owned `SIGINT`/`SIGTERM` handler + `process.exit(0)`. Historically
// this file registered its own signal handlers that called `shutdownAll()`
// then `process.exit(0)` — winning the race would drop `session_shutdown`
// extensions, orphan background bash/task jobs, and skip the editor draft
// save (issue #4080). `beforeExit` stays as-is: it fires only when the event
// loop drains with no more work, distinct from signal delivery.
if (typeof process !== "undefined") {
	process.on("beforeExit", () => {
		void shutdownAll();
	});
	postmortem.register("lsp-shutdown", () => shutdownAll());
}
