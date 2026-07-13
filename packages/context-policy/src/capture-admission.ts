import type { ConsentRecord } from "./types";

export interface CaptureRequest {
	userId: string;
	deviceId: string;
	sessionId: string;
	projectId?: string;
	applicationId?: string;
	persistent: boolean;
}

export interface AdmissionDecision {
	allowed: boolean;
	persistent: boolean;
	reason?: string;
}

/** Preserve the existing transient capture path while fail-closing persistence. */
export function authorizeCapture(request: CaptureRequest, consent: ConsentRecord | undefined): AdmissionDecision {
	if (!request.persistent) return { allowed: true, persistent: false };
	if (!consent?.enabled) return denied("persistent context is disabled");
	if (!consent.identityVerified) return denied("persistent context requires verified identity");
	if (consent.revokedAt) return denied("persistent context consent is revoked");
	if (consent.userId !== request.userId || consent.deviceId !== request.deviceId)
		return denied("consent identity mismatch");

	switch (consent.scope) {
		case "none":
			return denied("persistent context consent scope is none");
		case "session":
			return consent.sessionId === request.sessionId
				? { allowed: true, persistent: true }
				: denied("session is outside the consent scope");
		case "project":
			return consent.projectIds?.includes(request.projectId ?? "")
				? { allowed: true, persistent: true }
				: denied("project is outside the consent scope");
		case "selected_apps":
			return consent.applicationIds?.includes(request.applicationId ?? "")
				? { allowed: true, persistent: true }
				: denied("application is outside the consent scope");
		case "device":
		case "trusted_devices":
			return { allowed: true, persistent: true };
	}
}

function denied(reason: string): AdmissionDecision {
	return { allowed: false, persistent: false, reason };
}
