import { afterEach, describe, expect, it, vi } from "bun:test";
import { parseHTML } from "@oh-my-pi/pi-utils/dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { getSessionContext } from "../src/client/api";
import { ContextRoute } from "../src/client/routes/ContextRoute";
import { ContextActivityGrid } from "../src/client/routes/context/ContextActivityGrid";
import { ContextFleetGraph } from "../src/client/routes/context/ContextFleetGraph";
import { FilesTab } from "../src/client/routes/context/FilesTab";
import { buildActivityCells } from "../src/client/routes/context/view-models";
import type { ContextOverview, ContextTimeline } from "../src/client/types";

type FetchInput = string | URL | Request;
type FetchInit = RequestInit | BunFetchRequestInit;

const originalGlobals = new Map<string, PropertyDescriptor | undefined>();
let root: Root | null = null;
let sequence = 0;

function installGlobal(name: string, value: unknown): void {
	originalGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
	Object.defineProperty(globalThis, name, { configurable: true, value, writable: true });
}

function setupDom(): HTMLElement {
	const domWindow = parseHTML('<html><body><div id="root"></div></body></html>').window;
	for (const [name, value] of [
		["window", domWindow],
		["document", domWindow.document],
		["navigator", domWindow.navigator],
		["Node", domWindow.Node],
		["Element", domWindow.Element],
		["HTMLElement", domWindow.HTMLElement],
		["HTMLIFrameElement", domWindow.HTMLIFrameElement],
		["SVGElement", domWindow.SVGElement],
		["IS_REACT_ACT_ENVIRONMENT", true],
		[
			"ResizeObserver",
			class {
				observe() {}
				unobserve() {}
				disconnect() {}
			},
		],
		["requestAnimationFrame", (callback: FrameRequestCallback) => {
			callback(0);
			return 1;
		}],
		["cancelAnimationFrame", () => {}],
	] as const)
		installGlobal(name, value);
	const container = domWindow.document.getElementById("root");
	if (!container) throw new Error("Expected test root");
	root = createRoot(container as unknown as Element);
	return container as unknown as HTMLElement;
}

function makeOverview(range: ContextOverview["range"] = "24h"): ContextOverview {
	const now = Date.now();
	const cutoff = now - 24 * 60 * 60 * 1000;
	const bucket = Math.floor((now - 60 * 60 * 1000) / 3_600_000) * 3_600_000;
	return {
		range,
		cutoff,
		heatmapBucketMs: 3_600_000,
		kpi: {
			sessions: 2,
			requests: 3,
			avgPromptTokens: 120,
			peakPromptTokens: 240,
			totalTokens: 600,
			promptTokens: 360,
			inputTokens: 240,
			outputTokens: 60,
			cacheReadTokens: 100,
			cacheWriteTokens: 20,
			cacheRate: 100 / 340,
			costTotal: 0.12,
			unpricedRequests: 1,
		},
		heatmap: [
			{
				bucket,
				requests: 3,
				promptTokens: 360,
				outputTokens: 60,
				totalTokens: 600,
				costTotal: 0.12,
				unpricedRequests: 1,
			},
		],
		models: [
			{ model: "model-a", requests: 3, promptTokens: 360, totalTokens: 600, costTotal: 0.12, unpricedRequests: 1 },
		],
		sessions: [
			{
				file: `/tmp/context-${++sequence}.jsonl`,
				folder: "/tmp",
				title: "Context test",
				models: ["model-a"],
				startedAt: now - 2 * 60 * 60 * 1000,
				endedAt: now - 30 * 60 * 1000,
				requests: 2,
				totalTokens: 300,
				promptTokens: 200,
				peakPromptTokens: 180,
				avgPromptTokens: 100,
				inputTokens: 120,
				outputTokens: 30,
				cacheReadTokens: 50,
				cacheWriteTokens: 10,
				costTotal: 0.12,
				unpricedRequests: 1,
				sparkline: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 100, 100],
			},
		],
		omittedSessions: 1,
		omittedRequests: 1,
		omittedPromptTokens: 10,
	};
}

const timeline: ContextTimeline = {
	schemaVersion: 1,
	sessionId: "s",
	file: "/tmp/detail.jsonl",
	cwd: "/tmp",
	source: "journal",
	steps: [
		{
			id: "a",
			index: 0,
			timestamp: 1_700_000_000_000,
			model: "model-a",
			promptTokens: 100,
			anchored: true,
			composition: { systemPrompt: 20, systemTools: 10, systemContext: 10, skills: 10, messages: 50 },
			compositionEstimated: true,
			details: {
				contextWindow: 1000,
				categories: { systemPrompt: 20, systemTools: 10, systemContext: 10, skills: 10, messages: 50 },
				toolSchemas: [{ name: "read", tokens: 10 }],
				skills: [{ name: "skill", tokens: 10 }],
				systemPromptParts: [20],
				messageCount: 2,
				pendingMessageTokens: 0,
			},
			unattributed: 0,
			contextWindow: 1000,
			deltaKind: "first",
			usage: { input: 20, output: 5, cacheRead: 10, cacheWrite: 5, total: 40, costTotal: 0.01 },
			eventIds: [],
			filePaths: ["src/a.ts"],
		},
		{
			id: "b",
			index: 1,
			timestamp: 1_700_000_001_000,
			model: "model-a",
			promptTokens: 120,
			anchored: true,
			composition: { systemPrompt: 20, systemTools: 10, systemContext: 10, skills: 10, messages: 70 },
			compositionEstimated: true,
			details: {
				contextWindow: 1000,
				categories: { systemPrompt: 20, systemTools: 10, systemContext: 10, skills: 10, messages: 70 },
				toolSchemas: [{ name: "write", tokens: 10 }],
				skills: [{ name: "skill", tokens: 10 }],
				systemPromptParts: [20],
				messageCount: 3,
				pendingMessageTokens: 0,
			},
			unattributed: 0,
			contextWindow: 1000,
			deltaTokens: 20,
			deltaKind: "grow",
			usage: { input: 20, output: 5, cacheRead: 10, cacheWrite: 5, total: 40, costTotal: 0.01 },
			eventIds: ["e"],
			filePaths: ["src/a.ts"],
		},
	],
	omittedSteps: 0,
	detailsOmittedSteps: 0,
	composition: { systemPrompt: 20, systemTools: 10, systemContext: 10, skills: 10, messages: 70 },
	contextWindow: 1000,
	peakTokens: 120,
	peakTokensTotal: 120,
	costTotal: 0.02,
	events: [{ id: "e", timestamp: 1_700_000_001_000, kind: "compact", label: "Compaction", stepIndex: 1 }],
	omittedEvents: 0,
	files: [
		{
			path: "src/a.ts",
			reads: 1,
			writes: 1,
			edits: 0,
			searches: 0,
			linesRead: 2,
			linesAdded: 1,
			linesRemoved: 0,
			bytesRead: 40,
			bytesWritten: 20,
			lastTimestamp: 1_700_000_001_000,
		},
	],
	omittedFiles: 0,
	incompleteFileCalls: 1,
	agents: [
		{
			trackId: "main",
			file: "/tmp/detail.jsonl",
			label: "Main",
			agent: "main",
			model: "model-a",
			requests: 2,
			peakTokens: 120,
			lastTokens: 120,
			status: "main",
			costTotal: 0.02,
		},
		{
			trackId: "child",
			file: "/tmp/child.jsonl",
			label: "child",
			agent: "worker",
			model: "model-a",
			requests: 1,
			peakTokens: 50,
			lastTokens: 50,
			status: "subagent",
		},
	],
	legacySteps: 0,
	truncated: false,
};

function response(payload: unknown, headers?: HeadersInit): Response {
	return Response.json(payload, { headers });
}

async function renderRoute(
	file: string | null = null,
	range: "24h" | "all" = "24h",
	requests: string[] = [],
	detail: ContextTimeline = timeline,
) {
	const container = setupDom();
	const fetchStub = Object.assign(
		async (input: FetchInput, _init?: FetchInit) => {
			const url = input.toString();
			requests.push(url);
			if (url.includes("/api/context/overview")) return response(makeOverview(range === "all" ? "90d" : range));
			return response(detail, { ETag: '"v1"' });
		},
		{ preconnect: globalThis.fetch.preconnect },
	);
	vi.spyOn(globalThis, "fetch").mockImplementation(fetchStub);
	await act(async () => {
		root?.render(<ContextRoute active range={range} session={file} onOpenSession={() => {}} />);
	});
	await act(async () => {
		await Promise.resolve();
	});
	return container;
}

afterEach(async () => {
	if (root)
		await act(async () => {
			root?.unmount();
		});
	root = null;
	vi.restoreAllMocks();
	for (const [name, descriptor] of originalGlobals) {
		if (descriptor) Object.defineProperty(globalThis, name, descriptor);
		else Reflect.deleteProperty(globalThis, name);
	}
	originalGlobals.clear();
});

describe("Context page", () => {
	it("renders KPI values, activity cells, session cards and omission text", async () => {
		const container = await renderRoute();
		for (const label of ["Sessions", "Requests", "Prompt tokens", "Cache rate", "Est. cost", "Peak prompt"])
			expect(container.textContent).toContain(label);
		expect(container.textContent).toContain("+1 sessions");
		expect(container.querySelectorAll(".context-activity-cell").length).toBeGreaterThan(1);
		expect(container.querySelectorAll(".context-session-card")).toHaveLength(1);
		expect(container.textContent).toContain("~$0.12");
	});



	it("re-establishes one tab stop when the activity range changes", async () => {
		const container = setupDom();
		const seven = makeOverview("7d");
		const thirty = {
			...makeOverview("30d"),
			cutoff: Date.now() - 30 * 24 * 60 * 60 * 1000,
			heatmapBucketMs: 24 * 60 * 60 * 1000,
			heatmap: [],
		};
		const render = async (overview: ContextOverview) => {
			await act(async () => {
				root?.render(
					<ContextActivityGrid
						overview={overview}
						cells={buildActivityCells(overview)}
						metric="requests"
						selectedKey={null}
						onSelect={() => {}}
					/>,
				);
			});
		};
		await render(seven);
		expect(container.querySelectorAll('.context-activity-cell').length).toBeGreaterThan(0);
		expect([...container.querySelectorAll('.context-activity-cell')].filter(cell => cell.getAttribute('tabindex') === '0')).toHaveLength(1);
		await render(thirty);
		expect(container.querySelectorAll('.context-activity-cell').length).toBeGreaterThan(0);
		expect([...container.querySelectorAll('.context-activity-cell')].filter(cell => cell.getAttribute('tabindex') === '0')).toHaveLength(1);
	});

	it("switches between session cards and the list without losing the rows", async () => {
		const container = await renderRoute();
		expect(container.querySelectorAll(".context-session-card")).toHaveLength(1);
		const list = [...container.querySelectorAll("button")].find(button => button.textContent === "List");
		if (!list) throw new Error("List toggle missing");
		await act(async () => {
			list.click();
		});
		expect(container.querySelectorAll(".context-session-card")).toHaveLength(0);
		expect(container.textContent).toContain("Context test");
		const cards = [...container.querySelectorAll("button")].find(button => button.textContent === "Cards");
		if (!cards) throw new Error("Cards toggle missing");
		await act(async () => {
			cards.click();
		});
		expect(container.querySelectorAll(".context-session-card")).toHaveLength(1);
	});

	it("renders the model mix donut legend and an accessible data table", async () => {
		const container = await renderRoute();
		expect(container.textContent).toContain("Model mix");
		expect(container.textContent).toContain("model-a");
		expect(container.textContent).toContain("Data table");
		const figure = container.querySelector("figure.context-usage-chart");
		expect(figure?.getAttribute("aria-label")).toContain("Prompt");
	});

	it("maps all to a bounded 90d request and labels it", async () => {
		const container = await renderRoute(null, "all");
		expect(container.textContent).toContain("90d");
		expect(container.textContent).not.toContain("range=all");
	});

	it("opens detail tabs and renders file activity and fleet", async () => {
		const container = await renderRoute("/tmp/detail.jsonl");
		for (const label of ["Composition", "Trend", "Browser", "Events", "Files", "Fleet"])
			expect(container.textContent).toContain(label);
		const trend = [...container.querySelectorAll("button")].find(button => button.textContent === "Trend");
		if (!trend) throw new Error("Trend tab missing");
		await act(async () => {
			trend.click();
		});
		expect(container.textContent).toContain("Trend");
		const files = [...container.querySelectorAll("button")].find(button => button.textContent === "Files");
		if (!files) throw new Error("Files tab missing");
		await act(async () => {
			files.click();
		});
		expect(container.textContent).toContain("src/a.ts");
		const fleet = [...container.querySelectorAll("button")].find(button => button.textContent === "Fleet");
		if (!fleet) throw new Error("Fleet tab missing");
		await act(async () => {
			fleet.click();
		});
		expect(container.textContent).toContain("child");
		expect(container.textContent).not.toContain("message body");
	});

	it("keeps the current bar on the latest step when an earlier step is selected", async () => {
		const container = await renderRoute("/tmp/detail.jsonl");
		expect(container.textContent).toContain("Current context");
		expect(container.textContent).toContain("Step #1 · latest");
		expect(container.querySelector('[data-testid="context-current-reserve"]')).toBeTruthy();
		const first = [...container.querySelectorAll("button")].find(button => button.textContent?.startsWith("#0"));
		if (!first) throw new Error("step selector missing");
		await act(async () => {
			first.click();
		});
		expect(container.textContent).toContain("Step #1 · latest");
	});

	it("does not substitute timeline composition for a legacy latest step", async () => {
		const file = `/tmp/legacy-${++sequence}.jsonl`;
		const legacy = {
			...timeline,
			file,
			steps: [{ ...timeline.steps[1]!, composition: undefined, compositionEstimated: undefined }],
			composition: timeline.composition,
		} as ContextTimeline;
		const container = await renderRoute(file, "24h", [], legacy);
		expect(container.textContent).toContain("Composition unavailable for this legacy step.");
		expect(container.querySelectorAll(".context-current-seg")).toHaveLength(0);
	});


	it("bounds current segments and reserve under estimate overshoot", async () => {
		const file = `/tmp/overshoot-${++sequence}.jsonl`;
		const step = {
			...timeline.steps[1]!,
			promptTokens: 80,
			contextWindow: 100,
			composition: { systemPrompt: 20, systemTools: 20, systemContext: 20, skills: 20, messages: 10 },
			unattributed: -10,
		};
		const container = await renderRoute(file, "24h", [], { ...timeline, file, steps: [step] });
		expect(container.textContent).toContain("estimate overshoot");
		const widths = [...container.querySelectorAll<HTMLElement>(".context-current-seg")].map(element =>
			Number.parseFloat(element.style.width),
		);
		expect(widths.reduce((sum, width) => sum + width, 0)).toBeLessThanOrEqual(100.01);
	});

	it("renders an empty zero-prompt track without NaN widths", async () => {
		const file = `/tmp/zero-${++sequence}.jsonl`;
		const step = {
			...timeline.steps[1]!,
			promptTokens: 0,
			contextWindow: 100,
			composition: { systemPrompt: 0, systemTools: 0, systemContext: 0, skills: 0, messages: 0 },
			unattributed: 0,
		};
		const container = await renderRoute(file, "24h", [], { ...timeline, file, steps: [step] });
		expect(container.textContent).toContain("No prompt tokens recorded");
		expect(container.querySelectorAll(".context-current-seg:not(.context-current-reserve)")).toHaveLength(0);
		expect(container.textContent).not.toContain("NaN");
	});

	it("renders token mix, turn stats and no latency claim", async () => {
		const container = await renderRoute("/tmp/detail.jsonl");
		expect(container.textContent).toContain("Token mix");
		expect(container.textContent).toContain("Turn stats");
		expect(container.textContent).toContain("Cache read");
		expect(container.textContent).not.toContain("TTFT");
		expect(container.textContent).not.toContain("latency");
	});

	it("sums token usage and labels omitted steps", async () => {
		const file = `/tmp/tokens-${++sequence}.jsonl`;
		const container = await renderRoute(file, "24h", [], { ...timeline, file, omittedSteps: 3 });
		expect(container.querySelector(".context-donut-center strong")?.textContent).toBe("80");
		expect([...container.querySelectorAll(".context-donut-legend b")].map(element => element.textContent)).toEqual([
			"40",
			"10",
			"20",
			"10",
		]);
		expect(container.textContent).toContain("+3 steps omitted");
	});


	it("announces an explicit step selection without making polling live", async () => {
		const container = await renderRoute("/tmp/detail.jsonl");
		expect(container.querySelector('[role="status"]')?.textContent).toBe("");
		const trend = [...container.querySelectorAll("button")].find(button => button.textContent === "Trend");
		if (!trend) throw new Error("Trend tab missing");
		await act(async () => {
			trend.click();
		});
		const marker = container.querySelector(".context-marker");
		if (!marker) throw new Error("trend marker missing");
		await act(async () => {
			(marker as HTMLElement).click();
		});
		expect(container.querySelector('[role="status"]')?.textContent).toContain("selected");
	});

	it("routes a step event chip to Events with its kind active", async () => {
		const container = await renderRoute("/tmp/detail.jsonl");
		const trend = [...container.querySelectorAll("button")].find(button => button.textContent === "Trend");
		if (!trend) throw new Error("Trend tab missing");
		await act(async () => {
			trend.click();
		});
		const event = [...container.querySelectorAll("button")].find(button => button.textContent?.includes("Compaction"));
		if (!event) throw new Error("event chip missing");
		await act(async () => {
			event.click();
		});
		const events = [...container.querySelectorAll("button")].find(button => button.textContent === "Events");
		expect(events?.className).toContain("active");
	});

	it("shows only named browser details, never injected private content", async () => {
		const file = `/tmp/private-${++sequence}.jsonl`;
		const withSecret = {
			...timeline,
			file,
			steps: timeline.steps.map(step => ({
				...step,
				details: { ...step.details!, content: "SECRET_PROMPT_BODY", args: "SECRET_ARGS" },
			})),
		} as ContextTimeline;
		const container = await renderRoute(file, "24h", [], withSecret);
		const browser = [...container.querySelectorAll("button")].find(button => button.textContent === "Browser");
		if (!browser) throw new Error("Browser tab missing");
		await act(async () => {
			browser.click();
		});
		expect(container.textContent).toContain("Names and token counts only");
		expect(container.textContent).not.toContain("SECRET_PROMPT_BODY");
		expect(container.textContent).not.toContain("SECRET_ARGS");
	});

	it("drills into a fleet child by its actual filename", async () => {
		const requests: string[] = [];
		const container = await renderRoute("/tmp/detail.jsonl", "24h", requests);
		const fleet = [...container.querySelectorAll("button")].find(button => button.textContent === "Fleet");
		if (!fleet) throw new Error("Fleet tab missing");
		await act(async () => {
			fleet.click();
		});
		expect(container.querySelectorAll('[data-testid="fleet-main"]')).toHaveLength(1);
		expect(container.querySelector('[data-testid="fleet-graph"]')?.getAttribute("data-logical-edges")).toBe(
			"main->child",
		);
		const node = container.querySelector('[data-track-id="child"]');
		if (!node) throw new Error("fleet node missing");
		await act(async () => {
			(node as HTMLElement).click();
		});
		expect(requests.some(url => url.includes("file=%2Ftmp%2Fchild.jsonl"))).toBe(true);
		expect(container.textContent).toContain("Viewing subagent");
	});



	it("renders one connector for each visible fleet child and recomputes on lane scroll", async () => {
		const container = setupDom();
		const domWindow = globalThis.window as unknown as {
			HTMLElement: { prototype: { getBoundingClientRect: () => DOMRect } };
			Event: typeof Event;
		};
		const original = domWindow.HTMLElement.prototype.getBoundingClientRect;
		let scrolled = 0;
		const rect = (x: number, y: number, width: number, height: number) =>
			({ x, y, width, height, top: y, left: x, right: x + width, bottom: y + height, toJSON: () => ({}) }) as DOMRect;
		domWindow.HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
			if (this.classList.contains("context-fleet-canvas")) return rect(0, 0, 700, 420);
			if (this.dataset.testid === "fleet-main") return rect(0, 160, 200, 100);
			if (this.dataset.testid === "fleet-lane") return rect(228, 0, 472, 420);
			const index = this.dataset.trackId === "child-a" ? 0 : this.dataset.trackId === "child-b" ? 1 : -1;
			if (index >= 0) return rect(300, (index === 0 ? 10 : 310) - scrolled, 300, 80);
			return original.call(this);
		};
		try {
			const file = `/tmp/connectors-${++sequence}.jsonl`;
			const detail: ContextTimeline = {
				...timeline,
				file,
				agents: [
					{ ...timeline.agents[0]!, trackId: "main", label: "Main", status: "main" },
					{ ...timeline.agents[1]!, trackId: "child-a", label: "child-a" },
					{ ...timeline.agents[1]!, trackId: "child-b", label: "child-b" },
				],
			};
			await act(async () => {
				root?.render(<ContextFleetGraph timeline={detail} onOpenAgent={() => {}} />);
			});
			const lane = container.querySelector('[data-testid="fleet-lane"]') as HTMLElement;
			const paths = () =>
				[...container.querySelectorAll("svg.context-fleet-edges path")].map(path =>
					path.getAttribute("data-edge-for"),
				);
			expect(paths()).toEqual(["child-a", "child-b"]);
			expect(container.querySelector("clipPath rect")?.getAttribute("x")).toBe("200");
			scrolled = 200;
			await act(async () => {
				lane.dispatchEvent(new domWindow.Event("scroll", { bubbles: false }));
			});
			expect(paths()).toEqual(["child-b"]);
		} finally {
			domWindow.HTMLElement.prototype.getBoundingClientRect = original;
		}
	});

	it("keeps every fleet child in the logical edge set and in the table fallback", async () => {
		const file = `/tmp/fleet-${++sequence}.jsonl`;
		const detail: ContextTimeline = {
			...timeline,
			file,
			agents: [
				{ ...timeline.agents[0]!, trackId: "main", label: "Main", status: "main", requests: 6 },
				{ ...timeline.agents[1]!, trackId: "child-b", label: "child-b", requests: 4 },
				{ ...timeline.agents[1]!, trackId: "child-a", label: "child-a", requests: 1 },
				{
					...timeline.agents[1]!,
					trackId: "advisor",
					label: "advisor",
					agent: "advisor",
					status: "advisor",
					requests: 2,
				},
			],
		};
		const container = await renderRoute(file, "24h", [], detail);
		const fleet = [...container.querySelectorAll("button")].find(button => button.textContent === "Fleet");
		if (!fleet) throw new Error("Fleet tab missing");
		await act(async () => {
			fleet.click();
		});
		const graph = container.querySelector('[data-testid="fleet-graph"]');
		expect(container.querySelectorAll('[data-testid="fleet-main"]')).toHaveLength(1);
		expect(container.querySelectorAll("[data-track-id]")).toHaveLength(4);
		expect(
			[...container.querySelectorAll("[data-track-id]")]
				.map(element => element.getAttribute("data-track-id"))
				.sort(),
		).toEqual(["advisor", "child-a", "child-b", "main"]);
		expect(graph?.getAttribute("data-logical-edges")?.split(",")).toHaveLength(3);
		expect(new Set(graph?.getAttribute("data-logical-edges")?.split(","))).toHaveLength(3);
		const table = [...container.querySelectorAll("button")].find(button => button.textContent === "Table");
		if (!table) throw new Error("Table view missing");
		await act(async () => {
			table.click();
		});
		expect(container.querySelectorAll("tbody tr")).toHaveLength(4);
	});

	it("isolates the files open-trace control from row activation", async () => {
		const onOpenTrace = vi.fn();
		const container = setupDom();
		await act(async () => {
			root?.render(<FilesTab timeline={timeline} onOpenTrace={onOpenTrace} />);
		});
		expect(container.querySelector(".context-file-activity")?.getAttribute("aria-label")).toBe(
			"1 reads, 1 writes, 0 edits, 0 searches",
		);
		expect(container.querySelector(".context-file-counts")?.textContent).toBe("1100");
		const open = container.querySelector<HTMLButtonElement>('button[aria-label^="Open trace for"]');
		if (!open) throw new Error("open trace button missing");
		await act(async () => {
			open.click();
		});
		expect(onOpenTrace).toHaveBeenCalledTimes(1);
		for (const key of ["Enter", " "]) {
			const EventCtor = (globalThis.window as unknown as { Event: typeof Event }).Event;
			const keydown = new EventCtor("keydown", { bubbles: true });
			Object.defineProperty(keydown, "key", { value: key });
			await act(async () => {
				open.dispatchEvent(keydown);
			});
		}
		expect(onOpenTrace).toHaveBeenCalledTimes(1);
		const row = container.querySelector("tbody tr");
		if (!row) throw new Error("file row missing");
		await act(async () => {
			(row as HTMLElement).click();
		});
		expect(onOpenTrace).toHaveBeenCalledTimes(2);
	});

	it("rejects unsupported timeline schemas before rendering fields", async () => {
		const file = `/tmp/schema-${++sequence}.jsonl`;
		const container = await renderRoute(file, "24h", [], { file, schemaVersion: 2 } as never);
		expect(container.textContent).toContain("Unsupported context timeline schemaVersion 2");
		expect(container.textContent).not.toContain("Prompt composition");
	});

	it("renders negative prompt deltas on a signed zero baseline", async () => {
		const file = `/tmp/delta-${++sequence}.jsonl`;
		const container = await renderRoute(file, "24h", [], {
			...timeline,
			file,
			steps: [{ ...timeline.steps[1]!, deltaTokens: -100 }],
		});
		const trend = [...container.querySelectorAll("button")].find(button => button.textContent === "Trend");
		if (!trend) throw new Error("Trend tab missing");
		await act(async () => {
			trend.click();
		});
		const deltaButton = [...container.querySelectorAll("button")].find(button => button.textContent === "Δ");
		if (!deltaButton) throw new Error("delta toggle missing");
		await act(async () => {
			deltaButton.click();
		});
		expect(container.textContent).toContain("-100");
		const negative = container.querySelector(".context-delta-fill.negative") as HTMLElement | null;
		expect(negative).toBeTruthy();
		expect(negative?.style.right).toBe("50%");
		expect(negative?.style.width).toBe("50%");
	});


	it("keeps the selected step across Browser and Trend", async () => {
		const container = await renderRoute("/tmp/detail.jsonl");
		const browser = [...container.querySelectorAll("button")].find(button => button.textContent === "Browser");
		if (!browser) throw new Error("Browser tab missing");
		await act(async () => {
			browser.click();
		});
		const firstStep = [...container.querySelectorAll("button")].find(button => button.textContent?.startsWith("#0"));
		if (!firstStep) throw new Error("browser step missing");
		await act(async () => {
			firstStep.click();
		});
		const toTrend = [...container.querySelectorAll("button")].find(button => button.textContent === "Open in Trend");
		if (!toTrend) throw new Error("Open in Trend missing");
		await act(async () => {
			toTrend.click();
		});
		expect(container.querySelector('[data-testid="context-tab-trend"]')?.getAttribute("aria-selected")).toBe("true");
		expect(container.textContent).toContain("Step #0");
		const toBrowser = [...container.querySelectorAll("button")].find(
			button => button.textContent === "Open in Browser",
		);
		if (!toBrowser) throw new Error("Open in Browser missing");
		await act(async () => {
			toBrowser.click();
		});
		expect(container.querySelector('[data-testid="context-tab-browser"]')?.getAttribute("aria-selected")).toBe("true");
		expect(container.querySelector(".context-browser")?.textContent).toContain("Step #0");
	});

	it("renders system-part details in the Browser tab", async () => {
		const container = await renderRoute("/tmp/detail.jsonl");
		const browser = [...container.querySelectorAll("button")].find(button => button.textContent === "Browser");
		if (!browser) throw new Error("Browser tab missing");
		await act(async () => {
			browser.click();
		});
		expect(container.textContent).toContain("System parts");
		expect(container.textContent).toContain("part 0");
		expect(container.textContent).toContain("20");
		const barBackgrounds = [...container.querySelectorAll(".context-category-track i")].map(
			element => (element as HTMLElement).style.background,
		);
		expect(barBackgrounds).toContain("var(--ctx-system-tools)");
		expect(barBackgrounds).toContain("var(--ctx-system-prompt)");
	});

	it("revalidates session context with ETag without parsing a 304 body", async () => {
		const payload = { ...timeline, file: `/tmp/etag-${++sequence}.jsonl` };
		const ifNoneMatch: (string | null)[] = [];
		const jsonSpy = vi.spyOn(Response.prototype, "json");
		const fetchStub = Object.assign(
			async (_input: FetchInput, init?: FetchInit) => {
				const tag = new Headers(init?.headers).get("If-None-Match");
				ifNoneMatch.push(tag);
				return tag === '"v1"' ? new Response(null, { status: 304 }) : response(payload, { ETag: '"v1"' });
			},
			{ preconnect: globalThis.fetch.preconnect },
		);
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchStub);
		const first = await getSessionContext(payload.file!);
		const second = await getSessionContext(payload.file!, undefined, first);
		expect(ifNoneMatch).toEqual([null, '"v1"']);
		expect(jsonSpy).toHaveBeenCalledTimes(1);
		expect(second).toBe(first);
	});
});
