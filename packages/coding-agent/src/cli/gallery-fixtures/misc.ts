/** Gallery fixtures for the ask, ssh, and github tools. */
import type { GalleryFixture } from "./types";

export const miscFixtures: Record<string, GalleryFixture> = {
	ask: {
		label: "Ask",
		streamingArgs: {
			html: '<form>\n  <fieldset>\n    <legend>Which database should the new service use?</legend>\n    <label><input type="radio" name="db" value="postgres" checked> Postgres',
		},
		args: {
			html: [
				"<form>",
				"  <fieldset>",
				"    <legend>Which database should the new service use?</legend>",
				'    <label><input type="radio" name="db" value="postgres" checked> Postgres: relational, JSONB support</label>',
				'    <label><input type="radio" name="db" value="sqlite"> SQLite: embedded, zero-ops</label>',
				'    <label><input type="radio" name="db" value="mongodb"> MongoDB: document store, flexible schema</label>',
				"  </fieldset>",
				"  <fieldset>",
				"    <legend>Which auth flows should ship in v1?</legend>",
				'    <label><input type="checkbox" name="auth" value="password" checked> Email + password</label>',
				'    <label><input type="checkbox" name="auth" value="oauth" checked> OAuth (Google, GitHub)</label>',
				'    <label><input type="checkbox" name="auth" value="magic"> Magic links</label>',
				'    <label><input type="checkbox" name="auth" value="saml"> SAML SSO (enterprise; can be deferred)</label>',
				"  </fieldset>",
				"</form>",
			].join("\n"),
		},
		result: {
			content: [
				{
					type: "text",
					text: 'User answers:\n{\n  "db": "postgres",\n  "auth": [\n    "password",\n    "oauth"\n  ]\n}',
				},
			],
			details: {
				answers: [
					{
						name: "db",
						question: "Which database should the new service use?",
						answer: "Postgres: relational, JSONB support",
					},
					{
						name: "auth",
						question: "Which auth flows should ship in v1?",
						answer: "Email + password, OAuth (Google, GitHub)",
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
