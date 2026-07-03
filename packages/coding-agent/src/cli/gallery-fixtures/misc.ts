/** Gallery fixtures for the ask / resolve / ssh / github / inspect_image tools. */
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

	resolve: {
		label: "Resolve",
		streamingArgs: {
			action: "apply",
		},
		args: {
			action: "apply",
			reason: "Rename is mechanical and the staged diff matches the intended refactor.",
			extra: { title: "rename-usecredentials-hook" },
		},
		result: {
			content: [{ type: "text", text: "Applied pending ast_edit: 7 replacements across 3 files" }],
			details: {
				action: "apply",
				reason: "Rename is mechanical and the staged diff matches the intended refactor.",
				extra: { title: "rename-usecredentials-hook" },
				sourceToolName: "ast_edit",
				label: "ast_edit: 7 replacements across 3 files",
			},
		},
		errorResult: {
			content: [{ type: "text", text: "No pending action to resolve" }],
			isError: true,
			details: {
				action: "apply",
				reason: "Rename is mechanical and the staged diff matches the intended refactor.",
				sourceToolName: "ast_edit",
				label: "ast_edit: 7 replacements across 3 files",
			},
		},
	},

	ssh: {
		label: "SSH",
		streamingArgs: {
			host: "deploy@web-01",
			command: "systemctl status",
		},
		args: {
			host: "deploy@web-01",
			command: "systemctl status omp-api --no-pager | head -n 12",
			cwd: "/srv/omp",
			timeout: 60,
		},
		result: {
			content: [
				{
					type: "text",
					text: [
						"● omp-api.service - oh-my-pk API",
						"     Loaded: loaded (/etc/systemd/system/omp-api.service; enabled)",
						"     Active: active (running) since Sat 2026-06-06 09:14:02 UTC; 3h 21min ago",
						"   Main PID: 4812 (bun)",
						"      Tasks: 17 (limit: 4915)",
						"     Memory: 142.6M",
						"        CPU: 38.214s",
						"     CGroup: /system.slice/omp-api.service",
						"             └─4812 /usr/local/bin/bun run dist/server.js",
					].join("\n"),
				},
			],
		},
		errorResult: {
			content: [
				{
					type: "text",
					text: "ssh: connect to host web-01 port 22: Connection timed out",
				},
			],
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
			repo: "oh-my-pk/oh-my-pk",
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
					text: "gh: Could not resolve to a Repository with the name 'oh-my-pk/oh-my-pk'. (HTTP 404)",
				},
			],
			isError: true,
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
