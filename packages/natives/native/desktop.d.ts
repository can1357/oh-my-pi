import type { DesktopSession, DesktopSessionOptions } from "./index.js";

/** Construct a desktop session, loading the native addon on first use. */
export declare function createDesktopSession(options: DesktopSessionOptions): DesktopSession;

/** Physical-Escape stops counted under `key`, loading the native addon on first use. */
export declare function desktopEscapeStops(key: string): number;

/** Drop the stop count kept under `key`. */
export declare function forgetDesktopEscapeStops(key: string): void;
