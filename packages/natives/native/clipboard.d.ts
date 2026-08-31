import type { ClipboardImage } from "./index.js";

export type { ClipboardImage } from "./index.js";

/** Copy text and keep serving it until clipboard ownership changes. */
export declare function copyToClipboardPersistent(text: string): void;


/** Read text from the clipboard. */
export declare function readTextFromClipboard(): string;

/** Copy text to the clipboard, loading the native addon on first use. */
export declare function copyToClipboard(text: string): void;

/** Read an image from the clipboard, loading the native addon on first use. */
export declare function readImageFromClipboard(): Promise<ClipboardImage | undefined | null>;
