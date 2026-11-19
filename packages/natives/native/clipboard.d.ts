import type { ClipboardImage } from "./index.js";

export type { ClipboardImage } from "./index.js";

/** Copy text to the clipboard, loading the native addon on first use. */
export declare function copyToClipboard(text: string): void;

/** Read an image from the clipboard, loading the native addon on first use. */
export declare function readImageFromClipboard(): Promise<ClipboardImage | undefined | null>;

/** Read plain text from the clipboard, loading the native addon on first use. */
export declare function readTextFromClipboard(): Promise<string | undefined | null>;
