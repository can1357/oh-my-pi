import { logger } from "@oh-my-pi/pi-utils";
import { fingerprintBearer } from "../auth/bearer-fingerprint";
import type { UsageAdmission, UsageAdmissionOutcome, UsageAdmissionRequest, UsageRequestContext } from "./types";

let registered: UsageAdmission | undefined;

/**
 * Registers the usage admission seam for this thread: the main thread, or one worker. `undefined` clears it.
 * Every governed send consults it. With no seam, or with `active: false`, sends keep their pre-governor path.
 */
export function configureUsageAdmission(admission: UsageAdmission | undefined): void {
	registered = admission;
}

/** The seam registered on this thread, if any. */
export function currentUsageAdmission(): UsageAdmission | undefined {
	return registered;
}

/** Attribution for one send, as its call site knows it. */
export interface UsageAdmissionCall {
	/** Stored credential row serving the send, when known. */
	credentialId?: number;
	/** The bearer about to be sent, passed to the governor only as a fingerprint. */
	bearer?: string;
	provider?: string;
	modelId?: string;
	baseUrl?: string;
	context?: UsageRequestContext;
}

function admissionRequest(call: UsageAdmissionCall): UsageAdmissionRequest {
	const request: UsageAdmissionRequest = {
		credentialId: call.credentialId,
		provider: call.provider,
		modelId: call.modelId,
		baseUrl: call.baseUrl,
		context: call.context,
	};
	if (call.bearer) request.bearerFingerprint = fingerprintBearer(call.bearer);
	return request;
}

/** One admitted send. `settle` reports its outcome to the seam once; later calls do nothing. */
export interface AdmittedSend {
	settle(outcome: UsageAdmissionOutcome): void;
}

/**
 * Admits one send before it leaves the process. Resolves `undefined` when no seam is active or the seam does
 * not govern the send, and the caller then sends without settling. Rejects only when `signal` aborts first, so
 * nothing is sent.
 */
export async function admitSend(call: UsageAdmissionCall, signal?: AbortSignal): Promise<AdmittedSend | undefined> {
	const admission = registered;
	if (!admission?.active) return undefined;
	const grant = await admission.admit(admissionRequest(call), signal);
	if (grant === undefined) return undefined;
	let settled = false;
	return {
		settle(outcome) {
			if (settled) return;
			settled = true;
			try {
				admission.settle(grant.id, outcome);
			} catch (error) {
				// A ledger fault must not hang or fail the send it accounts for.
				logger.warn("Usage admission settle failed", { error: String(error) });
			}
		},
	};
}
