import type { DesktopRosterWindow, DesktopSession, DesktopSessionOptions } from "./index.js";

/** Construct a desktop session, loading the native addon on first use. */
export declare function createDesktopSession(options: DesktopSessionOptions): DesktopSession;

/** Physical-Escape stops counted under `key`, loading the native addon on first use. */
export declare function desktopEscapeStops(key: string): number;

/** Drop the stop count kept under `key`. */
export declare function forgetDesktopEscapeStops(key: string): void;

/** Invalidate this process's event taps before it exits (see the native doc). */
export declare function closeDesktopEventTaps(): void;

/**
 * Sample every on-screen window, popup menus and system panels included,
 * loading the native addon on first use. Empty off macOS.
 */
export declare function desktopWindowRoster(): DesktopRosterWindow[];
