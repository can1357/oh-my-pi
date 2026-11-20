/**
 * Cross-thread identity of agent sessions and registry refs.
 *
 * Codec `"agent-session"`: any {@link AgentSessionHandle} known to this
 * thread's session directory (a local `AgentSession`, main's
 * `RemoteAgentSession` mirror, a worker's `PeerAgentSession`) travels as its
 * {@link SessionToken}. The receiver decodes it to the local session when it
 * is the home thread; otherwise to main's canonical mirror (a closed one when
 * the worker no longer publishes that key) or a worker's canonical peer
 * handle. So `ref.session === session` holds on every thread.
 *
 * Codec `"agent-ref"`: main sends a ref minted by its registry as a full data
 * snapshot (sessions through the session codec). Workers decode it to one
 * canonical object per (id, generation), refreshed in place on every receipt,
 * and send it back as `{ id, generation }`. Main resolves that to the live
 * ref when the generation still matches, else to a detached tombstone that
 * equals nothing, so a stale expectation fails every CAS.
 */
import type { AgentRef } from "../../registry/agent-registry";
import { AgentRegistry, isMintedAgentRef } from "../../registry/agent-registry";
import type { AgentSessionHandle } from "../../session/agent-session-handle";
import { currentThreadId, isMainThread, isThreadId, type ThreadId } from "../identity";
import { PeerAgentSession, peerAgentSession } from "../peer-agent-session";
import { RemoteAgentSession } from "../remote-agent-session";
import type { RpcCodec } from "../rpc";
import type { ThreadService } from "../services";
import {
	findLocalSession,
	findRemoteSession,
	isRegisteredLocalSession,
	rememberRemoteSession,
	type SessionToken,
} from "../session-directory";

/** Wire kind of session tokens. */
export const AGENT_SESSION_CODEC = "agent-session";
/** Wire kind of registry refs. */
export const AGENT_REF_CODEC = "agent-ref";

// ─────────────────────────────────────────────────────────────────────────────
// Sessions
// ─────────────────────────────────────────────────────────────────────────────

/** Whether `value` is a session handle this thread can name by token. */
function isBridgedSession(value: unknown): value is AgentSessionHandle {
	return value instanceof RemoteAgentSession || value instanceof PeerAgentSession || isRegisteredLocalSession(value);
}

function isSessionToken(value: unknown): value is SessionToken {
	return (
		typeof value === "object" &&
		value !== null &&
		isThreadId(Reflect.get(value, "home")) &&
		typeof Reflect.get(value, "key") === "string"
	);
}

/** Token of a bridged session. */
export function sessionToken(session: AgentSessionHandle): SessionToken {
	const home: ThreadId =
		session instanceof RemoteAgentSession || session instanceof PeerAgentSession ? session.home : currentThreadId();
	return { home, key: session.instanceKey };
}

/** This thread's canonical handle for `token`; see the module doc. */
export function resolveSessionToken(token: SessionToken): AgentSessionHandle {
	const { home, key } = token;
	if (home === currentThreadId()) {
		const local = findLocalSession(key);
		if (local) return local;
	}
	if (!isMainThread()) return peerAgentSession(key, home);
	const known = findRemoteSession(key);
	if (known) return known;
	const gone = RemoteAgentSession.gone(key, home, `session ${key} is not open on ${home}`);
	rememberRemoteSession(key, gone);
	return gone;
}

const sessionCodec: RpcCodec<AgentSessionHandle> = {
	kind: AGENT_SESSION_CODEC,
	is: isBridgedSession,
	encode: sessionToken,
	decode: data => {
		if (!isSessionToken(data)) throw new Error("Malformed agent session token");
		return resolveSessionToken(data);
	},
};

// ─────────────────────────────────────────────────────────────────────────────
// Refs
// ─────────────────────────────────────────────────────────────────────────────

/** Main → worker: everything a worker reads on a ref. */
interface RefSnapshot {
	readonly id: string;
	readonly generation: number;
	readonly displayName: string;
	readonly kind: AgentRef["kind"];
	readonly parentId: AgentRef["parentId"];
	readonly status: AgentRef["status"];
	readonly session: AgentSessionHandle | null;
	readonly sessionFile: string | null;
	readonly createdAt: number;
	readonly lastActivity: number;
	readonly activity: AgentRef["activity"];
	readonly history: AgentRef["history"];
	readonly lifecycle: AgentRef["lifecycle"];
}

/** Worker → main: which ref generation the worker means. */
interface RefIdentity {
	readonly id: string;
	readonly generation: number;
}

function isRefIdentity(value: unknown): value is RefIdentity {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof Reflect.get(value, "id") === "string" &&
		typeof Reflect.get(value, "generation") === "number"
	);
}

function isRefSnapshot(value: unknown): value is RefSnapshot {
	return isRefIdentity(value) && typeof Reflect.get(value, "status") === "string";
}

/** A ref that matches nothing: what main decodes a stale generation to. */
function refTombstone(identity: RefIdentity): AgentRef {
	return {
		id: identity.id,
		generation: identity.generation,
		displayName: identity.id,
		kind: "sub",
		status: "aborted",
		session: null,
		sessionFile: null,
		createdAt: 0,
		lastActivity: 0,
	};
}

const mainRefCodec: RpcCodec<AgentRef> = {
	kind: AGENT_REF_CODEC,
	is: isMintedAgentRef,
	encode: ref =>
		({
			id: ref.id,
			generation: ref.generation,
			displayName: ref.displayName,
			kind: ref.kind,
			parentId: ref.parentId,
			status: ref.status,
			session: ref.session,
			sessionFile: ref.sessionFile,
			createdAt: ref.createdAt,
			lastActivity: ref.lastActivity,
			activity: ref.activity,
			history: ref.history,
			lifecycle: ref.lifecycle,
		}) satisfies RefSnapshot,
	decode: data => {
		if (!isRefIdentity(data)) throw new Error("Malformed agent ref identity");
		const live = AgentRegistry.global().get(data.id);
		return live?.generation === data.generation ? live : refTombstone(data);
	},
};

const kWorkerRef = Symbol("thread.worker-ref");
const workerRefs = new Map<string, WeakRef<AgentRef>>();
const workerRefFinalizer = new FinalizationRegistry<string>(slot => {
	if (!workerRefs.get(slot)?.deref()) workerRefs.delete(slot);
});

function isWorkerRef(value: unknown): value is AgentRef {
	return typeof value === "object" && value !== null && Reflect.get(value, kWorkerRef) === true;
}

/** Copy every snapshot field onto `ref` (generation is fixed per object). */
function refresh(ref: AgentRef, snapshot: RefSnapshot): AgentRef {
	ref.displayName = snapshot.displayName;
	ref.kind = snapshot.kind;
	ref.parentId = snapshot.parentId;
	ref.status = snapshot.status;
	ref.session = snapshot.session;
	ref.sessionFile = snapshot.sessionFile;
	ref.createdAt = snapshot.createdAt;
	ref.lastActivity = snapshot.lastActivity;
	ref.activity = snapshot.activity;
	ref.history = snapshot.history;
	ref.lifecycle = snapshot.lifecycle;
	return ref;
}

const workerRefCodec: RpcCodec<AgentRef> = {
	kind: AGENT_REF_CODEC,
	is: isWorkerRef,
	encode: ref => ({ id: ref.id, generation: ref.generation }) satisfies RefIdentity,
	decode: data => {
		if (!isRefSnapshot(data)) throw new Error("Malformed agent ref snapshot");
		const slot = `${data.generation}:${data.id}`;
		const known = workerRefs.get(slot)?.deref();
		if (known) return refresh(known, data);
		const ref: AgentRef = { ...data };
		Object.defineProperty(ref, kWorkerRef, { value: true });
		workerRefs.set(slot, new WeakRef(ref));
		workerRefFinalizer.register(ref, slot);
		return ref;
	},
};

/** Session and ref identity codecs; installed first so every other service's payloads can embed them. */
export const identityThreadService: ThreadService = {
	name: "identity",
	installMain(peer) {
		peer.link.codec(sessionCodec);
		peer.link.codec(mainRefCodec);
	},
	installWorker(link) {
		link.codec(sessionCodec);
		link.codec(workerRefCodec);
	},
};
