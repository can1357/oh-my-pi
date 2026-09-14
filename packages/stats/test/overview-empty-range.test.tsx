import { afterEach, describe, expect, it, vi } from "bun:test";
import { parseHTML } from "@oh-my-pi/pi-utils/dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { OverviewRoute } from "../src/client/routes/OverviewRoute";
import type { OverviewStats } from "../src/client/types";

type FetchInput = string | URL | Request;
type FetchInit = RequestInit | BunFetchRequestInit;

const originalGlobals = new Map<string, PropertyDescriptor | undefined>();
let root: Root | null = null;

function installGlobal(name: string, value: unknown): void {
	originalGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
	Object.defineProperty(globalThis, name, { configurable: true, value, writable: true });
}

function restoreGlobals(): void {
	for (const [name, descriptor] of originalGlobals) {
		if (descriptor) {
			Object.defineProperty(globalThis, name, descriptor);
		} else {
			Reflect.deleteProperty(globalThis, name);
		}
	}
	originalGlobals.clear();
}

function installFakeDom(): {
	container: Element;
	serialize: () => string;
	window: typeof parseHTML extends (h: string) => infer W ? W : never;
} {
	const domWindow = parseHTML('<html><body><div id="root"></div></body></html>').window;
	installGlobal("window", domWindow);
	installGlobal("document", domWindow.document);
	installGlobal("navigator", domWindow.navigator);
	installGlobal("Node", domWindow.Node);
	installGlobal("Element", domWindow.Element);
	installGlobal("HTMLElement", domWindow.HTMLElement);
	installGlobal("HTMLSelectElement", Reflect.get(domWindow, "HTMLSelectElement"));
	installGlobal("HTMLOptionElement", Reflect.get(domWindow, "HTMLOptionElement"));
	installGlobal("HTMLIFrameElement", domWindow.HTMLIFrameElement);
	installGlobal("SVGElement", domWindow.SVGElement);
	installGlobal("getComputedStyle", (el: unknown) => domWindow.getComputedStyle(el as never));
	installGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	const container = domWindow.document.getElementById("root") as unknown as Element;
	if (!container) throw new Error("Expected test root");
	return { container, serialize: () => domWindow.document.body.innerHTML, window: domWindow };
}

afterEach(async () => {
	const activeRoot = root;
	if (activeRoot) {
		await act(async () => {
			activeRoot.unmount();
		});
		root = null;
	}
	vi.restoreAllMocks();
	restoreGlobals();
});

function emptyOverview(): OverviewStats {
	return {
		overall: {
			totalRequests: 0,
			successfulRequests: 0,
			failedRequests: 0,
			errorRate: 0,
			totalInputTokens: 0,
			totalOutputTokens: 0,
			totalCacheReadTokens: 0,
			totalCacheWriteTokens: 0,
			cacheRate: 0,
			cacheSavings: 0,
			totalCost: 0,
			unpricedRequests: 0,
			totalPremiumRequests: 0,
			avgDuration: null,
			avgTtft: null,
			avgTokensPerSecond: null,
			firstTimestamp: 0,
			lastTimestamp: 0,
		},
		byAgentType: [],
		timeSeries: [],
	};
}

const EMPTY_PAYLOADS = {
	"/api/v1/overview": emptyOverview(),
	"/api/v1/models": { byModel: [], modelSeries: [], modelPerformanceSeries: [] },
	"/api/v1/providers": { providers: [], hourly: [], series: [], usageSeries: [], windowInsights: [] },
	"/api/v1/tools": { byTool: [], byToolModel: [], series: [] },
	"/api/v1/projects": [],
	"/api/v1/errors": [],
	"/api/v1/requests": { requests: [], total: 0 },
};

const SECTION_TITLES = [
	"Token breakdown",
	"Token usage by agent",
	"Models — share of requests",
	"Cost and token share",
	"Calls and error share",
	"Projects",
	"Live feed",
	"Recent requests",
	"Health · Recent errors",
];

function routeWithFetchStub(payloads: Record<string, unknown>): (input: FetchInput) => Promise<Response> {
	return async (input: FetchInput) => {
		const url = input instanceof Request ? input.url : input.toString();
		const path = url.split("?")[0];
		const payload = payloads[path];
		if (payload === undefined) throw new Error(`Unexpected fetch: ${url}`);
		return Response.json(payload);
	};
}

async function renderOverview(payloads: Record<string, unknown>): Promise<{ serialize: () => string }> {
	const { container, serialize } = installFakeDom();
	const fetchStub = Object.assign(routeWithFetchStub(payloads), { preconnect: globalThis.fetch.preconnect });
	vi.spyOn(globalThis, "fetch").mockImplementation(fetchStub);
	root = createRoot(container);
	await act(async () => {
		root?.render(<OverviewRoute active range="24h" refreshTrigger={0} onRequestClick={() => {}} />);
	});
	return { serialize };
}

describe("OverviewRoute empty sections", () => {
	it("renders no section chrome when every payload is empty", async () => {
		const { serialize } = await renderOverview(EMPTY_PAYLOADS);
		const html = serialize();

		// The hero and the KPI tape are unconditional and must still render.
		expect(html).toContain("Overview");
		expect(html).toContain("Key metrics");

		// Data-backed sections must vanish entirely — no headers, no rules, no chrome.
		for (const title of SECTION_TITLES) {
			expect(html).not.toContain(title);
		}
	});

	it("renders section headers when the same payloads carry data", async () => {
		const models = {
			byModel: [
				{
					model: "gpt-5.5",
					provider: "openai-codex",
					totalRequests: 4,
					successfulRequests: 4,
					failedRequests: 0,
					errorRate: 0,
					totalInputTokens: 100,
					totalOutputTokens: 50,
					totalCacheReadTokens: 0,
					totalCacheWriteTokens: 0,
					cacheRate: 0,
					cacheSavings: 0,
					totalCost: 0.02,
					unpricedRequests: 0,
					totalPremiumRequests: 0,
					avgDuration: 1000,
					avgTtft: 100,
					avgTokensPerSecond: 20,
					firstTimestamp: 1,
					lastTimestamp: 2,
				},
			],
			modelSeries: [],
			modelPerformanceSeries: [],
		};
		const overview = emptyOverview();
		overview.overall.totalInputTokens = 100;
		overview.overall.totalOutputTokens = 50;
		overview.byAgentType = [
			{
				agentType: "main",
				totalRequests: 4,
				totalInputTokens: 100,
				totalOutputTokens: 50,
				totalCacheReadTokens: 0,
				totalCacheWriteTokens: 0,
				totalCost: 0.02,
			},
		];
		const request = {
			id: 7,
			sessionFile: "s.jsonl",
			entryId: "e1",
			folder: "/tmp",
			model: "gpt-5.5",
			provider: "openai-codex",
			api: "openai",
			timestamp: Date.now(),
			duration: 1000,
			ttft: 100,
			stopReason: "end_turn",
			errorMessage: null,
			usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 } },
		};
		const { serialize } = await renderOverview({
			...EMPTY_PAYLOADS,
			"/api/v1/overview": overview,
			"/api/v1/models": models,
			"/api/v1/providers": {
				providers: [
					{
						provider: "openai-codex",
						totalRequests: 100,
						failedRequests: 0,
						models: 1,
						totalInputTokens: 700,
						totalOutputTokens: 50,
						totalCacheReadTokens: 0,
						totalCacheWriteTokens: 0,
						totalTokens: 750,
						totalCost: 1,
						unpricedRequests: 0,
						totalPremiumRequests: 0,
						avgTokensPerSecond: 30,
					},
				],
				hourly: [],
				series: [],
				usageSeries: [],
				windowInsights: [],
			},
			"/api/v1/tools": {
				byTool: [
					{
						tool: "bash",
						calls: 2,
						errors: 0,
						argsChars: 10,
						resultChars: 20,
						totalTokensShare: 30,
						outputTokensShare: 10,
						costShare: 0.001,
						unpricedRequestsShare: 0,
						lastUsed: Date.now(),
					},
				],
				byToolModel: [],
				series: [],
			},
			"/api/v1/projects": [
				{
					folder: "/tmp/proj",
					totalRequests: 4,
					successfulRequests: 4,
					failedRequests: 0,
					errorRate: 0,
					totalInputTokens: 100,
					totalOutputTokens: 50,
					totalCacheReadTokens: 0,
					totalCacheWriteTokens: 0,
					cacheRate: 0,
					cacheSavings: 0,
					totalCost: 0.02,
					unpricedRequests: 0,
					totalPremiumRequests: 0,
					avgDuration: 1000,
					avgTtft: 100,
					avgTokensPerSecond: 20,
					firstTimestamp: 1,
					lastTimestamp: 2,
				},
			],
			"/api/v1/errors": [request],
			"/api/v1/requests": { requests: [request], total: 1 },
		});
		const html = serialize();
		for (const title of SECTION_TITLES) {
			expect(html).toContain(title);
		}
	});
});

describe("OverviewRoute provider share bars", () => {
	it("sizes each provider bar by its token share of the displayed providers", async () => {
		const providers = [
			{
				provider: "openai-codex",
				totalRequests: 100,
				failedRequests: 0,
				models: 1,
				totalInputTokens: 700,
				totalOutputTokens: 50,
				totalCacheReadTokens: 0,
				totalCacheWriteTokens: 0,
				totalTokens: 750,
				totalCost: 1,
				unpricedRequests: 0,
				totalPremiumRequests: 0,
				avgTokensPerSecond: 30,
			},
			{
				provider: "anthropic",
				totalRequests: 50,
				failedRequests: 0,
				models: 1,
				totalInputTokens: 200,
				totalOutputTokens: 50,
				totalCacheReadTokens: 0,
				totalCacheWriteTokens: 0,
				totalTokens: 250,
				totalCost: 0.5,
				unpricedRequests: 0,
				totalPremiumRequests: 0,
				avgTokensPerSecond: 25,
			},
		];
		const { serialize } = await renderOverview({
			...EMPTY_PAYLOADS,
			"/api/v1/providers": { providers, hourly: [], series: [], usageSeries: [], windowInsights: [] },
		});
		const html = serialize();
		// 750 / (750+250) and 250 / (750+250): unequal bars, neither hard-coded 100%.
		expect(html).toContain('title="75.0% of provider tokens"');
		expect(html).toContain('title="25.0% of provider tokens"');
	});
});

describe("OverviewRoute request row keyboard affordance", () => {
	it("marks clickable recent-request rows as focusable buttons", async () => {
		const now = Date.now();
		const request = {
			id: 7,
			sessionFile: "s.jsonl",
			entryId: "e1",
			folder: "/tmp",
			model: "gpt-5.5",
			provider: "openai-codex",
			api: "openai",
			timestamp: now,
			duration: 1000,
			ttft: 100,
			stopReason: "end_turn",
			errorMessage: null,
			usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 } },
		};
		const { container, serialize, window: domWindow } = installFakeDom();
		const fetchStub = Object.assign(
			routeWithFetchStub({
				...EMPTY_PAYLOADS,
				"/api/v1/requests": { requests: [request], total: 1 },
			}),
			{ preconnect: globalThis.fetch.preconnect },
		);
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchStub);
		const clicked: number[] = [];
		root = createRoot(container);
		await act(async () => {
			root?.render(<OverviewRoute active range="24h" refreshTrigger={0} onRequestClick={id => clicked.push(id)} />);
		});

		const html = serialize();
		expect(html).toContain('role="button"');
		expect(html).toContain('tabindex="0"');

		// Enter on a live-feed row opens the request drawer.
		const buttons = container.querySelectorAll('[role="button"]');
		expect(buttons.length).toBeGreaterThan(0);
		const liveRow = [...buttons].find(el => el.textContent?.includes("gpt-5.5"));
		expect(liveRow).toBeDefined();
		const event = new domWindow.Event("keydown", { bubbles: true, cancelable: true });
		Object.assign(event, { key: "Enter" });
		await act(async () => {
			liveRow?.dispatchEvent(event as Event);
		});
		expect(clicked).toEqual([7]);
	});
});