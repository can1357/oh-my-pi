// Gallery fixtures for the long-term memory tools (retain, recall, reflect).
import type { GalleryFixture } from "./types";

export const memoryFixtures: Record<string, GalleryFixture> = {
	retain: {
		label: "Retain",
		// Streaming: first item complete, second still arriving without a context.
		streamingArgs: {
			items: [{ content: "User prefers Bun over Node for all new scripts in this repo." }],
		},
		args: {
			items: [
				{
					content: "User prefers Bun over Node for all new scripts in this repo.",
					context: "Established while wiring up the gallery command tooling.",
				},
				{
					content: "The TUI renderers live in packages/coding-agent/src/tools/*-render.ts.",
					context: "Discovered during the gallery-fixtures task.",
				},
			],
		},
		result: {
			content: [{ type: "text", text: "2 memories stored." }],
			details: { count: 2 },
		},
		errorResult: {
			isError: true,
			content: [{ type: "text", text: "Retain failed: memory store is not initialized." }],
		},
	},

	recall: {
		label: "Recall",
		// Streaming: query partially typed.
		streamingArgs: { query: "bun vs node" },
		args: { query: "Which runtime does the user prefer for scripts?" },
		result: {
			content: [
				{
					type: "text",
					text: [
						"Found 2 relevant memories:",
						"",
						"1. [0.92] User prefers Bun over Node for all new scripts in this repo.",
						"   (Established while wiring up the gallery command tooling.)",
						"2. [0.78] The TUI renderers live in packages/coding-agent/src/tools/*-render.ts.",
						"   (Discovered during the gallery-fixtures task.)",
					].join("\n"),
				},
			],
		},
		errorResult: {
			isError: true,
			content: [{ type: "text", text: "Recall failed: vector index unavailable." }],
		},
	},

	reflect: {
		label: "Reflect",
		streamingArgs: { query: "what have we learned about the user's" },
		args: { query: "What have we learned about the user's tooling preferences?" },
		result: {
			content: [
				{
					type: "text",
					text: [
						"The user consistently favors Bun as the runtime for scripts in this",
						"repository, avoiding Node where possible. They also track the location",
						"of TUI renderers under packages/coding-agent/src/tools, suggesting an",
						"interest in keeping rendering logic discoverable and well-organized.",
					].join("\n"),
				},
			],
		},
		errorResult: {
			isError: true,
			content: [{ type: "text", text: "Reflect failed: no memories matched the query." }],
		},
	},
};
