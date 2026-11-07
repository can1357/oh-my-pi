/**
 * Published alias for the shared promise-race helper.
 *
 * `raceSignal` used to be implemented here; the body now lives in
 * `utils/abort.ts` as `raceWithSignal`, which also takes the abort `message`
 * and keeps the underlying promise observed so a caller that leaves never turns
 * the work's later rejection into an unhandled one.
 *
 * `@oh-my-pi/pi-ai/auth/abort` is a published import path, so the name stays
 * exported for external consumers. Internal code should import
 * `raceWithSignal` from `../utils/abort` directly.
 */
export { raceWithSignal as raceSignal } from "../utils/abort";
