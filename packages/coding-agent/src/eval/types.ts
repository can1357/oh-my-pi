import type { ImageContent } from "@oh-my-pi/pi-ai";
import type { EvalLanguage, EvalStatusEvent, EvalView } from "@oh-my-pi/pi-tui/tools/eval";
import { isRecord } from "@oh-my-pi/pi-utils/type-guards";

/** Kernel-defined tool metadata exposed to task subagents. */
export interface EvalToolDescriptor {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
	language: EvalLanguage;
}

/** Result of invoking a kernel-defined tool. */
export type EvalToolInvokeResult = { ok: true; value: unknown } | { ok: false; error: string };

/** Image metadata accepted at the untyped JS/Python display boundary. */
export function evalImageMetadata(value: unknown): Pick<ImageContent, "detail" | "providerFile" | "url"> {
	const metadata: Pick<ImageContent, "detail" | "providerFile" | "url"> = {};
	if (!isRecord(value)) return metadata;
	if (value.detail === "auto" || value.detail === "low" || value.detail === "high" || value.detail === "original") {
		metadata.detail = value.detail;
	}
	if (typeof value.url === "string") metadata.url = value.url;
	const file = value.providerFile;
	if (isRecord(file) && (file.provider === "openai" || file.provider === "anthropic" || file.provider === "google")) {
		metadata.providerFile = { provider: file.provider };
		if (typeof file.id === "string") metadata.providerFile.id = file.id;
		if (typeof file.uri === "string") metadata.providerFile.uri = file.uri;
		if (typeof file.expiresAt === "number" && Number.isFinite(file.expiresAt)) {
			metadata.providerFile.expiresAt = file.expiresAt;
		}
	}
	return metadata;
}

/**
 * Non-text output of an eval cell, from either backend:
 * - an image, sent to the model and shown to the user;
 * - a `view`: a pretty rendering of `text` the cell printed, for the user only
 *   (the model sees `text` in the output stream);
 * - a helper `status` event for the UI.
 */
export type EvalDisplayOutput =
	| ImageContent
	| { type: "view"; text: string; view: EvalView }
	| { type: "status"; event: EvalStatusEvent };

/**
 * The first error a cell's output consumer threw, from either backend. The
 * cell kept running and its later output still went to the consumer.
 */
export interface EvalOutputConsumerFailure {
	/** `onChunk` for streamed text and tracebacks; `onDisplay` for views, images and status events. */
	callback: "onChunk" | "onDisplay";
	message: string;
}

/**
 * Records `thrown` as `callback`'s failure, and never throws. A consumer may
 * throw or reject with any value, including one whose conversion to text
 * throws: a null-prototype object, an error with a throwing `message` getter,
 * a `Proxy` whose traps throw. A failure to describe it must not escape, or the
 * report would itself end the Python reader or the host process.
 */
export function outputConsumerFailure(
	callback: EvalOutputConsumerFailure["callback"],
	thrown: unknown,
): EvalOutputConsumerFailure {
	try {
		return { callback, message: thrown instanceof Error ? String(thrown.message) : String(thrown) };
	} catch {
		// Its own conversion threw; this one calls no `toString` or `valueOf` the value defines.
	}
	try {
		return { callback, message: Object.prototype.toString.call(thrown) };
	} catch {
		// A Proxy throws even here.
	}
	return { callback, message: `a thrown ${typeof thrown} that cannot be converted to text` };
}
