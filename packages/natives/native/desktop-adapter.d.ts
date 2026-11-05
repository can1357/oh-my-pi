import type { DesktopSession } from "./index.js";

/** Return the current native ABI, or a constructor that rejects an outdated addon on first desktop use. */
export function adaptDesktopSession(NativeDesktopSession: unknown): typeof DesktopSession;
