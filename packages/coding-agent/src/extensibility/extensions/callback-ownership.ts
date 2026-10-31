import type { AdmittedWorkKind, ProviderCallGate } from "@oh-my-pi/pi-ai/auth/provider-gate";
import { copyHostData } from "./boundary-data";
import type { ExtensionCallbackOwner } from "./types";

/**
 * One `pi.registerProvider` call waiting in a runtime's queue, and the session that made it.
 *
 * Ownership belongs to the registration OCCURRENCE, not to the configuration object. An author may
 * hand the same object to every session that loads the extension — a module-level constant, a
 * subagent rebinding its parent's extensions — so the object alone cannot say which session a
 * given registration came from. The record is the occurrence's token: the runtime creates it when
 * the session queues the registration, it carries its own owner, and a drain that passes that
 * owner to `ModelRegistry.registerProvider` needs nothing else.
 *
 * A host that drains the queue itself passes only the documented three fields, which lose the
 * token. The registry then recovers it from the drain itself, never from queue age: the records
 * the host has taken out of the queue, or the one its `for…of` over the queue is on, are the ones
 * drained. A drain the registry cannot see — an index loop or `forEach` over the queue in place —
 * drains nothing it can tell apart, so every matching record still waiting is a candidate. The
 * candidates that match name, object and source must all belong to one session, or the
 * registration is refused — a guess would install one session's provider under another's
 * lifetime, where the right session's withdrawal cannot reach it. Records that left the queue
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
/** Each indexed record's queue, read when asked: a host may replace a runtime's queue array. */
const queueOfRecord = new WeakMap<object, () => readonly object[]>();
/** Records a `for…of` over their queue is on right now, counted because such loops may nest. */
const iteratedRecords = new WeakMap<object, number>();

/** The iterator of a {@link createProviderRegistrationQueue} queue: marks each record while the
 *  loop that asked for it is on it. */
function* iterateProviderRegistrationQueue<C extends object>(
	this: readonly QueuedProviderRegistration<C>[],
): Generator<QueuedProviderRegistration<C>, void, undefined> {
	for (let index = 0; index < this.length; index++) {
		const record = this[index];
		if (typeof record !== "object" || record === null) {
			yield record;
			continue;
		}
		iteratedRecords.set(record, (iteratedRecords.get(record) ?? 0) + 1);
		try {
			yield record;
		} finally {
			const remaining = (iteratedRecords.get(record) ?? 1) - 1;
			if (remaining > 0) iteratedRecords.set(record, remaining);
			else iteratedRecords.delete(record);
		}
	}
}

/**
 * A runtime's queue of provider registrations: an ordinary array whose `for…of` the registry can
 * see. While a host's loop over the queue is on a record, that record is the one being drained even
 * though it has not left the queue — the in-place drain hosts write. Index loops and `forEach` are
 * not observed: they register a record only while one session's records match it, and a host
 * draining that way over several sessions' queues takes the records out first or passes their
 * owners.
 */
export function createProviderRegistrationQueue<C extends object>(): QueuedProviderRegistration<C>[] {
	const queue: QueuedProviderRegistration<C>[] = [];
	for (const key of [Symbol.iterator, "values"]) {
		Object.defineProperty(queue, key, {
			value: iterateProviderRegistrationQueue,
			writable: true,
			configurable: true,
		});
	}
	return queue;
}

/** Indexes a record a runtime has just queued, with the way to read the queue it waits in. */
export function rememberQueuedProviderRegistration(
	registration: QueuedProviderRegistration,
	queue: () => readonly object[],
): void {
	queueOfRecord.set(registration, queue);
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
		const queue = queueOfRecord.get(registration);
		if (queue && isQueuedRecord(registration)) rememberQueuedProviderRegistration(registration, queue);
	}
}

/** Only records a runtime queued through {@link rememberQueuedProviderRegistration} are indexed;
 *  anything else a host puts in a queue is not ours to forget or restore. */
function isQueuedRecord(value: object): value is QueuedProviderRegistration {
	return queueOfRecord.has(value);
}

/** Whether the host has drained a record: taken it out of its queue, or is iterating over it. */
function isDrained(record: QueuedProviderRegistration): boolean {
	if (iteratedRecords.has(record)) return true;
	const queue = queueOfRecord.get(record);
	return queue === undefined || !queue().includes(record);
}

/**
 * The session a registration being applied belongs to, consuming its queued record.
 *
 * With `owner` given, the caller knows; that owner's matching record is consumed, wherever it is,
 * so a later ownerless registration of the same object cannot claim it again. Without `owner`, the
 * candidates are the matching records the host drained (see {@link QueuedProviderRegistration}),
 * or, when it drained none — an index loop or `forEach` over the queue in place — every matching
 * record still waiting. Candidates of one session are that session's; candidates of several are
 * refused rather than guessed.
 */
export function claimProviderRegistrationOwner(
	name: string,
	config: object,
	sourceId: string | undefined,
	owner: ExtensionCallbackOwner | undefined,
): ExtensionCallbackOwner | undefined {
	const queued = queuedByConfig.get(config);
	if (!queued) return owner;
	const matching = queued.filter(
		registration => registration.name === name && (sourceId === undefined || registration.sourceId === sourceId),
	);
	let claimed: QueuedProviderRegistration | undefined;
	if (owner) {
		claimed = matching.find(registration => registration.owner === owner);
	} else {
		const drained = matching.filter(isDrained);
		const candidates = drained.length > 0 ? drained : matching;
		const first = candidates[0];
		if (first && candidates.some(registration => registration.owner !== first.owner)) {
			throw new Error(
				`Provider "${name}": queued registrations of this configuration by several sessions match, so which session this one belongs to cannot be told. Pass the record's owner, as registerProvider(entry.name, entry.config, entry.sourceId, entry.owner), or drain one queue at a time by taking its records out of the queue (for example with splice) before registering them.`,
			);
		}
		claimed = first;
	}
	if (!claimed) return owner;
	queued.splice(queued.indexOf(claimed), 1);
	if (queued.length === 0) queuedByConfig.delete(config);
	// Registered now: a later rollback that puts the same record back must not make it claimable
	// a second time.
	queueOfRecord.delete(claimed);
	return owner ?? claimed.owner;
}

const gatesByOwner = new WeakMap<ExtensionCallbackOwner, ProviderCallGate>();
/** Each gate's registrant: the runtime whose session it belongs to. */
const registrantOfGate = new WeakMap<ProviderCallGate, ExtensionCallbackOwner>();

/**
 * The lifetime a registry hands to the provider entries an owner registered: the owner given —
 * the runtime itself for what an extension factory registered at load, live for each session it
 * serves in turn, or one session's owner (`ExtensionCallbackOwner.forSession`) for what that
 * session registered, retired with it and never live again. It reads the owner's state live —
 * retirement happens between registration and call — and is the SAME object every time for one
 * owner, because the registries use it to tell one owner's entries from another's. What it hands
 * the session (`hand`) is a copy.
 */
export function providerCallGate(owner: ExtensionCallbackOwner): ProviderCallGate {
	const existing = gatesByOwner.get(owner);
	if (existing) return existing;
	const gate: ProviderCallGate = {
		get retired(): boolean {
			return owner.isRetired;
		},
		run: <R>(call: () => R, kind?: AdmittedWorkKind): R => owner.runOwned(call, kind),
		hand: <T>(value: T): T => copyHostData(value),
	};
	gatesByOwner.set(owner, gate);
	registrantOfGate.set(gate, owner.registrant ?? owner);
	// A runtime with sessions of its own (`forSession`) serves each in turn: its gate is retired
	// only between them. Any other owner's retirement is for good.
	if (owner.registrant === undefined && typeof owner.forSession === "function") gatesServingEachSession.add(gate);
	return gate;
}

/** The gates of a runtime that serves one session after another, rather than one lifetime. */
const gatesServingEachSession = new WeakSet<ProviderCallGate>();

/**
 * Whether what `gate` registered is over for good. A gate of one session (`forSession`) retires
 * once, when the session ends, and never comes back; so does an owner with one lifetime. A gate of
 * a runtime itself — what an extension registered at load — serves each session in turn and is
 * retired only between them: what it registered stays, refusing calls until the next session
 * claims the runtime.
 */
export function registrationEnded(gate: ProviderCallGate | undefined): boolean {
	return gate !== undefined && gate.retired && !gatesServingEachSession.has(gate);
}

/** Whether two gates are one registrant's: the same runtime, whichever of its sessions each
 *  belongs to. A withdrawal takes away the registrant's registrations, as it did when one gate
 *  served every session; only liveness is per session. */
export function sameRegistrant(left: ProviderCallGate | undefined, right: ProviderCallGate | undefined): boolean {
	if (left === undefined || right === undefined) return left === right;
	return left === right || (registrantOfGate.has(left) && registrantOfGate.get(left) === registrantOfGate.get(right));
}
