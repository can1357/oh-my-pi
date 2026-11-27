import { THINKING_EFFORTS } from "@oh-my-pi/pi-catalog/effort";
import type { ConfiguredThinkingLevel } from "../utils/render-utils";

/**
 * Thinking selectors accepted by CLI inputs, in display order.
 *
 * Kept separate from `./levels` so addon-free CLI paths (`omp --help`) do not
 * pull `@oh-my-pi/pi-catalog/models` and the native addon behind it.
 */
export const CLI_THINKING_LEVELS: readonly ConfiguredThinkingLevel[] = ["off", ...THINKING_EFFORTS, "auto"];
