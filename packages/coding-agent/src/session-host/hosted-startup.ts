/**
 * Startup of a hosted TUI (`tui.hosted`, `omp attach <target>`, `/attach`): find or start the session host that
 * serves the session this terminal opens, then run an `InteractiveMode` that is only a client of it
 * ({@link HostedClientLink}). The terminal owns no model, tools, extensions, or session writer: the local session is
 * a lean passive replica, and the host runs with the launch flags this process was given.
 *
 * There is no reconnect and no in-process fallback. A host that cannot be reached is reported and the process exits.
 */
import * as crypto from "node:crypto";
import * as path from "node:path";
import { getBaseConfigRoot, withFileLock } from "@oh-my-pi/pi-utils";
import type { Args } from "../cli/args";
import { flagConsumesValue, PROFILE_BOOTSTRAP_BOUNDARY_ARG, restartArgv } from "../cli/flag-tables";
import { CliUsageError } from "../cli/usage-error";
import type { ModelRegistry } from "../config/model-registry";
import type { Settings } from "../config/settings";
import { ensurePrivateDir } from "../ipc/private-endpoint";
import type { InteractiveModeContext } from "../modes/types";
import type { CreateAgentSessionOptions, CreateAgentSessionResult } from "../sdk";
import type { AuthStorage } from "../session/auth-storage";
import { resolveResumableSession } from "../session/session-listing";
import { readSessionHeaderId } from "../session/session-loader";
import { SessionManager } from "../session/session-manager";
import { FileSessionStorage } from "../session/session-storage";
import { errorMessage } from "../slash-commands/helpers/parse";
import type { EventBus } from "../utils/event-bus";
import { spawnSessionHost } from "./client";
import { formatHostRow } from "./host-row";
import { HostedClientLink } from "./hosted-client";
import {
	findHostForSession,
	listSessionHosts,
	SESSION_HOST_REGISTRY_LABEL,
	type SessionHostEntry,
	sessionHostsDir,
} from "./registry";

/** A host id is 16 lowercase hex digits. */
const HOST_ID_PATTERN = /^[0-9a-f]{16}$/;
/**
 * How long a second terminal waits for the first to finish starting the host of the same session: the spawn
 * timeout (120 s) plus its registry poll, so a waiter outlasts a start that is merely slow.
 */
const START_LOCK_WAIT = { retries: 1_300, retryDelayMs: 100 } as const;

/** How a terminal finds or starts the hosts it attaches to. */
export interface HostLaunch {
	/** The directory a new host runs in. */
	cwd: string;
	/** The launch flags a new host starts with; see {@link hostLaunchArgs}. */
	args: readonly string[];
	/** `--session-dir` the session ids of an attach target are looked up in. */
	sessionDir?: string;
	/** Registry the hosts publish in. Default {@link sessionHostsDir}. */
	registryDir?: string;
	/** Environment overlaid on a new host's (tests isolate it from the real agent directory). */
	env?: Record<string, string>;
}

export interface HostedStartup {
	/** The host this terminal attaches to first. */
	entry: SessionHostEntry;
	launch: HostLaunch;
}

/**
 * The launch flags a new host is started with: everything this process was launched with except what only this
 * terminal consumes. Session-source flags (`--resume`, `--continue`, `--fork`, imports), positional prompts and
 * `@file` arguments are dropped (the terminal resolves the session and sends the prompt), and so is `--cwd`, which
 * the host receives already resolved. Taken from the argv as given, never from the lean options the local session
 * is built with, so a host keeps the tools, providers, and extensions that were asked for.
 */
export function hostLaunchArgs(rawArgs: readonly string[]): string[] {
	const configuration = restartArgv(
		rawArgs.filter(arg => arg !== PROFILE_BOOTSTRAP_BOUNDARY_ARG),
		undefined,
	);
	const kept: string[] = [];
	for (let i = 0; i < configuration.length; i++) {
		const arg = configuration[i];
		const consumesNext = flagConsumesValue(arg, configuration[i + 1]);
		if ((arg.startsWith("--") ? arg.split("=", 1)[0] : arg) === "--cwd") {
			if (consumesNext) i++;
			continue;
		}
		kept.push(arg);
		if (consumesNext) kept.push(configuration[++i]);
	}
	return kept;
}

/**
 * Refuse launch options a host cannot honor. They are errors, never silently dropped: dropping `--fork` would open
 * the original session, dropping `--goal` would start the session without the goal asked for (and running it here
 * would start local goal mode, which a terminal that only mirrors a host never does), and a flag only an extension
 * registers cannot be told from a typo (or from the prompt it would swallow) without loading the extensions this
 * terminal deliberately does not load.
 */
export function assertHostedLaunchSupported(
	parsed: Pick<Args, "fork" | "fromClaude" | "fromCodex" | "goal" | "unrecognizedFlags">,
): void {
	if (parsed.fork !== undefined) {
		throw new CliUsageError("--fork is not supported with hosted sessions (tui.hosted, omp attach)");
	}
	if (parsed.fromClaude) {
		throw new CliUsageError("--from-claude is not supported with hosted sessions (tui.hosted, omp attach)");
	}
	if (parsed.fromCodex) {
		throw new CliUsageError("--from-codex is not supported with hosted sessions (tui.hosted, omp attach)");
	}
	if (parsed.goal !== undefined) {
		throw new CliUsageError("--goal is not supported with hosted sessions (tui.hosted, omp attach)");
	}
	if (parsed.unrecognizedFlags.length > 0) {
		throw new CliUsageError(
			`Unknown or extension-registered flags are not supported with hosted sessions: ${parsed.unrecognizedFlags.join(", ")}`,
		);
	}
}

/**
 * Whether another process holds the ownership lease of the session in `sessionFile`. The lease is keyed by the
 * session id in the file's header, so every route to the journal meets it. A file with no header has no running
 * writer: omp writes the header with the first bytes of a session.
 */
async function openedByAnotherProcess(sessionFile: string): Promise<boolean> {
	const sessionId = await readSessionHeaderId(sessionFile);
	if (sessionId === undefined) return false;
	const release = new FileSessionStorage().claimSession(sessionId, sessionFile);
	if (release === null) return true;
	release();
	return false;
}

/**
 * The host serving `sessionFile`, started when none is. `undefined` is a new session: no other terminal can be
 * opening it, so a host is started without `--resume`.
 *
 * Opening an existing session is serialized across terminals by a start lock named after the file, taken before the
 * registry is read and held until a started host has published: two terminals resuming the same session cannot both
 * start a host (the second finds the first's) and never open a second writer or a fork of it. A file leased by a
 * process that is not a registered host is refused, not forked.
 *
 * `launchFlagsMustApply`: the caller asked for these launch flags, and a host that already runs the session was
 * started without them. Attaching would silently drop them (a narrower tool set, an approval mode), so it is refused.
 */
export async function ensureSessionHost(
	sessionFile: string | undefined,
	launch: HostLaunch,
	options: { launchFlagsMustApply?: boolean } = {},
): Promise<SessionHostEntry> {
	const registryDir = path.resolve(launch.registryDir ?? sessionHostsDir());
	if (sessionFile === undefined) {
		return spawnSessionHost({
			cwd: launch.cwd,
			args: [...launch.args],
			registryDir,
			env: launch.env,
		});
	}
	const file = path.resolve(sessionFile);
	await ensurePrivateDir(registryDir, SESSION_HOST_REGISTRY_LABEL);
	const lockName = `start-${crypto.createHash("sha256").update(file).digest("hex").slice(0, 32)}`;
	return withFileLock(
		path.join(registryDir, lockName),
		async () => {
			const running = await findHostForSession(file, registryDir);
			if (running) {
				if (options.launchFlagsMustApply && launch.args.length > 0) {
					throw new CliUsageError(
						`Session host ${running.hostId} already runs this session, so this launch's host options cannot apply; run without them, or attach with: omp attach ${running.hostId}`,
					);
				}
				return running;
			}
			if (await openedByAnotherProcess(file)) {
				throw new CliUsageError(
					`Session ${file} is open in a non-host process; close that process, then attach again`,
				);
			}
			return spawnSessionHost({
				cwd: launch.cwd,
				sessionFile: file,
				args: [...launch.args],
				registryDir,
				env: launch.env,
			});
		},
		START_LOCK_WAIT,
	);
}

/**
 * The host for the session `sessionManager` resolved to (the startup flags: `--resume`, `--continue`, `autoResume`,
 * or a new session). The manager only identifies the session: it is closed here so this process holds no lease on
 * the file the host is about to own.
 */
export async function ensureHostForResolvedSession(
	sessionManager: SessionManager | undefined,
	launch: HostLaunch,
): Promise<SessionHostEntry> {
	const sessionFile = sessionManager?.isSessionOnDisk() ? sessionManager.getSessionFile() : undefined;
	await sessionManager?.close();
	return ensureSessionHost(sessionFile, launch, { launchFlagsMustApply: true });
}

async function resolveSessionFile(name: string, launch: HostLaunch): Promise<string | undefined> {
	if (name.includes("/") || name.includes("\\") || name.endsWith(".jsonl")) {
		const file = path.resolve(launch.cwd, name);
		if (!(await SessionManager.peekSessionInit(file))) throw new CliUsageError(`Not a session file: ${file}`);
		return file;
	}
	return (await resolveResumableSession(name, launch.cwd, launch.sessionDir))?.session.path;
}

/**
 * The host an attach target names: a host id, else a session id or path, whose host is started when none runs.
 * Rejects with a {@link CliUsageError} when nothing matches.
 */
export async function resolveAttachTarget(target: string, launch: HostLaunch): Promise<SessionHostEntry> {
	const name = target.trim();
	if (!name) throw new CliUsageError("attach needs a target: a host id, a session id, or a session path");
	if (HOST_ID_PATTERN.test(name)) {
		const host = (await listSessionHosts(launch.registryDir)).find(entry => entry.hostId === name);
		if (host) return host;
	}
	const sessionFile = await resolveSessionFile(name, launch);
	if (!sessionFile) throw new CliUsageError(`No session host or session matches "${name}"`);
	return ensureSessionHost(sessionFile, launch);
}

/** Where a hosted terminal keeps its local copies of host transcripts: runtime state, never listed as sessions. */
export function hostedReplicaDir(): string {
	return path.join(getBaseConfigRoot(), "run", "hosted-replicas");
}

/**
 * The session a hosted terminal's `InteractiveMode` runs on until the host's snapshot replaces its content: a
 * passive replica on a read-only view of files, with nothing that runs or reaches a provider on its own. The host
 * owns tools, extensions, skills, rules, LSP, MCP, and memory, so none of them starts here; an empty session
 * manager over the file storage lets the replica's transcript copy be read back. No model is selected: the host's
 * model arrives with its first snapshot.
 */
export async function createHostedLocalSession(options: {
	cwd: string;
	authStorage: AuthStorage;
	modelRegistry: ModelRegistry;
	settings: Settings;
	eventBus: EventBus;
	subagentEventBus: EventBus;
	createSession: (options: CreateAgentSessionOptions) => Promise<CreateAgentSessionResult>;
}): Promise<CreateAgentSessionResult> {
	const { cwd } = options;
	return options.createSession({
		cwd,
		authStorage: options.authStorage,
		modelRegistry: options.modelRegistry,
		settings: options.settings,
		eventBus: options.eventBus,
		subagentEventBus: options.subagentEventBus,
		sessionManager: SessionManager.inMemory(cwd, new FileSessionStorage()),
		passiveReplica: true,
		hasUI: true,
		disableExtensionDiscovery: true,
		skills: [],
		rules: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		workspaceTree: { rootPath: cwd, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
		toolNames: [],
		// No discovered custom tools, extension factories, MCP, or memory tools: the empty list alone leaves them on.
		restrictToolNames: true,
		enableLsp: false,
		enableMCP: false,
		cacheWarming: false,
	});
}

/**
 * Connect `ctx` to its first host and let `/attach` replace it. `ctx.hostedClientMode` must already be set (before
 * `init()`). Resolves once the first snapshot is on screen and `ctx.hostedClient` is set; rejects, leaving nothing
 * attached, when it cannot connect.
 *
 * A lost connection ends the process (`ctx.shutdown` with exit status 1): there is no reconnect.
 */
export async function attachHostedUi(ctx: InteractiveModeContext, hosted: HostedStartup): Promise<void> {
	let current = hosted.entry;
	let switching = false;

	const connect = async (entry: SessionHostEntry): Promise<void> => {
		const link = await HostedClientLink.connect({
			ctx,
			entry,
			replicaDir: hostedReplicaDir(),
			onClosed: reason => {
				void ctx.shutdown({ exitCode: 1, farewell: reason.message });
			},
		});
		if (ctx.isShuttingDown) {
			// The terminal was closed while connecting: leave again without taking over the view.
			await link.detach();
			return;
		}
		current = entry;
		ctx.hostedClient = link;
	};

	/** The live host chosen in a selector; the one on screen is not offered. */
	const pickHost = async (onScreen: string): Promise<SessionHostEntry | undefined> => {
		const others = (await listSessionHosts(hosted.launch.registryDir)).filter(host => host.hostId !== onScreen);
		if (others.length === 0) {
			ctx.showStatus("No other session hosts running");
			return undefined;
		}
		const rows = others.map(host => ({ row: formatHostRow(host), host }));
		const picked = await ctx.showHookSelector(
			"Attach to session host",
			rows.map(({ row }) => row),
		);
		return rows.find(({ row }) => row === picked)?.host;
	};

	/**
	 * Leave the host on screen and take the view of `entry`. The old link is quiescent before the new one loads its
	 * replica, so two streams never interleave in one view, and inputs report "not connected" (keeping the draft)
	 * while the live link is cleared. A target that cannot be reached puts the previous host back once, with a
	 * fresh snapshot; if that fails too the process ends.
	 */
	const switchTo = async (entry: SessionHostEntry, previous: HostedClientLink): Promise<void> => {
		const previousEntry = current;
		ctx.hostedClient = undefined;
		try {
			await previous.detach();
		} catch (error) {
			// The old connection is closed either way; the transcript view it fed is replaced next.
			ctx.showWarning(`Could not leave host ${previous.hostId} cleanly: ${errorMessage(error)}`);
		}
		try {
			await connect(entry);
			return;
		} catch (error) {
			ctx.showError(`Could not attach to host ${entry.hostId}: ${errorMessage(error)}`);
		}
		try {
			await connect(previousEntry);
			ctx.showStatus(`Back on session host ${previousEntry.hostId}`);
		} catch (error) {
			void ctx.shutdown({
				exitCode: 1,
				farewell: `Could not attach to host ${entry.hostId}, and could not return to host ${previousEntry.hostId}: ${errorMessage(error)}`,
			});
		}
	};

	ctx.attachHostedSession = async target => {
		const previous = ctx.hostedClient;
		if (switching || !previous) {
			ctx.showStatus(switching ? "Already switching session hosts" : "Not connected to the session host yet");
			return;
		}
		switching = true;
		try {
			const entry =
				target === undefined ? await pickHost(previous.hostId) : await resolveAttachTarget(target, hosted.launch);
			if (!entry) return;
			if (entry.hostId === previous.hostId) {
				ctx.showStatus(`Already attached to session host ${entry.hostId}`);
				return;
			}
			await switchTo(entry, previous);
		} catch (error) {
			ctx.showError(`Attach failed: ${errorMessage(error)}`);
		} finally {
			switching = false;
		}
	};

	await connect(hosted.entry);
}
