import type { ProviderCallGate } from "@oh-my-pi/pi-ai/auth/provider-gate";
import type { ExtensionCallbackOwner } from "./types";

/**
 * One `pi.registerProvider` call waiting in a runtime's queue, and the session that made it.
 *
 * Ownership belongs to the registration OCCURRENCE, not to the configuration object. An author may
 * hand the same object to every session that loads the extension — a module-level constant, a
 * subagent rebinding its parent's extensions — so the object alone cannot say which session a
 * given registration came from. Each queued record carries its own owner, and a drain that
 * passes the record's owner to `ModelRegistry.registerProvider` needs nothing else.
 *
 * A host that drains the queue itself passes only the documented three fields. For it, the
 * queued records are also indexed here by configuration object, oldest first, and the registry
 * claims the oldest one still queued that matches name and source. Records that left the queue
 * without being registered are withdrawn from the index, so they can lend their owner to nobody.
 * Nothing of the author's object is wrapped, copied, extended or read: the index holds it only as
 * a key.
 */
export interface QueuedProviderRegistration<C extends object = object> {
	readonly name: string;
	readonly config: C;
	readonly sourceId: string;
	readonly owner: ExtensionCallbackOwner;
}

const queuedByConfig = new WeakMap<object, QueuedProviderRegistration[]>();
const queuedRecords = new WeakSet<object>();

/** Indexes a record a runtime has just queued. */
export function rememberQueuedProviderRegistration(registration: QueuedProviderRegistration): void {
	queuedRecords.add(registration);
	const queued = queuedByConfig.get(registration.config);
	if (queued) {
		if (!queued.includes(registration)) queued.push(registration);
	} else {
		queuedByConfig.set(registration.config, [registration]);
	}
}

/** Drops records that left a queue without being registered: an `unregisterProvider` before the
 *  drain, or a failed extension's rollback. */
export function forgetQueuedProviderRegistrations(registrations: Iterable<object>): void {
	for (const registration of registrations) {
		if (!isQueuedRecord(registration)) continue;
		const queued = queuedByConfig.get(registration.config);
		if (!queued) continue;
		const index = queued.indexOf(registration);
		if (index >= 0) queued.splice(index, 1);
		if (queued.length === 0) queuedByConfig.delete(registration.config);
	}
}

/** Re-indexes records a rollback put back into a queue, in queue order. */
export function restoreQueuedProviderRegistrations(registrations: Iterable<object>): void {
	for (const registration of registrations) {
		if (isQueuedRecord(registration)) rememberQueuedProviderRegistration(registration);
	}
}

/** Only records a runtime queued through {@link rememberQueuedProviderRegistration} are indexed;
 *  anything else a host puts in a queue is not ours to forget or restore. */
function isQueuedRecord(value: object): value is QueuedProviderRegistration {
	return queuedRecords.has(value);
}

/**
 * The session a registration being applied belongs to, consuming its queued record.
 *
 * With `owner` given, the caller knows; the matching record of that owner is consumed so it
 * cannot be claimed again by a later ownerless registration of the same object. Without it,
 * the oldest record still queued for this object, name and source is the one being drained.
 * Records that match equally are interchangeable for the registry: same object, same name, same
 * source — only their owners differ, and each drain gets a different one.
 */
export function claimProviderRegistrationOwner(
	name: string,
	config: object,
	sourceId: string | undefined,
	owner: ExtensionCallbackOwner | undefined,
): ExtensionCallbackOwner | undefined {
	const queued = queuedByConfig.get(config);
	if (!queued) return owner;
	const index = queued.findIndex(
		registration =>
			registration.name === name &&
			(sourceId === undefined || registration.sourceId === sourceId) &&
			(owner === undefined || registration.owner === owner),
	);
	if (index < 0) return owner;
	const [claimed] = queued.splice(index, 1);
	if (queued.length === 0) queuedByConfig.delete(config);
	if (!claimed) return owner;
	// Registered now: a later rollback that puts the same record back must not make it claimable
	// a second time.
	queuedRecords.delete(claimed);
	return owner ?? claimed.owner;
}

const gatesByOwner = new WeakMap<ExtensionCallbackOwner, ProviderCallGate>();

/** The lifetime a registry hands to the provider entries this session registered. Reads the
 *  owner's state live rather than a snapshot — retirement happens between registration and call
 *  — and is the SAME object every time for one session, because the registries use it to tell
 *  one session's entries from another's when a registration is replaced or withdrawn. */
export function providerCallGate(owner: ExtensionCallbackOwner): ProviderCallGate {
	const existing = gatesByOwner.get(owner);
	if (existing) return existing;
	const gate: ProviderCallGate = {
		get retired(): boolean {
			return owner.isRetired;
		},
		run: <R>(call: () => R): R => owner.runOwned(call),
	};
	gatesByOwner.set(owner, gate);
	return gate;
}
