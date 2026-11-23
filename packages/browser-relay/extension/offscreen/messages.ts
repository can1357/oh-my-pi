import type { GifFrame } from "../messages";

/** Extension page hosting the canvas and GIF encoder. */
export const OFFSCREEN_PAGE = "offscreen.html";

/** Worker → offscreen document request to compose and encode a run. */
export type EncodeGifRequest = { omp: "encode-gif"; frames: GifFrame[] };

/** Offscreen → worker GIF data URL or a readable error for the panel. */
export type EncodeGifResult = { ok: true; url: string } | { ok: false; error: string };
