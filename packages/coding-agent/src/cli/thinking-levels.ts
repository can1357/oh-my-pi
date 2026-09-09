import { THINKING_EFFORTS } from "@oh-my-pi/pi-catalog/effort";

/**
 * Thinking selectors accepted by the `--thinking` CLI flag, in display order.
 * Shared by help metadata, shell completions, and validation warnings.
 */
export const CLI_THINKING_LEVELS: readonly string[] = ["off", ...THINKING_EFFORTS, "auto"];
