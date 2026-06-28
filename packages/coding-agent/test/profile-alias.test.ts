import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import {
	installProfileAlias,
	readProfileAliasConfigFile,
	resolveProfileAliasCommandFromProcess,
} from "../src/cli/profile-alias";

describe("profile alias installer", () => {
	it("writes a bash-compatible function that forwards subcommands through omp", async () => {
		const files = new Map<string, string>();

		const result = await installProfileAlias({
			profile: "work",
			aliasName: "omp-work",
			shellPath: "/bin/bash",
			platform: "linux",
			homeDir: "/home/me",
			readFile: async filePath => files.get(filePath) ?? "",
			writeFile: async (filePath, content) => {
				files.set(filePath, content);
			},
		});

		expect(result.configPath).toBe("/home/me/.bashrc");
		expect(result.command).toBe("omp --profile=work");
		expect(files.get("/home/me/.bashrc")).toContain("omp-work() {");
		expect(files.get("/home/me/.bashrc")).toContain('command omp --profile=work "$@"');
	});

	it("resolves source invocations without forcing the source checkout as cwd", () => {
		const command = resolveProfileAliasCommandFromProcess(["/bin/bun", "src/cli.ts"], "/repo/packages/coding-agent");

		// path.resolve is platform-dependent (adds drive letter on Windows);
		// the code normalizes to forward slashes for POSIX shell fields.
		const expectedScriptPath = path.resolve("/repo/packages/coding-agent", "src/cli.ts");
		const expectedPosixPath = expectedScriptPath.replace(/\\/g, "/");

		expect(command.display).toBe(`/bin/bun ${expectedPosixPath}`);
		expect(command.posix).toBe(`'/bin/bun' '${expectedPosixPath}'`);
		expect(command.fish).toBe(`'/bin/bun' '${expectedPosixPath}'`);
		expect(command.powerShell).toBe(`'/bin/bun' '${expectedScriptPath}'`);
	});

	it("normalizes a backslash runtime path for POSIX shell command fields", () => {
		// On Windows argv[0] is typically a native path like C:\Users\me\.bun\bin\bun.exe;
		// bash/zsh/fish fields must use forward slashes while PowerShell keeps the native path.
		const runtime = "C:\\Users\\me\\.bun\\bin\\bun.exe";
		const command = resolveProfileAliasCommandFromProcess([runtime, "src/cli.ts"], "/repo/packages/coding-agent");

		const expectedScriptPath = path.resolve("/repo/packages/coding-agent", "src/cli.ts");
		const expectedPosixPath = expectedScriptPath.replace(/\\/g, "/");
		const posixRuntime = runtime.replace(/\\/g, "/");

		expect(command.display).toBe(`${posixRuntime} ${expectedPosixPath}`);
		expect(command.posix).toBe(`'${posixRuntime}' '${expectedPosixPath}'`);
		expect(command.fish).toBe(`'${posixRuntime}' '${expectedPosixPath}'`);
		expect(command.powerShell).toBe(`'${runtime}' '${expectedScriptPath}'`);
	});

	it("can target the current source invocation instead of the installed omp binary", async () => {
		const files = new Map<string, string>();

		const result = await installProfileAlias({
			profile: "work",
			aliasName: "omp-work",
			shellPath: "/bin/zsh",
			platform: "darwin",
			homeDir: "/Users/me",
			command: {
				display: "bun /repo/packages/coding-agent/src/cli.ts",
				posix: "bun '/repo/packages/coding-agent/src/cli.ts'",
				fish: "bun /repo/packages/coding-agent/src/cli.ts",
				powerShell: "bun '/repo/packages/coding-agent/src/cli.ts'",
			},
			readFile: async filePath => files.get(filePath) ?? "",
			writeFile: async (filePath, content) => {
				files.set(filePath, content);
			},
		});

		expect(result.command).toBe("bun /repo/packages/coding-agent/src/cli.ts --profile=work");
		expect(files.get("/Users/me/.zshrc")).toContain("omp-work() {");
		expect(files.get("/Users/me/.zshrc")).toContain(
			`command bun '/repo/packages/coding-agent/src/cli.ts' --profile=work "$@"`,
		);
	});

	it("installs the zsh alias under ZDOTDIR when set", async () => {
		const files = new Map<string, string>();

		const result = await installProfileAlias({
			profile: "work",
			aliasName: "omp-work",
			shellPath: "/bin/zsh",
			platform: "darwin",
			homeDir: "/Users/me",
			env: { ZDOTDIR: "/Users/me/.config/zsh" },
			readFile: async filePath => files.get(filePath) ?? "",
			writeFile: async (filePath, content) => {
				files.set(filePath, content);
			},
		});

		expect(result.configPath).toBe("/Users/me/.config/zsh/.zshrc");
		expect(files.get(result.configPath)).toContain("omp-work() {");
	});

	it("writes a fish function that forwards argv", async () => {
		const files = new Map<string, string>();

		await installProfileAlias({
			profile: "work",
			aliasName: "omp-work",
			shellPath: "/opt/homebrew/bin/fish",
			platform: "darwin",
			homeDir: "/Users/me",
			env: {},
			readFile: async filePath => files.get(filePath) ?? "",
			writeFile: async (filePath, content) => {
				files.set(filePath, content);
			},
		});

		const content = files.get("/Users/me/.config/fish/conf.d/omp-profiles.fish") ?? "";
		expect(content).toContain("function omp-work --wraps omp");
		expect(content).toContain("command omp --profile=work $argv");
	});

	it("installs the fish alias under XDG_CONFIG_HOME when set", async () => {
		const files = new Map<string, string>();

		const result = await installProfileAlias({
			profile: "work",
			aliasName: "omp-work",
			shellPath: "/usr/bin/fish",
			platform: "linux",
			homeDir: "/home/me",
			env: { XDG_CONFIG_HOME: "/home/me/.dotfiles/config" },
			readFile: async filePath => files.get(filePath) ?? "",
			writeFile: async (filePath, content) => {
				files.set(filePath, content);
			},
		});

		expect(result.configPath).toBe("/home/me/.dotfiles/config/fish/conf.d/omp-profiles.fish");
		expect(files.get(result.configPath)).toContain("function omp-work --wraps omp");
	});

	it("writes a PowerShell function because aliases cannot carry arguments", async () => {
		const files = new Map<string, string>();

		await installProfileAlias({
			profile: "work",
			aliasName: "omp-work",
			shellPath: "pwsh.exe",
			platform: "win32",
			homeDir: "C:\\Users\\me",
			readFile: async filePath => files.get(filePath) ?? "",
			writeFile: async (filePath, content) => {
				files.set(filePath, content);
			},
		});

		const psConfigPath = path.join("C:\\Users\\me", "Documents", "PowerShell", "Microsoft.PowerShell_profile.ps1");
		const content = files.get(psConfigPath) ?? "";
		expect(content).toContain("function omp-work");
		expect(content).toContain("& omp --profile=work @args");
	});

	it("detects pwsh from PSModulePath when SHELL is unset on Windows", async () => {
		const files = new Map<string, string>();

		const result = await installProfileAlias({
			profile: "work",
			aliasName: "omp-work",
			platform: "win32",
			homeDir: "C:\\Users\\me",
			env: {
				PSModulePath:
					"C:\\Users\\me\\Documents\\PowerShell\\Modules;C:\\Program Files\\PowerShell\\7\\Modules;C:\\Users\\me\\Documents\\WindowsPowerShell\\Modules",
			},
			readFile: async filePath => files.get(filePath) ?? "",
			writeFile: async (filePath, content) => {
				files.set(filePath, content);
			},
		});

		expect(result.shell).toBe("pwsh");
		const psConfigPath = path.join("C:\\Users\\me", "Documents", "PowerShell", "Microsoft.PowerShell_profile.ps1");
		expect(result.configPath).toBe(psConfigPath);
		expect(files.get(result.configPath)).toContain("& omp --profile=work @args");
	});

	it("selects Windows PowerShell when only WindowsPowerShell modules are present", async () => {
		const files = new Map<string, string>();

		const result = await installProfileAlias({
			profile: "work",
			aliasName: "omp-work",
			platform: "win32",
			homeDir: "C:\\Users\\me",
			env: {
				PSModulePath:
					"C:\\Users\\me\\Documents\\WindowsPowerShell\\Modules;C:\\WINDOWS\\system32\\WindowsPowerShell\\v1.0\\Modules",
			},
			readFile: async filePath => files.get(filePath) ?? "",
			writeFile: async (filePath, content) => {
				files.set(filePath, content);
			},
		});

		expect(result.shell).toBe("powershell");
		const psConfigPath = path.join(
			"C:\\Users\\me",
			"Documents",
			"WindowsPowerShell",
			"Microsoft.PowerShell_profile.ps1",
		);
		expect(result.configPath).toBe(psConfigPath);
	});

	it("treats POWERSHELL_DISTRIBUTION_CHANNEL as a pwsh hint when no module paths disambiguate", async () => {
		const files = new Map<string, string>();

		const result = await installProfileAlias({
			profile: "work",
			aliasName: "omp-work",
			platform: "win32",
			homeDir: "C:\\Users\\me",
			env: { POWERSHELL_DISTRIBUTION_CHANNEL: "MSI:Windows 10 Pro" },
			readFile: async filePath => files.get(filePath) ?? "",
			writeFile: async (filePath, content) => {
				files.set(filePath, content);
			},
		});

		expect(result.shell).toBe("pwsh");
		const psConfigPath = path.join("C:\\Users\\me", "Documents", "PowerShell", "Microsoft.PowerShell_profile.ps1");
		expect(result.configPath).toBe(psConfigPath);
	});

	it("replaces a previous block for the same alias", async () => {
		const files = new Map<string, string>([
			[
				"/home/me/.zshrc",
				[
					"before",
					"# >>> omp profile alias: omp-work >>>",
					"alias omp-work='command omp --profile=old'",
					"# <<< omp profile alias: omp-work <<<",
					"after",
				].join("\n"),
			],
		]);

		await installProfileAlias({
			profile: "work",
			aliasName: "omp-work",
			shellPath: "/bin/zsh",
			platform: "darwin",
			homeDir: "/home/me",
			readFile: async filePath => files.get(filePath) ?? "",
			writeFile: async (filePath, content) => {
				files.set(filePath, content);
			},
		});

		const content = files.get("/home/me/.zshrc") ?? "";
		expect(content).toContain("before");
		expect(content).toContain("after");
		expect(content).toContain('command omp --profile=work "$@"');
		expect(content).not.toContain("--profile=old");
	});

	it("refuses to rewrite a malformed managed block missing its end marker", async () => {
		// A start marker without its matching end marker means a previous install
		// was interrupted or hand-edited. Appending a fresh block would let the
		// *next* install splice from the stale start through the new end, deleting
		// the user config in between. Refuse and preserve the file untouched.
		const original = ["# >>> omp profile alias: omp-work >>>", "omp-work() {", "export SECRET=keepme"].join("\n");
		const files = new Map<string, string>([["/home/me/.zshrc", original]]);
		let wrote = false;

		await expect(
			installProfileAlias({
				profile: "work",
				aliasName: "omp-work",
				shellPath: "/bin/zsh",
				platform: "darwin",
				homeDir: "/home/me",
				readFile: async filePath => files.get(filePath) ?? "",
				writeFile: async (filePath, content) => {
					wrote = true;
					files.set(filePath, content);
				},
			}),
		).rejects.toThrow(/without a matching/);

		expect(wrote).toBe(false);
		expect(files.get("/home/me/.zshrc")).toBe(original);
	});

	it("refuses to shadow the base omp command case-insensitively", async () => {
		for (const aliasName of ["omp", "OMP"]) {
			await expect(
				installProfileAlias({
					profile: "work",
					aliasName,
					shellPath: "/bin/bash",
					homeDir: "/home/me",
				}),
			).rejects.toThrow("Refusing to shadow");
		}
	});

	it("rejects shell reserved words before rendering alias functions", async () => {
		for (const { aliasName, shellPath } of [
			{ aliasName: "if", shellPath: "/bin/bash" },
			{ aliasName: "end", shellPath: "/opt/homebrew/bin/fish" },
			{ aliasName: "foreach", shellPath: "pwsh.exe" },
		]) {
			await expect(
				installProfileAlias({
					profile: "work",
					aliasName,
					shellPath,
					platform: shellPath === "pwsh.exe" ? "win32" : "linux",
					homeDir: "/home/me",
				}),
			).rejects.toThrow("reserved word");
		}
	});

	it("rejects POSIX sh because it does not read bash config files", async () => {
		await expect(
			installProfileAlias({
				profile: "work",
				aliasName: "omp-work",
				shellPath: "/bin/sh",
				platform: "linux",
				homeDir: "/home/me",
			}),
		).rejects.toThrow('Unsupported shell "sh"');
	});

	it("treats missing shell config as empty but preserves other read failures", async () => {
		await expect(
			readProfileAliasConfigFile("/home/me/.bashrc", async () => {
				throw Object.assign(new Error("missing"), { code: "ENOENT" });
			}),
		).resolves.toBe("");

		await expect(
			readProfileAliasConfigFile("/home/me/.bashrc", async () => {
				throw Object.assign(new Error("denied"), { code: "EACCES" });
			}),
		).rejects.toThrow("denied");
	});

	it("validates profile names before rendering shell code", async () => {
		const files = new Map<string, string>();

		await expect(
			installProfileAlias({
				profile: "work'; touch /tmp/pwn; #",
				aliasName: "omp-work",
				shellPath: "/bin/bash",
				platform: "linux",
				homeDir: "/home/me",
				readFile: async filePath => files.get(filePath) ?? "",
				writeFile: async (filePath, content) => {
					files.set(filePath, content);
				},
			}),
		).rejects.toThrow("Invalid OMP profile");
		expect(files.size).toBe(0);
	});

	it("normalizes backslashes in Windows homeDir for POSIX shell config paths", async () => {
		const files = new Map<string, string>();

		const result = await installProfileAlias({
			profile: "work",
			aliasName: "omp-work",
			shellPath: "/bin/bash",
			platform: "win32",
			homeDir: "C:\\Users\\me",
			readFile: async filePath => files.get(filePath) ?? "",
			writeFile: async (filePath, content) => {
				files.set(filePath, content);
			},
		});

		// path.posix.join preserves backslashes in input segments, so we must
		// normalize them — bash/zsh/fish can't resolve C:\Users\me/.bashrc
		expect(result.configPath).toBe("C:/Users/me/.bashrc");
		expect(result.reloadedWith).toBe(". 'C:/Users/me/.bashrc'");
	});

	it("normalizes backslashes in ZDOTDIR for zsh config paths on Windows", async () => {
		const files = new Map<string, string>();

		const result = await installProfileAlias({
			profile: "work",
			aliasName: "omp-work",
			shellPath: "/bin/zsh",
			platform: "win32",
			homeDir: "C:\\Users\\me",
			env: { ZDOTDIR: "D:\\zdotdir" },
			readFile: async filePath => files.get(filePath) ?? "",
			writeFile: async (filePath, content) => {
				files.set(filePath, content);
			},
		});

		expect(result.configPath).toBe("D:/zdotdir/.zshrc");
		expect(result.reloadedWith).toBe(". 'D:/zdotdir/.zshrc'");
	});

	it("normalizes backslashes in XDG_CONFIG_HOME for fish config paths on Windows", async () => {
		const files = new Map<string, string>();

		const result = await installProfileAlias({
			profile: "work",
			aliasName: "omp-work",
			shellPath: "/bin/fish",
			platform: "win32",
			homeDir: "C:\\Users\\me",
			env: { XDG_CONFIG_HOME: "D:\\xdg" },
			readFile: async filePath => files.get(filePath) ?? "",
			writeFile: async (filePath, content) => {
				files.set(filePath, content);
			},
		});

		expect(result.configPath).toBe("D:/xdg/fish/conf.d/omp-profiles.fish");
		expect(result.reloadedWith).toBe("source 'D:/xdg/fish/conf.d/omp-profiles.fish'");
	});

	it("preserves UNC path roots when normalizing POSIX shell config paths", async () => {
		const files = new Map<string, string>();

		const result = await installProfileAlias({
			profile: "work",
			aliasName: "omp-work",
			shellPath: "/bin/bash",
			platform: "win32",
			homeDir: "\\\\server\\share\\me",
			readFile: async filePath => files.get(filePath) ?? "",
			writeFile: async (filePath, content) => {
				files.set(filePath, content);
			},
		});

		// UNC path //server/share/me must NOT be collapsed to /server/share/me
		expect(result.configPath).toBe("//server/share/me/.bashrc");
		expect(result.reloadedWith).toBe(". '//server/share/me/.bashrc'");
	});
});
