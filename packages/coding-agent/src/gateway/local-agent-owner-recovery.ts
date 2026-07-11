import {
	SessionAlreadyOwnedError,
	SessionWriterGuard,
	type SessionWriterGuardHandle,
} from "../session/session-writer-guard";
import type { LocalAgentRuntimeDescriptor } from "./local-agent-owner-types";

export type LocalAgentOwnerRecoveryResult<T> =
	| { readonly recovered: false; readonly reason: "lease_fresh" | "writer_active" }
	| {
			readonly recovered: true;
			readonly ownerEpoch: number;
			readonly guard: SessionWriterGuardHandle;
			readonly value: T;
	  };

export interface RecoverLocalAgentOwnerOptions<T> {
	readonly descriptor: LocalAgentRuntimeDescriptor;
	readonly now?: number;
	readonly lockRoot?: string;
	readonly recover: (guard: SessionWriterGuardHandle, nextOwnerEpoch: number) => Promise<T>;
}

/**
 * Performs the only permitted crashed-owner takeover gate. Lease expiry makes a
 * runtime eligible for recovery; acquisition of the rollback-journal guard is
 * the proof that the previous process no longer owns a transcript writer.
 */
export async function recoverLocalAgentOwner<T>(
	options: RecoverLocalAgentOwnerOptions<T>,
): Promise<LocalAgentOwnerRecoveryResult<T>> {
	if ((options.now ?? Date.now()) < options.descriptor.leaseExpiresAt) {
		return { recovered: false, reason: "lease_fresh" };
	}
	let guard: SessionWriterGuardHandle;
	try {
		guard = SessionWriterGuard.acquire({
			sessionId: options.descriptor.sessionId,
			transcriptPath: options.descriptor.transcriptPath,
			lockRoot: options.lockRoot,
		});
	} catch (error) {
		if (error instanceof SessionAlreadyOwnedError) return { recovered: false, reason: "writer_active" };
		throw error;
	}
	try {
		const ownerEpoch = options.descriptor.ownerEpoch + 1;
		const value = await options.recover(guard, ownerEpoch);
		return { recovered: true, ownerEpoch, guard, value };
	} catch (error) {
		await guard.release();
		throw error;
	}
}
