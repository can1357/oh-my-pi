/**
 * `composer/footer` corpus: the classic footer through usage, context,
 * thinking and extension-status changes.
 */
import * as os from "node:os";
import { jsx, signal } from "@oh-my-pi/pi-tui";
import { Footer, type FooterFacts } from "../../../src/ui/status/footer";
import "../../../src/ui/styles/status";
import { stagedSuite } from "./corpus-suite";

/** The capture's session double (`inputs.session`). */
interface FooterMock {
	readonly model?: { readonly id: string; readonly contextWindow?: number; readonly thinking?: unknown };
	readonly thinkingLevel?: string;
	readonly auto: boolean;
	readonly resolved?: string;
	readonly usage: FooterFacts["usage"];
	readonly ctx?: { readonly tokens: number | null; readonly contextWindow: number; readonly percent: number | null };
	readonly sub: boolean;
}

function footerFacts(mock: FooterMock): FooterFacts {
	return {
		...(mock.model
			? {
					model: {
						id: mock.model.id,
						thinking: mock.model.thinking !== undefined,
						contextWindow: mock.model.contextWindow,
					},
				}
			: {}),
		thinkingLevel: mock.thinkingLevel,
		autoThinking: mock.auto,
		autoResolvedLevel: mock.resolved,
		usage: mock.usage,
		usingSubscription: mock.sub,
		...(mock.ctx
			? { context: { tokens: mock.ctx.tokens, window: mock.ctx.contextWindow, percent: mock.ctx.percent } }
			: {}),
		autoCompact: true,
		// The capture ran in the checkout's `packages/tui`; git was off.
		cwd: "/work/.tree/agents/pi-ui/packages/tui",
		home: os.homedir(),
		statuses: [],
	};
}

stagedSuite("composer/footer", corpusCase => {
	const inputs = corpusCase.inputs as { session: FooterMock };
	const facts = signal(footerFacts(inputs.session));
	const statuses = new Map<string, string>();
	const update = (patch: Partial<FooterFacts>) => facts.set({ ...facts(), ...patch });
	const setStatus = (key: string, text: string | undefined) => {
		if (text === undefined) statuses.delete(key);
		else statuses.set(key, text);
		const sorted = [...statuses].sort(([a], [b]) => a.localeCompare(b)).map(([, value]) => value);
		update({ statuses: sorted });
	};
	const steps: Record<string, () => void> = {
		"autocompact off": () => update({ autoCompact: false }),
		"extension status b": () => setStatus("b", "second \x1b[31mred\x1b[0m\ttab"),
		"extension status a": () => setStatus("a", "first status 日本語 with a long long long long long long long text"),
		"auto thinking resolved medium": () =>
			update({
				autoThinking: true,
				autoResolvedLevel: "medium",
				model: { id: "x", contextWindow: 10, thinking: true },
			}),
		"usage grows (input 5M, cost 42, ctx 90%)": () =>
			update({
				usage: { ...facts().usage, input: 5_000_000, cost: 42 },
				context: { tokens: 9, window: 10, percent: 90 },
			}),
		"clear extension status": () => {
			setStatus("a", undefined);
			setStatus("b", undefined);
		},
		"autocompact on": () => update({ autoCompact: true }),
	};
	return {
		tree: jsx(Footer, { facts }),
		step(label) {
			const step = steps[label];
			if (!step) throw new Error(`footer: unknown stage ${label}`);
			step();
		},
	};
});
