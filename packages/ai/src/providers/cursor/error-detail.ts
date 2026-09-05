import type { RunInferenceErrorDetail } from "@oh-my-pi/pi-catalog/discovery/cursor-proto";
import { ErrorDetailsSchema } from "@oh-my-pi/pi-catalog/discovery/cursor-proto";
import { fromBinary, type JsonValue } from "@oh-my-pi/pi-catalog/discovery/protobuf";

const ERROR_DETAILS_TYPE = "aiserver.v1.ErrorDetails";

function decodeErrorDetails(detail: RunInferenceErrorDetail) {
	if (detail.type !== ERROR_DETAILS_TYPE) return undefined;
	try {
		return fromBinary(ErrorDetailsSchema, detail.value);
	} catch {
		return undefined;
	}
}

/** Render typed Cursor error metadata without treating protobuf bytes as UTF-8. */
export function cursorErrorDetailValue(detail: RunInferenceErrorDetail): JsonValue {
	const decoded = decodeErrorDetails(detail);
	return decoded === undefined ? new TextDecoder().decode(detail.value) : ErrorDetailsSchema.toJson(decoded);
}

/** Decode Cursor's structured upstream HTTP status from invocation error metadata. */
export function cursorProviderStatusCode(details: readonly RunInferenceErrorDetail[]): number | undefined {
	for (const detail of details) {
		const value = decodeErrorDetails(detail)?.details?.additionalInfo.providerStatusCode;
		if (value !== undefined && /^[1-5]\d\d$/u.test(value)) return Number(value);
	}
	return undefined;
}
