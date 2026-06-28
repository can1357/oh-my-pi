/** Gallery fixtures for the todo / ask / resolve interaction tools. */
import type { GalleryFixture } from "./types";

export const interactionFixtures: Record<string, GalleryFixture> = {
	todo: {
		label: "Todo",
		streamingArgs: {
			op: "init",
			list: [{ phase: "Foundation", items: ["Scaffold crate"] }],
		},
		args: {
			op: "init",
			list: [
				{ phase: "Foundation", items: ["Scaffold crate", "Wire workspace"] },
				{ phase: "Auth", items: ["Port credential store", "Wire OAuth providers"] },
			],
		},
		result: {
			content: [{ type: "text", text: "Initialized 4 tasks across 2 phases" }],
			details: {
				storage: "session",
				phases: [
					{
						name: "Foundation",
						tasks: [
							{ content: "Scaffold crate", status: "done" },
							{ content: "Wire workspace", status: "in_progress" },
						],
					},
					{
						name: "Auth",
						tasks: [
							{ content: "Port credential store", status: "pending" },
							{ content: "Wire OAuth providers", status: "pending" },
						],
					},
				],
				completedTasks: [{ phase: "Foundation", content: "Scaffold crate" }],
			},
		},
		errorResult: {
			content: [{ type: "text", text: "Unknown phase 'Auth' — initialize the list first" }],
			isError: true,
		},
	},
};
