import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CombinedAutocompleteProvider } from "@oh-my-pi/pi-tui/autocomplete";

describe("CombinedAutocompleteProvider", () => {
	describe("extractPathPrefix", () => {
		it("extracts / from 'hey /' when forced", async () => {
			const provider = new CombinedAutocompleteProvider([], "/tmp");
			const lines = ["hey /"];
			const cursorLine = 0;
			const cursorCol = 5; // After the "/"

			const result = await provider.getForceFileSuggestions(lines, cursorLine, cursorCol);

			expect(result?.prefix).toBe("/");
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

			expect(result?.prefix).toBe("/");
		});
	});

	describe("slash commands", () => {
		it("suggests only skill commands after prose", async () => {
			const provider = new CombinedAutocompleteProvider(
				[
					{ name: "skill:security-scan", description: "Security scan" },
					{ name: "model", description: "Switch model" },
				],
				"/tmp",
			);
			const line = "run /security";

			const result = await provider.getSuggestions([line], 0, line.length);

			expect(result?.prefix).toBe("/security");
			expect(result?.items.map(item => item.value)).toEqual(["skill:security-scan"]);
		});

		it("suggests only skill commands after prior prompt lines", async () => {
			const provider = new CombinedAutocompleteProvider(
				[
					{ name: "skill:security-scan", description: "Security scan" },
					{ name: "model", description: "Switch model" },
				],
				"/tmp",
			);

			const result = await provider.getSuggestions(["there is an issue", "/skill:"], 1, "/skill:".length);

			expect(result?.prefix).toBe("/skill:");
			expect(result?.items.map(item => item.value)).toEqual(["skill:security-scan"]);
		});

		it("does not suggest skills when the slash is inside a word", async () => {
			const provider = new CombinedAutocompleteProvider(
				[{ name: "skill:security-scan", description: "Security scan" }],
				"/tmp",
			);
			const line = "word/security";

			const result = await provider.getSuggestions([line], 0, line.length);

			expect(result).toBeNull();
		});

		// Requires a real `/tmp` directory at the filesystem root.
		it.skipIf(process.platform === "win32")(
			"falls back to path suggestions for an unmatched mid-prompt slash token",
			async () => {
				const provider = new CombinedAutocompleteProvider(
					[{ name: "skill:security-scan", description: "Security scan" }],
					"/tmp",
				);
				const line = "see /tmp";

				const result = await provider.getSuggestions([line], 0, line.length);

				expect(result?.prefix).toBe("/tmp");
				expect(result?.items.map(item => item.value)).toContain("/tmp/");
			},
		);

		it("returns nothing for a prose token that only fuzzy-matches skill text", async () => {
			const provider = new CombinedAutocompleteProvider(
				[{ name: "skill:humanizer", description: "Remove signs of AI-generated writing from text" }],
				"/tmp",
			);
			// "sign" fuzzy-matches the description ("signs") but is neither a
			// name prefix nor a `skill:` query; the popup must close instead of
			// hovering on an irrelevant skill (falls through to path completion,
			// which has no /sign* entries either).
			const line = "we should /sign";

			const result = await provider.getSuggestions([line], 0, line.length);

			expect(result).toBeNull();
		});

		it("matches skills by bare-name prefix mid-prompt", async () => {
			const provider = new CombinedAutocompleteProvider(
				[
					{ name: "skill:humanizer", description: "Remove signs of AI writing" },
					{ name: "skill:reviewer", description: "Code review" },
				],
				"/tmp",
			);
			const line = "polish this /hum";

			const result = await provider.getSuggestions([line], 0, line.length);

			expect(result?.prefix).toBe("/hum");
			expect(result?.items.map(item => item.value)).toEqual(["skill:humanizer"]);
		});

		it("collapses skills into a single skill: namespace row at prompt start", async () => {
			const provider = new CombinedAutocompleteProvider(
				[
					{ name: "skill:humanizer", description: "Remove signs of AI writing" },
					{ name: "skill:reviewer", description: "Code review" },
					{ name: "model", description: "Switch model" },
				],
				"/tmp",
			);

			const result = await provider.getSuggestions(["/"], 0, 1);

			expect(result?.items.map(item => item.value)).toEqual(["skill:", "model"]);
		});

		it("keeps only the namespace row while the leading prefix approaches skill:", async () => {
			const provider = new CombinedAutocompleteProvider(
				[
					{ name: "skill:humanizer", description: "Remove signs of AI writing" },
					{ name: "skill:reviewer", description: "Code review" },
					{ name: "model", description: "Switch model" },
				],
				"/tmp",
			);

			const result = await provider.getSuggestions(["/sk"], 0, "/sk".length);

			expect(result?.items.map(item => item.value)).toEqual(["skill:"]);
		});

		it("surfaces skills for a leading bare-name prefix no command matches as strongly", async () => {
			const provider = new CombinedAutocompleteProvider(
				[
					{ name: "skill:batch", description: "Run batch workflows" },
					{ name: "skill:reviewer", description: "Code review" },
					{ name: "run-batch", description: "Run a saved batch job" },
				],
				"/tmp",
			);

			// `run-batch` only fuzzy-matches `batch`; the skill's bare-name prefix
			// match is strictly stronger, so it breaks out of the group and
			// outranks the fuzzy command hit.
			const result = await provider.getSuggestions(["/batch"], 0, "/batch".length);

			expect(result?.prefix).toBe("/batch");
			expect(result?.items.map(item => item.value)).toEqual(["skill:batch", "run-batch"]);
		});

		it("keeps skills collapsed when a command name matches the prefix equally", async () => {
			const provider = new CombinedAutocompleteProvider(
				[
					{ name: "skill:setup-ci", description: "Bootstrap CI pipelines" },
					{ name: "settings", description: "Open settings" },
				],
				"/tmp",
			);

			// Both the command and the skill's bare name prefix-match `set`;
			// the tie keeps the popup command-only.
			const result = await provider.getSuggestions(["/set"], 0, "/set".length);

			expect(result?.items.map(item => item.value)).toEqual(["settings"]);
		});

		it("breaks a skill out when its bare name matches exactly and commands only prefix-match", async () => {
			const provider = new CombinedAutocompleteProvider(
				[
					{ name: "skill:set", description: "Set tracked values" },
					{ name: "settings", description: "Open settings" },
				],
				"/tmp",
			);

			const result = await provider.getSuggestions(["/set"], 0, "/set".length);

			expect(result?.items.map(item => item.value)).toEqual(["skill:set", "settings"]);
		});

		it("never breaks skills out on fuzzy-only bare-name hits", async () => {
			const provider = new CombinedAutocompleteProvider(
				[{ name: "skill:humanizer", description: "Remove signs of AI writing" }],
				"/tmp",
			);

			// `hmz` fuzzy-matches `humanizer` but is not a prefix; the popup
			// stays closed instead of surfacing a weak skill hit.
			const result = await provider.getSuggestions(["/hmz"], 0, "/hmz".length);

			expect(result).toBeNull();
		});

		it("expands individual skills once the leading prefix enters the namespace", async () => {
			const provider = new CombinedAutocompleteProvider(
				[
					{ name: "skill:humanizer", description: "Remove signs of AI writing" },
					{ name: "skill:reviewer", description: "Code review" },
					{ name: "model", description: "Switch model" },
				],
				"/tmp",
			);

			const result = await provider.getSuggestions(["/skill:"], 0, "/skill:".length);

			expect(result?.items.map(item => item.value)).toEqual(["skill:humanizer", "skill:reviewer"]);
		});

		it("completes the namespace row without a trailing space so completion can continue", () => {
			const provider = new CombinedAutocompleteProvider([], "/tmp");

			const result = provider.applyCompletion(["/sk"], 0, "/sk".length, { value: "skill:", label: "skill:" }, "/sk");

			expect(result.lines[0]).toBe("/skill:");
			expect(result.cursorCol).toBe("/skill:".length);
		});

		it("never sync-completes Enter to the bare skill namespace", () => {
			const provider = new CombinedAutocompleteProvider(
				[{ name: "skill:humanizer", description: "Remove signs of AI writing" }],
				"/tmp",
			);

			// items[0] of the sync path is applied and submitted immediately;
			// `/skill:` alone is not a runnable command, so `/sk` must not match.
			expect(provider.trySyncSlashCompletion("/sk")).toBeNull();
		});

		it("lists every skill while typing toward the skill: namespace mid-prompt", async () => {
			const provider = new CombinedAutocompleteProvider(
				[
					{ name: "skill:humanizer", description: "Remove signs of AI writing" },
					{ name: "skill:reviewer", description: "Code review" },
					{ name: "model", description: "Switch model" },
				],
				"/tmp",
			);
			const line = "polish this /sk";

			const result = await provider.getSuggestions([line], 0, line.length);

			expect(result?.items.map(item => item.value)).toEqual(["skill:humanizer", "skill:reviewer"]);
		});

		it("keeps fuzzy matching for explicit skill: queries mid-prompt", async () => {
			const provider = new CombinedAutocompleteProvider(
				[
					{ name: "skill:humanizer", description: "Remove signs of AI writing" },
					{ name: "skill:reviewer", description: "Code review" },
				],
				"/tmp",
			);
			const line = "polish this /skill:hmnzr";

			const result = await provider.getSuggestions([line], 0, line.length);

			expect(result?.items.map(item => item.value)).toEqual(["skill:humanizer"]);
		});

		it("does not treat whitespace-only no-arg slash command arguments as file prefixes", async () => {
			const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "autocomplete-quit-whitespace-"));
			try {
				fs.writeFileSync(path.join(baseDir, "copy-target.ts"), "export {};\n");
				const provider = new CombinedAutocompleteProvider(
					[{ name: "quit", description: "Quit", allowArgs: false }],
					baseDir,
				);
				const line = "/quit  ";
				const result = await provider.getSuggestions([line], 0, line.length);

				expect(result).toBeNull();
			} finally {
				fs.rmSync(baseDir, { recursive: true, force: true });
			}
		});

		it("returns @ file-reference completions inside slash command arguments without command completions", async () => {
			const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "autocomplete-rename-args-"));
			try {
				fs.writeFileSync(path.join(baseDir, "copy-target.ts"), "export {};\n");
				const provider = new CombinedAutocompleteProvider(
					[{ name: "rename", description: "Rename current session", allowArgs: true }],
					baseDir,
				);
				const line = "/rename repro @";
				const result = await provider.getSuggestions([line], 0, line.length);

				expect(result?.prefix).toBe("@");
				expect(result?.items.map(item => item.value)).toContain("@copy-target.ts");
			} finally {
				fs.rmSync(baseDir, { recursive: true, force: true });
			}
		});

		it("returns @ file-reference completions for matched slash commands that reject arguments", async () => {
			const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "autocomplete-settings-args-"));
			try {
				fs.writeFileSync(path.join(baseDir, "copy-target.ts"), "export {};\n");
				const provider = new CombinedAutocompleteProvider(
					[{ name: "settings", description: "Open settings", allowArgs: false }],
					baseDir,
				);
				const line = "/settings @";
				const result = await provider.getSuggestions([line], 0, line.length);

				expect(result?.prefix).toBe("@");
				expect(result?.items.map(item => item.value)).toContain("@copy-target.ts");
			} finally {
				fs.rmSync(baseDir, { recursive: true, force: true });
			}
		});

		it("returns slash command argument completions instead of @ file references when the command defines them", async () => {
			const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "autocomplete-rename-args-"));
			try {
				fs.writeFileSync(path.join(baseDir, "copy-target.ts"), "export {};\n");
				const provider = new CombinedAutocompleteProvider(
					[
						{
							name: "rename",
							description: "Rename current session",
							allowArgs: true,
							getArgumentCompletions: argumentPrefix =>
								argumentPrefix === "repro @"
									? [{ value: "repro @literal", label: "Keep @ in the title" }]
									: null,
						},
					],
					baseDir,
				);
				const line = "/rename repro @";
				const result = await provider.getSuggestions([line], 0, line.length);

				expect(result).toEqual({
					prefix: "repro @",
					items: [{ value: "repro @literal", label: "Keep @ in the title" }],
				});
			} finally {
				fs.rmSync(baseDir, { recursive: true, force: true });
			}
		});

		it("falls back to path completions when slash command argument completions have no match", async () => {
			const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "autocomplete-rename-path-"));
			try {
				fs.mkdirSync(path.join(baseDir, "src"));
				fs.writeFileSync(path.join(baseDir, "src", "app.ts"), "export {};\n");
				const provider = new CombinedAutocompleteProvider(
					[
						{
							name: "btw",
							description: "Ask a side question",
							allowArgs: true,
							getArgumentCompletions(argumentPrefix) {
								if (argumentPrefix === "option") {
									return [{ value: "option", label: "option" }];
								}
								return null;
							},
						},
					],
					baseDir,
				);
				const line = "/btw ./src/ap";
				const result = await provider.getSuggestions([line], 0, line.length);

				expect(result?.prefix).toBe("./src/ap");
				expect(result?.items.map(item => item.value)).toContain("./src/app.ts");
			} finally {
				fs.rmSync(baseDir, { recursive: true, force: true });
			}
		});
	});

	describe("natural file completion triggers", () => {
		it("uses only explicit path contexts during automatic updates", async () => {
			const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "autocomplete-natural-trigger-"));
			try {
				fs.writeFileSync(path.join(baseDir, ".secret"), "secret\n");
				fs.mkdirSync(path.join(baseDir, "src"));
				fs.writeFileSync(path.join(baseDir, "src", "index.ts"), "export {};\n");
				const provider = new CombinedAutocompleteProvider(
					[{ name: "model", description: "Switch model" }],
					baseDir,
				);

				for (const line of [".", "Sentence .", "Sentence ", "use src/in", "/tmp"]) {
					expect(await provider.getSuggestions([line], 0, line.length)).toBeNull();
				}

				const explicitPath = "./src/in";
				expect(
					(await provider.getSuggestions([explicitPath], 0, explicitPath.length))?.items.map(item => item.value),
				).toContain("./src/index.ts");
				const forcedPath = "use src/in";
				expect(
					(await provider.getForceFileSuggestions([forcedPath], 0, forcedPath.length))?.items.map(
						item => item.value,
					),
				).toContain("src/index.ts");
			} finally {
				fs.rmSync(baseDir, { recursive: true, force: true });
			}
		});
	});

	describe("absolute path completion", () => {
		let baseDir: string;

		beforeEach(() => {
			baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "autocomplete-absolute-"));
			fs.writeFileSync(path.join(baseDir, "alpha.ts"), "export {};\n");
		});

		afterEach(() => {
			fs.rmSync(baseDir, { recursive: true, force: true });
		});

		it("falls through from an unmatched leading slash command token to file suggestions", async () => {
			const provider = new CombinedAutocompleteProvider([{ name: "model", description: "Switch model" }], baseDir);
			const normalizedBaseDir = baseDir.replace(/\\/g, "/");
			const prefix = `${normalizedBaseDir}/al`;

			const result = await provider.getSuggestions([prefix], 0, prefix.length);

			expect(result?.prefix).toBe(prefix);
			expect(result?.items.map(item => item.value)).toContain(`${normalizedBaseDir}/alpha.ts`);
		});

		it("falls through to file suggestions when an absolute path has leading whitespace", async () => {
			const provider = new CombinedAutocompleteProvider([{ name: "model", description: "Switch model" }], baseDir);
			const normalizedBaseDir = baseDir.replace(/\\/g, "/");
			const prefix = `${normalizedBaseDir}/al`;
			const line = `  ${prefix}`;

			const result = await provider.getSuggestions([line], 0, line.length);

			expect(result?.prefix).toBe(prefix);
			expect(result?.items.map(item => item.value)).toContain(`${normalizedBaseDir}/alpha.ts`);
		});

		it("triggers automatic completion for a drive-letter path token on every platform", async () => {
			// On Windows `C:/` is a real drive root; on POSIX it is a relative
			// directory literally named `C:`, created here so the same drive-style
			// token exercises the trigger without platform branching downstream.
			if (process.platform !== "win32") {
				fs.mkdirSync(path.join(baseDir, "C:"));
				fs.writeFileSync(path.join(baseDir, "C:", "alpha.ts"), "export {};\n");
			}
			const provider = new CombinedAutocompleteProvider([{ name: "model", description: "Switch model" }], baseDir);
			const line = "see C:/";

			const result = await provider.getSuggestions([line], 0, line.length);

			expect(result?.prefix).toBe("C:/");
			if (process.platform !== "win32") {
				expect(result?.items.map(item => item.value)).toContain("C:/alpha.ts");
			}
		});

		it("keeps slash command matches ahead of file suggestions", async () => {
			const provider = new CombinedAutocompleteProvider([{ name: "model", description: "Switch model" }], baseDir);
			const line = "/mod";

			const result = await provider.getSuggestions([line], 0, line.length);

			expect(result?.prefix).toBe(line);
			expect(result?.items.map(item => item.value)).toEqual(["model"]);
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

		it("applies a leading-slash path completion without slash-command insertion", () => {
			const provider = new CombinedAutocompleteProvider([], "/tmp");
			const result = provider.applyCompletion(["/tm"], 0, 3, { value: "/tmp/", label: "tmp/" }, "/tm");

			expect(result.lines[0]).toBe("/tmp/");
			expect(result.cursorCol).toBe("/tmp/".length);
		});

		it("applies an absolute deep path by replacing only the active token", () => {
			const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "autocomplete-absolute-apply-"));
			try {
				fs.writeFileSync(path.join(baseDir, "alpha.ts"), "export {};\n");
				const provider = new CombinedAutocompleteProvider([], baseDir);
				const normalizedBaseDir = baseDir.replace(/\\/g, "/");
				const prefix = `${normalizedBaseDir}/al`;
				const completedPath = `${normalizedBaseDir}/alpha.ts`;
				const line = `open ${prefix}`;

				const result = provider.applyCompletion(
					[line],
					0,
					line.length,
					{ value: completedPath, label: "alpha.ts" },
					prefix,
				);

				expect(result.lines[0]).toBe(`open ${completedPath}`);
				expect(result.cursorCol).toBe(`open ${completedPath}`.length);
			} finally {
				fs.rmSync(baseDir, { recursive: true, force: true });
			}
		});

		it("applies a quoted absolute path completion without slash-command insertion", () => {
			const provider = new CombinedAutocompleteProvider([], "/tmp");
			const result = provider.applyCompletion(["/tm"], 0, 3, { value: '"/tmp/"', label: "tmp/" }, "/tm");

			expect(result.lines[0]).toBe('"/tmp/"');
			expect(result.cursorCol).toBe('"/tmp/"'.length);
		});

		it("inserts the skill token at the cursor when applying a mid-prompt skill completion", () => {
			const provider = new CombinedAutocompleteProvider([], "/tmp");
			const result = provider.applyCompletion(
				["explain this", "then use /security"],
				1,
				"then use /security".length,
				{ value: "skill:security-scan", label: "/skill:security-scan" },
				"/security",
			);

			// Prior line + prose before the slash are preserved; only the partial
			// "/security" token is replaced with "/skill:security-scan ".
			expect(result.lines).toEqual(["explain this", "then use /skill:security-scan "]);
			expect(result.cursorLine).toBe(1);
			expect(result.cursorCol).toBe("then use /skill:security-scan ".length);
		});

		it("keeps text after the cursor when applying a mid-prompt skill completion", () => {
			const provider = new CombinedAutocompleteProvider([], "/tmp");
			const result = provider.applyCompletion(
				["fix bug /sec then ship"],
				0,
				"fix bug /sec".length,
				{ value: "skill:security-scan", label: "/skill:security-scan" },
				"/sec",
			);

			expect(result.lines[0]).toBe("fix bug /skill:security-scan  then ship");
			expect(result.cursorLine).toBe(0);
			expect(result.cursorCol).toBe("fix bug /skill:security-scan ".length);
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
			const values = result?.items.map(item => item.value) ?? [];
			expect(values).toContain("./update.sh");
		});

		it("preserves ./ prefix when completing directories", async () => {
			fs.mkdirSync(path.join(baseDir, "src"), { recursive: true });
			fs.writeFileSync(path.join(baseDir, "src", "index.ts"), "export {};\n");
			const provider = new CombinedAutocompleteProvider([], baseDir);
			const line = "./sr";
			const result = await provider.getForceFileSuggestions([line], 0, line.length);
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
		expect(result!.prefix).toBe("/mo");
		expect(result!.items.map(i => i.value)).toEqual(["model"]);
	});

	it("returns matching items when slash is the first non-whitespace token", () => {
		const provider = new CombinedAutocompleteProvider(
			[{ name: "model", description: "Switch AI model", value: "model" }],
			"/tmp",
		);
		const result = provider.trySyncSlashCompletion("  /mo");
		expect(result!.prefix).toBe("  /mo");
		expect(result!.items.map(i => i.value)).toEqual(["model"]);
	});

	it("matches multiple commands and excludes non-matches", () => {
		const provider = new CombinedAutocompleteProvider(
			[
				{ name: "model", description: "Switch AI model", value: "model" },
				{ name: "mode", description: "Change editor mode", value: "mode" },
				{ name: "help", description: "Show help", value: "help" },
			],
			"/tmp",
		);
		const result = provider.trySyncSlashCompletion("/mo");
		const values = result!.items.map(i => i.value);
		// /model and /mode should match; /help should not
		expect(values).toContain("model");
		expect(values).toContain("mode");
		expect(values).not.toContain("help");
	});

	it("matches case-insensitively", () => {
		const provider = new CombinedAutocompleteProvider(
			[{ name: "Model", description: "Switch AI model", value: "Model" }],
			"/tmp",
		);
		const result = provider.trySyncSlashCompletion("/MOD");
		expect(result!.items.map(i => i.value)).toContain("Model");
	});

	it("also matches against description", () => {
		const provider = new CombinedAutocompleteProvider(
			[{ name: "md", description: "Switch AI model", value: "md" }],
			"/tmp",
		);
		const result = provider.trySyncSlashCompletion("/model");
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
		expect(result!.items.map(i => i.value)).toEqual(["model"]);
	});

	it("ranks equal-score prefix matches by usage frequency, keeping registry order for unused ones", async () => {
		const commands = [
			{ name: "setup", description: "Open provider setup" },
			{ name: "settings", description: "Open settings menu" },
			{ name: "session", description: "Session management" },
		];
		const usage: Record<string, number> = { settings: 4 };

		const ranked = new CombinedAutocompleteProvider(commands, "/tmp", {
			commandUsage: name => usage[name] ?? 0,
		});
		const result = await ranked.getSuggestions(["/se"], 0, 3);
		expect(result?.items.map(i => i.value)).toEqual(["settings", "setup", "session"]);

		// Exact text matches still outrank usage: /setup beats a frequent /settings.
		const exact = await ranked.getSuggestions(["/setup"], 0, 6);
		expect(exact?.items[0]?.value).toBe("setup");

		// Without usage data, registry order is preserved.
		const unranked = new CombinedAutocompleteProvider(commands, "/tmp");
		const plain = await unranked.getSuggestions(["/se"], 0, 3);
		expect(plain?.items.map(i => i.value)).toEqual(["setup", "settings", "session"]);
	});

	it("carries command icons into name and alias suggestion rows", async () => {
		const provider = new CombinedAutocompleteProvider(
			[
				{ name: "model", description: "Switch model", icon: "\uec19" },
				{ name: "quit", aliases: ["q"], description: "Quit the application", icon: "\uf011" },
				{ name: "hotkeys", description: "Show keyboard shortcuts" },
			],
			"/tmp",
		);
		const bare = await provider.getSuggestions(["/"], 0, 1);
		expect(bare?.items.find(i => i.value === "model")?.icon).toBe("\uec19");
		expect(bare?.items.find(i => i.value === "hotkeys")?.icon).toBeUndefined();

		// An alias row inherits the owning command's icon (/q resolves via alias).
		const alias = await provider.getSuggestions(["/q"], 0, 2);
		expect(alias?.items[0]).toMatchObject({ value: "q", icon: "\uf011" });
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
		expect(result!.items.map(i => i.value)).toEqual(["setup", "usage"]);
	});

	it("does not list an alias separately when the primary name also matches", async () => {
		const provider = new CombinedAutocompleteProvider(
			[{ name: "model", aliases: ["models"], description: "Switch model" }],
			"/tmp",
		);
		const result = await provider.getSuggestions(["/mod"], 0, 4);
		expect(result!.items.map(i => i.value)).toEqual(["model"]);
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
		expect(result!.items[0]?.value).toBe("providers");
	});

	it("prefers an exact alias over an earlier same-prefix command (/q -> quit, not queue)", () => {
		const provider = new CombinedAutocompleteProvider(
			[
				{ name: "queue", description: "Queue a message for after the agent yields" },
				{ name: "quit", aliases: ["q"], description: "Quit the application" },
			],
			"/tmp",
		);
		const result = provider.trySyncSlashCompletion("/q");
		// The sync-completion path applies items[0] on Enter. Even though `queue`
		// is registered first and shares the `q` prefix, the exact `q` alias on
		// `quit` must win (score 1000 > 900) so /q + Enter dispatches the `q`
		// alias, which resolves to `quit` (#5335).
		expect(result!.items[0]?.value).toBe("q");
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
