/**
 * Daemon lease held by a browser consumer for as long as it uses a
 * daemon-supervised process (the project-shared Chromium, the browser relay).
 *
 * Leases are connection-bound: a daemon restart drops them. The holder
 * retakes its lease on reconnect, but only on the very process generation it
 * was using — a different generation is a different browser, whose consumers
 * re-open it themselves.
 */
import { logger } from "@oh-my-pi/pi-utils";
import type { DaemonClient, OpenRequest, OpenResult, UnitScope, UnitSnapshot } from "../../daemon/protocol";
import { throwIfAborted } from "../tool-errors";

/** Identity triple of a unit. */
export interface UnitIdentity {
	kind: string;
	scope: UnitScope;
	key: string;
}

/** True while the unit has a process (or is about to). */
export function isLiveUnit(unit: UnitSnapshot | undefined): boolean {
	return unit !== undefined && unit.state !== "exited" && unit.state !== "failed";
}

/** The unit's snapshot, or undefined when the daemon knows no such unit (or did not answer). */
export async function describeUnit(
	client: DaemonClient,
	unit: UnitIdentity | string,
	signal?: AbortSignal,
): Promise<UnitSnapshot | undefined> {
	try {
		return (await client.request({ op: "describe", unit }, signal)).unit;
	} catch (error) {
		throwIfAborted(signal);
		logger.debug("Daemon describe failed", { error: error instanceof Error ? error.message : String(error) });
		return undefined;
	}
}

/** A lease from {@link DaemonClient.open}, kept across daemon reconnects until {@link release}d. */
export class UnitLease {
	readonly #client: DaemonClient;
	readonly #request: OpenRequest;
	readonly #unit: UnitSnapshot;
	readonly #unsubscribe: () => void;
	#lease: string | undefined;
	#released = false;

	constructor(client: DaemonClient, request: OpenRequest, result: OpenResult) {
		this.#client = client;
		this.#request = request;
		this.#unit = result.unit;
		this.#lease = result.lease;
		this.#unsubscribe = client.onReconnect(() => {
			void this.#retake();
		});
	}

	/** The unit as it was when the lease was taken. */
	get unit(): UnitSnapshot {
		return this.#unit;
	}

	async #retake(): Promise<void> {
		this.#lease = undefined;
		const { kind, scope, key } = this.#request;
		const current = await describeUnit(this.#client, { kind, scope, key });
		if (this.#released || !current || !isLiveUnit(current) || current.generation !== this.#unit.generation) return;
		try {
			const reopened = await this.#client.open({
				...this.#request,
				replace: false,
				awaitReady: false,
				lease: true,
			});
			if (this.#released) {
				if (reopened.lease) await this.#client.release(reopened.lease);
				return;
			}
			this.#lease = reopened.lease;
		} catch (error) {
			logger.debug("Failed to retake daemon lease", {
				key,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	/** Drop the lease; the unit's idle policy takes over once no client holds one. Idempotent, never throws. */
	async release(): Promise<void> {
		if (this.#released) return;
		this.#released = true;
		this.#unsubscribe();
		const lease = this.#lease;
		this.#lease = undefined;
		if (!lease) return;
		try {
			await this.#client.release(lease);
		} catch (error) {
			logger.debug("Failed to release daemon lease", {
				key: this.#request.key,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
}
