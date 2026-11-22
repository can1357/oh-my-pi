import { logger } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import {
	claimProviderTransitions,
	type ProviderAvailabilityTransition,
	subscribeProviderTransitions,
} from "./provider-exhaustion";
import { cfgProviderAvailabilityNoticeCommand } from "./settings";

export function formatProviderAvailabilityNotice(event: ProviderAvailabilityTransition): string {
	return `${event.provider} ${event.available ? "available" : "unavailable"} (${event.class}); since ${new Date(event.since).toISOString()}; failed calls: ${event.failedCallCount}`;
}

/** UI-only notices never enter model context. A host command receives the same event. */
export function bindProviderAvailabilityNotices(host: {
	settings: Settings;
	emitNotice(level: "info" | "warning", message: string, source?: string): void;
}): () => void {
	const deliver = (event: ProviderAvailabilityTransition): void => {
		host.emitNotice(
			event.available ? "info" : "warning",
			formatProviderAvailabilityNotice(event),
			"provider-availability",
		);
		const command = cfgProviderAvailabilityNoticeCommand.get(host.settings).trim();
		if (!command) return;
		// Config supplies the executable path. Provider-controlled fields travel only as stdin.
		try {
			const child = Bun.spawn([command], {
				stdin: new Blob([JSON.stringify(event)]),
				stdout: "ignore",
				stderr: "ignore",
				signal: AbortSignal.timeout(10_000),
			});
			void child.exited
				.then(code => {
					if (code !== 0) logger.warn("Provider availability notice command failed", { code });
				})
				.catch(error => logger.warn("Provider availability notice command failed", { error: String(error) }));
		} catch (error) {
			logger.warn("Provider availability notice command failed", { error: String(error) });
		}
	};
	const drain = (): void => {
		try {
			for (const event of claimProviderTransitions()) deliver(event);
		} catch (error) {
			logger.warn("Provider availability notice queue failed", { error: String(error) });
		}
	};
	const unsubscribe = subscribeProviderTransitions(drain);
	const timer = setInterval(drain, 5_000);
	timer.unref();
	drain();
	return () => {
		unsubscribe();
		clearInterval(timer);
	};
}
