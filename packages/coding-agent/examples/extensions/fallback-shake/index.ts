import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import {
	MAX_THINKING_SUFFIX_OPTIONS,
	parseModelString,
	splitUpstreamRouting,
} from "@oh-my-pi/pi-tui/overlays/model-selector";
import { shouldShakeFallback } from "./rule";

export default function fallbackShake(pi: ExtensionAPI): void {
	let pending: Promise<unknown> | undefined;
	pi.on("retry_fallback_applied", async (event, ctx) => {
		const parseOptions = {
			...MAX_THINKING_SUFFIX_OPTIONS,
			isLiteralModelId: (provider: string, id: string) => ctx.modelRegistry.find(provider, id) !== undefined,
		};
		const resolveIdentity = (selector: string) => {
			const parsed = parseModelString(selector, parseOptions);
			return (
				(parsed && ctx.modelRegistry.find(parsed.provider, parsed.id)) ??
				ctx.models.resolve(selector) ??
				parseModelString(splitUpstreamRouting(selector)?.base ?? selector, parseOptions)
			);
		};
		const shouldShake = shouldShakeFallback({
			agentKind: ctx.agent.kind,
			target: event.target,
			from: resolveIdentity(event.from),
			to: resolveIdentity(event.to),
			current: ctx.model,
		});
		if (!shouldShake) return;
		// Duplicate concurrent notifications share the same history rewrite.
		if (pending) {
			await pending;
			return;
		}
		pending = ctx.shake({ protectTurns: 6 });
		try {
			await pending;
		} finally {
			pending = undefined;
		}
	});
}
