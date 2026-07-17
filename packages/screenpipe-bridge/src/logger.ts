/**
 * Minimal structural logger so hosts can route bridge diagnostics through
 * their own facility (e.g. the coding agent's `logger` from
 * `@pk-nerdsaver-ai/pi-utils` satisfies this shape) without this package
 * depending on any of them.
 */
export interface BridgeLogger {
	info(message: string, context?: Record<string, unknown>): void;
	warn(message: string, context?: Record<string, unknown>): void;
}

export const consoleBridgeLogger: BridgeLogger = {
	info(message, context) {
		if (context === undefined) console.info(message);
		else console.info(message, context);
	},
	warn(message, context) {
		if (context === undefined) console.warn(message);
		else console.warn(message, context);
	},
};
