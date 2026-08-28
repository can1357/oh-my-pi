import { describe, expect, it } from "bun:test";
import { buildSpec, type CompletionSpec, generateCompletion } from "@oh-my-pi/pi-coding-agent/cli/completion-gen";
import { generateLiveCompletion } from "@oh-my-pi/pi-coding-agent/commands/completions";
import type { CliConfig, CommandCtor } from "@oh-my-pi/pi-utils/cli";

// A compact synthetic spec exercising every value-source kind and an aliased
// subcommand. The generators are pure functions of this shape, so pinning their
// output here defends the exact bytes each shell parses without booting the CLI.
const spec: CompletionSpec = {
	bin: "omp",
	root: {
		flags: [
			{ name: "model", description: "Model to use", value: { kind: "models", multiple: false }, repeatable: false },
			{ name: "models", description: "Model list", value: { kind: "models", multiple: true }, repeatable: false },
			{
				name: "thinking",
				description: "Effort",
				value: { kind: "enum", values: ["low", "high"] },
				repeatable: false,
			},
			{ name: "tools", description: "Tools", value: { kind: "list", values: ["read", "bash"] }, repeatable: false },
			{ name: "resume", char: "r", description: "Resume", value: { kind: "sessions" }, repeatable: false },
			{ name: "print", char: "p", description: "Print", value: { kind: "flag" }, repeatable: false },
			{ name: "extension", char: "e", description: "Ext", value: { kind: "file" }, repeatable: true },
			{ name: "session-dir", description: "Dir", value: { kind: "dir" }, repeatable: false },
		],
		args: [],
	},
	commands: [
		{
			name: "commit",
			aliases: [],
			description: "Commit",
			flags: [{ name: "push", description: "Push", value: { kind: "flag" }, repeatable: false }],
			args: [],
		},
		{
			name: "worktree",
			aliases: ["wt"],
			description: "Worktrees",
			flags: [],
			args: [{ name: "action", description: "Action", value: { kind: "enum", values: ["list", "clear"] } }],
		},
	],
};

describe("generateCompletion — bash", () => {
	const out = generateCompletion("bash", spec);

	it("registers the dispatcher and resolves alias arms to the canonical handler", () => {
		expect(out).toContain("complete -F _omp omp");
		expect(out).toContain("_omp_cmd_commit");
		// worktree + its alias dispatch to the same function
		expect(out).toContain("worktree|wt)");
	});

	it("completes enum, dynamic, and comma-list flag values by previous flag", () => {
		expect(out).toContain('--thinking)\n\t\t\tCOMPREPLY=( $(compgen -W "low high"');
		expect(out).toContain('--model)\n\t\t\tCOMPREPLY=( $(compgen -W "$(command omp __complete models -- "$cur"');
		expect(out).toContain("--resume|-r)");
		expect(out).toContain("command omp __complete sessions");
		// static comma list routes through the comma-aware helper
		expect(out).toContain('--tools)\n\t\t\t_omp_comma "read bash"');
		// multiple-value models flag also uses the comma helper
		expect(out).toContain("--models)\n\t\t\t_omp_comma");
	});

	it("offers subcommand names and root flags at the top level", () => {
		expect(out).toMatch(/compgen -W "commit worktree wt [^"]*--model/);
	});

	it("completes a subcommand's positional enum and its own flags", () => {
		expect(out).toContain("_omp_cmd_worktree()");
		expect(out).toContain('compgen -W "list clear"');
		expect(out).toContain("_omp_cmd_commit()");
		expect(out).toContain('compgen -W "--push"');
	});
});

describe("generateCompletion — zsh", () => {
	const out = generateCompletion("zsh", spec);

	it("emits the compdef header and dual-mode (autoload + eval) tail", () => {
		expect(out.startsWith("#compdef omp")).toBe(true);
		expect(out).toContain('if [ "$funcstack[1]" = "_omp" ]; then');
		expect(out).toContain("compdef _omp omp");
	});

	it("maps value sources to the right _arguments actions", () => {
		expect(out).toContain("'--model[Model to use]:model:_omp_call models'");
		expect(out).toContain("'--models[Model list]:models:_omp_models_list'");
		expect(out).toContain("'--thinking[Effort]:value:(low high)'");
		expect(out).toContain("'--tools[Tools]:value:_omp_tools'");
		expect(out).toContain("'(-r --resume)'{-r,--resume}'[Resume]:session:_omp_call sessions'");
		expect(out).toContain("'--session-dir[Dir]:dir:_files -/'");
		// repeatable short+long flag uses the `*{...}` form
		expect(out).toContain("'*'{-e,--extension}'[Ext]:file:_files'");
		// the static tool list helper is baked
		expect(out).toContain("_omp_tools() { _values -s , 'tools' read bash }");
	});

	it("dispatches aliased subcommands and completes positional enums", () => {
		expect(out).toContain("worktree|wt) _omp_cmd_worktree ;;");
		expect(out).toContain("':action:(list clear)'");
	});
});

describe("generateCompletion — fish", () => {
	const out = generateCompletion("fish", spec);

	it("declares the no-subcommand predicate over every command token", () => {
		expect(out).toContain("function __fish_omp_no_subcommand");
		expect(out).toContain("if contains -- $i commit worktree wt");
	});

	it("renders subcommand names, including aliases, with descriptions", () => {
		expect(out).toContain("-a 'commit' -d 'Commit'");
		expect(out).toContain("-a 'wt' -d 'Worktrees'");
	});

	it("maps value sources to fish completion args", () => {
		expect(out).toContain("-l model -d 'Model to use' -x -a '(command omp __complete models -- (commandline -ct))'");
		expect(out).toContain("-l thinking -d 'Effort' -x -a 'low high'");
		expect(out).toContain("-l tools -d 'Tools' -x -a 'read bash'");
		expect(out).toContain("-s r -l resume -d 'Resume' -x -a '(command omp __complete sessions");
		// a bare boolean flag takes no value
		expect(out).toContain("-s p -l print -d 'Print'");
		expect(out).not.toContain("-l print -d 'Print' -x");
	});

	it("gates a positional enum on its subcommand", () => {
		expect(out).toContain("-n '__fish_seen_subcommand_from worktree wt' -a 'list clear'");
	});
});

describe("buildSpec", () => {
	function fakeCmd(props: Partial<CommandCtor>): CommandCtor {
		return props as unknown as CommandCtor;
	}

	it("lifts the root command's flags and excludes root + hidden from subcommands", () => {
		const config: CliConfig = {
			bin: "omp",
			version: "0",
			commands: new Map<string, CommandCtor>([
				["launch", fakeCmd({ hidden: true, flags: { model: { kind: "string" } }, args: {} })],
				["__complete", fakeCmd({ hidden: true, flags: {}, args: {} })],
				["config", fakeCmd({ description: "Cfg", flags: { json: { kind: "boolean" } }, args: {} })],
			]),
		};
		const result = buildSpec(config, "launch", new Map([["config", ["c"]]]));

		expect(result.root.flags.map(f => f.name)).toContain("model");
		// hidden (__complete) and the root entry (launch) are both dropped
		expect(result.commands.map(c => c.name)).toEqual(["config"]);
		expect(result.commands[0]?.aliases).toEqual(["c"]);
	});

	it("classifies flag value sources from descriptor metadata", () => {
		const config: CliConfig = {
			bin: "omp",
			version: "0",
			commands: new Map<string, CommandCtor>([
				[
					"launch",
					fakeCmd({
						hidden: true,
						flags: {
							model: { kind: "string" },
							thinking: { kind: "string", options: ["low", "high"] },
							"no-tools": { kind: "boolean" },
							"session-dir": { kind: "string" },
						},
						args: {},
					}),
				],
			]),
		};
		const root = buildSpec(config, "launch", new Map()).root;
		const byName = new Map(root.flags.map(f => [f.name, f.value.kind]));
		expect(byName.get("model")).toBe("models");
		expect(byName.get("thinking")).toBe("enum");
		expect(byName.get("no-tools")).toBe("flag");
		expect(byName.get("session-dir")).toBe("dir");
	});
});

describe("live completion surface", () => {
	it("generates a zsh script reflecting the registered commands and flags", async () => {
		const stdout = await generateLiveCompletion("zsh");

		// Real top-level flags from launch's static `flags` table. Flags with a
		// short char render as `{-r,--resume}`, so only assert the bracket form for
		// the long-only ones and check the char-paired form separately.
		for (const flag of ["--model", "--thinking", "--mode", "--approval-mode", "--tools", "--no-tools"]) {
			expect(stdout).toContain(`${flag}[`);
		}
		expect(stdout).toContain("{-r,--resume}");
		// Real enum option sets flow through unchanged.
		expect(stdout).toContain(":value:(off minimal low medium high xhigh max auto)");
		expect(stdout).toContain(":value:(always-ask write yolo)");
		// Real subcommands present; dynamic callbacks wired.
		expect(stdout).toContain("_omp_cmd_commit");
		expect(stdout).toContain("'completions:");
		// zsh routes single-value dynamic flags through the _omp_call action, which
		// itself shells out to `omp __complete $kind`.
		expect(stdout).toContain("_omp_call models");
		expect(stdout).toContain("_omp_call sessions");
		expect(stdout).toContain("command omp __complete $kind");
		// Hidden/default commands must NOT surface as completable subcommands.
		expect(stdout).not.toContain("_omp_cmd_launch");
		expect(stdout).not.toContain("_omp_cmd___complete");
	}, 30_000);
});
