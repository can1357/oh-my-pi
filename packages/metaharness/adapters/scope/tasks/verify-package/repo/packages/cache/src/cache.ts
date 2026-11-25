import { type Clock, systemClock } from "../../util/src/clock";
import { expiresAt } from "./ttl";

/** In-memory cache whose entries expire after their TTL. */
export class TtlCache<T> {
	#entries = new Map<string, { value: T; expires: number }>();
	#clock: Clock;

	constructor(clock: Clock = systemClock) {
		this.#clock = clock;
	}

	set(key: string, value: T, ttl: string): void {
		this.#entries.set(key, { value, expires: expiresAt(this.#clock.now(), ttl) });
	}

	get(key: string): T | undefined {
		const entry = this.#entries.get(key);
		if (!entry) return undefined;
		if (this.#clock.now() >= entry.expires) {
			this.#entries.delete(key);
			return undefined;
		}
		return entry.value;
	}
}
