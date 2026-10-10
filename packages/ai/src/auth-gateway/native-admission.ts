import { timingSafeEqual } from "node:crypto";
import { ModelSelectionError, StreamTimeoutError } from "../error";
import type {
	PiNativeAdmissionControl,
	PiNativeAdmissionDecision,
	PiNativeAdmissionEvent,
} from "../providers/pi-native-admission";

const ADMISSION_TIMEOUT_MS = 100_000;

interface PendingAdmission {
	event: PiNativeAdmissionEvent;
	resolve(): void;
	reject(reason: unknown): void;
	timer: Timer;
}

function ownerDigest(authorization: string): Uint8Array {
	return new Bun.CryptoHasher("sha256").update(authorization).digest();
}

class NativeAdmissionSession implements PiNativeAdmissionControl {
	readonly #pending = new Map<string, PendingAdmission>();
	readonly #owner: Uint8Array;
	#emit: ((event: PiNativeAdmissionEvent) => void) | undefined;
	#attempt = 0;
	#closed = false;
	readonly #onAbort = (): void => this.close(this.signal.reason);

	constructor(
		readonly requestId: string,
		authorization: string,
		readonly signal: AbortSignal,
		readonly onClose: () => void,
	) {
		this.#owner = ownerDigest(authorization);
		signal.addEventListener("abort", this.#onAbort, { once: true });
	}

	async beforeRequest(): Promise<void> {
		this.signal.throwIfAborted();
		if (this.#closed) throw new ModelSelectionError("The native admission request has closed.");
		const nonce = crypto.randomUUID();
		const deferred = Promise.withResolvers<void>();
		const event: PiNativeAdmissionEvent = {
			type: "inference_admission",
			requestId: this.requestId,
			nonce,
			attempt: ++this.#attempt,
		};
		const timer = setTimeout(() => {
			this.#settle(nonce, new StreamTimeoutError("Origin admission timed out before native inference."));
		}, ADMISSION_TIMEOUT_MS);
		timer.unref();
		this.#pending.set(nonce, { event, resolve: deferred.resolve, reject: deferred.reject, timer });
		try {
			this.#emit?.(event);
			await deferred.promise;
		} finally {
			const pending = this.#pending.get(nonce);
			if (pending) {
				clearTimeout(pending.timer);
				this.#pending.delete(nonce);
			}
		}
	}

	bind(emit: (event: PiNativeAdmissionEvent) => void): void {
		if (this.#closed) return;
		if (this.#emit) throw new ModelSelectionError("Native admission was bound to more than one response.");
		this.#emit = emit;
		for (const { event } of this.#pending.values()) emit(event);
	}

	decide(decision: PiNativeAdmissionDecision, authorization: string): boolean {
		if (this.#closed || !this.#pending.has(decision.nonce)) return false;
		if (!timingSafeEqual(this.#owner, ownerDigest(authorization))) return false;
		this.#settle(
			decision.nonce,
			decision.allow ? undefined : new ModelSelectionError("The originating session denied native inference."),
		);
		return true;
	}

	#settle(nonce: string, reason?: unknown): void {
		const pending = this.#pending.get(nonce);
		if (!pending) return;
		this.#pending.delete(nonce);
		clearTimeout(pending.timer);
		if (reason === undefined) pending.resolve();
		else pending.reject(reason);
	}

	close(reason: unknown = new Error("Native admission response closed.")): void {
		if (this.#closed) return;
		this.#closed = true;
		this.signal.removeEventListener("abort", this.#onAbort);
		this.#emit = undefined;
		for (const nonce of this.#pending.keys()) this.#settle(nonce, reason);
		this.onClose();
	}
}

/** One gateway instance owns its request-bound, one-use origin approvals. */
export class NativeAdmissionRegistry {
	readonly #sessions = new Map<string, NativeAdmissionSession>();

	open(requestId: string, authorization: string, signal: AbortSignal): PiNativeAdmissionControl {
		signal.throwIfAborted();
		const session = new NativeAdmissionSession(requestId, authorization, signal, () => {
			this.#sessions.delete(requestId);
		});
		this.#sessions.set(requestId, session);
		return session;
	}

	decide(decision: PiNativeAdmissionDecision, authorization: string): boolean {
		return this.#sessions.get(decision.requestId)?.decide(decision, authorization) ?? false;
	}

	close(): void {
		for (const session of this.#sessions.values()) session.close();
	}
}
