import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getProfileRootDir, isEnoent, isRecord } from "@oh-my-pi/pi-utils";
import { withFileLockSync } from "@oh-my-pi/pi-utils/file-lock";

/** A `/fast` enablement scope. */
export type FastModeScope = "session" | "provider" | "global";

/** Enable one scope, or turn priority off everywhere. */
export type FastModeAction = FastModeScope | "off";

/** Requested priority, actual wire realization, and the scopes applying to the active model. */
export interface FastModeStatus {
	enabled: boolean;
	active: boolean;
	scopes: FastModeScope[];
}

/** Revisions are serialized user actions, not clocks or provider/model identities. */
export interface FastModeScopesState {
	readonly revision: number;
	readonly off: number;
	readonly global: number;
	readonly providers: Readonly<Record<string, number>>;
	readonly sessions: Readonly<Record<string, number>>;
}

const emptyScopes: FastModeScopesState = { revision: 0, off: 0, global: 0, providers: {}, sessions: {} };
let cachedPath: string | undefined;
let cachedStat: fs.BigIntStats | undefined;
let cachedScopes: FastModeScopesState = emptyScopes;

/** The user-wide state is deliberately independent of the active profile. */
export function fastModeScopesPath(): string {
	return path.join(getProfileRootDir(undefined), "fast-mode-scopes.json");
}

function isRevision(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isScopeMap(value: unknown): value is Record<string, number> {
	return isRecord(value) && Object.values(value).every(isRevision);
}

function parseScopes(raw: string): FastModeScopesState {
	const value: unknown = JSON.parse(raw);
	if (
		!isRecord(value) ||
		!isRevision(value.revision) ||
		!isRevision(value.off) ||
		!isRevision(value.global) ||
		!isScopeMap(value.providers) ||
		!isScopeMap(value.sessions)
	) {
		throw new Error("Invalid fast-mode scope state");
	}
	return value as unknown as FastModeScopesState;
}

/** Atomic replacement lets readers stay lock-free; unchanged files reuse their parsed state. */
export function readFastModeScopes(filePath: string = fastModeScopesPath()): FastModeScopesState {
	let stat: fs.BigIntStats;
	try {
		stat = fs.statSync(filePath, { bigint: true });
	} catch (error) {
		if (!isEnoent(error)) throw error;
		cachedPath = undefined;
		cachedStat = undefined;
		return emptyScopes;
	}
	if (
		filePath === cachedPath &&
		cachedStat?.dev === stat.dev &&
		cachedStat.ino === stat.ino &&
		cachedStat.size === stat.size &&
		cachedStat.mtimeNs === stat.mtimeNs &&
		cachedStat.ctimeNs === stat.ctimeNs
	) {
		return cachedScopes;
	}
	const state = parseScopes(fs.readFileSync(filePath, "utf8"));
	cachedPath = filePath;
	cachedStat = stat;
	cachedScopes = state;
	return state;
}

/** The newest applicable enable action re-arms only its actual target sessions/providers. */
export function fastModeScopeRevision(state: FastModeScopesState, sessionId: string, provider?: string): number {
	const session = Object.hasOwn(state.sessions, sessionId) ? state.sessions[sessionId] : 0;
	const providerRevision = provider && Object.hasOwn(state.providers, provider) ? state.providers[provider] : 0;
	return Math.max(state.global, session, providerRevision);
}

/** Scope ordering is presentation only: all enable actions are additive. */
export function applicableFastModeScopes(
	state: FastModeScopesState,
	sessionId: string,
	provider?: string,
): FastModeScope[] {
	const scopes: FastModeScope[] = [];
	if (state.global) scopes.push("global");
	if (provider && Object.hasOwn(state.providers, provider)) scopes.push("provider");
	if (Object.hasOwn(state.sessions, sessionId)) scopes.push("session");
	return scopes;
}

function writeFastModeScopes(filePath: string, state: FastModeScopesState): void {
	const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
	try {
		fs.writeFileSync(tempPath, `${JSON.stringify(state)}\n`, { mode: 0o600, flag: "wx" });
		fs.renameSync(tempPath, filePath);
		cachedPath = undefined;
		cachedStat = undefined;
	} catch (error) {
		try {
			fs.rmSync(tempPath, { force: true });
		} catch {
			// Surface the original publication failure.
		}
		throw error;
	}
}

/**
 * Enables accumulate. Off removes every selection and persists a reset that
 * also suppresses older priority tiers in peers, resumed sessions and helpers.
 */
export function applyFastModeAction(
	action: FastModeAction,
	target: { sessionId?: string; provider?: string },
	filePath: string = fastModeScopesPath(),
): FastModeScopesState {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	return withFileLockSync(filePath, () => {
		const state = readFastModeScopes(filePath);
		const revision = state.revision + 1;
		let next: FastModeScopesState;
		switch (action) {
			case "off":
				next = { ...emptyScopes, revision, off: revision };
				break;
			case "global":
				next = { ...state, revision, global: revision };
				break;
			case "provider":
				if (!target.provider) throw new Error("No provider is selected for fast mode");
				next = { ...state, revision, providers: { ...state.providers, [target.provider]: revision } };
				break;
			case "session":
				if (!target.sessionId) throw new Error("No owning session is selected for fast mode");
				next = { ...state, revision, sessions: { ...state.sessions, [target.sessionId]: revision } };
				break;
		}
		writeFastModeScopes(filePath, next);
		return next;
	});
}

/** Carry a session selection across `/new` without issuing a new enable action. */
export function inheritSessionFastMode(
	sourceSessionId: string,
	targetSessionId: string,
	filePath: string = fastModeScopesPath(),
): void {
	if (sourceSessionId === targetSessionId || !Object.hasOwn(readFastModeScopes(filePath).sessions, sourceSessionId)) {
		return;
	}
	withFileLockSync(filePath, () => {
		// Off may have cleared the selection while this transition waited for the lock.
		const state = readFastModeScopes(filePath);
		if (!Object.hasOwn(state.sessions, sourceSessionId)) return;
		writeFastModeScopes(filePath, {
			...state,
			sessions: { ...state.sessions, [targetSessionId]: state.sessions[sourceSessionId] },
		});
	});
}
