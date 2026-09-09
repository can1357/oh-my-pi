use super::{CardFixture, FixtureState};

const READ_ARGS: &str = r#"{"path":"packages/coding-agent/src/tools/glob.ts:437-448"}"#;
/// `read@1` `Payload`: the hashline-numbered projection the tool journals
/// (`[<path>#<tag>]` header, `LINE:TEXT` rows); the card derives the gutter
/// from it.
const READ_RESULT: &str = r#"{"parts":[{"kind":"text","text":"[packages/coding-agent/src/tools/glob.ts#E48E]\n437:export const globToolRenderer = {\n438:\tinline: true,\n439:\trenderCall(args: GlobRenderArgs, _options: RenderResultOptions, uiTheme: Theme): Component {\n440:\t\tconst meta: string[] = [];\n441:\t\tif (args.limit !== undefined) meta.push(`limit:${args.limit}`);\n442:\n443:\t\tconst text = renderStatusLine(\n444:\t\t\t{ icon: \"pending\", title: \"Glob\", description: formatGlobRenderPaths(args.paths) || \"*\", meta },\n445:\t\t\tuiTheme,\n446:\t\t);\n447:\t\treturn new Text(text, 0, 0);\n448:\t},"}]}"#;
const READ_GROUP_STREAM: &str = r#"{"targets":[{"path":"packages/coding-agent/test/streaming-preview-height.test.ts:301-409"},{"path":"packages/coding-agent/test/tool-live-region-scrollback.test.ts:143-"}]}"#;
const READ_GROUP_RUNNING: &str = r#"{"targets":[{"path":"packages/coding-agent/test/streaming-preview-height.test.ts:301-409"},{"path":"packages/coding-agent/test/tool-live-region-scrollback.test.ts:143-310"},{"path":"packages/tui/test/streaming-scrollback-defer.test.ts:89-464"},{"path":"packages/coding-agent/src/task/render.ts:507-605,1070-1194,…,1270-1274"}]}"#;
const READ_GROUP_DONE: &str = r#"{"targets":[{"path":"packages/coding-agent/test/streaming-preview-height.test.ts:301-409"},{"path":"packages/coding-agent/test/tool-live-region-scrollback.test.ts:143-310"},{"path":"packages/tui/test/streaming-scrollback-defer.test.ts:89-464","usage":{"timestamp":"2026-07-28 21:05:47","input":"2.4K","output":"113","cache":"103K","time":"2.2s","throughput":"21.3/s"}},{"path":"packages/coding-agent/src/task/render.ts:507-605,1070-1194,…,1270-1274","usage":{"timestamp":"2026-07-28 21:05:52","input":"2.4K","output":"113","cache":"103K","time":"1.9s","throughput":"24.0/s"}}]}"#;
const READ_GROUP_FAILED: &str = r#"{"targets":[{"path":"packages/coding-agent/test/streaming-preview-height.test.ts:301-409"},{"path":"packages/coding-agent/test/tool-live-region-scrollback.test.ts:143-310"},{"path":"packages/tui/test/streaming-scrollback-defer.test.ts:89-464","usage":{"timestamp":"2026-07-28 21:05:47","input":"2.4K","output":"113","cache":"103K","time":"2.2s","throughput":"21.3/s"}},{"path":"packages/coding-agent/src/task/render.ts:507-605,1070-1194,…,1270-1274","error":true,"usage":{"timestamp":"2026-07-28 21:05:52","input":"2.4K","output":"113","cache":"103K","time":"1.9s","throughput":"24.0/s"}}]}"#;

const WRITE_STREAM: &str = r#"{"path":"packages/coding-agent/test/parse-sel.test.ts","content":"import { describe, expect, it } from \"bun:test\";\nimport { parseSel } from \"../src/tools/read\";\n"}"#;
const WRITE_ARGS: &str = r#"{"path":"packages/coding-agent/test/parse-sel.test.ts","content":"import { describe, expect, it } from \"bun:test\";\nimport { parseSel } from \"../src/tools/read\";\n\ndescribe(\"parseSel\", () => {\n\tit(\"parses a single line range\", () => {\n\t\texpect(parseSel(\"42-58\")).toEqual({\n\t\t\tkind: \"lines\",\n\t\t\tranges: [{ startLine: 42, endLine: 58 }],\n\t\t});\n\t});\n\n\tit(\"treats raw as a verbatim selector\", () => {\n\t\texpect(parseSel(\"raw\")).toEqual({ kind: \"raw\" });\n\t});\n});\n"}"#;
const WRITE_RESULT: &str =
	r#"{"disposition":"created","line_count":16,"byte_count":412,"lang":"typescript"}"#;

const EDIT_STREAM: &str = r#"{"file_path":"packages/coding-agent/src/tools/read.ts","previewDiff":"@@ -88,3 +88,4 @@\n \tconst offset = args.offset ?? 1;\n-\tconst limit = args.limit ?? 2000;\n+\tconst limit = args.limit ?? 4000;"}"#;
const EDIT_ARGS: &str = r#"{"file_path":"packages/coding-agent/src/tools/read.ts","previewDiff":"@@ -88,5 +88,6 @@\n \tconst offset = args.offset ?? 1;\n-\tconst limit = args.limit ?? 2000;\n+\tconst limit = args.limit ?? 4000;\n \tconst raw = await Bun.file(path).text();\n-\treturn raw.slice(offset , offset + limit);\n+\treturn raw.split(\"\\n\").slice(offset - 1, offset - 1 + limit).join(\"\\n\");"}"#;
const EDIT_RESULT: &str = r#"{"sections":[{"path":"packages/coding-agent/src/tools/read.ts","op":"update","first_changed_line":89,"diff":"@@ -88,5 +88,6 @@\n \tconst offset = args.offset ?? 1;\n-\tconst limit = args.limit ?? 2000;\n+\tconst limit = args.limit ?? 4000;\n \tconst raw = await Bun.file(path).text();\n-\treturn raw.slice(offset , offset + limit);\n+\treturn raw.split(\"\\n\").slice(offset - 1, offset - 1 + limit).join(\"\\n\");"}]}"#;
const DELETE_ARGS: &str = r#"{"file_path":"scripts/prune-changelogs.ts","op":"delete"}"#;
const DELETE_RESULT: &str =
	r#"{"sections":[{"path":"scripts/prune-changelogs.ts","op":"delete","diff":""}]}"#;
const MOVE_ARGS: &str =
	r#"{"file_path":"scripts/prune-changelogs.ts","rename":"scripts/archived/prune-changelogs.ts"}"#;
const MOVE_RESULT: &str = r#"{"sections":[{"path":"scripts/archived/prune-changelogs.ts","op":"move","source_path":"scripts/prune-changelogs.ts","diff":""}]}"#;
const PATCH_STREAM: &str = r#"{"file_path":"packages/coding-agent/src/edit/renderer.ts","previewDiff":"@@ -464,2 +464,2 @@\n-\t\tfileCount = countEditFiles(editArgs.edits);\n+\t\tfileCount = countDistinctFiles(editArgs.edits);"}"#;
const PATCH_ARGS: &str = r#"{"file_path":"packages/coding-agent/src/edit/renderer.ts","previewDiff":"@@ -177,4 +177,4 @@\n /** Count distinct file paths in an edits array. */\n-function countEditFiles(edits: EditRenderEntry[]): number {\n+function countDistinctFiles(edits: EditRenderEntry[]): number {\n \treturn new Set(edits.map(edit => filePathFromEditEntry(edit.path)).filter(Boolean)).size;\n }\n@@ -467,2 +467,2 @@\n-\t\tfileCount = countEditFiles(editArgs.edits);\n+\t\tfileCount = countDistinctFiles(editArgs.edits);"}"#;
const PATCH_RESULT: &str = r#"{"sections":[{"path":"packages/coding-agent/src/edit/renderer.ts","op":"update","first_changed_line":178,"diff":"@@ -177,4 +177,4 @@\n /** Count distinct file paths in an edits array. */\n-function countEditFiles(edits: EditRenderEntry[]): number {\n+function countDistinctFiles(edits: EditRenderEntry[]): number {\n \treturn new Set(edits.map(edit => filePathFromEditEntry(edit.path)).filter(Boolean)).size;\n }\n@@ -467,2 +467,2 @@\n-\t\tfileCount = countEditFiles(editArgs.edits);\n+\t\tfileCount = countDistinctFiles(editArgs.edits);"}]}"#;

const GLOB_ARGS: &str = r#"{"path":"packages/coding-agent/src/**/*.test.ts","limit":50}"#;
const GLOB_RESULT: &str = r#"{"file_count":5,"files":[{"path":"packages/coding-agent/src/cli/gallery-cli.test.ts"},{"path":"packages/coding-agent/src/edit/edit.test.ts"},{"path":"packages/coding-agent/src/tools/glob.test.ts"},{"path":"packages/coding-agent/src/tools/read.test.ts"},{"path":"packages/coding-agent/src/tools/write.test.ts"}]}"#;
const GREP_ARGS: &str = r#"{"pattern":"useState","path":"packages/tui/src"}"#;
const GREP_RESULT: &str = r#"{"matches":[{"path":"packages/tui/src/components/SearchBox.tsx","line":18,"text":"  const [query, setQuery] = useState(\"\");"},{"path":"packages/tui/src/components/SearchBox.tsx","line":19,"text":"  const [results, setResults] = useState<Match[]>([]);"},{"path":"packages/tui/src/components/StatusBar.tsx","line":27,"text":"  const [expanded, setExpanded] = useState(false);"},{"path":"packages/tui/src/hooks/useDebounced.ts","line":9,"text":"  const [value, setValue] = useState(initial);"},{"path":"packages/tui/src/hooks/useDebounced.ts","line":10,"text":"  const [pending, setPending] = useState(false);"}],"total":5}"#;

pub(super) const FIXTURES: &[CardFixture] = &[
	CardFixture {
		tool:   "read",
		title:  "Read",
		states: [
			FixtureState {
				args:   r#"{"path":"packages/coding-agent/src/tools/glob"#,
				update: None,
				result: None,
				fault:  None,
			},
			FixtureState { args: READ_ARGS, update: None, result: None, fault: None },
			FixtureState { args: READ_ARGS, update: None, result: Some(READ_RESULT), fault: None },
			FixtureState {
				args:   READ_ARGS,
				update: None,
				result: None,
				fault:  Some(
					r#"{"kind":"source","message":"ENOENT: no such file or directory, open 'packages/coding-agent/src/tools/glob.ts'"}"#,
				),
			},
		],
	},
	CardFixture {
		tool:   "read_group",
		title:  "Read Groups",
		states: [
			FixtureState { args: READ_GROUP_STREAM, update: None, result: None, fault: None },
			FixtureState { args: READ_GROUP_RUNNING, update: None, result: None, fault: None },
			FixtureState {
				args:   READ_GROUP_DONE,
				update: None,
				result: Some(r#"{"ok":true}"#),
				fault:  None,
			},
			FixtureState {
				args:   READ_GROUP_FAILED,
				update: None,
				result: None,
				fault:  Some(r#"{"message":"selector 1270-1274 is outside the file"}"#),
			},
		],
	},
	CardFixture {
		tool:   "write",
		title:  "Write",
		states: [
			FixtureState { args: WRITE_STREAM, update: None, result: None, fault: None },
			FixtureState { args: WRITE_ARGS, update: None, result: None, fault: None },
			FixtureState {
				args:   WRITE_ARGS,
				update: None,
				result: Some(WRITE_RESULT),
				fault:  None,
			},
			FixtureState {
				args:   WRITE_ARGS,
				update: None,
				result: None,
				fault:  Some(
					r#"{"message":"EACCES: permission denied, open 'packages/coding-agent/test/parse-sel.test.ts'"}"#,
				),
			},
		],
	},
	CardFixture {
		tool:   "edit",
		title:  "Edit",
		states: [
			FixtureState { args: EDIT_STREAM, update: None, result: None, fault: None },
			FixtureState { args: EDIT_ARGS, update: None, result: None, fault: None },
			FixtureState { args: EDIT_ARGS, update: None, result: Some(EDIT_RESULT), fault: None },
			FixtureState {
				args:   EDIT_ARGS,
				update: None,
				result: None,
				fault:  Some(
					r#"{"message":"No match for the search text. Expected `const limit = args.limit ?? 2000;` near line 89, but the file has `const limit = args.limit ?? 1000;`. Re-read the file and retry with the current contents."}"#,
				),
			},
		],
	},
	CardFixture {
		tool:   "edit_delete",
		title:  "Delete",
		states: [
			FixtureState { args: DELETE_ARGS, update: None, result: None, fault: None },
			FixtureState { args: DELETE_ARGS, update: None, result: None, fault: None },
			FixtureState {
				args:   DELETE_ARGS,
				update: None,
				result: Some(DELETE_RESULT),
				fault:  None,
			},
			FixtureState {
				args:   DELETE_ARGS,
				update: None,
				result: None,
				fault:  Some(
					r#"{"message":"Cannot delete scripts/prune-changelogs.ts: the file does not exist."}"#,
				),
			},
		],
	},
	CardFixture {
		tool:   "edit_move",
		title:  "Move",
		states: [
			FixtureState { args: MOVE_ARGS, update: None, result: None, fault: None },
			FixtureState { args: MOVE_ARGS, update: None, result: None, fault: None },
			FixtureState { args: MOVE_ARGS, update: None, result: Some(MOVE_RESULT), fault: None },
			FixtureState {
				args:   MOVE_ARGS,
				update: None,
				result: None,
				fault:  Some(
					r#"{"message":"MV destination scripts/archived/prune-changelogs.ts already exists."}"#,
				),
			},
		],
	},
	CardFixture {
		tool:   "apply_patch",
		title:  "Apply Patch",
		states: [
			FixtureState { args: PATCH_STREAM, update: None, result: None, fault: None },
			FixtureState { args: PATCH_ARGS, update: None, result: None, fault: None },
			FixtureState {
				args:   PATCH_ARGS,
				update: None,
				result: Some(PATCH_RESULT),
				fault:  None,
			},
			FixtureState {
				args:   PATCH_ARGS,
				update: None,
				result: None,
				fault:  Some(
					r#"{"message":"Hunk @@ -177,4 +177,4 @@ failed to apply: the context line `function countEditFiles(edits: EditRenderEntry[]): number {` does not match the file. The file may have changed since it was read."}"#,
				),
			},
		],
	},
	CardFixture {
		tool:   "glob",
		title:  "Glob",
		states: [
			FixtureState {
				args:   r#"{"path":"packages/coding-agent/src/tools/*-render"}"#,
				update: None,
				result: None,
				fault:  None,
			},
			FixtureState { args: GLOB_ARGS, update: None, result: None, fault: None },
			FixtureState { args: GLOB_ARGS, update: None, result: Some(GLOB_RESULT), fault: None },
			FixtureState {
				args:   r#"{"path":"[unclosed"}"#,
				update: None,
				result: None,
				fault:  Some(r#"{"message":"invalid glob pattern '[unclosed'"}"#),
			},
		],
	},
	CardFixture {
		tool:   "grep",
		title:  "Grep",
		states: [
			FixtureState {
				args:   r#"{"pattern":"useState"}"#,
				update: None,
				result: None,
				fault:  None,
			},
			FixtureState { args: GREP_ARGS, update: None, result: None, fault: None },
			FixtureState { args: GREP_ARGS, update: None, result: Some(GREP_RESULT), fault: None },
			FixtureState {
				args:   r#"{"pattern":"(foo|bar","path":"packages/tui/src"}"#,
				update: None,
				result: None,
				fault:  Some(r#"{"message":"Invalid regex pattern: unclosed group near index 8"}"#),
			},
		],
	},
];
