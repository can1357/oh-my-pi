import type { AdmittedWorkKind, ProviderCallGate } from "@oh-my-pi/pi-ai/auth/provider-gate";
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
 * token. The registry then recovers it from the drain itself, never from queue age: a record still
 * waiting in its runtime's queue has not been drained and is never claimed, while one the host has
 * taken out of the queue, or the one its `for…of` over the queue is on, has been. The drained
 * records that match name, object and source must all belong to one session, or the registration
 * is refused — a guess would install one session's provider under another's lifetime, where the
 * right session's withdrawal cannot reach it. Records that left the queue without being registered
 * are withdrawn from the index, so they can lend their owner to nobody. Nothing of the author's
 * object is wrapped, copied, extended or read: the index holds it only as a key.
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
 * not observed; a host draining that way takes the records out first or passes their owners.
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
 * record is the one the host drained (see {@link QueuedProviderRegistration}); this throws rather
 * than guess when drained records of several sessions match, or when the only matching records are
 * still waiting in their queues.
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
		const first = drained[0];
		if (first && drained.some(registration => registration.owner !== first.owner)) {
			throw new Error(
				`Provider "${name}": several sessions' queued registrations of this configuration have left their queues, so which one this is cannot be told. Pass the queued record's owner to registerProvider.`,
			);
		}
		if (!first && matching.length > 0) {
			throw new Error(
				`Provider "${name}": this configuration is still waiting in a session's queue. Take its record out of the queue, or pass the record's owner to registerProvider.`,
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
		run: <R>(call: () => R, kind?: AdmittedWorkKind): R => owner.runOwned(call, kind),
	};
	gatesByOwner.set(owner, gate);
	return gate;
}
