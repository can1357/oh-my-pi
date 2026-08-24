/**
 * `@oh-my-pi/pi-agent-core/presentation` — the typed presentation boundary.
 *
 * A deliberately dependency-free module graph: nothing under `src/presentation/`
 * imports anything outside itself, which is what lets the strict presentation
 * TypeScript project (`tsconfig.presentation.json`, with
 * `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`) own exactly this
 * boundary and nothing else.
 */
export * from "./presentation/index";
