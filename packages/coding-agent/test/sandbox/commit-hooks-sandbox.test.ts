/**
 * The eval `commit` helper's git hooks under the OS sandbox: contained under the eval policy while
 * the sandbox applies to eval, on the host otherwise, and per `sandbox.fallback` when unavailable.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { ChangeJournal } from "@oh-my-pi/pi-coding-agent/commit/selective/journal";
import { createCommitPrelude } from "@oh-my-pi/pi-coding-agent/commit/selective/prelude-definition";
import { SandboxRuntime } from "@oh-my-pi/pi-coding-agent/sandbox/runtime";
import { cfgSandboxEnabled, cfgSandboxFallback, cfgSandboxScope } from "@oh-my-pi/pi-coding-agent/sandbox/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import {
	type ContainedSandboxTest,
	beginContainedSandboxTest,
	containedToolSession,
	endContainedSandboxTest,
	git,
	outcome,
	SANDBOX_BACKEND_PRESENT,
	SANDBOX_UNAVAILABLE,
} from "../helpers/sandbox-test-state";

let test: ContainedSandboxTest;

beforeEach(async () => {
	test = await beginContainedSandboxTest("commit-hooks-sandbox");
	const { workspace } = test;
	git(workspace, "init", "-q", "-b", "main");
	git(workspace, "config", "user.email", "test@example.com");
	git(workspace, "config", "user.name", "Test");
	// The commit itself runs in-process and reads the developer's global config.
	git(workspace, "config", "commit.gpgSign", "false");
	git(workspace, "config", "core.autocrlf", "false");
	git(workspace, "config", "core.hooksPath", ".git/hooks");
	fs.writeFileSync(path.join(workspace, "seed.txt"), "seed\n");
	git(workspace, "add", "seed.txt");
	git(workspace, "commit", "-qm", "seed");
});

afterEach(async () => {
	await endContainedSandboxTest(test);
});

/** stdout of `git args` in the workspace, isolated from the developer's global/system config. */
function gitOutput(...args: string[]): string {
	const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
	const result = Bun.spawnSync(["git", ...args], { cwd: test.workspace, env, stdout: "pipe", stderr: "pipe" });
	if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
	return result.stdout.toString().trim();
}

/** HEAD of the workspace repository. */
function head(): string {
	return gitOutput("rev-parse", "HEAD");
}

/** Installs `body` as the workspace's executable hook `name`. */
function hook(name: string, body: string): void {
	const file = path.join(test.workspace, ".git", "hooks", name);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}

/** Main's journaled edit, committed through the eval `commit` helper; what the model sees of the commit call. */
async function commitThroughHelper(signal?: AbortSignal): Promise<string> {
	const file = path.join(test.workspace, "agent.txt");
	fs.writeFileSync(file, "agent\n");
	const journal = ChangeJournal.at(test.artifacts);
	journal.recordChange({ agent: "Main", parent: undefined, tool: "edit", path: file, before: null, after: "agent\n" });
	await journal.flush();
	const session: ToolSession = {
		...containedToolSession(test),
		getSessionSpawns: () => null,
		getAgentId: () => "Main",
	};
	const helper = createCommitPrelude(session);
	const call = (parameters: object) => helper.invoke(parameters, { session, toolCallId: "test", signal });
	const { id } = type({ id: "string" }).assert((await call({ action: "draft" })).details);
	return await outcome(call({ action: "commit", draft: id, subject: "feat: agent" }));
}

describe("commit helper hooks without a sandbox backend", () => {
	it("run on the host while the sandbox is off", async () => {
		cfgSandboxEnabled.set(test.settings, false);
		const escaped = path.join(test.outside, "escaped.txt");
		hook("pre-commit", `echo host > '${escaped}'`);
		const before = head();

		const text = await commitThroughHelper();

		expect(text).toContain("feat: agent");
		expect(head()).not.toBe(before);
		expect(fs.readFileSync(escaped, "utf8")).toBe("host\n");
	});

	it("run on the host while the sandbox does not apply to eval", async () => {
		// Applying to eval would refuse the commit: no backend, and the block fallback.
		SandboxRuntime.resetForTest(SANDBOX_UNAVAILABLE);
		cfgSandboxFallback.set(test.settings, "block");
		cfgSandboxScope.set(test.settings, ["bash"]);
		const escaped = path.join(test.outside, "escaped.txt");
		hook("pre-commit", `echo host > '${escaped}'`);
		const before = head();

		const text = await commitThroughHelper();

		expect(text).toContain("feat: agent");
		expect(head()).not.toBe(before);
		expect(fs.readFileSync(escaped, "utf8")).toBe("host\n");
	});

	it("run on the host after the warning when unavailable with the warn fallback", async () => {
		SandboxRuntime.resetForTest(SANDBOX_UNAVAILABLE);
		const warnings: string[] = [];
		SandboxRuntime.setWarningSink(message => warnings.push(message));
		const escaped = path.join(test.outside, "escaped.txt");
		hook("pre-commit", `echo host > '${escaped}'`);
		try {
			const text = await commitThroughHelper();

			expect(text).toContain("feat: agent");
			expect(fs.readFileSync(escaped, "utf8")).toBe("host\n");
			expect(warnings).toEqual([
				`Sandbox unavailable (${SANDBOX_UNAVAILABLE.reason}); running unsandboxed because sandbox.fallback is "warn".`,
			]);
		} finally {
			SandboxRuntime.setWarningSink(undefined);
		}
	});

	it("refuse the commit when unavailable with the block fallback", async () => {
		SandboxRuntime.resetForTest(SANDBOX_UNAVAILABLE);
		cfgSandboxFallback.set(test.settings, "block");
		const escaped = path.join(test.outside, "escaped.txt");
		hook("pre-commit", `echo host > '${escaped}'`);
		const before = head();

		const text = await commitThroughHelper();

		expect(text).toContain(`Sandbox unavailable: ${SANDBOX_UNAVAILABLE.reason}`);
		expect(head()).toBe(before);
		expect(fs.existsSync(escaped)).toBe(false);
	});
});

// Contained on Windows, Git's MSYS `sh.exe` dies before any hook runs (docs/sandbox.md, "Windows").
describe.skipIf(!SANDBOX_BACKEND_PRESENT || process.platform === "win32")("commit helper hooks in the sandbox", () => {
	it("cannot write outside the workspace, and the failure carries the sandbox notice", async () => {
		const escaped = path.join(test.outside, "escaped.txt");
		hook("pre-commit", `echo contained > '${escaped}'`);
		const before = head();

		const text = await commitThroughHelper();

		expect(head()).toBe(before);
		expect(fs.existsSync(escaped)).toBe(false);
		expect(text).toMatch(/operation not permitted|read-only file system/i);
		expect(text).toContain("[OS sandbox:");
	});

	it("fail the commit with their own output and no sandbox notice when they fail for their own reason", async () => {
		hook("pre-commit", "echo lint failed; exit 1");
		const before = head();

		const text = await commitThroughHelper();

		// The hook's output alone: no sandbox notice, nothing appended.
		expect(text).toBe("lint failed");
		expect(head()).toBe(before);
	});

	it("write inside the workspace, and the commit lands", async () => {
		const inside = path.join(test.workspace, "hook-ran.txt");
		hook("pre-commit", `echo contained > '${inside}'`);
		const before = head();

		const text = await commitThroughHelper();

		expect(text).toContain("feat: agent");
		expect(head()).not.toBe(before);
		expect(fs.readFileSync(inside, "utf8")).toBe("contained\n");
	});

	it("rewrite the commit message from commit-msg", async () => {
		hook("commit-msg", `echo 'Change-Id: I0123456789' >> "$1"`);

		const text = await commitThroughHelper();

		expect(text).toContain("feat: agent");
		expect(gitOutput("log", "-1", "--format=%B")).toBe("feat: agent\nChange-Id: I0123456789");
	});

	it("keep a denied post-commit's notice off a later failure, since git ignores that hook", async () => {
		const escaped = path.join(test.outside, "escaped.txt");
		// Denied, then breaks the shared index the helper syncs once the commit has landed.
		hook("post-commit", `echo contained > '${escaped}'\nprintf broken > .git/index\nexit 1`);
		const before = head();

		const text = await commitThroughHelper();

		expect(head()).not.toBe(before);
		expect(text).not.toContain("feat: agent");
		expect(text).not.toContain("[OS sandbox:");
	});

	it("are killed by an abort, which fails the commit", async () => {
		const marker = path.join(test.workspace, "hook-started");
		hook("pre-commit", `touch '${marker}'\nsleep 30`);
		const before = head();
		const controller = new AbortController();
		const started = Promise.withResolvers<void>();
		const watcher = fs.watch(test.workspace, () => {
			if (fs.existsSync(marker)) started.resolve();
		});
		try {
			const call = commitThroughHelper(controller.signal);
			await started.promise;
			const abortedAt = performance.now();
			controller.abort();
			const text = await call;

			expect(performance.now() - abortedAt).toBeLessThan(10_000);
			expect(text).not.toContain("feat: agent");
			expect(text).not.toContain("[OS sandbox:");
			expect(head()).toBe(before);
		} finally {
			watcher.close();
		}
	});
});
