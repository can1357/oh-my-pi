/**
 * Effective snapcompact budgets after applying `snapcompact.frameBytesBudget`
 * and `snapcompact.maxFrames`. Compaction, context rebuilds, inline imaging, and
 * the send-time image clamp all resolve through here so every path applies the
 * same configured limits.
 */
import * as snapcompact from "@oh-my-pi/snapcompact";

/** Base64 bytes of archive frames one rebuilt request may carry; non-positive settings keep the default. */
export function snapcompactFrameBytesBudget(configured: number): number {
	return configured > 0 ? configured : snapcompact.FRAME_DATA_BYTES_BUDGET;
}

/**
 * Archive frame cap for `provider`. A positive `snapcompact.maxFrames` replaces the
 * provider-derived cap; either way the result never exceeds {@link snapcompact.MAX_FRAMES_DEFAULT},
 * which `snapcompact.compact` enforces regardless.
 */
export function snapcompactFrameBudget(provider: string | undefined, configuredMaxFrames: number): number {
	if (configuredMaxFrames < 1) return snapcompact.providerFrameBudget(provider);
	return Math.min(Math.floor(configuredMaxFrames), snapcompact.MAX_FRAMES_DEFAULT);
}

/**
 * Per-request image cap for `provider`, raised to at least the configured archive frame cap.
 * The cap counts every image in the request (archive frames, user and tool images); a request
 * over it loses its oldest images to the send-time clamp, archive frames included.
 */
export function providerImageBudget(provider: string | undefined, configuredMaxFrames: number): number {
	return Math.max(snapcompact.providerImageBudget(provider), snapcompactFrameBudget(provider, configuredMaxFrames));
}
