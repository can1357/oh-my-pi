import { type SpotlightDetails, type SpotlightOriginal } from "../../../tools/details/spotlight";

/** Whether a trace has an original to show. */
export function hasSpotlightOriginal(
	spotlight: SpotlightDetails,
): spotlight is SpotlightDetails & { original: SpotlightOriginal } {
	return spotlight.original !== undefined;
}
