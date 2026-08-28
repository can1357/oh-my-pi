/**
 * Setup version the wizard advances a fresh install to. Bump it whenever a new
 * setup scene lands (or an existing scene raises its `minVersion`).
 *
 * Kept in its own dependency-free module so the cold-launch gate in `main.ts`
 * can answer "is the stored setup version stale?" without statically importing
 * the full wizard — every scene (sign-in/OAuth, web search, theme previews) plus
 * the overlay component and their TUI deps. MUST equal `max(scene.minVersion)`
 * across `ALL_SCENES`; the `setup-wizard` barrel and test suite guard it.
 */
export const CURRENT_SETUP_VERSION = 2;
