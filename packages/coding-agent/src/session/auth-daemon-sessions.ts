import { type } from "@oh-my-pi/omptype";
import type { SessionRestrictionLease } from "@oh-my-pi/pi-ai/auth-storage";
import type { AuthDaemonRequestHandler } from "../daemon/modules/auth";
import { isAuthDaemonCredentialId } from "./auth-daemon-contract";
import type { AuthDaemonLease } from "./auth-daemon-owner";

const NonEmpty = type("string > 0");
// The affinity cache uses ':' to separate provider and scoped session IDs.
const Provider = NonEmpty.narrow(value => !value.includes(":"));
const Token = type("string").narrow(value =>
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value),
);
const scope = { provider: Provider, sessionId: NonEmpty, "+": "reject" } as const;
const Scope = type(scope);
const Pin = type({
	...scope,
	credentialId: type("number").narrow(isAuthDaemonCredentialId),
	"restoredAtMs?": type("number").narrow(value => Number.isSafeInteger(value) && value >= 0),
});
const Restrict = type({ ...scope, identityKeys: NonEmpty.array() });
const Unrestrict = type({ ...scope, token: Token });
const InheritEntry = type({ provider: Provider, explicit: "boolean", "+": "reject" });
const Inherit = type({
	sourceSessionId: NonEmpty,
	targetSessionId: NonEmpty,
	"allow?": InheritEntry.array(),
	"+": "reject",
});

interface HeldRestriction {
	token: string;
	lease: SessionRestrictionLease;
}

// The lease owns restriction cleanup; this property only maps its current wire tokens.
const kRestrictions = Symbol("auth-daemon.restrictions");
type LeaseWithRestrictions = AuthDaemonLease & {
	[kRestrictions]?: Map<string, Map<string, HeldRestriction>>;
};

function parse<T>(schema: (value: unknown) => T | type.errors, value: unknown): T {
	const params = schema(value);
	if (params instanceof type.errors) throw new Error("auth: invalid session params");
	return params;
}

function scopedId(lease: AuthDaemonLease, original: string, provider?: string): string {
	const id = lease.sessionId(original, provider);
	if (id === undefined) throw new Error("auth: missing scoped session id");
	return id;
}

function pin(lease: AuthDaemonLease, value: unknown): boolean | Promise<boolean> {
	const { provider, sessionId, credentialId, restoredAtMs } = parse(Pin, value);
	const id = scopedId(lease, sessionId, provider);
	const { sessions } = lease.storage;
	return (
		sessions.permits(provider, id, credentialId) === true &&
		sessions.pin(provider, id, credentialId, restoredAtMs === undefined ? undefined : { restoredAtMs })
	);
}

function release(lease: AuthDaemonLease, value: unknown): boolean | Promise<boolean> {
	const { provider, sessionId } = parse(Scope, value);
	return lease.storage.sessions.release(provider, scopedId(lease, sessionId, provider));
}

async function clear(lease: AuthDaemonLease, value: unknown): Promise<boolean> {
	const { provider, sessionId } = parse(Scope, value);
	await lease.storage.sessions.clear(provider, scopedId(lease, sessionId, provider));
	return true;
}

function restrict(lease: AuthDaemonLease, value: unknown): string {
	const { provider, sessionId, identityKeys } = parse(Restrict, value);
	const token = crypto.randomUUID();
	const installed = lease.restrict(provider, sessionId, identityKeys);
	const byProvider = ((lease as LeaseWithRestrictions)[kRestrictions] ??= new Map());
	let bySession = byProvider.get(provider);
	if (!bySession) {
		bySession = new Map();
		byProvider.set(provider, bySession);
	}
	bySession.set(sessionId, { token, lease: installed });
	return token;
}

function unrestrict(lease: AuthDaemonLease, value: unknown): boolean {
	const { provider, sessionId, token } = parse(Unrestrict, value);
	const byProvider = (lease as LeaseWithRestrictions)[kRestrictions];
	if (!byProvider) return false;
	const bySession = byProvider.get(provider);
	if (!bySession) return false;
	const held = bySession.get(sessionId);
	if (!held || held.token !== token) return false;
	lease.unrestrict(provider, sessionId, held.lease);
	bySession.delete(sessionId);
	if (bySession.size === 0) byProvider.delete(provider);
	return true;
}

function inherit(lease: AuthDaemonLease, value: unknown): number | Promise<number> {
	const { sourceSessionId, targetSessionId, allow } = parse(Inherit, value);
	if (sourceSessionId === targetSessionId || allow?.length === 0) return 0;
	let include: ((provider: string, explicit: boolean) => boolean) | undefined;
	if (allow) {
		const automatic = new Set<string>();
		const explicitPins = new Set<string>();
		for (const entry of allow) (entry.explicit ? explicitPins : automatic).add(entry.provider);
		include = (provider, explicit) => (explicit ? explicitPins : automatic).has(provider);
	}
	return lease.storage.sessions.inherit(scopedId(lease, sourceSessionId), scopedId(lease, targetSessionId), include);
}

export const authDaemonSessionHandlers: ReadonlyMap<string, AuthDaemonRequestHandler> = new Map<
	string,
	AuthDaemonRequestHandler
>([
	["session-pin", pin],
	["session-release", release],
	["session-clear", clear],
	["session-restrict", restrict],
	["session-unrestrict", unrestrict],
	["session-inherit", inherit],
]);
