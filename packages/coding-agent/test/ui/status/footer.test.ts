/**
 * `composer/footer` corpus: the classic footer through usage, context,
 * thinking and extension-status changes.
 */
import * as os from "node:os";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createRoot, jsx, resolveChildren, signal } from "@oh-my-pi/pi-tui";
import { paintNode, staticEnvironment } from "@oh-my-pi/pi-tui/term/paint";
import { loadThemeSync } from "@oh-my-pi/pi-tui/theme/loader";
import { currentTheme, setCurrentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
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

describe("footer symbols", () => {
	let restoreTheme: () => void;
	beforeEach(() => {
		const theme = currentTheme();
		restoreTheme = () => setCurrentTheme(theme);
	});
	afterEach(() => restoreTheme());

	test("draws subscription, auto-compaction and pending thinking marks with the active preset", () => {
		const facts = footerFacts({
			model: { id: "model", contextWindow: 200_000, thinking: true },
			auto: true,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, premiumRequests: 0, cost: 0 },
			sub: true,
		});
		const theme = loadThemeSync("dark", { symbolPreset: "nerd" });
		const { symbols } = theme;
		setCurrentTheme(theme);
		createRoot(dispose => {
			try {
				const [footer] = resolveChildren(jsx(Footer, { facts: () => facts }))();
				if (!footer) throw new Error("Expected the footer");
				const stats = Bun.stripANSI(paintNode(staticEnvironment(theme), footer, 100).rows[1] ?? "");
				expect(stats).toContain(`${symbols.icon("subscription")} 0.0%/200K ${symbols.icon("auto")} `);
				expect(stats).toEndWith(`model • ${symbols.symbol("thinking.autoPending")} auto`);
			} finally {
				dispose();
			}
		});
	});

	test("marks AI credits as a lower bound once a turn sent no billing frame, even before any credit is reported", () => {
		const theme = loadThemeSync("dark", { symbolPreset: "unicode" });
		setCurrentTheme(theme);
		const statsRow = (usage: Partial<FooterFacts["usage"]>): string =>
			createRoot(dispose => {
				try {
					const facts = footerFacts({
						model: { id: "model", contextWindow: 200_000, thinking: true },
						auto: false,
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, premiumRequests: 0, cost: 0, ...usage },
						sub: false,
					});
					const [footer] = resolveChildren(jsx(Footer, { facts: () => facts }))();
					if (!footer) throw new Error("Expected the footer");
					return Bun.stripANSI(paintNode(staticEnvironment(theme), footer, 100).rows[1] ?? "");
				} finally {
					dispose();
				}
			});

		expect(statsRow({ aiuNano: 436_590_000 })).toContain("0.44 cr");
		expect(statsRow({ aiuNano: 436_590_000, aiuUnreportedTurns: 1 })).toContain("0.44+ cr");
		expect(statsRow({ aiuUnreportedTurns: 2 })).toContain("0.00+ cr");
		expect(statsRow({})).not.toContain(" cr");
	});
});

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
