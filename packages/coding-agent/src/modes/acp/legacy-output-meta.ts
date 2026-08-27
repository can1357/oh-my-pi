import type { PresentationOutputMeta } from "../../presentation/schemas/output-meta";
import { formatOutputNotice } from "../../tools/output-meta";

/**
 * Keep legacy formatter ownership outside `modes/acp/view`, whose strict
 * presentation project must not import the general tools implementation.
 */
export function formatLegacyOutputNotice(meta: PresentationOutputMeta | undefined): string {
	if (meta === undefined) return "";
	return formatOutputNotice(meta).trim();
}
