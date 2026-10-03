import { beforeAll, describe, expect, it } from "bun:test";
import { node, text } from "../src/native/describe";
import type { DescribeContext, NativeNode } from "../src/native/node";
import { StatusLineComponent } from "../src/status-line/component";
import type { StatusLineHost, StatusLineSession } from "../src/status-line/host";
import type { SegmentContext } from "../src/status-line/segments";
import type { StatusLineRenderer, StatusLineSettings } from "../src/status-line/types";
import { initTheme } from "../src/theme";

beforeAll(async () => {
	await initTheme();
});

function createSession(modelName: string): StatusLineSession {
	return {
		state: { model: { id: modelName, name: modelName }, messages: [] },
		isStreaming: false,
		isAutoThinking: false,
		sessionManager: {
			getSessionName: () => undefined,
			getSessionId: () => "session-1",
			getUsageStatistics: () => ({
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				orchestrationInput: 0,
				orchestrationOutput: 0,
				orchestrationCacheRead: 0,
				premiumRequests: 0,
				cost: 0,
			}),
		},
		modelRegistry: { isUsingOAuth: () => false },
		isFastModeActive: () => false,
		getAsyncJobSnapshot: () => ({ running: [] }),
	} as unknown as StatusLineSession;
}

function createHost(settings?: StatusLineSettings): StatusLineHost {
	return {
		// A real segment list, so "the built-in bar has the surface" is
		// observable. With no segments configured the bar renders empty and every
		// assertion about it would pass for the wrong reason.
		getSettings: () => settings ?? { preset: "custom", leftSegments: ["model"], rightSegments: [] },
		gitEnabled: () => false,
		codexResetFireworksEnabled: () => false,
		getSettingsRevision: () => 0,
		getSessionSettingsIdentity: () => "session-1",
		getSessionSettingsRevision: () => 0,
		goalStatusInFooter: () => false,
		activeAccount: () => undefined,
		canFetchUsageReports: () => false,
		fetchUsageReports: () => Promise.resolve(undefined),
		resolveActiveRepo: () => null,
		lookupPullRequest: () => Promise.resolve({ stdout: "", exitCode: 0 }),
		calculateTokensPerSecond: () => null,
		limitMatchesActiveAccount: () => false,
		computeCompactionBoundaries: () => null,
	} as unknown as StatusLineHost;
}

/**
 * Every built-in placement that could paint the surface a second time.
 *
 * The prepaint frame is not among them: `createStartupStatusLine` builds a
 * separate component that is disposed when the session-bound bar mounts, so it
 * never shares this component's override and cannot duplicate the rows.
 */
function builtInSurfaces(component: StatusLineComponent, width: number): Record<string, string> {
	return {
		topBorder: component.getTopBorder(width).content,
		bandTopBorder: component.getBandTopBorder(width).content,
		standaloneTopBorder: component.getStandaloneTopBorder(width).content,
	};
}

/**
 * A component with the standalone bottom bar actually enabled, so "the built-in
 * bar owns the surface" is observable. A bare component leaves `#standalone`
 * false and paints nothing, which would make every claim about who holds the
 * surface pass for the wrong reason.
 */
function createComponent(modelName: string, settings?: StatusLineSettings): StatusLineComponent {
	const component = new StatusLineComponent(createSession(modelName), createHost(settings));
	component.setComposerStyle({ statusAttachment: "none", bottomBar: "full", bottomBarGap: false });
	return component;
}

/** The describe context a frame hands the composer. */
const cx: DescribeContext = {
	cols: 80,
	reduceMotion: false,
	dark: true,
	supports: () => true,
	feature: () => true,
};

/** The dock block a renderer mounts on a TSP terminal, or undefined when it has none. */
function dockBlock(component: StatusLineComponent, cols = 80): NativeNode | undefined {
	const block = component.describeNativeBlock({ ...cx, cols });
	return block.k === "col" && !block.c?.length ? undefined : block;
}

/** Keys of the `seg`s in the bar's flexible space, in order. */
function segKeys(component: StatusLineComponent): (string | undefined)[] {
	return (component.describeComposerFacts(cx).extras.c ?? [])
		.filter(child => "k" in child && child.k === "seg")
		.map(child => ("k" in child ? child.key : undefined));
}

describe("status line renderer override", () => {
	it("paints the renderer's rows through the one status surface", () => {
		const component = createComponent("main-model");
		expect(component.render(80).join("\n")).toContain("main-model");

		component.setRendererOverride({ id: "rows", label: "Rows", render: () => ["ROW-A", "ROW-B"] });

		// The composer's StatusHost is the only thing that may show the rows...
		expect(component.render(80)).toEqual(["ROW-A", "ROW-B"]);
		// ...so every built-in placement must be empty, or the rows are painted
		// twice and each frame builds a second SegmentContext.
		expect(builtInSurfaces(component, 80)).toEqual({
			topBorder: "",
			bandTopBorder: "",
			standaloneTopBorder: "",
		});
	});

	it("yields the renderer's rows, truncated to the available width", () => {
		const component = new StatusLineComponent(createSession("main-model"), createHost());
		const renderer: StatusLineRenderer = {
			id: "rows",
			label: "Rows",
			render: () => ["first row", "second row", "a".repeat(120)],
		};
		component.setRendererOverride(renderer);
		const rows = component.render(40);
		expect(rows).toHaveLength(3);
		expect(rows[0]).toBe("first row");
		expect(rows[1]).toBe("second row");
		expect(rows[2]?.length).toBe(40);
	});

	it("expands tabs in renderer rows and keeps one row from injecting another", () => {
		const component = new StatusLineComponent(createSession("main-model"), createHost());
		component.setRendererOverride({
			id: "rows",
			label: "Rows",
			render: () => ["a\tb", "first\nsecond", "trailing\r\n"],
		});
		// A raw tab punches a hole in the terminal, and an embedded newline would
		// smuggle in an extra TUI row the renderer never declared.
		expect(component.render(80)).toEqual(["a   b", "first second", "trailing "]);
	});

	it("hands the renderer the focused subagent session and id", () => {
		const main = createSession("main-model");
		const sub = createSession("subagent-model");
		const component = new StatusLineComponent(main, createHost());
		const seen: SegmentContext[] = [];
		component.setRendererOverride({
			id: "rows",
			label: "Rows",
			render: ctx => {
				seen.push(ctx);
				return [ctx.session.state.model?.name ?? ""];
			},
		});

		expect(component.render(80)).toEqual(["main-model"]);

		component.setSession(sub, "agent-7");
		expect(component.render(80)).toEqual(["subagent-model"]);
		expect(seen.at(-1)?.focusedAgentId).toBe("agent-7");
		expect(seen.at(-1)?.session).toBe(sub);

		component.setSession(main, undefined);
		expect(component.render(80)).toEqual(["main-model"]);
		expect(seen.at(-1)?.focusedAgentId).toBeUndefined();
	});

	it("hands the built-in bar back when the renderer is removed", () => {
		const component = createComponent("main-model");
		component.setRendererOverride({ id: "rows", label: "Rows", render: () => ["row"] });
		expect(component.render(80)).toEqual(["row"]);

		component.setRendererOverride(undefined);
		expect(component.render(80).join("\n")).toContain("main-model");
	});

	it("reports a broken renderer and does not reinstall it on the next sync", () => {
		const component = createComponent("main-model");
		const reported: { error: unknown; id: string }[] = [];
		component.setRendererErrorSink((error, renderer) => reported.push({ error, id: renderer.id }));

		let calls = 0;
		const broken: StatusLineRenderer = {
			id: "rows",
			label: "Rows",
			render: () => {
				calls++;
				throw new Error("boom");
			},
		};
		component.setRendererOverride(broken);

		// The throw must not blank the surface: the built-in bar takes it back.
		expect(component.render(80).join("\n")).toContain("main-model");
		expect(reported).toHaveLength(1);
		expect(reported[0]?.id).toBe("rows");
		expect(String(reported[0]?.error)).toContain("boom");

		// The runner still holds the broken renderer, so a shape re-sync would
		// otherwise reinstall it on the very next frame.
		component.setRendererOverride(broken);
		expect(component.render(80).join("\n")).toContain("main-model");
		expect(calls).toBe(1);

		// A genuine re-registration is the escape hatch for a renderer that has
		// been fixed, so it gets one more attempt.
		component.setRendererOverride(broken, { retry: true });
		component.render(80);
		expect(calls).toBe(2);
	});

	it("previews the renderer's rows instead of the bar it replaced", () => {
		const component = new StatusLineComponent(createSession("main-model"), createHost());
		component.setRendererOverride({ id: "rows", label: "Rows", render: () => ["preview row", "second"] });
		expect(component.getPreviewLines(80)).toEqual(["preview row", "second"]);
	});
});

/**
 * The Tern Surface Protocol path builds its bar from `describeComposerFacts()`
 * and never reads `render()`, so a `render()`-only renderer cannot reach it and
 * the host has to decline the override there. A renderer that also describes
 * the bar reaches it through `describeNative`, which takes the bar's flexible
 * space from the configured segments.
 */
describe("the TSP native surface", () => {
	it("leaves a render()-only renderer's facts alone: it paints in the dock, not the bar", () => {
		const component = createComponent("main-model");
		const before = component.describeComposerFacts(cx);
		component.setRendererOverride({ id: "rows", label: "Rows", render: () => ["ROW-A"] });

		// The box surface took the rows...
		expect(component.render(80)).toEqual(["ROW-A"]);
		// ...while the native facts came back identical: a renderer with no
		// describeNative has no bar description, so the bar keeps the built-in
		// segments and the renderer is mounted in the dock instead.
		expect(component.describeComposerFacts(cx)).toEqual(before);
	});

	it("gives a described bar the flexible space the configured segments held", () => {
		const component = createComponent("main-model", {
			preset: "custom",
			leftSegments: ["hostname"],
			rightSegments: [],
		});
		expect(segKeys(component)).toEqual(["hostname"]);

		component.setRendererOverride({
			id: "rows",
			label: "Rows",
			render: () => ["ROW-A"],
			describeNative: () => node("status", { role: "omp.composer.extras", grow: 1 }, [text("mine")], "mine"),
		});

		const extras = component.describeComposerFacts(cx).extras;
		expect(extras).toMatchObject({ k: "status", p: { role: "omp.composer.extras" } });
		expect(segKeys(component)).toEqual([]);
	});

	it("leaves the composer's own chrome alone: the model chip, the usage text, the context hairline", () => {
		const component = createComponent("main-model");
		component.setRendererOverride({
			id: "rows",
			label: "Rows",
			render: () => ["ROW-A"],
			describeNative: () => text("mine"),
		});

		// A renderer describes the segments, not the composer: these three are
		// the composer's, and dropping them would take the send key and the
		// context readout with it.
		const facts = component.describeComposerFacts(cx);
		expect(facts.model.spans.map(span => span.t).join("")).toContain("main-model");
		expect(facts.usage.p).toMatchObject({ role: "omp.composer.usage" });
		expect(facts.context.p).toMatchObject({ role: "omp.composer.context" });
	});

	it("describes from the same segment context the built-in facts came from", () => {
		const component = createComponent("main-model");
		let seen: { model: string; hook: string | undefined; cols: number } | undefined;
		component.setRendererOverride({
			id: "rows",
			label: "Rows",
			render: () => ["ROW-A"],
			describeNative: native => {
				seen = {
					model: native.segments.options.model ? "y" : "n",
					hook: native.hookStatuses.get("build"),
					cols: native.cols,
				};
				return null;
			},
		});
		component.setHookStatus("build", "green");

		component.describeComposerFacts({ ...cx, cols: 120 });
		// One context, so the description cannot disagree with the bar it replaces.
		expect(seen?.hook).toBe("green");
		expect(seen?.cols).toBe(120);
		// Returning null declines the slot, so the built-in facts are described —
		// hook statuses included, since nothing took them over.
		expect(segKeys(component)).toEqual(["hook-0"]);
	});

	it("reuses the previous node for an equivalent description and rebuilds for a changed one", () => {
		const component = createComponent("main-model");
		let label = "first";
		// A fresh object on every call, the way a renderer that builds its tree
		// inline will behave.
		component.setRendererOverride({
			id: "rows",
			label: "Rows",
			render: () => ["ROW-A"],
			describeNative: () => text(label),
		});

		const first = component.describeComposerFacts(cx);
		expect(component.describeComposerFacts(cx)).toBe(first);

		// Asked again, and it built a new object with the same content. The host
		// fingerprints the description, so the reconciler keeps the node it
		// already has and nothing is re-sent — a description has to be stable
		// in content, not in identity.
		component.invalidate();
		expect(component.describeComposerFacts(cx)).toBe(first);

		// A genuinely different description does replace it, so the fingerprint
		// is not swallowing real changes.
		label = "second";
		component.invalidate();
		expect(component.describeComposerFacts(cx)).not.toBe(first);
	});

	it("blocks a describeNative that throws and hands the bar back to the built-in facts", () => {
		const component = createComponent("main-model", {
			preset: "custom",
			leftSegments: ["hostname"],
			rightSegments: [],
		});
		const failures: { id: string; error: string }[] = [];
		component.setRendererErrorSink((error, renderer) => failures.push({ id: renderer.id, error: String(error) }));
		const broken: StatusLineRenderer = {
			id: "rows",
			label: "Rows",
			render: () => ["ROW-A"],
			describeNative: () => {
				throw new Error("describe blew up");
			},
		};
		component.setRendererOverride(broken);

		const facts = component.describeComposerFacts(cx);
		// The bar is the built-in one again, not an empty slot and not a crash.
		expect(segKeys(component)).toEqual(["hostname"]);
		expect(facts.extras.p).toMatchObject({ role: "omp.composer.extras" });
		expect(failures).toEqual([{ id: "rows", error: "Error: describe blew up" }]);

		// The box surface comes back too — the built-in bar, not the
		// renderer's rows — and a later re-sync must not reinstall a
		// renderer that already proved broken.
		const box = component.render(80);
		expect(box.join("\n")).not.toContain("ROW-A");
		expect(box.length).toBeGreaterThan(0);
		component.setRendererOverride(broken);
		expect(component.describeComposerFacts(cx).extras.p).toMatchObject({ role: "omp.composer.extras" });
		expect(failures).toHaveLength(1);
	});

	it("does not trail hook statuses behind a described bar", () => {
		const component = createComponent("main-model", { preset: "custom", leftSegments: [], rightSegments: [] });
		component.setHookStatus("build", "green");
		expect(segKeys(component)).toEqual(["hook-0"]);

		component.setRendererOverride({
			id: "rows",
			label: "Rows",
			render: () => ["ROW-A"],
			describeNative: () => text("mine"),
		});

		// On a box terminal the renderer takes the hook rows too, so leaving them
		// here would show statuses the renderer never asked for.
		expect(segKeys(component)).toEqual([]);
	});
});

/**
 * The dock block is the other native mount: where a `render()`-only renderer
 * reaches a Tern terminal, and where a renderer with multi-row content puts it.
 */
describe("the TSP dock block", () => {
	it("hands the focused subagent session to the dock block, so the rows follow focus there too", () => {
		const main = createSession("main-model");
		const sub = createSession("subagent-model");
		const component = new StatusLineComponent(main, createHost());
		const seen: SegmentContext[] = [];
		component.setRendererOverride({
			id: "rows",
			label: "Rows",
			render: ctx => {
				seen.push(ctx);
				return [ctx.session.state.model?.name ?? ""];
			},
		});

		// The dock block is the only mount on a Tern terminal, and it is what a
		// renderer is for: without the focused session here, its rows would
		// describe the main agent while the user reads a subagent window.
		expect(dockBlock(component)).toMatchObject({ k: "rows" });
		expect(seen.at(-1)?.session).toBe(main);
		expect(seen.at(-1)?.focusedAgentId).toBeUndefined();

		component.setSession(sub, "agent-7");
		expect(dockBlock(component)?.p).toMatchObject({ lines: ["subagent-model"] });
		expect(seen.at(-1)?.focusedAgentId).toBe("agent-7");
		expect(seen.at(-1)?.session).toBe(sub);
	});

	it("mounts a render()-only renderer's rows, which is how it reaches a Tern terminal", () => {
		const component = createComponent("main-model");
		expect(dockBlock(component)).toBeUndefined();

		component.setRendererOverride({ id: "rows", label: "Rows", render: () => ["ROW-A", "ROW-B"] });

		const block = dockBlock(component);
		expect(block?.k).toBe("rows");
		// Every row kept, in order, and truncated to the surface width it was
		// described at — the same rows the box surface would show.
		expect(block?.p).toEqual({ cols: 80, lines: ["ROW-A", "ROW-B"] });
	});

	it("truncates to the surface width, so a row cannot overflow the dock", () => {
		const component = createComponent("main-model");
		component.setRendererOverride({ id: "rows", label: "Rows", render: () => ["x".repeat(200)] });
		const block = dockBlock(component, 40);
		expect(block).toBeDefined();
		if (!block) throw new Error("no dock block");
		expect(block.p).toMatchObject({ cols: 40 });
		expect((block.p as { lines: string[] }).lines[0]!.length).toBe(40);
	});

	it("mounts a dock-placed renderer's described node, and leaves the bar to the built-in facts", () => {
		const component = createComponent("main-model", {
			preset: "custom",
			leftSegments: ["hostname"],
			rightSegments: [],
		});
		component.setRendererOverride({
			id: "rows",
			label: "Rows",
			render: () => ["ROW-A"],
			nativePlacement: "dock",
			describeNative: () => text("described block"),
		});

		// The node, not the rows: a described dock block is semantic, so the
		// terminal themes and lays it out itself.
		expect(dockBlock(component)).toEqual({ k: "text", p: { text: "described block" }, c: undefined, key: undefined });
		// And the bar keeps its segments, so the content is mounted once.
		expect(segKeys(component)).toEqual(["hostname"]);
	});

	it("mounts a bar-placed renderer's node in the bar only, never in both", () => {
		const component = createComponent("main-model", {
			preset: "custom",
			leftSegments: ["hostname"],
			rightSegments: [],
		});
		component.setRendererOverride({
			id: "rows",
			label: "Rows",
			render: () => ["ROW-A"],
			nativePlacement: "bar",
			describeNative: () => text("described bar"),
		});

		expect(component.describeComposerFacts(cx).extras).toMatchObject({ k: "text", p: { text: "described bar" } });
		// Default placement is the bar, and a described bar leaves the dock empty,
		// so the same content is never painted twice.
		expect(dockBlock(component)).toBeUndefined();
	});

	it("empties the block and drops a renderer whose rows throw, rather than painting nothing silently", () => {
		const component = createComponent("main-model");
		const failures: string[] = [];
		component.setRendererErrorSink((error, renderer) => failures.push(renderer.id));
		component.setRendererOverride({
			id: "rows",
			label: "Rows",
			render: () => {
				throw new Error("boom");
			},
		});

		// The rows are the only thing a render()-only renderer paints here, so a
		// throw empties the block and drops the id — reported, not silent.
		expect(dockBlock(component)).toBeUndefined();
		expect(failures).toEqual(["rows"]);
		// The bar never went through the renderer, so its facts are the built-in
		// ones and a later re-sync cannot reinstall the broken renderer.
		expect(segKeys(component)).toEqual([]);
		expect(dockBlock(component)).toBeUndefined();
		expect(failures).toHaveLength(1);
	});
});
