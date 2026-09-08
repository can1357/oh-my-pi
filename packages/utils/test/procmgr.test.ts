import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, MAIN_CONFIG_FILENAMES } from "../src/dirs";
import { getShellArgs, getShellConfig, isPosixShell, resolveWindowsShell } from "../src/procmgr";

describe("getShellConfig", () => {
	it("directs invalid custom shell paths to the canonical config file", () => {
		const missingShell = path.join(os.tmpdir(), `omp-missing-shell-${process.pid}`, "bash");
		const configPath = path.join(getAgentDir(), MAIN_CONFIG_FILENAMES[0]);
		expect(() => getShellConfig(missingShell)).toThrow(
			`Custom shell path not found: ${missingShell}\nPlease update shellPath in ${configPath}`,
		);
	});
});

describe("isPosixShell", () => {
	it("recognizes only known POSIX-quoting shell executable basenames", () => {
		for (const shell of [
			"sh",
			"/bin/BaSh",
			String.raw`C:\Program Files\Git\bin\DASH.EXE`,
			"/bin/ash",
			"ksh.exe",
			"/usr/bin/zsh",
		]) {
			expect(isPosixShell(shell)).toBe(true);
		}

		for (const shell of [
			"",
			"fish",
			"/usr/bin/csh",
			"/usr/bin/tcsh",
			"nu",
			"cmd.exe",
			String.raw`C:\Windows\System32\PowerShell.EXE`,
			"busybox",
			"/usr/local/bin/bash-wrapper",
		]) {
			expect(isPosixShell(shell)).toBe(false);
		}
	});
});

describe("getShellArgs", () => {
	it("uses -Command for PowerShell shells instead of the POSIX -l -c pair", () => {
		// `powershell -l -c <cmd>` parses `-l` as the command and fails with
		// `The term '-l' is not recognized`, breaking every spawn path for a
		// shellPath pointed at PowerShell.
		expect(getShellArgs("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", {})).toEqual([
			"-NoLogo",
			"-Command",
		]);
		expect(getShellArgs("C:\\Program Files\\PowerShell\\7\\pwsh.exe", {})).toEqual(["-NoLogo", "-Command"]);
		expect(getShellArgs("/usr/bin/pwsh", {})).toEqual(["-NoLogo", "-Command"]);
	});

	it("maps the no-login env gate to -NoProfile for PowerShell", () => {
		expect(getShellArgs("pwsh.exe", { PI_BASH_NO_LOGIN: "1" })).toEqual(["-NoLogo", "-NoProfile", "-Command"]);
	});

	it("keeps cmd.exe and POSIX shell args unchanged", () => {
		expect(getShellArgs("C:\\Windows\\System32\\cmd.exe", {})).toEqual(["/c"]);
		expect(getShellArgs("/bin/bash", {})).toEqual(["-l", "-c"]);
		expect(getShellArgs("/bin/bash", { PI_BASH_NO_LOGIN: "1" })).toEqual(["-c"]);
	});
});

describe("resolveWindowsShell", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	function makeGitRoot(): string {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-git-root-"));
		tempDirs.push(root);
		fs.mkdirSync(path.join(root, "bin"), { recursive: true });
		fs.writeFileSync(path.join(root, "bin", "bash.exe"), "");
		return root;
	}

	it("finds scoop's Git Bash via GIT_INSTALL_ROOT despite bash.exe missing from PATH", () => {
		// scoop's git manifest sets GIT_INSTALL_ROOT and shims sh.exe/git.exe but
		// never bash.exe, so PATH lookup alone misses the install.
		const root = makeGitRoot();
		expect(resolveWindowsShell({ GIT_INSTALL_ROOT: root })).toBe(path.join(root, "bin", "bash.exe"));
	});

	it("finds Git Bash in the default scoop app dir via USERPROFILE", () => {
		const profile = fs.mkdtempSync(path.join(os.tmpdir(), "omp-profile-"));
		tempDirs.push(profile);
		const root = path.join(profile, "scoop", "apps", "git", "current");
		fs.mkdirSync(path.join(root, "bin"), { recursive: true });
		fs.writeFileSync(path.join(root, "bin", "bash.exe"), "");
		expect(resolveWindowsShell({ USERPROFILE: profile })).toBe(path.join(root, "bin", "bash.exe"));
	});

	it("prefers a Git for Windows install root over the cmd.exe fallback", () => {
		const programFiles = fs.mkdtempSync(path.join(os.tmpdir(), "omp-programfiles-"));
		tempDirs.push(programFiles);
		const bash = path.join(programFiles, "Git", "bin", "bash.exe");
		fs.mkdirSync(path.dirname(bash), { recursive: true });
		fs.writeFileSync(bash, "");
		expect(resolveWindowsShell({ ProgramFiles: programFiles, ComSpec: "C:\\Windows\\System32\\cmd.exe" })).toBe(bash);
	});

	// On a real Windows host — or under WSL, which inherits the Windows PATH —
	// bash.exe/sh.exe may resolve from PATH before the cmd.exe fallback is
	// reached, so the fallback contract is only deterministic off-Windows.
	const isWindowsHost =
		process.platform === "win32" ||
		(process.platform === "linux" && Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP));
	it.skipIf(isWindowsHost)("falls back to cmd.exe instead of failing when no bash exists", () => {
		expect(resolveWindowsShell({})).toBe("C:\\Windows\\System32\\cmd.exe");
		expect(resolveWindowsShell({ ComSpec: "D:\\win\\cmd.exe" })).toBe("D:\\win\\cmd.exe");
	});
});
