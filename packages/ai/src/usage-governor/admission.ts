import { AsyncLocalStorage } from "node:async_hooks";
import { logger } from "@oh-my-pi/pi-utils";
import { fingerprintBearer } from "../auth/bearer-fingerprint";
import type {
	UsageAdmission,
	UsageAdmissionOutcome,
	UsageAdmissionRequest,
	UsageRequestContext,
	UsageRouteBinding,
} from "./types";

let registered: UsageAdmission | undefined;
const scopedAdmission = new AsyncLocalStorage<{ admission: UsageAdmission | undefined }>();

/**
 * Registers the usage admission seam for this thread: the main thread, or one worker. `undefined` clears it.
 * Every governed send consults it. With no seam, or with `active: false`, sends keep their pre-governor path.
 */
export function configureUsageAdmission(admission: UsageAdmission | undefined): void {
	registered = admission;
}

/** Runs work with its own admission owner, including an explicitly absent owner. */
export function withUsageAdmission<T>(admission: UsageAdmission | undefined, run: () => T): T {
	return scopedAdmission.run({ admission }, run);
}

/** Clear only the matching explicitly configured fallback. */
export function clearUsageAdmission(admission: UsageAdmission): void {
	if (registered === admission) registered = undefined;
}

/** The scoped owner, or the explicitly configured thread fallback. */
export function currentUsageAdmission(): UsageAdmission | undefined {
	const scope = scopedAdmission.getStore();
	return scope ? scope.admission : registered;
}

/** Attribution for one send, as its call site knows it. */
export interface UsageAdmissionCall {
	/** Captured owner for this physical send; null explicitly means none. */
	admission?: UsageAdmission | null;
	/** Stored credential row serving the send, when known. */
	credentialId?: number;
	/** The bearer about to be sent, passed to the governor only as a fingerprint. */
	bearer?: string;
	provider?: string;
	modelId?: string;
	baseUrl?: string;
	context?: UsageRequestContext;
	usageRouteBinding?: UsageRouteBinding;
}

function admissionRequest(call: UsageAdmissionCall): UsageAdmissionRequest {
	const request: UsageAdmissionRequest = {
		credentialId: call.credentialId,
		provider: call.provider,
		modelId: call.modelId,
		baseUrl: call.baseUrl,
		context: call.context,
		usageRouteBinding: call.usageRouteBinding,
	};
	if (call.bearer) request.bearerFingerprint = fingerprintBearer(call.bearer);
	return request;
}

/** The cached authorization for an automatically selected route no longer holds. */
export class UsageRouteInvalidatedError extends Error {
	constructor() {
		super("Usage route authorization is no longer valid");
		this.name = "UsageRouteInvalidatedError";
	}
}

/** Reject bound sends even when admission is absent or degraded. */
export function validateSendRoute(call: UsageAdmissionCall): void {
	const binding = call.usageRouteBinding;
	if (!binding) return;
	const request = admissionRequest(call);
	const admission = call.admission === undefined ? currentUsageAdmission() : call.admission;
	if (!admission?.active || admission.validateRoute?.(binding, request) !== true) {
		throw new UsageRouteInvalidatedError();
	}
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
	const admission = call.admission === undefined ? currentUsageAdmission() : call.admission;
	const captured = { ...call, admission: admission ?? null };
	validateSendRoute(captured);
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
