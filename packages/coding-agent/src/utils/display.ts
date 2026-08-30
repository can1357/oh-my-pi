/**
 * True when a GUI can be reached: a window server always exists off Linux,
 * while X11/Wayland must be advertised through the environment there.
 *
 * Shared because clipboard tooling and headful-browser launches gate on the
 * same fact — two copies would let platform hardening drift apart, and the
 * failure mode is a hang or an opaque "Missing X server" rather than a clean
 * skip.
 *
 * Deliberately its own module with no imports: `@oh-my-pi/pi-utils/env` would be
 * the natural home, but that module parses `.env` files at import time, and
 * `cli.ts` must not pull it in before profile bootstrap runs.
 */
export function hasDisplay(): boolean {
	return process.platform !== "linux" || Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}
