import { describe, expect, it } from "bun:test";
import { isNativeShell } from "../../src/cli/native-shell";
import { commands, resolveCliArgv } from "../../src/cli-commands";
import { generateLiveCompletion } from "../../src/commands/completions";

const SHELLS = ["zsh", "bash", "sh"] as const;

describe("omp zsh|bash|sh", () => {
	it("dispatches exactly the three shell words", () => {
		for (const shell of SHELLS) expect(isNativeShell(shell)).toBe(true);
		for (const other of [undefined, "shell", "fish", "-c", "launch"]) expect(isNativeShell(other)).toBe(false);
	});

	it("registers each as a command taking arbitrary arguments", async () => {
		for (const shell of SHELLS) {
			const entry = commands.find(c => c.name === shell);
			expect(entry?.help?.description).toContain(shell);
			const Cmd = await entry!.load();
			expect(Cmd.strict).toBe(false);
			expect(Cmd.args?.args?.multiple).toBe(true);
			// The word routes to the command, never to `launch` as a prompt.
			expect(resolveCliArgv([shell, "-c", "echo hi"])).toEqual({ argv: [shell, "-c", "echo hi"] });
		}
	});

	it("appears in the generated completions", async () => {
		const zsh = await generateLiveCompletion("zsh");
		const bash = await generateLiveCompletion("bash");
		const fish = await generateLiveCompletion("fish");
		for (const shell of SHELLS) {
			expect(zsh).toContain(`'${shell}:Run `);
			expect(zsh).toContain(`_omp_cmd_${shell}()`);
			expect(bash).toMatch(new RegExp(`compgen -W "[^"]*\\b${shell}\\b`));
			expect(fish).toContain(`-a '${shell}' -d 'Run `);
		}
	}, 30_000);
});
