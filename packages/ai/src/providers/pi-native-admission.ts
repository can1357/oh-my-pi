/** Request-scoped origin admission for governed pi-native inference. */
export const PI_NATIVE_ADMISSION_VERSION = 1;
export const PI_NATIVE_GOVERNED_STREAM_PATH = "/v1/pi/stream/admitted";
export const PI_NATIVE_ADMISSION_PATH = "/v1/pi/admission";
export const PI_NATIVE_ADMISSION_HEADER = "x-omp-native-admission";

export interface PiNativeAdmissionRequest {
	version: typeof PI_NATIVE_ADMISSION_VERSION;
}

export interface PiNativeAdmissionEvent {
	type: "inference_admission";
	requestId: string;
	nonce: string;
	attempt: number;
}

export interface PiNativeAdmissionDecision {
	requestId: string;
	nonce: string;
	allow: boolean;
}

export interface PiNativeAdmissionControl {
	beforeRequest(): Promise<void>;
	bind(emit: (event: PiNativeAdmissionEvent) => void): void;
	close(reason?: unknown): void;
}

export function isPiNativeAdmissionEvent(value: unknown): value is PiNativeAdmissionEvent {
	if (typeof value !== "object" || value === null) return false;
	const event = value as Partial<PiNativeAdmissionEvent>;
	return (
		event.type === "inference_admission" &&
		typeof event.requestId === "string" &&
		event.requestId.length > 0 &&
		typeof event.nonce === "string" &&
		event.nonce.length > 0 &&
		typeof event.attempt === "number" &&
		Number.isSafeInteger(event.attempt) &&
		event.attempt > 0
	);
}

export function isPiNativeAdmissionDecision(value: unknown): value is PiNativeAdmissionDecision {
	if (typeof value !== "object" || value === null) return false;
	const decision = value as Partial<PiNativeAdmissionDecision>;
	return (
		typeof decision.requestId === "string" &&
		decision.requestId.length > 0 &&
		typeof decision.nonce === "string" &&
		decision.nonce.length > 0 &&
		typeof decision.allow === "boolean"
	);
}
