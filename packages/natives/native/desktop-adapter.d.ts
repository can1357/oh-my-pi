import type { DesktopSession } from "./index.js";

/** Return a missing export as undefined and reject stale native ABIs on first desktop use. */
export function adaptDesktopSession(NativeDesktopSession: undefined): undefined;
export function adaptDesktopSession(NativeDesktopSession: unknown): typeof DesktopSession | undefined;
