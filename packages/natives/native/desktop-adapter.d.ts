import type { DesktopSession } from "./index.js";

/** Reject stale native ABIs on first desktop use without unsafe fallbacks. */
export function adaptDesktopSession(NativeDesktopSession: unknown): typeof DesktopSession;
