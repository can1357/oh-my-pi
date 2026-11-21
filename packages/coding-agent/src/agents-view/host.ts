/**
 * Hosted sessions: an `omp` process running in a daemon PTY unit (`agent-<uuid>`,
 * global scope, persisted across terminal loss), viewed through `attach.ts`.
 */
import * as path from "node:path";
import { rederiveTerminalCapabilities } from "@oh-my-pi/pi-tui/terminal-capabilities";
import { setViewerTerminalMultiplexer, TERMINAL_MULTIPLEXER_ENV_KEYS } from "@oh-my-pi/pi-tui/terminal-multiplexer";
import { logger } from "@oh-my-pi/pi-utils";
import { DaemonRejectedError, daemonClient, probeDaemon } from "../daemon/client";
import { GLOBAL_SCOPE, type UnitRef } from "../daemon/protocol";
import type { Settings } from "../config/settings";
import { cfgComposerLeftArrowBackground } from "../modes/settings";
import { resolveCliEntryCmd } from "../subprocess/worker-client";
import { newAttachToken, VIEWER_ENV_KEYS, type ViewerIdentity } from "./markers";

/** Names the daemon unit a hosted process runs in; removed from the environment once read, re-added only for `/restart` ({@link hostedRestartEnv}). */
export const AGENT_INSTANCE_ENV = "OMP_AGENT_INSTANCE";
/** Set by a foreground handoff that had to abort the running turn: the hosted process goes on with it. */
export const AGENT_HANDOFF_CONTINUE_ENV = "OMP_AGENT_HANDOFF_CONTINUE";

const INSTANCE_KEY = /^agent-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const VERIFY_TIMEOUT_MS = 2000;
const STOP_TIMEOUT_MS = 10_000;
const MAX_LABEL_LENGTH = 80;

/** A fresh hosted-unit key; random, never derived from the session id. */
export function newInstanceKey(): string {
	return `agent-${crypto.randomUUID()}`;
}

/** Daemon reference of the hosted unit `key`. */
export function agentUnitRef(key: string): UnitRef {
	return { kind: "proc", scope: GLOBAL_SCOPE, key };
}

/** Multiplexer session markers (control sockets, session ids); TERM is handled as viewer identity. */
const MULTIPLEXER_SESSION_KEYS = TERMINAL_MULTIPLEXER_ENV_KEYS.filter(name => name !== "TERM");

// Variables naming the launching terminal, multiplexer or remote login: wrong for a
// process that outlives them and is viewed from other terminals.
const DROPPED_ENV_PREFIXES = ["SSH_", "TMUX", "ITERM_", "VSCODE_"];
const DROPPED_ENV_NAMES = new Set([
	"STY",
	"WINDOWID",
	"TERM_SESSION_ID",
	"KITTY_WINDOW_ID",
	"KITTY_PID",
	"WT_SESSION",
	...MULTIPLEXER_SESSION_KEYS,
	AGENT_INSTANCE_ENV,
	AGENT_HANDOFF_CONTINUE_ENV,
]);

/** The launching client's environment minus terminal/session-bound variables. */
export function filterHostedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
	const result: Record<string, string> = {};
	for (const name in env) {
		const value = env[name];
		if (value === undefined || DROPPED_ENV_NAMES.has(name)) continue;
		if (DROPPED_ENV_PREFIXES.some(prefix => name.startsWith(prefix))) continue;
		result[name] = value;
	}
	return result;
}

export interface LaunchHostedOptions {
	cwd: string;
	/** CLI arguments after the omp entry command. */
	argv: string[];
	/** Exact environment of the hosted process; defaults to this process's, filtered. */
	env?: Record<string, string>;
	cols: number;
	rows: number;
	title?: string;
}

/** Start `omp <argv>` as a hosted daemon PTY unit; resolves its key. */
export async function launchHosted(opts: LaunchHostedOptions): Promise<string> {
	const key = newInstanceKey();
	const [application, ...entryArgs] = resolveCliEntryCmd();
	const label = (opts.title || path.basename(opts.cwd))
		.replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
		.trim()
		.slice(0, MAX_LABEL_LENGTH);
	const client = await daemonClient();
	await client.open({
		kind: "proc",
		key,
		label: label || key,
		scope: GLOBAL_SCOPE,
		policy: { hold: "persist", restart: "no", survive: "exec" },
		lease: false,
		proc: {
			application,
			args: [...entryArgs, ...opts.argv],
			cwd: opts.cwd,
			env: { ...(opts.env ?? filterHostedEnv(process.env)), [AGENT_INSTANCE_ENV]: key },
			pty: true,
			cols: opts.cols,
			rows: opts.rows,
			clearEnv: true,
			exclusiveAttach: true,
		},
	});
	return key;
}

/** Stop the hosted unit `key` (SIGTERM first: the session saves itself). */
export async function stopHosted(key: string): Promise<void> {
	const client = await daemonClient();
	await client.request({ op: "stop", unit: agentUnitRef(key), timeoutMs: STOP_TIMEOUT_MS });
}

let hostedKey: string | undefined;
let attachToken: string | undefined;
let handoffContinue = false;
let hostedInit: Promise<string | undefined> | undefined;

/**
 * Whether this process is the hosted session `key`: the daemon's unit owns this pid.
 * Best effort: an unreachable or slow daemon accepts (only `launchHosted` sets the
 * variable); a daemon that answers for another process, or knows no such unit, refuses.
 */
async function verifyHostedInstance(key: string): Promise<boolean> {
	const client = await probeDaemon();
	if (!client) return true;
	try {
		const answer = client.request({ op: "describe", unit: agentUnitRef(key) }).then(
			({ unit }) => unit.pids.includes(process.pid) || unit.pids.includes(process.ppid),
			(error: unknown) => !(error instanceof DaemonRejectedError),
		);
		return await Promise.race([answer, Bun.sleep(VERIFY_TIMEOUT_MS).then(() => true)]);
	} finally {
		client.close();
	}
}

/**
 * Resolve once at startup whether this process is a hosted session. Reads and removes
 * {@link AGENT_INSTANCE_ENV} and {@link AGENT_HANDOFF_CONTINUE_ENV} synchronously on the
 * first call, so nothing this process spawns inherits them (only an in-place relaunch
 * gets the unit key back, through {@link hostedRestartEnv}).
 */
export function initHostedInstance(): Promise<string | undefined> {
	hostedInit ??= (async () => {
		const candidate = process.env[AGENT_INSTANCE_ENV];
		const continueTurn = process.env[AGENT_HANDOFF_CONTINUE_ENV] === "1";
		delete process.env[AGENT_INSTANCE_ENV];
		delete process.env[AGENT_HANDOFF_CONTINUE_ENV];
		if (!candidate || !INSTANCE_KEY.test(candidate)) return undefined;
		if (!(await verifyHostedInstance(candidate))) {
			logger.warn("Ignoring agent instance variable not owned by the daemon unit", { key: candidate });
			return undefined;
		}
		hostedKey = candidate;
		attachToken = newAttachToken();
		handoffContinue = continueTurn;
		return candidate;
	})();
	return hostedInit;
}

/** The verified hosted-unit key of this process; undefined until {@link initHostedInstance} resolved, or when not hosted. */
export function hostedInstanceKey(): string | undefined {
	return hostedKey;
}

/** Whether ← on the empty main composer backgrounds this session: always when hosted, else per `composer.leftArrowBackground`. */
export function leftArrowBackgrounds(settings: Settings): boolean {
	return hostedKey !== undefined || cfgComposerLeftArrowBackground.get(settings);
}

/**
 * The attach token of this hosted process: published in its (private) status record
 * and required in every attach/detach marker. Undefined when not hosted.
 */
export function hostedAttachToken(): string | undefined {
	return attachToken;
}

/**
 * Environment for relaunching this process in place (`/restart`): `env` with every
 * defined value, plus the verified hosted-unit `key` ({@link hostedInstanceKey}) when
 * hosted, so the replacement (same pid after exec, or a child of this pid) still
 * recognizes its daemon unit.
 */
export function hostedRestartEnv(env: NodeJS.ProcessEnv, key: string | undefined): Record<string, string> {
	const result: Record<string, string> = {};
	for (const name in env) {
		const value = env[name];
		if (value !== undefined) result[name] = value;
	}
	if (key) result[AGENT_INSTANCE_ENV] = key;
	return result;
}

/** True exactly once when this hosted process was launched by a handoff that aborted the running turn. */
export function takeHandoffContinue(): boolean {
	const result = handoffContinue;
	handoffContinue = false;
	return result;
}

/**
 * Replace every viewer-specific variable of `env` with `viewer`'s: identity variables
 * the viewer lacks are deleted, and multiplexer session markers (control sockets of
 * whatever terminal came before) are always deleted. The viewer's multiplexer travels
 * through the registry instead ({@link applyViewerIdentity}).
 */
export function applyViewerEnv(env: NodeJS.ProcessEnv, viewer: ViewerIdentity): void {
	for (const name of VIEWER_ENV_KEYS) {
		const value = viewer.env[name];
		if (value === undefined) delete env[name];
		else env[name] = value;
	}
	for (const name of MULTIPLEXER_SESSION_KEYS) delete env[name];
}

/**
 * Adopt the attached viewer's terminal identity: rewrite the identity variables (later
 * child processes see the viewer too), make multiplexer classification answer for the
 * viewer's multiplexer, and re-derive the viewer-dependent capabilities. The caller
 * restarts the terminal afterwards so probes run against the viewer.
 */
export function applyViewerIdentity(viewer: ViewerIdentity): void {
	applyViewerEnv(process.env, viewer);
	setViewerTerminalMultiplexer(viewer.multiplexer ?? null);
	rederiveTerminalCapabilities(process.env);
}
