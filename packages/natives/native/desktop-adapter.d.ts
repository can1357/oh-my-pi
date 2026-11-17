import type { DesktopSession } from "./index.js";

type NativeDesktopClass = typeof DesktopSession;
type NativeDesktopConstructor = new (...args: never[]) => unknown;

/** Reject stale native ABIs on first desktop use without unsafe fallbacks. */
export function adaptDesktopSession(NativeDesktopSession: NativeDesktopConstructor): NativeDesktopClass;
export function adaptDesktopSession(NativeDesktopSession: undefined): undefined;
export function adaptDesktopSession(NativeDesktopSession: NativeDesktopConstructor | undefined): NativeDesktopClass | undefined;
