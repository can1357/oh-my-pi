import { $ } from "bun";
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	loginUrlCopyCommand,
	loginUrlWritesSettled,
	persistLoginUrl,
	wrapCommandRow,
} from "@oh-my-pi/pi-coding-agent/utils/login-url";
import * as piUtils from "@oh-my-pi/pi-utils";

// Redirected per test: writing to the real agent dir would overwrite or delete
// a clean-copy URL belonging to a live omp login on the developer's machine.
let tmp: string | undefined;
function useTempAgentDir(): string {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "login-url-test-"));
	vi.spyOn(piUtils, "getAgentDir").mockReturnValue(tmp);
	return tmp;
}

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
function setPlatform(value: NodeJS.Platform): void {
	Object.defineProperty(process, "platform", { value, configurable: true });
}

afterEach(async () => {
	// A write still in flight would re-create the temp dir after the rm below.
	await loginUrlWritesSettled();
	// The spy must not outlive the temp dir it points at.
	vi.restoreAllMocks();
	if (platformDescriptor) Object.defineProperty(process, "platform", platformDescriptor);
	if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
	tmp = undefined;
});

describe("persistLoginUrl", () => {
	it("writes the URL byte-exact to a per-flow path, mode 600", async () => {
		const dir = useTempAgentDir();
		const url = `https://auth.example.com/oauth/authorize?code_challenge=${"B".repeat(43)}&state=${"s".repeat(64)}`;
		const returned = persistLoginUrl(url);
		// Per-process pid plus per-flow counter: neither a concurrent omp login
		// nor a later flow in this process may overwrite an advertised file.
		expect(path.dirname(returned)).toBe(dir);
		expect(path.basename(returned)).toMatch(new RegExp(`^login-url-${process.pid}-\\d+\\.txt$`));
		// The write must not block the caller: it runs inside OAuth `onAuth`
		// callbacks on the render path. Synchronously after the call the file
		// cannot exist yet — a regression to sync IO makes this line fail.
		expect(fs.existsSync(returned)).toBe(false);
		await loginUrlWritesSettled();
		// Byte-exact: the whole point is that no terminal artifact touches it.
		expect(fs.readFileSync(returned, "utf8")).toBe(`${url}\n`);
		expect(fs.statSync(returned).mode & 0o777).toBe(0o600);
	});

	it("gives each flow its own file so an earlier copy command keeps its URL", async () => {
		useTempAgentDir();
		const first = persistLoginUrl("https://x.test/first");
		const second = persistLoginUrl("https://x.test/second");
		expect(second).not.toBe(first);
		await loginUrlWritesSettled();
		expect(fs.readFileSync(first, "utf8")).toBe("https://x.test/first\n");
		expect(fs.readFileSync(second, "utf8")).toBe("https://x.test/second\n");
	});

	it("sweeps day-old files from dead processes, keeps fresh ones", async () => {
		const dir = useTempAgentDir();
		const stale = path.join(dir, "login-url-99999.txt");
		const fresh = path.join(dir, "login-url-88888.txt");
		fs.writeFileSync(stale, "old\n");
		fs.writeFileSync(fresh, "new\n");
		const dayAgo = (Date.now() - 25 * 60 * 60 * 1000) / 1000;
		fs.utimesSync(stale, dayAgo, dayAgo);

		persistLoginUrl("https://x.test/a");
		await loginUrlWritesSettled();

		expect(() => fs.statSync(stale)).toThrow();
		expect(fs.readFileSync(fresh, "utf8")).toBe("new\n");
	});
});

describe("loginUrlCopyCommand (posix)", () => {
	it("shortens the home prefix and leaves ~ outside quotes so it expands", () => {
		if (process.platform === "win32") return;
		const home = os.homedir();
		expect(loginUrlCopyCommand(`${home}/.omp/agent/login-url-1.txt`)).toBe("cat ~/.omp/agent/login-url-1.txt");
	});

	it("single-quotes the absolute path when it carries shell metacharacters", () => {
		if (process.platform === "win32") return;
		expect(loginUrlCopyCommand("/tmp/agent dir/login-url-1.txt")).toBe("cat '/tmp/agent dir/login-url-1.txt'");
	});

	it("keeps ~ outside the quotes when a home path needs quoting", async () => {
		if (process.platform === "win32") return;
		const home = os.homedir();
		// The tilde must stay outside the single quotes to expand; the rest of
		// the path, metacharacters included, stays literal inside them.
		const cmd = loginUrlCopyCommand(`${home}/.omp agent/login-url-1.txt`);
		expect(cmd).toBe("cat ~/'.omp agent/login-url-1.txt'");
		expect(loginUrlCopyCommand(`${home}/o'brien $(x)/login-url-1.txt`)).toBe(
			"cat ~/'o'\\''brien $(x)/login-url-1.txt'",
		);
		// The advertised word must actually resolve under tilde expansion: echo
		// it through a real shell with HOME pointed at a temp dir. (`sh` on
		// purpose — the command is advertised to the user's POSIX shell, not to
		// Bun Shell's interpreter.)
		const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "login-url-home-"));
		try {
			const word = cmd.slice("cat ".length);
			const resolved = await $`sh -c ${`printf %s ${word}`}`.env({ ...process.env, HOME: fakeHome }).text();
			expect(resolved).toBe(`${fakeHome}/.omp agent/login-url-1.txt`);
		} finally {
			fs.rmSync(fakeHome, { recursive: true, force: true });
		}
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

describe("loginUrlCopyCommand (win32)", () => {
	it("leaves a shell-inert path unquoted so cmd and PowerShell read it identically", () => {
		setPlatform("win32");
		expect(loginUrlCopyCommand("C:\\Users\\seth\\.omp\\agent\\login-url-1.txt")).toBe(
			"type C:\\Users\\seth\\.omp\\agent\\login-url-1.txt",
		);
	});

	it("double-quotes a path whose only offending characters are spaces", () => {
		setPlatform("win32");
		// Double quotes group in cmd and stay expansion-free in PowerShell when
		// the path carries none of % ! $ ` ", so both shells read it literally.
		expect(loginUrlCopyCommand("C:\\Users\\Seth Morton\\agent dir\\login-url-1.txt")).toBe(
			'type "C:\\Users\\Seth Morton\\agent dir\\login-url-1.txt"',
		);
	});

	it("keeps cmd %VAR% and delayed-expansion ! literal via PowerShell single quotes", () => {
		setPlatform("win32");
		// Double quotes would let cmd expand %NAME% and !x!; the single-quoted
		// form is byte-literal in PowerShell, the shell the quoting targets.
		expect(loginUrlCopyCommand("C:\\Users\\%NAME%\\agent dir\\login-url-1.txt")).toBe(
			"type 'C:\\Users\\%NAME%\\agent dir\\login-url-1.txt'",
		);
		expect(loginUrlCopyCommand("C:\\agents\\!x!\\login-url-1.txt")).toBe("type 'C:\\agents\\!x!\\login-url-1.txt'");
	});

	it("never lets PowerShell run a subexpression from the path", () => {
		setPlatform("win32");
		// $() executes inside PowerShell double quotes; single quotes stop it.
		expect(loginUrlCopyCommand("C:\\agents\\$(calc)\\login-url-1.txt")).toBe(
			"type 'C:\\agents\\$(calc)\\login-url-1.txt'",
		);
		// An embedded single quote cannot terminate the quoting: doubled per
		// PowerShell's literal-string escape. %TEMP% forces the single-quote tier.
		expect(loginUrlCopyCommand("C:\\Users\\o'brien\\%TEMP%\\login-url-1.txt")).toBe(
			"type 'C:\\Users\\o''brien\\%TEMP%\\login-url-1.txt'",
		);
	});
});

describe("wrapCommandRow", () => {
	it("wraps exactly at the width boundary, never one column early", () => {
		const cmd = "cat ~/.omp/agent/login-url-1.txt";
		// A command exactly as wide as the row must stay on one row: an
		// off-by-one here wraps every borderline command for no reason.
		expect(wrapCommandRow(cmd, cmd.length)).toEqual([cmd]);
		// One column narrower must wrap, and both rows together must carry
		// every byte of the command.
		expect(wrapCommandRow(cmd, cmd.length - 1)).toEqual([cmd.slice(0, -1), cmd.slice(-1)]);
	});

	it("keeps every byte when a break lands on a space", () => {
		// wrapTextWithAnsi would swallow the space at the break point, so the
		// displayed command would read a path that does not exist.
		const cmd = "cat '/tmp/agent dir with a very long spaced name/login-url-12345-1.txt'";
		const rows = wrapCommandRow(cmd, 44);
		expect(rows.length).toBeGreaterThan(1);
		expect(rows.join("")).toBe(cmd);
		for (const row of rows) expect(row.length).toBeLessThanOrEqual(44);
	});

	it("reopens ANSI styling on every continuation row", () => {
		const cmd = `\x1b[2mClean copy: cat '/tmp/agent dir with spaces/login-url-1.txt'\x1b[0m`;
		const rows = wrapCommandRow(cmd, 40);
		expect(rows.length).toBeGreaterThan(1);
		expect(rows.map(row => Bun.stripANSI(row)).join("")).toBe(Bun.stripANSI(cmd));
		for (const row of rows.slice(1)) expect(row.startsWith("\x1b[2m")).toBe(true);
	});
});
