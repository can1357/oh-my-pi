/**
 * Shared types for TUI rendering components.
 */
import type { Theme } from "../modes/theme/theme";

export type State = "pending" | "running" | "success" | "error" | "warning";

export interface TreeContext {
	index: number;
	isLast: boolean;
	depth: number;
	theme: Theme;
	prefix: string;
	continuePrefix: string;
	/** Maximum rendered branch/continuation prefix width reserved during pre-rendering. */
	prefixWidth?: number;
}
