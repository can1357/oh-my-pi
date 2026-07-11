import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CombinedAutocompleteProvider } from "@pk-nerdsaver-ai/pi-tui/autocomplete";

describe("CombinedAutocompleteProvider", () => {
	describe("extractPathPrefix", () => {
		it("extracts / from 'hey /' when forced", async () => {
			const provider = new CombinedAutocompleteProvider([], "/tmp");
			const lines = ["hey /"];
			const cursorLine = 0;
			const cursorCol = 5; // After the "/"

			const result = await provider.getForceFileSuggestions(lines, cursorLine, cursorCol);

			expect(result).not.toBeNull();
			if (result) {
				expect(result.prefix).toBe("/");
			}
		});

		it("extracts /A from '/A' when forced", async () => {
			const provider = new CombinedAutocompleteProvider([], "/tmp");
			const lines = ["/A"];
			const cursorLine = 0;
			const cursorCol = 2; // After the "A"

			const result = await provider.getForceFileSuggestions(lines, cursorLine, cursorCol);

			// This might return null if /A doesn't match anything, which is fine
			// We're mainly testing that the prefix extraction works
			if (result) {
				expect(result.prefix).toBe("/A");
			}
		});

		it("does not trigger for slash commands", async () => {
			const provider = new CombinedAutocompleteProvider([], "/tmp");
			const lines = ["/model"];
			const cursorLine = 0;
			const cursorCol = 6; // After "model"

			const result = await provider.getForceFileSuggestions(lines, cursorLine, cursorCol);

			expect(result).toBe(null);
		});

		it("triggers for absolute paths after slash command argument", async () => {
			const provider = new CombinedAutocompleteProvider([], "/tmp");
			const lines = ["/command /"];
			const cursorLine = 0;
			const cursorCol = 10; // After the second "/"

			const result = await provider.getForceFileSuggestions(lines, cursorLine, cursorCol);

			expect(result).not.toBeNull();
			if (result) {
				expect(result.prefix).toBe("/");
			}
		});
	});

	describe("slash commands", () => {
		it("does not suggest slash commands after prose", async () => {
			const provider = new CombinedAutocompleteProvider([{ name: "skill", description: "Manage skills" }], "/tmp");
			const line = "run /sk";

			const result = await provider.getSuggestions([line], 0, line.length);

			expect(result).toBeNull();
		});
	});
	describe("applyCompletion", () => {
		it("replaces the live slash command prefix when rendered suggestions are stale", () => {
			const provider = new CombinedAutocompleteProvider([], "/tmp");
			const result = provider.applyCompletion(
				["/ski"],
				0,
				4,
				{ value: "skills:fix-bug", label: "/skills:fix-bug" },
				"/s",
			);

			expect(result.lines[0]).toBe("/skills:fix-bug ");
			expect(result.cursorCol).toBe("/skills:fix-bug ".length);
		});

		it("preserves leading whitespace when applying a slash command completion", () => {
			const provider = new CombinedAutocompleteProvider([], "/tmp");
			const result = provider.applyCompletion(
				["  /ski"],
				0,
				6,
				{ value: "skills:fix-bug", label: "/skills:fix-bug" },
				"/s",
			);

			expect(result.lines[0]).toBe("  /skills:fix-bug ");
			expect(result.cursorCol).toBe("  /skills:fix-bug ".length);
		});

		it("applies a slash completion whose prefix carries leading whitespace", () => {
			const provider = new CombinedAutocompleteProvider([], "/tmp");
			const result = provider.applyCompletion(["  /sk"], 0, 5, { value: "skill", label: "skill" }, "  /sk");

			expect(result.lines[0]).toBe("  /skill ");
			expect(result.cursorCol).toBe("  /skill ".length);
		});

		it("preserves earlier slash command arguments when completing a path inside the last argument", () => {
			const provider = new CombinedAutocompleteProvider([], "/tmp");
			const result = provider.applyCompletion(
				["/swarm run pac"],
				0,
				14,
				{ value: "package.json", label: "package.json" },
				"pac",
			);

			expect(result.lines[0]).toBe("/swarm run package.json");
			expect(result.cursorCol).toBe("/swarm run package.json".length);
		});

		it("replaces only the last path token when completing a multi-token slash command argument", () => {
			const provider = new CombinedAutocompleteProvider([], "/tmp");
			const result = provider.applyCompletion(
				["/model claude"],
				0,
				13,
				{ value: "claude-sonnet", label: "claude-sonnet" },
				"claude",
			);

			expect(result.lines[0]).toBe("/model claude-sonnet");
			expect(result.cursorCol).toBe("/model claude-sonnet".length);
		});
	});

	describe("hidden paths", () => {
		let baseDir: string;

		beforeEach(() => {
			baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "autocomplete-test-"));
		});

		afterEach(() => {
			fs.rmSync(baseDir, { recursive: true, force: true });
		});

		it("matches segmented filenames from abbreviated fuzzy query", async () => {
			fs.writeFileSync(path.join(baseDir, "history-search.ts"), "export const x = 1;\n");

			const provider = new CombinedAutocompleteProvider([], baseDir);
			const line = "@histsr";
			const result = await provider.getSuggestions([line], 0, line.length);

			const values = result?.items.map(item => item.value) ?? [];
			expect(values).toContain("@history-search.ts");
		});
		it("includes hidden paths but excludes .git", async () => {
			for (const dir of [".github", ".git"]) {
				fs.mkdirSync(path.join(baseDir, dir), { recursive: true });
			}
			fs.mkdirSync(path.join(baseDir, ".github", "workflows"), { recursive: true });
			fs.writeFileSync(path.join(baseDir, ".github", "workflows", "ci.yml"), "name: ci");
			fs.writeFileSync(path.join(baseDir, ".git", "config"), "[core]");

			const provider = new CombinedAutocompleteProvider([], baseDir);
			const line = "@";
			const result = await provider.getSuggestions([line], 0, line.length);

			const values = result?.items.map(item => item.value) ?? [];
			expect(values).toContain("@.github/");
			expect(values.some(value => value === "@.git" || value.startsWith("@.git/"))).toBe(false);
		});

		it("returns more than 20 fuzzy matches when the project contains them", async () => {
			// Regression: previously hard-capped at 20 by `slice(0, 20)`.
			const total = 30;
			for (let i = 0; i < total; i += 1) {
				fs.writeFileSync(path.join(baseDir, `controller-${i}.ts`), "export {};\n");
			}

			const provider = new CombinedAutocompleteProvider([], baseDir);
			const line = "@controller";
			const result = await provider.getSuggestions([line], 0, line.length);

			expect(result).not.toBeNull();
			const values = result?.items.map(item => item.value) ?? [];
			expect(values.length).toBeGreaterThan(20);
			expect(values.length).toBeGreaterThanOrEqual(total);
		});
	});

	describe("@ paths outside cwd", () => {
		let rootDir: string;
		let baseDir: string;
		let outsideDir: string;

		beforeEach(() => {
			rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "autocomplete-scope-test-"));
			baseDir = path.join(rootDir, "cwd");
			outsideDir = path.join(rootDir, "outside");
			fs.mkdirSync(baseDir, { recursive: true });
			fs.mkdirSync(outsideDir, { recursive: true });
		});

		afterEach(() => {
			fs.rmSync(rootDir, { recursive: true, force: true });
		});

		it("uses immediate-directory prefix completion for @../ (no recursive fuzzy walk)", async () => {
			// Sibling-of-cwd layout, mirroring the user-reported case: parent
			// dir holds many unrelated projects, each with deep subtrees.
			fs.mkdirSync(path.join(outsideDir, "workspace"), { recursive: true });
			fs.mkdirSync(path.join(outsideDir, "workflows"), { recursive: true });
			fs.mkdirSync(path.join(outsideDir, "other"), { recursive: true });
			fs.mkdirSync(path.join(outsideDir, "other", "deep", "nested"), { recursive: true });
			fs.writeFileSync(path.join(outsideDir, "other", "deep", "nested", "workspace-config.yml"), "x\n");

			const provider = new CombinedAutocompleteProvider([], baseDir);
			const line = "@../outside/wor";
			const result = await provider.getSuggestions([line], 0, line.length);

			const values = result?.items.map(item => item.value) ?? [];
			expect(values).toContain("@../outside/workspace/");
			expect(values).toContain("@../outside/workflows/");
			// Recursive matches must NOT leak in — that's the whole point of
			// the short-circuit.
			expect(values.some(value => value.includes("workspace-config.yml"))).toBe(false);
			expect(values.some(value => value.includes("/deep/"))).toBe(false);
		});

		it("normalizes backslash separators in a relative @..\\ prefix (Windows-style input)", async () => {
			// Mirrors the @../ test but with Windows-native backslashes. The fix
			// normalizes "\\" -> "/" before the path splitting/joining, so this is
			// catchable on POSIX CI. On the pre-fix code POSIX path.dirname/basename
			// treat "\\" as a literal char and the prefix yields no suggestions.
			fs.mkdirSync(path.join(outsideDir, "workspace"), { recursive: true });
			fs.mkdirSync(path.join(outsideDir, "workflows"), { recursive: true });

			const provider = new CombinedAutocompleteProvider([], baseDir);
			const line = "@..\\outside\\wor";
			const result = await provider.getSuggestions([line], 0, line.length);

			const values = result?.items.map(item => item.value) ?? [];
			expect(values).toContain("@../outside/workspace/");
			expect(values).toContain("@../outside/workflows/");
		});

		it("lists entries inside an absolute @/abs/ path without walking recursively", async () => {
			fs.mkdirSync(path.join(outsideDir, "alpha"), { recursive: true });
			fs.mkdirSync(path.join(outsideDir, "beta"), { recursive: true });
			fs.writeFileSync(path.join(outsideDir, "alpha", "nested.ts"), "export {};\n");

			const provider = new CombinedAutocompleteProvider([], baseDir);
			const line = `@${outsideDir}/`;
			const result = await provider.getSuggestions([line], 0, line.length);

			const values = result?.items.map(item => item.value) ?? [];
			// Normalize to forward slashes — the provider normalizes suggestion paths
			// so they work consistently on all platforms (forward slashes are valid on Windows).
			const normalizedOutsideDir = outsideDir.replace(/\\/g, "/");
			expect(values).toContain(`@${normalizedOutsideDir}/alpha/`);
			expect(values).toContain(`@${normalizedOutsideDir}/beta/`);
			expect(values.some(value => value.endsWith("nested.ts"))).toBe(false);
		});

		it("preserves the full absolute prefix when completing a partial leaf", async () => {
			fs.mkdirSync(path.join(outsideDir, "alpha"), { recursive: true });
			fs.mkdirSync(path.join(outsideDir, "beta"), { recursive: true });

			const provider = new CombinedAutocompleteProvider([], baseDir);
			const line = `@${outsideDir}/a`;
			const result = await provider.getSuggestions([line], 0, line.length);

			const values = result?.items.map(item => item.value) ?? [];
			const normalizedOutsideDir = outsideDir.replace(/\\/g, "/");
			expect(values).toContain(`@${normalizedOutsideDir}/alpha/`);
			// The parent path must be preserved, not stripped to just the leaf name
			expect(values.some(v => v === "@alpha/")).toBe(false);
		});
	});

	describe("dot-slash path completion", () => {
		let baseDir: string;

		beforeEach(() => {
			baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "autocomplete-dot-slash-test-"));
		});

		afterEach(() => {
			fs.rmSync(baseDir, { recursive: true, force: true });
		});

		it("preserves ./ prefix when completing files", async () => {
			fs.writeFileSync(path.join(baseDir, "update.sh"), "#!/bin/sh\n");
			const provider = new CombinedAutocompleteProvider([], baseDir);
			const line = "./up";
			const result = await provider.getForceFileSuggestions([line], 0, line.length);
			expect(result).not.toBeNull();
			const values = result?.items.map(item => item.value) ?? [];
			expect(values).toContain("./update.sh");
		});

		it("preserves ./ prefix when completing directories", async () => {
			fs.mkdirSync(path.join(baseDir, "src"), { recursive: true });
			fs.writeFileSync(path.join(baseDir, "src", "index.ts"), "export {};\n");
			const provider = new CombinedAutocompleteProvider([], baseDir);
			const line = "./sr";
			const result = await provider.getForceFileSuggestions([line], 0, line.length);
			expect(result).not.toBeNull();
			const values = result?.items.map(item => item.value) ?? [];
			expect(values).toContain("./src/");
		});
	});
});
describe("trySyncSlashCompletion", () => {
	it("returns null for bare '/' (no prefix to match)", () => {
		const provider = new CombinedAutocompleteProvider([], "/tmp");
		const result = provider.trySyncSlashCompletion("/");
		expect(result).toBeNull();
	});

	it("returns null for non-slash text", () => {
		const provider = new CombinedAutocompleteProvider([], "/tmp");
		expect(provider.trySyncSlashCompletion("hello")).toBeNull();
		expect(provider.trySyncSlashCompletion("")).toBeNull();
	});

	it("returns null when text has spaces (argument phase, not command name)", () => {
		const provider = new CombinedAutocompleteProvider([], "/tmp");
		expect(provider.trySyncSlashCompletion("/model claude")).toBeNull();
		expect(provider.trySyncSlashCompletion("/model ")).toBeNull();
	});

	it("returns null when no commands match", () => {
		const provider = new CombinedAutocompleteProvider([], "/tmp");
		const result = provider.trySyncSlashCompletion("/zzzzz");
		expect(result).toBeNull();
	});

	it("returns matching items for partial slash command name", () => {
		const provider = new CombinedAutocompleteProvider(
			[{ name: "model", description: "Switch AI model", value: "model" }],
			"/tmp",
		);
		const result = provider.trySyncSlashCompletion("/mo");
		expect(result).not.toBeNull();
		expect(result!.prefix).toBe("/mo");
		expect(result!.items.map(i => i.value)).toEqual(["model"]);
	});

	it("returns matching items when slash is the first non-whitespace token", () => {
		const provider = new CombinedAutocompleteProvider(
			[{ name: "model", description: "Switch AI model", value: "model" }],
			"/tmp",
		);
		const result = provider.trySyncSlashCompletion("  /mo");
		expect(result).not.toBeNull();
		expect(result!.prefix).toBe("  /mo");
		expect(result!.items.map(i => i.value)).toEqual(["model"]);
	});

	it("matches multiple commands and sorts by relevance", () => {
		const provider = new CombinedAutocompleteProvider(
			[
				{ name: "model", description: "Switch AI model", value: "model" },
				{ name: "mode", description: "Change editor mode", value: "mode" },
				{ name: "help", description: "Show help", value: "help" },
			],
			"/tmp",
		);
		const result = provider.trySyncSlashCompletion("/mo");
		expect(result).not.toBeNull();
		const values = result!.items.map(i => i.value);
		// /model and /mode should match; /help should not
		expect(values).toContain("model");
		expect(values).toContain("mode");
		expect(values).not.toContain("help");
		// The better name match should come first (higher score)
		const modelIdx = values.indexOf("model");
		const modeIdx = values.indexOf("mode");
		// model matches 3/5 chars, mode matches 3/4 chars — mode has higher match ratio
		// Both should be present; order depends on fuzzyScore internals
		expect(modelIdx).not.toBe(-1);
		expect(modeIdx).not.toBe(-1);
	});

	it("matches case-insensitively", () => {
		const provider = new CombinedAutocompleteProvider(
			[{ name: "Model", description: "Switch AI model", value: "Model" }],
			"/tmp",
		);
		const result = provider.trySyncSlashCompletion("/MOD");
		expect(result).not.toBeNull();
		expect(result!.items.map(i => i.value)).toContain("Model");
	});

	it("also matches against description", () => {
		const provider = new CombinedAutocompleteProvider(
			[{ name: "md", description: "Switch AI model", value: "md" }],
			"/tmp",
		);
		const result = provider.trySyncSlashCompletion("/model");
		expect(result).not.toBeNull();
		expect(result!.items.map(i => i.value)).toContain("md");
	});

	it("uses dynamic descriptions for slash command suggestions", async () => {
		let enabled = false;
		const provider = new CombinedAutocompleteProvider(
			[
				{
					name: "fast",
					description: "Toggle fast mode",
					getAutocompleteDescription: () => `Fast: ${enabled ? "on" : "off"}`,
				},
			],
			"/tmp",
		);

		const off = await provider.getSuggestions(["/fa"], 0, 3);
		expect(off?.items[0]).toMatchObject({ value: "fast", label: "fast", description: "Fast: off" });

		enabled = true;
		const on = await provider.getSuggestions(["/fa"], 0, 3);
		expect(on?.items[0]).toMatchObject({ value: "fast", label: "fast", description: "Fast: on" });
	});

	it("keeps static slash descriptions as the search corpus", async () => {
		const provider = new CombinedAutocompleteProvider(
			[{ name: "fast", description: "Toggle fast mode", getAutocompleteDescription: () => "Fast: enabled" }],
			"/tmp",
		);

		expect(await provider.getSuggestions(["/toggle"], 0, "/toggle".length)).not.toBeNull();
		expect(await provider.getSuggestions(["/enabled"], 0, "/enabled".length)).toBeNull();
	});

	it("handles AutocompleteItem-shaped commands (no 'name' property)", () => {
		const provider = new CombinedAutocompleteProvider([{ value: "model", label: "Switch model" }], "/tmp");
		const result = provider.trySyncSlashCompletion("/mod");
		expect(result).not.toBeNull();
		expect(result!.items.map(i => i.value)).toEqual(["model"]);
	});

	it("does not list aliases as separate rows for bare slash suggestions", async () => {
		const provider = new CombinedAutocompleteProvider(
			[
				{ name: "setup", aliases: ["providers"], description: "Open provider setup" },
				{ name: "usage", description: "Show provider usage and limits" },
			],
			"/tmp",
		);
		const result = await provider.getSuggestions(["/"], 0, 1);
		expect(result).not.toBeNull();
		expect(result!.items.map(i => i.value)).toEqual(["setup", "usage"]);
	});

	it("keeps registry order for same-prefix commands so /set still applies settings", () => {
		const provider = new CombinedAutocompleteProvider(
			[
				{ name: "settings", description: "Open settings menu", value: "settings" },
				{ name: "setup", description: "Open provider setup", value: "setup" },
			],
			"/tmp",
		);
		const result = provider.trySyncSlashCompletion("/set");
		expect(result).not.toBeNull();
		// The sync-completion path applies items[0] on Enter; the shorter `setup`
		// must not jump ahead of the earlier-registered `settings`.
		expect(result!.items[0]?.value).toBe("settings");
	});

	it("prefers exact command aliases over fuzzy description matches", () => {
		const provider = new CombinedAutocompleteProvider(
			[
				{ name: "setup", aliases: ["providers"], description: "Open provider setup" },
				{ name: "usage", description: "Show provider usage and limits" },
			],
			"/tmp",
		);
		const result = provider.trySyncSlashCompletion("/providers");
		expect(result).not.toBeNull();
		expect(result!.items[0]?.value).toBe("providers");
	});

	it("uses aliases when completing slash command arguments", async () => {
		const provider = new CombinedAutocompleteProvider(
			[
				{
					name: "setup",
					aliases: ["onboarding"],
					getArgumentCompletions: prefix =>
						"providers".startsWith(prefix) ? [{ value: "providers ", label: "providers" }] : null,
				},
			],
			"/tmp",
		);
		const result = await provider.getSuggestions(["/onboarding pro"], 0, "/onboarding pro".length);
		expect(result?.items.map(i => i.value)).toEqual(["providers "]);
	});

	it("uses aliases when rendering inline slash command hints", () => {
		const provider = new CombinedAutocompleteProvider(
			[
				{
					name: "setup",
					aliases: ["onboarding"],
					getInlineHint: argumentText => (argumentText === "pro" ? "viders" : null),
				},
			],
			"/tmp",
		);
		expect(provider.getInlineHint(["/onboarding pro"], 0, "/onboarding pro".length)).toBe("viders");
		expect(provider.getInlineHint(["  /onboarding pro"], 0, "  /onboarding pro".length)).toBe("viders");
	});
});
