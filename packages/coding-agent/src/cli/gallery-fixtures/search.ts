/** Gallery fixtures for the search tools (grep, search_tool_bm25, ast_grep). */
import type { GalleryFixture } from "./types";

export const searchFixtures: Record<string, GalleryFixture> = {
	grep: {
		label: "Grep",
		streamingArgs: {
			pattern: "useState",
		},
		args: {
			pattern: "useState",
			paths: ["packages/tui/src"],
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

	search_tool_bm25: {
		label: "SearchTools",
		streamingArgs: {
			query: "read pdf and ext",
		},
		args: {
			query: "read pdf and extract tables",
			limit: 5,
		},
		result: {
			content: [
				{
					type: "text",
					text: JSON.stringify({
						query: "read pdf and extract tables",
						activated_tools: ["docling_extract_tables", "docling_convert", "pdf_read_text"],
						match_count: 4,
						total_tools: 142,
					}),
				},
			],
			details: {
				query: "read pdf and extract tables",
				limit: 5,
				total_tools: 142,
				activated_tools: ["docling_extract_tables", "docling_convert", "pdf_read_text"],
				active_selected_tools: ["read", "grep", "edit", "bash"],
				tools: [
					{
						name: "docling_extract_tables",
						label: "Extract Tables",
						description: "Extract tabular data from PDF documents into CSV or JSON rows.",
						server_name: "docling",
						mcp_tool_name: "extract_tables",
						schema_keys: ["path", "pages", "format"],
						score: 9.412037,
					},
					{
						name: "docling_convert",
						label: "Convert Document",
						description: "Convert PDF, DOCX, or PPTX into structured Markdown with layout preserved.",
						server_name: "docling",
						mcp_tool_name: "convert",
						schema_keys: ["path", "target", "ocr"],
						score: 6.83102,
					},
					{
						name: "pdf_read_text",
						label: "Read PDF Text",
						description: "Read raw text from a PDF, optionally scoped to a page range.",
						server_name: "pdf-tools",
						mcp_tool_name: "read_text",
						schema_keys: ["path", "page_start", "page_end"],
						score: 5.207884,
					},
					{
						name: "tabula_scan",
						label: "Scan Tables",
						description: "Detect table bounding boxes on scanned PDF pages before extraction.",
						server_name: "pdf-tools",
						mcp_tool_name: "scan",
						schema_keys: ["path", "dpi"],
						score: 3.119556,
					},
				],
			},
		},
		errorResult: {
			content: [
				{
					type: "text",
					text: "Tool discovery is disabled. Enable tools.discoveryMode or mcp.discoveryMode to use search_tool_bm25.",
				},
			],
			isError: true,
		},
	},

	ast_grep: {
		label: "AST Grep",
		streamingArgs: {
			pat: "useState(",
		},
		args: {
			pat: "useState($A)",
			paths: ["packages/tui/src/components"],
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
