/**
 * Published alias for the shared promise-race helper.
 *
 * `raceSignal` used to be implemented here; the body now lives in
 * `utils/abort.ts` (as `raceWithSignal`, which also takes the abort `message`).
 * `@oh-my-pi/pi-ai/auth/abort` is a published import path, so the name stays
 * exported for external consumers. Internal code should import
 * `raceWithSignal` from `../utils/abort` directly.
 */
export { raceWithSignal as raceSignal } from "../utils/abort";
