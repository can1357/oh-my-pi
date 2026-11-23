import { describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import {
	BackgroundHandoff,
	describeInProcessWork,
	type HandoffHost,
	hostedSessionArgv,
} from "@oh-my-pi/pi-coding-agent/agents-view/handoff";
import type { AsyncJob } from "@oh-my-pi/pi-coding-agent/async";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";

function setup(state: { persistent?: boolean; draft?: string; queued?: number }) {
	const manager = {
		isPersistent: vi.fn(() => state.persistent ?? true),
		ensureOnDisk: vi.fn(async () => {}),
		persistCopy: vi.fn(),
		isSessionOnDisk: vi.fn(() => true),
		getSessionFile: vi.fn(() => "/tmp/session.jsonl"),
	};
	const session = {
		sessionManager: manager,
		queuedMessageCount: state.queued ?? 0,
		isStreaming: false,
		asyncJobManager: undefined,
		abort: vi.fn(async () => {}),
	} as unknown as AgentSession;
	const host = {
		getSession: () => session,
		composerText: () => state.draft ?? "",
		showStatus: vi.fn(),
		showWarning: vi.fn(),
		confirm: vi.fn(async () => true),
		beginClose: vi.fn(() => true),
		abandonClose: vi.fn(),
		teardown: vi.fn(async () => true),
		runAgentsView: vi.fn(async () => 0),
		quit: vi.fn(async () => {}),
		reportFailure: vi.fn(async () => {}),
	} satisfies HandoffHost;
	return { host, manager, handoff: new BackgroundHandoff(host) };
}

describe("background handoff refusals", () => {
	it.each([
		["the composer holds a draft", { draft: "half a thought" }],
		["messages are queued", { queued: 2 }],
		["the session is --no-session", { persistent: false }],
	])("leaves the session alone when %s", async (_name, state) => {
		const { host, manager, handoff } = setup(state);
		await handoff.trigger();
		expect(host.showWarning).toHaveBeenCalledTimes(1);
		expect(manager.ensureOnDisk).not.toHaveBeenCalled();
		expect(manager.persistCopy).not.toHaveBeenCalled();
		expect(host.beginClose).not.toHaveBeenCalled();
		expect(host.teardown).not.toHaveBeenCalled();
		expect(host.runAgentsView).not.toHaveBeenCalled();
		expect(host.quit).not.toHaveBeenCalled();
		expect(handoff.running).toBe(false);
	});

	it("gives the close back and keeps the session when it cannot be saved", async () => {
		const { host, manager, handoff } = setup({});
		manager.isSessionOnDisk.mockReturnValue(false);
		await handoff.trigger();
		expect(host.beginClose).toHaveBeenCalledTimes(1);
		expect(host.abandonClose).toHaveBeenCalledTimes(1);
		expect(host.teardown).not.toHaveBeenCalled();
		expect(host.runAgentsView).not.toHaveBeenCalled();
	});

	it("does not launch when another close already owns the session", async () => {
		const { host, manager, handoff } = setup({});
		host.beginClose.mockReturnValue(false);
		await handoff.trigger();
		expect(manager.ensureOnDisk).not.toHaveBeenCalled();
		expect(host.teardown).not.toHaveBeenCalled();
		expect(host.runAgentsView).not.toHaveBeenCalled();
	});
});

describe("in-process work listing", () => {
	it("lists each job on one control-free line", () => {
		const jobs = [
			{ label: "task", intent: "Review\nthe diff\x1b[31m" },
			{ label: "bash: npm test" },
		] as unknown as AsyncJob[];
		const lines = describeInProcessWork(jobs);
		expect(lines).toHaveLength(2);
		for (const line of lines) expect(line).not.toMatch(/[\x00-\x1f\x7f]/);
		expect(lines[1]).toContain("bash: npm test");
	});
});

describe("hosted session argv", () => {
	it("restores the saved session in place of resume selectors and drops one-shot prompts", () => {
		const argv = hostedSessionArgv(["--model", "sonnet", "--resume", "abc", "fix the bug"], "s.jsonl", undefined);
		expect(argv).toContain("--restore");
		expect(argv[argv.indexOf("--restore") + 1]).toBe(path.resolve("s.jsonl"));
		expect(argv).toContain("--model");
		expect(argv).not.toContain("--resume");
		expect(argv).not.toContain("fix the bug");
	});

	it("passes the active profile explicitly exactly once", () => {
		const argv = hostedSessionArgv(["--profile", "old"], "/tmp/s.jsonl", "work");
		expect(argv.filter(arg => arg === "--profile")).toHaveLength(1);
		expect(argv[argv.indexOf("--profile") + 1]).toBe("work");
	});
});
