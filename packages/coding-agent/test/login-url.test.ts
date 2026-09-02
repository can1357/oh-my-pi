import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import { loginUrlCopyCommand, persistLoginUrl } from "@oh-my-pi/pi-coding-agent/utils/login-url";
import * as piUtils from "@oh-my-pi/pi-utils";

// Redirected per test: writing to the real agent dir would overwrite or delete
// a clean-copy URL belonging to a live omp login on the developer's machine.
let tmp: string;
function useTempAgentDir(): string {
	tmp = mkdtempSync(join(os.tmpdir(), "login-url-test-"));
	spyOn(piUtils, "getAgentDir").mockReturnValue(tmp);
	return tmp;
}

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

describe("persistLoginUrl", () => {
	it("writes the URL byte-exact to a per-process path, mode 600", () => {
		const dir = useTempAgentDir();
		const url = `https://auth.example.com/oauth/authorize?code_challenge=${"B".repeat(43)}&state=${"s".repeat(64)}`;
		const returned = persistLoginUrl(url);
		// Per-process: concurrent omp logins must not overwrite each other.
		expect(returned).toBe(join(dir, `login-url-${process.pid}.txt`));
		// Byte-exact: the whole point is that no terminal artifact touches it.
		expect(readFileSync(returned as string, "utf8")).toBe(`${url}\n`);
		expect(statSync(returned as string).mode & 0o777).toBe(0o600);
	});

	it("sweeps day-old files from dead processes, keeps fresh ones", () => {
		const dir = useTempAgentDir();
		const stale = join(dir, "login-url-99999.txt");
		const fresh = join(dir, "login-url-88888.txt");
		writeFileSync(stale, "old\n");
		writeFileSync(fresh, "new\n");
		const dayAgo = (Date.now() - 25 * 60 * 60 * 1000) / 1000;
		utimesSync(stale, dayAgo, dayAgo);

		persistLoginUrl("https://x.test/a");

		expect(() => statSync(stale)).toThrow();
		expect(readFileSync(fresh, "utf8")).toBe("new\n");
	});
});

describe("loginUrlCopyCommand", () => {
	it("shortens the home prefix and leaves ~ outside quotes so it expands", () => {
		if (process.platform === "win32") return;
		const home = os.homedir();
		expect(loginUrlCopyCommand(`${home}/.omp/agent/login-url-1.txt`)).toBe("cat ~/.omp/agent/login-url-1.txt");
	});

	it("single-quotes the absolute path when it carries shell metacharacters", () => {
		if (process.platform === "win32") return;
		expect(loginUrlCopyCommand("/tmp/agent dir/login-url-1.txt")).toBe("cat '/tmp/agent dir/login-url-1.txt'");
	});

	it("never lets the shell substitute inside the advertised command", () => {
		if (process.platform === "win32") return;
		// Double quotes would run $(...) and backticks; single quotes must not.
		expect(loginUrlCopyCommand("/tmp/$(touch pwned)/login-url-1.txt")).toBe(
			"cat '/tmp/$(touch pwned)/login-url-1.txt'",
		);
		// An embedded single quote cannot terminate the quoting.
		expect(loginUrlCopyCommand("/tmp/o'brien/login-url-1.txt")).toBe("cat '/tmp/o'\\''brien/login-url-1.txt'");
	});
});
