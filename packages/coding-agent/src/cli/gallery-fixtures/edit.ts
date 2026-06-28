/** Gallery fixtures for the edit tools (edit, apply_patch, ast_edit). */
import type { GalleryFixture } from "./types";

export const editFixtures: Record<string, GalleryFixture> = {
	edit: {
		label: "Edit",
		editMode: "replace",
		// `previewDiff` is surfaced verbatim by the renderer's call preview, and the
		// harness diff strategy skips `{ file_path, previewDiff }` (no `path`/`edits`),
		// so the canned diff survives the streaming and progress states.
		streamingArgs: {
			file_path: "packages/coding-agent/src/tools/read.ts",
			previewDiff: [
				"@@ -88,3 +88,4 @@",
				" 	const offset = args.offset ?? 1;",
				"-	const limit = args.limit ?? 2000;",
				"+	const limit = args.limit ?? 4000;",
			].join("\n"),
		},
		args: {
			file_path: "packages/coding-agent/src/tools/read.ts",
			previewDiff: [
				"@@ -88,5 +88,6 @@",
				" 	const offset = args.offset ?? 1;",
				"-	const limit = args.limit ?? 2000;",
				"+	const limit = args.limit ?? 4000;",
				" 	const raw = await Bun.file(path).text();",
				"-	return raw.slice(offset, offset + limit);",
				'+	return raw.split("\\n").slice(offset - 1, offset - 1 + limit).join("\\n");',
			].join("\n"),
		},
		result: {
			content: [{ type: "text", text: "Edited packages/coding-agent/src/tools/read.ts (1 hunk, +3 -2)" }],
			details: {
				path: "packages/coding-agent/src/tools/read.ts",
				firstChangedLine: 89,
				diff: [
					"@@ -88,5 +88,6 @@",
					" 	const offset = args.offset ?? 1;",
					"-	const limit = args.limit ?? 2000;",
					"+	const limit = args.limit ?? 4000;",
					" 	const raw = await Bun.file(path).text();",
					"-	return raw.slice(offset, offset + limit);",
					'+	return raw.split("\\n").slice(offset - 1, offset - 1 + limit).join("\\n");',
				].join("\n"),
			},
		},
		errorResult: {
			content: [
				{
					type: "text",
					text: "Edit failed: the search text was not found in packages/coding-agent/src/tools/read.ts",
				},
			],
			isError: true,
			details: {
				path: "packages/coding-agent/src/tools/read.ts",
				diff: "",
				errorText:
					"No match for the search text. Expected `const limit = args.limit ?? 2000;` near line 89, but the file has `const limit = args.limit ?? 1000;`. Re-read the file and retry with the current contents.",
			},
		},
	},

	edit_delete: {
		label: "Delete",
		// The registry has no `edit_delete` key, so `renderer: "edit"` routes this
		// fixture through the real built-in edit renderer (see the harness in
		// `gallery-cli`), keeping the sample identical to a production delete.
		renderer: "edit",
		streamingArgs: { file_path: "scripts/prune-changelogs.ts", op: "delete" },
		args: { file_path: "scripts/prune-changelogs.ts", op: "delete" },
		result: {
			content: [{ type: "text", text: "Deleted scripts/prune-changelogs.ts" }],
			details: {
				op: "delete",
				path: "scripts/prune-changelogs.ts",
				diff: "",
				oldText: "#!/usr/bin/env bun\n// obsolete changelog pruning helper\n",
			},
		},
		errorResult: {
			content: [{ type: "text", text: "Edit failed: scripts/prune-changelogs.ts not found" }],
			isError: true,
			details: {
				op: "delete",
				path: "scripts/prune-changelogs.ts",
				diff: "",
				errorText: "Cannot delete scripts/prune-changelogs.ts: the file does not exist.",
			},
		},
	},

	edit_move: {
		label: "Move",
		renderer: "edit",
		streamingArgs: { file_path: "scripts/prune-changelogs.ts", rename: "scripts/archived/prune-changelogs.ts" },
		args: { file_path: "scripts/prune-changelogs.ts", rename: "scripts/archived/prune-changelogs.ts" },
		result: {
			content: [{ type: "text", text: "Moved scripts/prune-changelogs.ts to scripts/archived/prune-changelogs.ts" }],
			details: {
				op: "update",
				path: "scripts/archived/prune-changelogs.ts",
				move: "scripts/archived/prune-changelogs.ts",
				sourcePath: "scripts/prune-changelogs.ts",
				diff: "",
			},
		},
		errorResult: {
			content: [
				{ type: "text", text: "Edit failed: destination scripts/archived/prune-changelogs.ts already exists" },
			],
			isError: true,
			details: {
				op: "update",
				path: "scripts/archived/prune-changelogs.ts",
				move: "scripts/archived/prune-changelogs.ts",
				sourcePath: "scripts/prune-changelogs.ts",
				diff: "",
				errorText: "MV destination scripts/archived/prune-changelogs.ts already exists.",
			},
		},
	},

	apply_patch: {
		label: "Apply Patch",
		editMode: "apply_patch",
		streamingArgs: {
			file_path: "packages/coding-agent/src/edit/renderer.ts",
			previewDiff: [
				"@@ -464,2 +464,2 @@",
				"-		fileCount = countEditFiles(editArgs.edits);",
				"+		fileCount = countDistinctFiles(editArgs.edits);",
			].join("\n"),
		},
		args: {
			file_path: "packages/coding-agent/src/edit/renderer.ts",
			previewDiff: [
				"@@ -177,4 +177,4 @@",
				" /** Count distinct file paths in an edits array. */",
				"-function countEditFiles(edits: EditRenderEntry[]): number {",
				"+function countDistinctFiles(edits: EditRenderEntry[]): number {",
				" 	return new Set(edits.map(edit => filePathFromEditEntry(edit.path)).filter(Boolean)).size;",
				" }",
				"@@ -467,2 +467,2 @@",
				"-		fileCount = countEditFiles(editArgs.edits);",
				"+		fileCount = countDistinctFiles(editArgs.edits);",
			].join("\n"),
		},
		result: {
			content: [
				{ type: "text", text: "Applied patch to packages/coding-agent/src/edit/renderer.ts (2 hunks, +2 -2)" },
			],
			details: {
				op: "update",
				path: "packages/coding-agent/src/edit/renderer.ts",
				firstChangedLine: 178,
				diff: [
					"@@ -177,4 +177,4 @@",
					" /** Count distinct file paths in an edits array. */",
					"-function countEditFiles(edits: EditRenderEntry[]): number {",
					"+function countDistinctFiles(edits: EditRenderEntry[]): number {",
					" 	return new Set(edits.map(edit => filePathFromEditEntry(edit.path)).filter(Boolean)).size;",
					" }",
					"@@ -467,2 +467,2 @@",
					"-		fileCount = countEditFiles(editArgs.edits);",
					"+		fileCount = countDistinctFiles(editArgs.edits);",
				].join("\n"),
			},
		},
		errorResult: {
			content: [
				{
					type: "text",
					text: "Apply patch failed: context does not match at line 177 of packages/coding-agent/src/edit/renderer.ts",
				},
			],
			isError: true,
			details: {
				op: "update",
				path: "packages/coding-agent/src/edit/renderer.ts",
				diff: "",
				errorText:
					"Hunk @@ -177,4 +177,4 @@ failed to apply: the context line `function countEditFiles(edits: EditRenderEntry[]): number {` does not match the file. The file may have changed since it was read.",
			},
		},
	},

	ast_edit: {
		label: "AST Edit",
		streamingArgs: {
			ops: [{ pat: "countEditFiles($$$ARGS)" }],
			paths: ["packages/coding-agent/src/**/*.ts"],
		},
		args: {
			ops: [{ pat: "countEditFiles($$$ARGS)", out: "countDistinctFiles($$$ARGS)" }],
			paths: ["packages/coding-agent/src/**/*.ts"],
		},
		result: {
			content: [
				{
					type: "text",
					text: [
						"# edit/renderer.ts (2 replacements)",
						"-468:		fileCount = countEditFiles(editArgs.edits);",
						"+468:		fileCount = countDistinctFiles(editArgs.edits);",
						"-488:		const totalFiles = args?.edits ? countEditFiles(args.edits) : 0;",
						"+488:		const totalFiles = args?.edits ? countDistinctFiles(args.edits) : 0;",
						"",
						"# tools/tool-result.ts (1 replacement)",
						"-42:	return countEditFiles(files);",
						"+42:	return countDistinctFiles(files);",
					].join("\n"),
				},
			],
			details: {
				totalReplacements: 3,
				filesTouched: 2,
				filesSearched: 214,
				applied: false,
				limitReached: false,
				scopePath: "packages/coding-agent/src",
				searchPath: "/Users/dev/Projects/pi/packages/coding-agent/src",
				files: ["edit/renderer.ts", "tools/tool-result.ts"],
				fileReplacements: [
					{ path: "edit/renderer.ts", count: 2 },
					{ path: "tools/tool-result.ts", count: 1 },
				],
				displayContent: [
					"# edit/",
					"## renderer.ts (2 replacements)",
					"-468│		fileCount = countEditFiles(editArgs.edits);",
					"+468│		fileCount = countDistinctFiles(editArgs.edits);",
					"-488│		const totalFiles = args?.edits ? countEditFiles(args.edits) : 0;",
					"+488│		const totalFiles = args?.edits ? countDistinctFiles(args.edits) : 0;",
					"",
					"# tools/",
					"## tool-result.ts (1 replacement)",
					"-42│	return countEditFiles(files);",
					"+42│	return countDistinctFiles(files);",
				].join("\n"),
			},
		},
		errorResult: {
			content: [
				{
					type: "text",
					text: "Pattern parse error in ops[0].pat: unbalanced parenthesis in `countEditFiles($$$ARGS`",
				},
			],
			isError: true,
		},
	},
};
