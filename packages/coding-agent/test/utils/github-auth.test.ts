import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ghRequestHost, ghRequestRepo, resolveGhRequestHost } from "@oh-my-pi/pi-coding-agent/tools/gh-common";
import {
	checkoutPullRequest,
	executePrCheckout,
	executePrCreate,
} from "@oh-my-pi/pi-coding-agent/tools/gh-pr-checkout";
import {
	executeSearchCode,
	executeSearchCommits,
	executeSearchIssues,
	executeSearchPrs,
	executeSearchRepos,
} from "@oh-my-pi/pi-coding-agent/tools/gh-search";
import { executeRepoView } from "@oh-my-pi/pi-coding-agent/tools/gh-view";
import { ghAuthHost, github } from "@oh-my-pi/pi-coding-agent/utils/github";

/**
 * The `gh` runner acquires a github.com credential and hands it to one child.
 *
 * Every case drives the real runner against a `gh` on PATH that records the
 * argv and credential environment it was handed, so each assertion is about
 * what a `gh` process actually received. A fake answering from memory could not
 * tell an injected variable from a leaked one, nor show a child that ran when
 * it should not have.
 */

const TOKEN_ENV_VARS = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"] as const;
const MANAGED_ENV_VARS = ["PATH", "GH_HOST", ...TOKEN_ENV_VARS] as const;
const PUBLIC = ghAuthHost("github.com");
const ENTERPRISE = ghAuthHost("github.example.com");
const TRUNCATION_MARKER = "\n[gh subprocess output truncated after 8 MiB]\n";
/** Ceiling for cases that wait on a real child, including the probe's own deadline. */
const WAIT_FOR_CHILD_MS = 40_000;
/** The probe's own deadline is 10s; a stalled read must not outlast it by much. */
const PROBE_DEADLINE_BOUND_MS = 20_000;

const originalEnv: Record<string, string | undefined> = Object.fromEntries(
	MANAGED_ENV_VARS.map(name => [name, process.env[name]]),
);

afterEach(() => {
	for (const name of MANAGED_ENV_VARS) {
		const value = originalEnv[name];
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
});

interface GhInvocation {
	argv: string[];
	/** Only the credential variables; everything else is inherited noise. */
	env: Record<string, string>;
}

interface GhFixture {
	dir: string;
	/** Every `gh` invocation so far, in call order. */
	invocations(): Promise<GhInvocation[]>;
	/** Resolves once `count` invocations have been recorded. */
	awaitInvocations(count: number): Promise<GhInvocation[]>;
}

/**
 * Put a `gh` on PATH that appends one record per invocation before running
 * `script`. Appending is what lets a case prove a child never ran: an
 * overwritten file would keep only the last record.
 */
async function fakeGh(script: string): Promise<GhFixture> {
	const dir = await mkdtemp(path.join(os.tmpdir(), "github-auth-test-"));
	const log = path.join(dir, "invocations");
	await Bun.write(
		path.join(dir, "gh"),
		`#!/bin/sh
dir=$(dirname "$0")
{
	printf 'ARGV'
	for arg in "$@"; do printf '\\t%s' "$arg"; done
	printf '\\n'
	for name in ${TOKEN_ENV_VARS.join(" ")}; do
		eval "value=\\$$name"
		[ -n "$value" ] && printf 'ENV\\t%s\\t%s\\n' "$name" "$value"
	done
	printf 'END\\n'
} >> "$dir/invocations"
${script}
`,
	);
	await Bun.$`chmod +x ${path.join(dir, "gh")}`.quiet();
	process.env.PATH = `${dir}:${originalEnv.PATH ?? ""}`;
	delete process.env.GH_HOST;
	for (const name of TOKEN_ENV_VARS) delete process.env[name];

	async function invocations(): Promise<GhInvocation[]> {
		const file = Bun.file(log);
		if (!(await file.exists())) return [];
		const records: GhInvocation[] = [];
		let current: GhInvocation | undefined;
		for (const line of (await file.text()).split("\n")) {
			const [kind, ...rest] = line.split("\t");
			if (kind === "ARGV") current = { argv: rest, env: {} };
			else if (kind === "ENV" && current) current.env[rest[0]] = rest[1];
			else if (kind === "END" && current) {
				records.push(current);
				current = undefined;
			}
		}
		return records;
	}

	return {
		dir,
		invocations,
		// A child's progress is only observable through what it has written, so
		// this waits on that record instead of guessing at a duration.
		async awaitInvocations(count: number) {
			const deadline = Date.now() + WAIT_FOR_CHILD_MS;
			while (true) {
				const records = await invocations();
				if (records.length >= count) return records;
				if (Date.now() > deadline) throw new Error(`gh made ${records.length} of ${count} expected calls`);
				await Bun.sleep(10);
			}
		},
	};
}

/**
 * A `gh` answering the auth probe with `stdout`, and every other call with `ok`.
 *
 * `%b` so a case can hand the probe real newlines and byte escapes; `exec` so a
 * hanging probe is the direct child itself, with no descendant holding the pipes.
 */
function probeScript(stdout: string, options?: { exit?: number; stderr?: string; hang?: boolean }): string {
	const lines = ['if [ "$1" = auth ]; then'];
	if (options?.hang) lines.push("\texec sleep 600");
	lines.push(`\tprintf '%b' ${JSON.stringify(stdout)}`);
	if (options?.stderr) lines.push(`\tprintf '%b' ${JSON.stringify(options.stderr)} >&2`);
	lines.push(`\texit ${options?.exit ?? 0}`, "fi", "printf 'ok'");
	return lines.join("\n");
}

/**
 * A `gh` that forks a long-lived descendant inheriting stdout and stderr, then
 * exits cleanly itself.
 *
 * This is the shape a credential helper takes when it leaves background work
 * behind: the direct child is gone, so terminating only that PID neither ends
 * the descendant nor closes the pipes a read is waiting on.
 */
const descendantScript = `if [ "$1" = auth ]; then
	sleep 600 &
	printf '%s' "$!" > "$dir/descendant"
	exit 0
fi
printf 'ok'`;

/**
 * The same shape, but the probe first prints a perfectly usable token.
 *
 * The token is well-formed and the root exits zero, so only noticing that the
 * command itself was stopped — its tree terminated at the deadline — keeps this
 * from being accepted and handed to a child.
 */
const descendantWithTokenScript = `if [ "$1" = auth ]; then
	printf 'ghp_stalled-token\\n'
	sleep 600 &
	printf '%s' "$!" > "$dir/descendant"
	exit 0
fi
printf 'ok'`;

/** Resolve once the probe's descendant exists, so an abort cannot race its fork. */
async function awaitDescendant(fixture: GhFixture): Promise<number> {
	const pidPath = path.join(fixture.dir, "descendant");
	const deadline = Date.now() + WAIT_FOR_CHILD_MS;
	while (true) {
		// The fork happens in another process, so the file is the only observable
		// -- and a BunFile handle caches a negative existence check, so read a
		// fresh handle each time rather than reusing one. The redirection creates
		// the file before the pid is written, so an empty read (`Number("") === 0`)
		// is the truncated file, not a descendant.
		const pid = await Bun.file(pidPath)
			.text()
			.then(text => Number(text.trim()))
			.catch(() => Number.NaN);
		if (Number.isInteger(pid) && pid > 0) return pid;
		if (Date.now() > deadline) throw new Error("the probe never forked its descendant");
		await Bun.sleep(10);
	}
}

/**
 * Assert what the platform owes for the probe's descendant, then collect it.
 *
 * Where ownership is tracked the descendant is reaped, and reaping happens in the
 * OS rather than in this process: there is no promise or event to await and no
 * clock to advance, so the only observable is whether the PID still exists,
 * polled until it does not. That is the Linux child subreaper this probe asks
 * for, and the retained root handle on Windows.
 *
 * Elsewhere on POSIX the probe's root is reaped before its descendant is dealt
 * with, and from that moment neither the root's pid nor the group id that pid
 * named can be shown to still be this command's -- signalling either could reach
 * whatever inherited the number -- so nothing is signalled and the descendant
 * outlives the request. That limitation is asserted here rather than assumed, and
 * its `sleep 600` is killed on the spot: a fixture that strands one leaves it
 * running for the rest of the suite.
 */
async function expectDescendantSettled(fixture: GhFixture): Promise<void> {
	const pidFile = Bun.file(path.join(fixture.dir, "descendant"));
	expect(await pidFile.exists()).toBe(true);
	const pid = Number((await pidFile.text()).trim());
	expect(Number.isInteger(pid)).toBe(true);
	const reapingOwed = process.platform === "linux" || process.platform === "win32";
	const deadline = Date.now() + 5_000;
	for (;;) {
		// `kill(pid, 0)` probes for the process without signalling it.
		let alive = true;
		try {
			process.kill(pid, 0);
		} catch {
			alive = false;
		}
		if (!reapingOwed) {
			expect(alive, `probe descendant ${pid} must outlive a request whose group cannot be proven`).toBe(true);
			try {
				process.kill(pid, "SIGKILL");
			} catch {}
			return;
		}
		if (!alive) return;
		if (Date.now() > deadline) throw new Error(`probe descendant ${pid} outlived the request`);
		await Bun.sleep(20);
	}
}

/**
 * A `gh` handing out a distinct token per probe, so two children cannot share one.
 *
 * The slot is reserved with `mkdir`, which fails when the name already exists.
 * Reading a counter, adding one and writing it back is not atomic: two probes can
 * both read the same value and both mint `ghp_token-1`, which looks exactly like
 * production sharing one credential between requests. That was a fixture defect,
 * and CI on a busier runner hit the window this machine almost never does.
 */
function countingProbeScript(hang: boolean): string {
	return `if [ "$1" = auth ]; then
	count=1
	while ! mkdir "$dir/slot.$count" 2>/dev/null; do
		count=$((count + 1))
	done
	${hang ? 'sleep "0.$((4 - count))"' : "true"}
	printf 'ghp_token-%s\\n' "$count"
	exit 0
fi
printf 'ok'`;
}

function session(cwd: string): ToolSession {
	return { cwd } as unknown as ToolSession;
}

describe("gh runner credential acquisition", () => {
	it("probes github.com and injects the token into only the requested child", async () => {
		const fixture = await fakeGh(probeScript("ghp_probed-token\n"));

		const result = await github.run(fixture.dir, ["pr", "create", "--repo", "owner/repo"], undefined, {
			repoProvided: true,
			authHost: PUBLIC,
		});

		expect(result.exitCode).toBe(0);
		const [probe, requested] = await fixture.invocations();
		expect(probe.argv).toEqual(["auth", "token", "--hostname", "github.com"]);
		expect(probe.env).toEqual({});
		expect(requested.argv).toEqual(["pr", "create", "--repo", "owner/repo"]);
		expect(requested.env).toEqual({ GITHUB_TOKEN: "ghp_probed-token" });
		expect(process.env.GITHUB_TOKEN).toBeUndefined();
		expect(process.env.GH_TOKEN).toBeUndefined();
	});

	it("accepts a CRLF-terminated credential", async () => {
		const fixture = await fakeGh(probeScript("ghp_crlf-token\r\n"));

		await github.run(fixture.dir, ["pr", "view"], undefined, { authHost: PUBLIC });

		const invocations = await fixture.invocations();
		expect(invocations[1].env).toEqual({ GITHUB_TOKEN: "ghp_crlf-token" });
	});

	it("runs on the ambient environment when no host metadata is supplied", async () => {
		const fixture = await fakeGh(probeScript("ghp_unwanted-token\n"));

		const result = await github.run(fixture.dir, ["pr", "view"]);

		expect(result.exitCode).toBe(0);
		const invocations = await fixture.invocations();
		expect(invocations).toHaveLength(1);
		expect(invocations[0].argv).toEqual(["pr", "view"]);
		expect(invocations[0].env).toEqual({});
	});

	it("never probes for a host other than github.com", async () => {
		const fixture = await fakeGh(probeScript("ghp_unwanted-token\n"));

		await github.run(fixture.dir, ["pr", "view"], undefined, { authHost: ENTERPRISE });

		const invocations = await fixture.invocations();
		expect(invocations).toHaveLength(1);
		expect(invocations[0].argv).toEqual(["pr", "view"]);
		expect(invocations[0].env).toEqual({});
	});

	for (const name of ["GH_TOKEN", "GITHUB_TOKEN"] as const) {
		it(`treats an ambient ${name} as the github.com credential`, async () => {
			const fixture = await fakeGh(probeScript("ghp_unwanted-token\n"));
			process.env[name] = `ambient-${name}`;

			await github.run(fixture.dir, ["pr", "view"], undefined, { authHost: PUBLIC });

			const invocations = await fixture.invocations();
			expect(invocations).toHaveLength(1);
			expect(invocations[0].env).toEqual({ [name]: `ambient-${name}` });
		});
	}

	it("forwards both ambient public tokens untouched rather than choosing between them", async () => {
		const fixture = await fakeGh(probeScript("ghp_unwanted-token\n"));
		process.env.GH_TOKEN = "ambient-gh";
		process.env.GITHUB_TOKEN = "ambient-github";

		await github.run(fixture.dir, ["pr", "view"], undefined, { authHost: PUBLIC });

		const invocations = await fixture.invocations();
		expect(invocations).toHaveLength(1);
		expect(invocations[0].env).toEqual({ GH_TOKEN: "ambient-gh", GITHUB_TOKEN: "ambient-github" });
	});

	it("forwards the ambient token's current value on every request", async () => {
		const fixture = await fakeGh(probeScript("ghp_unwanted-token\n"));
		process.env.GH_TOKEN = "first-value";

		await github.run(fixture.dir, ["pr", "view"], undefined, { authHost: PUBLIC });
		process.env.GH_TOKEN = "second-value";
		await github.run(fixture.dir, ["pr", "view"], undefined, { authHost: PUBLIC });

		const invocations = await fixture.invocations();
		expect(invocations.map(entry => entry.env.GH_TOKEN)).toEqual(["first-value", "second-value"]);
	});

	for (const name of ["GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"] as const) {
		it(`does not let an ambient ${name} stand in for a github.com credential`, async () => {
			const fixture = await fakeGh(probeScript("ghp_probed-token\n"));
			process.env[name] = `enterprise-${name}`;

			await github.run(fixture.dir, ["pr", "view"], undefined, { authHost: PUBLIC });

			const [probe, requested] = await fixture.invocations();
			expect(probe.argv).toEqual(["auth", "token", "--hostname", "github.com"]);
			// The probe keeps the enterprise variable but carries no public token.
			expect(probe.env).toEqual({ [name]: `enterprise-${name}` });
			expect(requested.env).toEqual({ [name]: `enterprise-${name}`, GITHUB_TOKEN: "ghp_probed-token" });
		});

		it(`forwards an ambient ${name} to an enterprise request without probing`, async () => {
			const fixture = await fakeGh(probeScript("ghp_unwanted-token\n"));
			process.env[name] = `enterprise-${name}`;

			await github.run(fixture.dir, ["pr", "view"], undefined, { authHost: ENTERPRISE });

			const invocations = await fixture.invocations();
			expect(invocations).toHaveLength(1);
			expect(invocations[0].env).toEqual({ [name]: `enterprise-${name}` });
		});
	}

	it("acquires a fresh credential per request instead of caching one", async () => {
		const fixture = await fakeGh(countingProbeScript(false));

		await github.run(fixture.dir, ["pr", "view"], undefined, { authHost: PUBLIC });
		await github.run(fixture.dir, ["pr", "view"], undefined, { authHost: PUBLIC });

		const invocations = await fixture.invocations();
		expect(invocations.map(entry => entry.argv[0])).toEqual(["auth", "pr", "auth", "pr"]);
		expect(invocations[1].env.GITHUB_TOKEN).toBe("ghp_token-1");
		expect(invocations[3].env.GITHUB_TOKEN).toBe("ghp_token-2");
	});

	it("keeps concurrent requests on their own credentials", async () => {
		// The probes finish in reverse order, so a shared value would surface.
		const fixture = await fakeGh(countingProbeScript(true));

		await Promise.all([
			github.run(fixture.dir, ["pr", "view", "1"], undefined, { authHost: PUBLIC }),
			github.run(fixture.dir, ["pr", "view", "2"], undefined, { authHost: PUBLIC }),
		]);

		const requested = (await fixture.invocations()).filter(entry => entry.argv[0] === "pr");
		expect(requested).toHaveLength(2);
		const tokens = requested.map(entry => entry.env.GITHUB_TOKEN);
		expect(tokens).toContain("ghp_token-1");
		expect(tokens).toContain("ghp_token-2");
	});

	describe("fails closed without running the requested child", () => {
		const cases = [
			{ name: "a second line of output", secret: "ghp_multi", stdout: "ghp_multi\nghp_second\n" },
			{ name: "a leading blank line", secret: "ghp_lead", stdout: "\nghp_lead\n" },
			{ name: "a trailing blank line", secret: "ghp_trail", stdout: "ghp_trail\n\n" },
			{ name: "surrounding spaces", secret: "ghp_padded", stdout: " ghp_padded \n" },
			{ name: "output past the capture cap", secret: "ghp_overflow", stdout: `ghp_overflow${"x".repeat(70_000)}` },
			{ name: "a token with embedded whitespace", secret: "ghp_spaced", stdout: "ghp_spaced extra\n" },
			{ name: "a bare carriage return terminator", secret: "ghp_cr", stdout: "ghp_cr\r" },
			// U+2028 as the UTF-8 bytes `printf %b` understands; \uXXXX is not portable.
			{ name: "a Unicode line separator", secret: "ghp_sep", stdout: "ghp_sep\\0342\\0200\\0250" },
			{ name: "empty output", secret: "unused", stdout: "" },
			{ name: "whitespace-only output", secret: "unused", stdout: "   \n\n" },
			{ name: "a nonzero exit", secret: "ghp_failed", stdout: "ghp_failed\n", exit: 1, stderr: "stderr-secret" },
			{ name: "a warning on stderr", secret: "ghp_noisy", stdout: "ghp_noisy\n", stderr: "stderr-secret" },
			// `printf %b` octal escapes: the raw bytes, so the probe's own decoder is
			// what turns them into whatever it turns them into.
			{ name: "a NUL inside the credential", secret: "ghp_nul", stdout: "ghp_nul\\0000tail\n" },
			{ name: "a trailing NUL", secret: "ghp_nultail", stdout: "ghp_nultail\\0000\n" },
			{ name: "an embedded C0 control", secret: "ghp_bell", stdout: "ghp_bell\\0007tail\n" },
			{ name: "a trailing DEL", secret: "ghp_del", stdout: "ghp_del\\0177\n" },
			{ name: "an embedded escape byte", secret: "ghp_esc", stdout: "ghp_esc\\0033[0m\n" },
			// 0xff is not valid UTF-8 anywhere, so it decodes to U+FFFD -- which is
			// not whitespace, and would otherwise be minted into a credential.
			{ name: "raw invalid UTF-8", secret: "ghp_mojibake", stdout: "ghp_mojibake\\0377\n" },
			{ name: "output that is only invalid UTF-8", secret: "unused", stdout: "\\0377\\0376\n" },
			{ name: "a non-ASCII credential character", secret: "ghp_wide", stdout: "ghp_wide\\0303\\0251\n" },
		];

		for (const testCase of cases) {
			it(`rejects ${testCase.name} without leaking it`, async () => {
				const fixture = await fakeGh(
					probeScript(testCase.stdout, { exit: testCase.exit, stderr: testCase.stderr }),
				);

				const error = await github
					.run(fixture.dir, ["pr", "create", "--repo", "owner/repo"], undefined, { authHost: PUBLIC })
					.then(() => "resolved")
					.catch(err => String(err));

				expect(error).toContain("GitHub CLI authentication is unavailable");
				expect(error).not.toContain(testCase.secret);
				expect(error).not.toContain("stderr-secret");
				expect((await fixture.invocations()).map(entry => entry.argv[0])).toEqual(["auth"]);
			});
		}
	});

	it(
		"bounds a probe whose descendant still holds the pipes",
		async () => {
			// The direct `gh` exits at once while a descendant keeps stdout and
			// stderr open. That is the shape which stalls a read waiting for EOF
			// and lets a forked credential helper outlive its budget, and the only
			// bound on it is the real deadline — nothing in-process can advance a
			// clock for a child that is already running.
			const fixture = await fakeGh(descendantScript);
			const started = Date.now();

			await expect(github.run(fixture.dir, ["pr", "view"], undefined, { authHost: PUBLIC })).rejects.toThrow(
				"GitHub CLI authentication is unavailable",
			);

			expect(Date.now() - started).toBeLessThan(PROBE_DEADLINE_BOUND_MS);
			expect((await fixture.invocations()).map(entry => entry.argv[0])).toEqual(["auth"]);
			await expectDescendantSettled(fixture);
		},
		WAIT_FOR_CHILD_MS,
	);

	it(
		"refuses a usable token from a probe that had to be stopped",
		async () => {
			// Valid token, clean exit code, and a descendant that keeps the pipes open
			// until the deadline releases the reads. The token is the only part of this
			// that looks right, so it must not be enough.
			const fixture = await fakeGh(descendantWithTokenScript);
			const started = Date.now();

			const error = await github
				.run(fixture.dir, ["pr", "create", "--repo", "owner/repo"], undefined, { authHost: PUBLIC })
				.then(() => "resolved")
				.catch(err => String(err));

			expect(error).toContain("GitHub CLI authentication is unavailable");
			expect(error).not.toContain("ghp_stalled-token");
			expect(Date.now() - started).toBeLessThan(PROBE_DEADLINE_BOUND_MS);
			expect((await fixture.invocations()).map(entry => entry.argv[0])).toEqual(["auth"]);
			await expectDescendantSettled(fixture);
		},
		WAIT_FOR_CHILD_MS,
	);

	it(
		"abandons a probe at once when the caller aborts after its root exited",
		async () => {
			// The probe has already printed a usable token and exited; only its
			// descendant still holds the pipes. An abort here has to release the caller
			// immediately rather than leave it on the deadline -- reaching the
			// descendant itself is only owed where its ownership is still provable.
			const fixture = await fakeGh(descendantWithTokenScript);
			const controller = new AbortController();

			const pending = github.run(fixture.dir, ["pr", "create", "--repo", "owner/repo"], controller.signal, {
				authHost: PUBLIC,
			});
			// The descendant must already hold the pipes: aborting earlier would
			// race the fork rather than exercise a pipe-holding descendant.
			await awaitDescendant(fixture);
			const aborted = Date.now();
			controller.abort();

			await expect(pending).rejects.toThrow();
			expect(Date.now() - aborted).toBeLessThan(5_000);
			expect((await fixture.invocations()).map(entry => entry.argv[0])).toEqual(["auth"]);
			await expectDescendantSettled(fixture);
		},
		WAIT_FOR_CHILD_MS,
	);

	it("does not probe at all once the caller has already aborted", async () => {
		const fixture = await fakeGh(probeScript("ghp_unused-token\n"));
		const controller = new AbortController();
		controller.abort();

		await expect(
			github.run(fixture.dir, ["pr", "create", "--repo", "owner/repo"], controller.signal, { authHost: PUBLIC }),
		).rejects.toThrow();

		expect(await fixture.invocations()).toEqual([]);
	});

	it(
		"abandons an in-flight probe at once and starts no requested child",
		async () => {
			const fixture = await fakeGh(probeScript("ghp_late-token\n", { hang: true }));
			const controller = new AbortController();

			const pending = github.run(fixture.dir, ["pr", "create", "--repo", "owner/repo"], controller.signal, {
				authHost: PUBLIC,
			});
			await fixture.awaitInvocations(1);
			const aborted = Date.now();
			controller.abort();

			await expect(pending).rejects.toThrow();
			// Terminating a probe still running is immediate; it does not wait out
			// the deadline.
			expect(Date.now() - aborted).toBeLessThan(5_000);
			expect((await fixture.invocations()).map(entry => entry.argv[0])).toEqual(["auth"]);
		},
		WAIT_FOR_CHILD_MS,
	);

	it(
		"keeps the requested child cancellable after the credential is acquired",
		async () => {
			const fixture = await fakeGh(`if [ "$1" = auth ]; then printf 'ghp_probed-token\\n'; exit 0; fi
exec sleep 600`);
			const controller = new AbortController();

			const pending = github.run(fixture.dir, ["pr", "view"], controller.signal, { authHost: PUBLIC });
			const invocations = await fixture.awaitInvocations(2);
			controller.abort();

			await expect(pending).rejects.toThrow();
			expect(invocations.map(entry => entry.argv[0])).toEqual(["auth", "pr"]);
			expect(invocations[1].env).toEqual({ GITHUB_TOKEN: "ghp_probed-token" });
		},
		WAIT_FOR_CHILD_MS,
	);

	it("caps requested-child output at 8 MiB with a marker", async () => {
		const fixture = await fakeGh(`if [ "$1" = auth ]; then printf 'ghp_probed-token\\n'; exit 0; fi
exec bun -e 'const chunk = "a".repeat(1024 * 1024); for (let i = 0; i < 9; i++) process.stdout.write(chunk);'`);

		const result = await github.run(fixture.dir, ["pr", "view"], undefined, {
			authHost: PUBLIC,
			trimOutput: false,
		});

		expect(result.stdout.length).toBe(8 * 1024 * 1024 + TRUNCATION_MARKER.length);
		expect(result.stdout.endsWith(TRUNCATION_MARKER)).toBe(true);
	});
});

describe("gh request host derivation", () => {
	it("takes the host a repo names over the environment default", () => {
		process.env.GH_HOST = "github.example.com";

		expect(ghRequestHost("github.com/owner/repo")).toBe(PUBLIC);
		expect(ghRequestHost({ host: "GitHub.Com", slug: "owner/repo" })).toBe(PUBLIC);
	});

	it("sends an unqualified repo to the host gh defaults to", () => {
		expect(ghRequestHost("owner/repo")).toBe(PUBLIC);
		expect(ghRequestHost(undefined)).toBe(PUBLIC);

		process.env.GH_HOST = "github.example.com";
		expect(ghRequestHost("owner/repo")).toBe(ENTERPRISE);
		expect(ghRequestHost(undefined)).toBe(ENTERPRISE);
	});

	it("keeps an enterprise repo on its own host", () => {
		expect(ghRequestHost("github.example.com/owner/repo")).toBe(ENTERPRISE);
	});

	it("reads the host out of a URL instead of splitting it on slashes", () => {
		expect(ghRequestHost("https://github.example.com/owner/repo")).toBe(ENTERPRISE);
		expect(ghRequestHost("https://github.com/owner/repo")).toBe(PUBLIC);
		expect(ghRequestHost("https://github.example.com/owner/repo/pull/7")).toBe(ENTERPRISE);
		// A URL is never downgraded to the default host, whatever its scheme:
		// that downgrade is how an off-host URL forges github.com.
		expect(ghRequestHost("ssh://github.example.com/owner/repo")).toBe(ENTERPRISE);
		// Userinfo is not the host, however much it looks like one.
		expect(ghRequestHost("https://github.com@github.example.com/owner/repo")).toBe(ENTERPRISE);
	});

	it("keeps a port in the authority it reports", () => {
		// A port is part of the authority a request reaches, so this is not
		// github.com and must never be handed the public credential.
		expect(ghRequestHost("https://github.com:8443/owner/repo")).toBe(ghAuthHost("github.com:8443"));
		expect(ghRequestHost("https://github.com:8443/owner/repo")).not.toBe(PUBLIC);
		expect(ghRequestHost("https://github.example.com:8443/owner/repo")).toBe(ghAuthHost("github.example.com:8443"));
		// The scheme's own default port names the same authority, so it stays.
		expect(ghRequestHost("https://github.com:443/owner/repo")).toBe(PUBLIC);
		// A port cannot ride in on the split form either.
		expect(ghRequestHost("github.com:8443/owner/repo")).toBeUndefined();
	});

	it("claims no host for a shape it cannot vouch for", () => {
		// `parseRepoRef` would call each of these a repository on the default
		// host, and the default host is the one holding a credential.
		const unvouchable = [
			"owner",
			"owner/",
			"/repo",
			"a/b/c/d",
			"github.example.com/owner/repo/extra",
			"o/r extra",
			// A URL that names no repository is not one either.
			"https://github.example.com",
		];
		for (const repo of unvouchable) {
			expect(ghRequestHost(repo)).toBeUndefined();
		}
	});

	it("lets a URL identifier outrank a separate repo, exactly as the argv does", () => {
		expect(ghRequestRepo("owner/repo", "https://github.example.com/o/r/pull/1")).toBe(
			"https://github.example.com/o/r/pull/1",
		);
		expect(ghRequestRepo("github.example.com/owner/repo", "7")).toBe("github.example.com/owner/repo");
		expect(ghRequestRepo(undefined, "https://github.com/o/r/pull/1")).toBe("https://github.com/o/r/pull/1");
		// The scheme is case-insensitive and `http` is a URL as much as `https`;
		// reading either as a branch name would keep a competing `--repo`.
		expect(ghRequestRepo("github.com/victim/secret", "HTTPS://github.example.com/o/r/pull/1")).toBe(
			"HTTPS://github.example.com/o/r/pull/1",
		);
		expect(ghRequestRepo("github.com/victim/secret", "http://github.example.com/o/r/pull/1")).toBe(
			"http://github.example.com/o/r/pull/1",
		);
		// A branch name is not a URL, whatever it contains.
		expect(ghRequestRepo("owner/repo", "feature/https://x")).toBe("owner/repo");
		expect(ghRequestRepo("owner/repo", undefined)).toBe("owner/repo");
	});

	it("settles a named repo without consulting the checkout", async () => {
		const fixture = await fakeGh(probeScript("ghp_unused-token\n"));

		expect(await resolveGhRequestHost(fixture.dir, "github.example.com/owner/repo", undefined)).toBe(ENTERPRISE);
		expect(await resolveGhRequestHost(fixture.dir, "owner/repo", undefined)).toBe(PUBLIC);
		expect(await fixture.invocations()).toEqual([]);
	});

	it("keeps the host of the repository the checkout points at", async () => {
		const fixture = await fakeGh(
			`if [ "$1" = repo ]; then printf 'https://github.example.com/owner/repo\\n'; exit 0; fi
printf 'ok'`,
		);

		expect(await resolveGhRequestHost(fixture.dir, undefined, undefined)).toBe(ENTERPRISE);
		// Resolving a host must never itself trigger a credential probe.
		expect((await fixture.invocations()).map(entry => entry.argv[0])).toEqual(["repo"]);
	});

	it("re-reads the checkout instead of answering from the default-repo cache", async () => {
		// Same cwd, different origin: a cached answer would still say github.com
		// and hand a public credential to an enterprise request.
		const fixture = await fakeGh(`if [ "$1" = repo ]; then
	if [ -f "$dir/switched" ]; then printf 'https://github.example.com/owner/repo\\n'
	else printf 'https://github.com/owner/repo\\n'; fi
	exit 0
fi
printf 'ok'`);

		expect(await resolveGhRequestHost(fixture.dir, undefined, undefined)).toBe(PUBLIC);
		await Bun.write(path.join(fixture.dir, "switched"), "");
		expect(await resolveGhRequestHost(fixture.dir, undefined, undefined)).toBe(ENTERPRISE);
	});

	it("reports no host when the checkout resolves to no repository", async () => {
		const fixture = await fakeGh(`if [ "$1" = repo ]; then printf 'not a git repository\\n' >&2; exit 1; fi
printf 'ok'`);

		expect(await resolveGhRequestHost(fixture.dir, undefined, undefined)).toBeUndefined();
	});
});

describe("github tool operations state the host their argv reaches", () => {
	/**
	 * A `gh` for repo-view shaped routes. The cwd resolver asks for one field
	 * with `-q`, so it gets the bare URL that `gh` would print; the op itself
	 * gets the JSON object.
	 */
	function repoViewScript(url: string, token: string): string {
		return `case "$1" in
auth) printf '%b' ${JSON.stringify(`${token}\n`)} ;;
*)
	for arg in "$@"; do
		[ "$arg" = -q ] && { printf '%b' ${JSON.stringify(`${url}\n`)}; exit 0; }
	done
	printf '{"url":"%s","nameWithOwner":"owner/repo"}' ${JSON.stringify(url)}
	;;
esac`;
	}

	it("acquires a credential for a repo_view resolved from the checkout", async () => {
		const fixture = await fakeGh(repoViewScript("https://github.com/owner/repo", "ghp_probed-token"));

		await executeRepoView(session(fixture.dir), { op: "repo_view" }, undefined);

		const invocations = await fixture.invocations();
		expect(invocations.map(entry => entry.argv.slice(0, 2))).toEqual([
			["repo", "view"],
			["auth", "token"],
			["repo", "view"],
		]);
		expect(invocations[0].env).toEqual({});
		expect(invocations[2].env).toEqual({ GITHUB_TOKEN: "ghp_probed-token" });
	});

	it("leaves an explicit enterprise repo_view unprobed", async () => {
		const fixture = await fakeGh(repoViewScript("https://github.example.com/owner/repo", "ghp_unwanted-token"));

		await executeRepoView(
			session(fixture.dir),
			{ op: "repo_view", repo: "github.example.com/owner/repo" },
			undefined,
		);

		const invocations = await fixture.invocations();
		expect(invocations).toHaveLength(1);
		expect(invocations[0].argv.slice(0, 3)).toEqual(["repo", "view", "github.example.com/owner/repo"]);
		expect(invocations[0].env).toEqual({});
	});

	it("does not hand a credential to a repo_view URL pointing elsewhere", async () => {
		const fixture = await fakeGh(repoViewScript("https://github.example.com/owner/repo", "ghp_unwanted-token"));

		await executeRepoView(
			session(fixture.dir),
			{ op: "repo_view", repo: "https://github.example.com/owner/repo" },
			undefined,
		);

		const invocations = await fixture.invocations();
		expect(invocations).toHaveLength(1);
		expect(invocations[0].argv).toContain("https://github.example.com/owner/repo");
		expect(invocations[0].env).toEqual({});
	});

	it("does not hand a credential to a pr_create URL pointing elsewhere", async () => {
		const fixture = await fakeGh(`case "$1" in
auth) printf 'ghp_unwanted-token\\n' ;;
*) printf 'https://github.example.com/owner/repo/pull/7\\n' ;;
esac`);

		await executePrCreate(
			session(fixture.dir),
			{ op: "pr_create", repo: "https://github.example.com/owner/repo", title: "t" },
			undefined,
		);

		const invocations = await fixture.invocations();
		expect(invocations.map(entry => entry.argv[0])).not.toContain("auth");
		expect(invocations[0].argv.slice(0, 4)).toEqual([
			"pr",
			"create",
			"--repo",
			"https://github.example.com/owner/repo",
		]);
		for (const invocation of invocations) expect(invocation.env).toEqual({});
	});

	it("follows the PR URL's host when a conflicting repo is also supplied", async () => {
		const fixture = await fakeGh(`case "$1" in
auth) printf 'ghp_unwanted-token\\n' ;;
*) printf '{"number":1}' ;;
esac`);

		// The checkout work after the `gh` call needs a real git repository; the
		// credential decision under test has already been made by then.
		await checkoutPullRequest(session(fixture.dir), undefined, {
			prRef: "https://github.example.com/owner/repo/pull/1",
			repo: "github.com/victim/secret",
			force: false,
			// Even with the operation's own host public, the URL decides.
			authHost: PUBLIC,
		}).catch(() => undefined);

		const invocations = await fixture.invocations();
		expect(invocations.map(entry => entry.argv[0])).toEqual(["pr"]);
		// `gh` drops `--repo` for a URL identifier, so the URL's host is the one
		// that must decide, and it is not github.com.
		expect(invocations[0].argv).not.toContain("--repo");
		expect(invocations[0].env).toEqual({});
	});

	// A URL scheme is case-insensitive, and `gh` follows an `http://` URL to its
	// host too, so neither spelling may be mistaken for a branch name: that
	// reading leaves the conflicting `--repo` in the argv and states its
	// github.com host while the child talks to the enterprise instance.
	for (const prRef of [
		"http://github.example.com/owner/repo/pull/1",
		"HTTPS://github.example.com/owner/repo/pull/1",
	]) {
		it(`follows an off-host PR URL written as ${prRef.split("/")[0]} over a conflicting repo`, async () => {
			const fixture = await fakeGh(`case "$1" in
auth) printf 'ghp_unwanted-token\\n' ;;
*) printf '{"number":1}' ;;
esac`);

			await checkoutPullRequest(session(fixture.dir), undefined, {
				prRef,
				repo: "github.com/victim/secret",
				force: false,
				authHost: PUBLIC,
			}).catch(() => undefined);

			const invocations = await fixture.invocations();
			expect(invocations.map(entry => entry.argv[0])).toEqual(["pr"]);
			expect(invocations[0].argv).not.toContain("--repo");
			expect(invocations[0].env).toEqual({});
		});
	}

	it("still acquires a credential for a public PR URL beside an enterprise repo", async () => {
		const fixture = await fakeGh(`case "$1" in
auth) printf 'ghp_probed-token\\n' ;;
*) printf '{"number":1}' ;;
esac`);

		await checkoutPullRequest(session(fixture.dir), undefined, {
			prRef: "https://github.com/owner/repo/pull/1",
			repo: "github.example.com/victim/secret",
			force: false,
			authHost: ENTERPRISE,
		}).catch(() => undefined);

		const invocations = await fixture.invocations();
		expect(invocations.map(entry => entry.argv[0])).toEqual(["auth", "pr"]);
		expect(invocations[1].env).toEqual({ GITHUB_TOKEN: "ghp_probed-token" });
	});
	it("falls back to the host the operation resolved when a PR names no repository", async () => {
		const fixture = await fakeGh(`case "$1" in
auth) printf 'ghp_probed-token\\n' ;;
*) printf '{"number":1}' ;;
esac`);

		// A bare PR number leaves `gh` to resolve the checkout, so the host the
		// operation resolved once is the one that applies.
		await checkoutPullRequest(session(fixture.dir), undefined, {
			prRef: "1",
			repo: undefined,
			force: false,
			authHost: PUBLIC,
		}).catch(() => undefined);

		const invocations = await fixture.invocations();
		expect(invocations.map(entry => entry.argv[0])).toEqual(["auth", "pr"]);
		expect(invocations[1].env).toEqual({ GITHUB_TOKEN: "ghp_probed-token" });
	});

	it("does not resolve the checkout when every PR ref carries its own host", async () => {
		const fixture = await fakeGh(`case "$1" in
auth) printf 'ghp_unwanted-token\\n' ;;
repo) printf 'https://github.com/owner/repo\\n' ;;
*) printf '{"number":1}' ;;
esac`);

		// Both refs are full URLs, so each one already names the authority its own
		// request reaches. The checkout work after the `gh` call needs a real git
		// repository; the credential decision under test is already made by then.
		await executePrCheckout(
			session(fixture.dir),
			{
				pr: ["https://github.example.com/owner/repo/pull/1", "https://github.example.com/owner/repo/pull/2"],
			} as Parameters<typeof executePrCheckout>[1],
			undefined,
		).catch(() => undefined);

		const invocations = await fixture.invocations();
		// A `repo view` here is the cwd fallback, and nothing would read its answer.
		expect(invocations.map(entry => entry.argv[0])).not.toContain("repo");
		// Enterprise URLs, so no github.com credential is acquired for either.
		expect(invocations.map(entry => entry.argv[0])).toEqual(["pr", "pr"]);
		for (const invocation of invocations) expect(invocation.env).toEqual({});
	});

	it("resolves the operation's host exactly once when some PR ref names no repository", async () => {
		const fixture = await fakeGh(`case "$1" in
auth) printf 'ghp_probed-token\\n' ;;
repo) printf 'https://github.com/owner/repo\\n' ;;
*) printf '{"number":1}' ;;
esac`);

		await executePrCheckout(
			session(fixture.dir),
			{ pr: ["https://github.example.com/owner/repo/pull/1", "2", "3"] } as Parameters<typeof executePrCheckout>[1],
			undefined,
		).catch(() => undefined);

		const argv0 = (await fixture.invocations()).map(entry => entry.argv[0]);
		// One cwd resolution for the whole operation, however many refs need it --
		// not one per ref, and not one for the ref that named its own host.
		expect(argv0.filter(name => name === "repo")).toHaveLength(1);
		// Only the two bare refs fall back to github.com and so probe; the enterprise
		// URL keeps its own authority and gets no credential.
		expect(argv0.filter(name => name === "auth")).toHaveLength(2);
		expect(argv0.filter(name => name === "pr")).toHaveLength(3);
	});

	it("states no host for a PR that names no repository and resolved none", async () => {
		const fixture = await fakeGh(`case "$1" in
auth) printf 'ghp_unwanted-token\\n' ;;
*) printf '{"number":1}' ;;
esac`);

		await checkoutPullRequest(session(fixture.dir), undefined, {
			prRef: "1",
			repo: undefined,
			force: false,
			authHost: undefined,
		}).catch(() => undefined);

		const invocations = await fixture.invocations();
		expect(invocations.map(entry => entry.argv[0])).toEqual(["pr"]);
		expect(invocations[0].env).toEqual({});
	});
});

describe("search operations agree with their own --hostname", () => {
	/** A `gh` that answers the probe, and every search with an empty result set. */
	const searchScript = `case "$1" in
auth) printf 'ghp_probed-token\\n' ;;
*) printf '{"items":[]}' ;;
esac`;

	const routes = [
		{ name: "search_issues", run: executeSearchIssues },
		{ name: "search_prs", run: executeSearchPrs },
		{ name: "search_code", run: executeSearchCode },
		{ name: "search_commits", run: executeSearchCommits },
	];

	for (const route of routes) {
		it(`sends ${route.name} to the host its repo URL names, with a matching credential`, async () => {
			const fixture = await fakeGh(searchScript);
			// A public repo URL under an enterprise default: the argv must reach
			// github.com, and only then may the public credential travel with it.
			process.env.GH_HOST = "github.example.com";

			await route.run(
				session(fixture.dir),
				{ op: "search_issues", repo: "https://github.com/owner/repo", query: "bug" },
				undefined,
			);

			const [probe, requested] = await fixture.invocations();
			expect(probe.argv).toEqual(["auth", "token", "--hostname", "github.com"]);
			expect(requested.argv.slice(0, 3)).toEqual(["api", "--hostname", "github.com"]);
			// The qualifier carries the bare slug: the URL was normalized once, not
			// pasted into the query.
			expect(requested.argv.some(arg => arg.startsWith("q=") && arg.includes(" repo:owner/repo"))).toBe(true);
			expect(requested.env).toEqual({ GITHUB_TOKEN: "ghp_probed-token" });
		});

		it(`keeps ${route.name} unprobed when its repo URL names another host`, async () => {
			const fixture = await fakeGh(searchScript);

			await route.run(
				session(fixture.dir),
				{ op: "search_issues", repo: "https://github.example.com/owner/repo", query: "bug" },
				undefined,
			);

			const invocations = await fixture.invocations();
			expect(invocations).toHaveLength(1);
			expect(invocations[0].argv.slice(0, 3)).toEqual(["api", "--hostname", "github.example.com"]);
			expect(invocations[0].env).toEqual({});
		});

		it(`sends ${route.name} to the exact authority its URL names, port included`, async () => {
			const fixture = await fakeGh(searchScript);

			await route.run(
				session(fixture.dir),
				{ op: "search_issues", repo: "https://github.com:8443/owner/repo", query: "bug" },
				undefined,
			);

			const invocations = await fixture.invocations();
			// A port makes this a different authority from github.com, so the argv
			// carries it and no public credential is acquired for it.
			expect(invocations).toHaveLength(1);
			expect(invocations[0].argv.slice(0, 3)).toEqual(["api", "--hostname", "github.com:8443"]);
			expect(invocations[0].env).toEqual({});
		});

		it(`refuses ${route.name} for a repository it cannot read`, async () => {
			const fixture = await fakeGh(searchScript);

			await expect(
				route.run(session(fixture.dir), { op: "search_issues", repo: "owner", query: "bug" }, undefined),
			).rejects.toThrow("unrecognized repository: owner");

			expect(await fixture.invocations()).toEqual([]);
		});
	}

	it("leaves an unscoped search_repos on the default host", async () => {
		const fixture = await fakeGh(searchScript);
		process.env.GH_HOST = "github.example.com";

		await executeSearchRepos(session(fixture.dir), { op: "search_repos", query: "omp" }, undefined);

		const invocations = await fixture.invocations();
		expect(invocations).toHaveLength(1);
		expect(invocations[0].argv).not.toContain("--hostname");
		expect(invocations[0].env).toEqual({});
	});

	it("acquires a credential for an unscoped search_repos on github.com", async () => {
		const fixture = await fakeGh(searchScript);

		await executeSearchRepos(session(fixture.dir), { op: "search_repos", query: "omp" }, undefined);

		const [probe, requested] = await fixture.invocations();
		expect(probe.argv).toEqual(["auth", "token", "--hostname", "github.com"]);
		expect(requested.argv).not.toContain("--hostname");
		expect(requested.env).toEqual({ GITHUB_TOKEN: "ghp_probed-token" });
	});
});
