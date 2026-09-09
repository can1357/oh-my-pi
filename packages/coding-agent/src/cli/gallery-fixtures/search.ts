/** Gallery fixtures for the search tools (grep, ast_grep). */
import type { GalleryFixture } from "./types";

export const searchFixtures: Record<string, GalleryFixture> = {
	grep: {
		label: "Grep",
		streamingArgs: {
			pattern: "useState",
		},
		args: {
			pattern: "useState",
			path: "packages/tui/src",
		},
		result: {
			content: [
				{
					type: "text",
					text: [
						"# packages/tui/src/components/",
						"## SearchBox.tsx",
						'18:  const [query, setQuery] = useState("");',
						"19:  const [results, setResults] = useState<Match[]>([]);",
						"## StatusBar.tsx",
						"27:  const [expanded, setExpanded] = useState(false);",
						"",
						"# packages/tui/src/hooks/",
						"## useDebounced.ts",
						"9:  const [value, setValue] = useState(initial);",
						"10:  const [pending, setPending] = useState(false);",
					].join("\n"),
				},
			],
			details: {
				scopePath: "packages/tui/src",
				searchPath: "/Users/dev/Projects/pi/packages/tui/src",
				matchCount: 5,
				fileCount: 3,
				files: [
					"packages/tui/src/components/SearchBox.tsx",
					"packages/tui/src/components/StatusBar.tsx",
					"packages/tui/src/hooks/useDebounced.ts",
				],
				fileMatches: [
					{ path: "packages/tui/src/components/SearchBox.tsx", count: 2 },
					{ path: "packages/tui/src/components/StatusBar.tsx", count: 1 },
					{ path: "packages/tui/src/hooks/useDebounced.ts", count: 2 },
				],
				truncated: false,
				displayContent: [
					"# packages/tui/src/components/",
					"## SearchBox.tsx",
					'*18│  const [query, setQuery] = useState("");',
					"*19│  const [results, setResults] = useState<Match[]>([]);",
					"## StatusBar.tsx",
					"*27│  const [expanded, setExpanded] = useState(false);",
					"",
					"# packages/tui/src/hooks/",
					"## useDebounced.ts",
					" *9│  const [value, setValue] = useState(initial);",
					"*10│  const [pending, setPending] = useState(false);",
				].join("\n"),
			},
		},
		errorResult: {
			content: [
				{
					type: "text",
					text: "Invalid regex pattern: unclosed group near index 8",
				},
			],
			isError: true,
			details: {
				error: "Invalid regex pattern: unclosed group near index 8",
			},
		},
	},

	ast_grep: {
		label: "AST Grep",
		streamingArgs: {
			pat: "useState(",
		},
		args: {
			pat: "useState($A)",
			path: "packages/tui/src/components",
		},
		result: {
			content: [
				{
					type: "text",
					text: [
						"# packages/tui/src/components/",
						"## SearchBox.tsx",
						'18:  const [query, setQuery] = useState("");',
						'  meta: $A=""',
						"## StatusBar.tsx",
						"27:  const [expanded, setExpanded] = useState(false);",
						"  meta: $A=false",
					].join("\n"),
				},
			],
			details: {
				matchCount: 2,
				fileCount: 2,
				filesSearched: 14,
				limitReached: false,
				scopePath: "packages/tui/src/components",
				searchPath: "/Users/dev/Projects/pi/packages/tui/src/components",
				files: ["packages/tui/src/components/SearchBox.tsx", "packages/tui/src/components/StatusBar.tsx"],
				fileMatches: [
					{ path: "packages/tui/src/components/SearchBox.tsx", count: 1 },
					{ path: "packages/tui/src/components/StatusBar.tsx", count: 1 },
				],
				displayContent: [
					"# packages/tui/src/components/",
					"## SearchBox.tsx",
					'*18│  const [query, setQuery] = useState("");',
					'  meta: $A=""',
					"## StatusBar.tsx",
					"*27│  const [expanded, setExpanded] = useState(false);",
					"  meta: $A=false",
				].join("\n"),
			},
		},
		errorResult: {
			content: [
				{
					type: "text",
					text: "Pattern parse error: incomplete node `useState(` — expected a closing `)`",
				},
			],
			isError: true,
		},
	},
};
