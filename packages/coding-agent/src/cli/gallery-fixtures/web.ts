// Gallery fixtures for the web tools (web_search, browser).
import type { GalleryFixture } from "./types";

export const webFixtures: Record<string, GalleryFixture> = {
	web_search: {
		label: "Web Search",
		// Streaming: query still being typed, no recency/limit yet.
		streamingArgs: { query: "bun vs node performance" },
		args: {
			query: "Bun vs Node.js performance benchmarks 2026",
			recency: "month",
			limit: 4,
		},
		result: {
			content: [
				{
					type: "text",
					text: [
						"Bun continues to outperform Node.js on raw HTTP throughput and cold-start",
						"time thanks to its JavaScriptCore engine and native-Zig runtime, while",
						"Node.js retains an edge in ecosystem maturity and long-term stability.",
						"For script-heavy workflows Bun's faster startup is the decisive factor.",
					].join("\n"),
				},
			],
			details: {
				response: {
					provider: "perplexity",
					model: "sonar-pro",
					authMode: "api_key",
					requestId: "req_a1b2c3d4e5f6",
					answer: [
						"Bun continues to outperform Node.js on raw HTTP throughput and cold-start",
						"time thanks to its JavaScriptCore engine and native-Zig runtime, while",
						"Node.js retains an edge in ecosystem maturity and long-term stability.",
						"For script-heavy workflows Bun's faster startup is the decisive factor.",
					].join("\n"),
					searchQueries: ["bun vs node.js performance benchmarks 2026", "bun http throughput vs node"],
					sources: [
						{
							title: "Bun 1.2 Benchmarks: HTTP, SQLite, and Startup Time",
							url: "https://bun.sh/blog/bun-v1.2-benchmarks",
							snippet:
								"Bun serves roughly 2.5x the requests per second of Node.js on a simple HTTP server and starts in under 10ms.",
							ageSeconds: 86400 * 12,
							author: "The Bun Team",
						},
						{
							title: "Node.js vs Bun: A 2026 Performance Deep Dive",
							url: "https://blog.platformatic.dev/nodejs-vs-bun-2026",
							snippet:
								"Across CPU-bound workloads the gap narrows, but Bun's faster module resolution keeps cold starts ahead.",
							ageSeconds: 86400 * 3,
							author: "Matteo Collina",
						},
						{
							title: "Real-world API latency: Bun, Deno, and Node compared",
							url: "https://www.theregister.com/2026/05/18/js_runtime_latency/",
							snippet:
								"Under sustained load p99 latencies converge, suggesting runtime choice matters less for steady-state services.",
							ageSeconds: 86400 * 19,
						},
						{
							title: "Why we migrated our CLI tooling from Node to Bun",
							url: "https://engineering.example.com/posts/bun-cli-migration",
							snippet:
								"Startup dropped from 180ms to 22ms, shaving seconds off every developer command invocation.",
							ageSeconds: 86400 * 27,
							author: "Dana Whitfield",
						},
					],
					citations: [
						{
							url: "https://bun.sh/blog/bun-v1.2-benchmarks",
							title: "Bun 1.2 Benchmarks",
							citedText: "Bun serves roughly 2.5x the requests per second of Node.js",
						},
					],
					usage: {
						inputTokens: 312,
						outputTokens: 248,
						totalTokens: 560,
						searchRequests: 2,
					},
				},
			},
		},
		errorResult: {
			isError: true,
			content: [{ type: "text", text: "Web search failed: provider returned HTTP 429 (rate limited)." }],
			details: {
				response: {
					provider: "perplexity",
					sources: [],
				},
				error: "Provider returned HTTP 429 (rate limited). Retry after 30s.",
			},
		},
	},

	browser: {
		label: "Browser",
		// Streaming: code body still arriving for a `run` action.
		streamingArgs: {
			action: "run",
			name: "docs",
			code: "const obs = await tab.observe();\n",
		},
		args: {
			action: "run",
			name: "docs",
			code: [
				"const obs = await tab.observe();",
				"const heading = obs.elements.find(e => e.role === 'heading');",
				"display({ url: obs.url, title: obs.title, headings: obs.elements.filter(e => e.role === 'heading').length });",
				"return heading?.name ?? 'no heading found';",
			].join("\n"),
		},
		result: {
			content: [
				{
					type: "text",
					text: [
						'{ url: "https://bun.sh/docs", title: "Bun Documentation", headings: 14 }',
						'"Get started with Bun"',
					].join("\n"),
				},
			],
			details: {
				action: "run",
				name: "docs",
				url: "https://bun.sh/docs",
				browser: "headless",
				viewport: { width: 1280, height: 800, deviceScaleFactor: 1 },
				result: '"Get started with Bun"',
			},
		},
		errorResult: {
			isError: true,
			content: [
				{
					type: "text",
					text: [
						"TimeoutError: waiting for selector `aria/Sign in` failed: timeout 30000ms exceeded",
						"    at Tab.waitFor (browser/tab.ts:212:13)",
						"    at run (eval:3:7)",
					].join("\n"),
				},
			],
			details: {
				action: "run",
				name: "docs",
				url: "https://bun.sh/docs",
				browser: "headless",
			},
		},
	},
};
