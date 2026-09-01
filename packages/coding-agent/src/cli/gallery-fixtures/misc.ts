/** Gallery fixtures for the ask / ssh / github / inspect_image tools. */
import type { GalleryFixture } from "./types";

export const miscFixtures: Record<string, GalleryFixture> = {
	ask: {
		label: "Ask",
		streamingArgs: {
			questions: [
				{
					id: "db",
					question: "Which database should the new service use?",
					options: [{ label: "Postgres" }],
				},
			],
		},
		args: {
			questions: [
				{
					id: "db",
					question: "Which database should the new service use?",
					options: [
						{ label: "Postgres", description: "Relational, strong consistency, JSONB support" },
						{ label: "SQLite", description: "Embedded, zero-ops, great for single-node" },
						{ label: "MongoDB", description: "Document store, flexible schema" },
					],
					recommended: 0,
				},
				{
					id: "features",
					question: "Which auth flows should ship in v1?",
					options: [
						{ label: "Email + password" },
						{ label: "OAuth (Google, GitHub)" },
						{ label: "Magic links" },
						{ label: "SAML SSO", description: "Enterprise; can be deferred" },
					],
					multi: true,
				},
			],
		},
		result: {
			content: [
				{
					type: "text",
					text: "db: Postgres\nfeatures: Email + password, OAuth (Google, GitHub)",
				},
			],
			details: {
				results: [
					{
						id: "db",
						question: "Which database should the new service use?",
						options: ["Postgres", "SQLite", "MongoDB"],
						multi: false,
						selectedOptions: ["Postgres"],
					},
					{
						id: "features",
						question: "Which auth flows should ship in v1?",
						options: ["Email + password", "OAuth (Google, GitHub)", "Magic links", "SAML SSO"],
						multi: true,
						selectedOptions: ["Email + password", "OAuth (Google, GitHub)"],
					},
				],
			},
		},
		errorResult: {
			content: [{ type: "text", text: "Prompt cancelled by user before any answer was given" }],
			isError: true,
		},
	},

	github: {
		label: "GitHub",
		streamingArgs: {
			op: "search_prs",
			query: "is:open author:@me",
		},
		args: {
			op: "search_prs",
			query: "is:open review-requested:@me sort:updated",
			repo: "oh-my-pi/pi",
		},
		result: {
			content: [
				{
					type: "text",
					text: [
						"#1842  feat(tui): virtualized scrollback for tool output     openyou · 2h ago   +312 -47",
						"#1839  fix(agent): retry stream on transient 529             dvir   · 5h ago   +18 -4",
						"#1830  refactor(edit): unify hashline + ast_edit previews    mira   · 1d ago   +540 -210",
						"#1817  docs: document gallery fixtures contract             leo    · 2d ago   +96 -0",
						"",
						"4 open pull requests requesting your review",
					].join("\n"),
				},
			],
		},
		errorResult: {
			content: [
				{
					type: "text",
					text: "gh: Could not resolve to a Repository with the name 'oh-my-pi/pi'. (HTTP 404)",
				},
			],
			isError: true,
		},
	},

	generate_image: {
		customRendered: true,
		label: "GenerateImage",
		streamingArgs: { subject: "a massive stylized dire wolf", model: "nano-banana-pro" },
		args: {
			subject: "a massive stylized dire wolf",
			model: "nano-banana-pro",
			aspect_ratio: "9:16",
			resolution: "2K",
		},
		result: {
			content: [
				{
					type: "text",
					text: [
						"Provider: fal",
						"Model: fal-ai/nano-banana-pro",
						"Generated 1 image(s):",
						"  /tmp/omp-image-1.png (1536x2752, 5.1MB)",
					].join("\n"),
				},
			],
			details: {
				provider: "fal",
				model: "fal-ai/nano-banana-pro",
				entryId: "nano-banana-pro",
				costUsd: 0.0123,
				imageStats: [
					{
						path: "/tmp/omp-image-1.png",
						width: 1536,
						height: 2752,
						sizeBytes: 5_400_000,
						mimeType: "image/png",
					},
				],
				images: [],
			},
		},
		errorResult: {
			content: [
				{
					type: "text",
					text: "Quality is not supported by gpt-image-2 via fal (openai/gpt-image-2). Background handling is not supported by gpt-image-2 via fal (openai/gpt-image-2).",
				},
			],
			isError: true,
			details: {
				provider: "fal",
				model: "gpt-image-2",
				entryId: "gpt-image-2",
			},
		},
	},

	inspect_image: {
		label: "Inspect Image",
		streamingArgs: {
			path: "docs/assets/dashboard-mock.png",
		},
		args: {
			path: "docs/assets/dashboard-mock.png",
			question: "What chart types are shown and roughly what layout does the dashboard use?",
		},
		result: {
			content: [
				{
					type: "text",
					text: [
						"The dashboard uses a two-column layout on a dark background.",
						"Top row: four KPI cards (Revenue, Active Users, Churn, MRR) with sparklines.",
						"Left column: a stacked area chart of weekly sessions over ~3 months.",
						"Right column: a horizontal bar chart ranking the top 6 referrers.",
						"Bottom: a paginated table of recent transactions with status pills.",
					].join("\n"),
				},
			],
			details: {
				model: "claude-opus-4",
				imagePath: "docs/assets/dashboard-mock.png",
				mimeType: "image/png",
			},
		},
		errorResult: {
			content: [{ type: "text", text: "Image not found: docs/assets/dashboard-mock.png" }],
			isError: true,
			details: {
				model: "claude-opus-4",
				imagePath: "docs/assets/dashboard-mock.png",
				mimeType: "image/png",
			},
		},
	},

	// Built-in tool with no dedicated renderer — exercises the generic fallback
	// (`#formatToolExecution`) path so its padded, state-tinted block is QA'd.
	report_tool_issue: {
		label: "Report Tool Issue",
		streamingArgs: { tool: "lsp" },
		args: {
			tool: "lsp",
			report: "Rename returned no edit for an exported symbol that has 12 references",
		},
		result: { content: [{ type: "text", text: "Noted, thanks!" }] },
		errorResult: {
			content: [{ type: "text", text: "Could not record the report: issue tracker unreachable" }],
			isError: true,
		},
	},

	// Stand-in for a custom/extension tool that ships no renderer — same generic
	// fallback path most MCP/extension tools take.
	custom: {
		label: "Custom Tool",
		streamingArgs: { query: "weather" },
		args: { query: "weather in Tokyo", units: "metric" },
		result: { content: [{ type: "text", text: "Tokyo: 22°C, partly cloudy, humidity 64%." }] },
		errorResult: {
			content: [{ type: "text", text: "Upstream provider returned 503 Service Unavailable" }],
			isError: true,
		},
	},
};
