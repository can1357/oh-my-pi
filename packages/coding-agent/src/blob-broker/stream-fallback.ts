/**
 * Transparent provider-file to URL to inline recovery for image requests.
 * Retries are allowed only before the provider emits content, keeping the
 * consumer-facing stream single and ordered.
 */

import type { StreamFn } from "@oh-my-pi/pi-agent-core";
import type { Context } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { logger } from "@oh-my-pi/pi-utils";
import { contextHasImageUrls, contextHasProviderFiles } from "./context-images";
import type { ImageUrlService } from "./service";

type ImageSource = "provider-file" | "url" | "inline";

function imageSource(context: Context): ImageSource {
	if (contextHasProviderFiles(context)) return "provider-file";
	return contextHasImageUrls(context) ? "url" : "inline";
}

/** Wrap `base` with provider-file then URL then inline recovery. */
export function wrapStreamFnWithBlobUrlFallback(base: StreamFn, broker: ImageUrlService | undefined): StreamFn {
	if (!broker) return base;
	return (model, context, options) => {
		if (!contextHasProviderFiles(context) && !contextHasImageUrls(context)) return base(model, context, options);

		const outer = new AssistantMessageEventStream();
		let sawStart = false;

		const run = async (): Promise<void> => {
			let attemptContext = context;
			let failedSourceAwaitingProof: ImageSource | undefined;
			for (;;) {
				const source = imageSource(attemptContext);
				const inner = await base(model, attemptContext, options);
				let sawAttemptContent = false;
				let retry = false;
				let succeeded = false;
				for await (const event of inner) {
					if (event.type === "start") {
						if (!sawStart) {
							sawStart = true;
							outer.push(event);
						}
						continue;
					}
					if (event.type === "error" && !sawAttemptContent && event.error.stopReason === "error") {
						const fallback = await broker.fallbackContext(attemptContext, model);
						const fallbackSource = imageSource(fallback);
						if (source !== "inline" && fallbackSource !== source) {
							logger.warn("blob-broker: provider rejected image source; retrying with fallback", {
								provider: model.provider,
								model: model.id,
								source,
								fallback: fallbackSource,
								error: event.error.errorMessage?.slice(0, 200),
							});
							attemptContext = fallback;
							failedSourceAwaitingProof = source;
							retry = true;
							break;
						}
					}
					if (event.type === "done") succeeded = true;
					else if (event.type !== "error") sawAttemptContent = true;
					outer.push(event);
				}
				if (retry) continue;
				if (succeeded && failedSourceAwaitingProof === "url") {
					broker.quarantine(model.provider, "request failed with image URLs but succeeded with inline data");
				}
				return;
			}
		};

		void run().catch(error => {
			if (!outer.done) outer.fail(error);
		});
		return outer;
	};
}
