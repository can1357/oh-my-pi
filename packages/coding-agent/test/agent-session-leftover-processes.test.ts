import * as path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, TextContent } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { UnitSnapshot } from "@oh-my-pi/pi-coding-agent/daemon/daemon-types";
import { executeBash, heldShellProcesses } from "@oh-my-pi/pi-coding-agent/exec/bash-executor";
import { BASH_SESSION_ENV, bashSessionTag } from "@oh-my-pi/pi-coding-agent/exec/session-processes";
import { cfgBashReapBackground } from "@oh-my-pi/pi-coding-agent/exec/settings";
import * as services from "@oh-my-pi/pi-coding-agent/launch/services";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { listProcessesWithEnvPrefix, processInfo } from "@oh-my-pi/pi-natives";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const sharedAuthStorage = createInMemoryAuthStorage();
sharedAuthStorage.keys.setRuntime("anthropic", "test-key");
const sharedModelRegistry = new ModelRegistry(sharedAuthStorage);

afterAll(() => {
	sharedAuthStorage.close();
});

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** Polls real OS process state (a kill or spawn has no event to await), bounded at ~3s. */
async function waitFor(check: () => boolean, what: string): Promise<void> {
	for (let i = 0; i < 300; i++) {
		if (check()) return;
		await Bun.sleep(10);
	}
	throw new Error(`Timed out waiting for ${what}`);
}

describe.skipIf(process.platform === "win32")("AgentSession leftover background processes", () => {
	let tempDir: TempDir;
	let sessionManager: SessionManager;
	let sessions: AgentSession[];
	/** Leftover pids a case started, killed after it whatever it asserted. */
	let spawned: number[];

	function createSession(options: {
		settings?: Record<string, unknown>;
		agentKind?: "main" | "sub";
		toolSession?: ToolSession;
	}): AgentSession {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model to exist");
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"todo.enabled": false,
			...options.settings,
		});
		const session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager,
			settings,
			modelRegistry: sharedModelRegistry,
			agentKind: options.agentKind,
			evalToolSession: options.toolSession,
		});
		sessions.push(session);
		return session;
	}

	/** Runs `script` as a bash tool call of the session would: on its shell, tagged with its id. */
	async function runTagged(script: string): Promise<void> {
		const sessionId = sessionManager.getSessionId();
		const result = await executeBash(script, {
			cwd: tempDir.path(),
			sessionKey: sessionId,
			env: { [BASH_SESSION_ENV]: bashSessionTag(sessionId) },
			timeout: 10_000,
		});
		expect(result.exitCode).toBe(0);
	}

	/** What the tracker sees: env-tagged processes plus the externals the session's shells hold. */
	function sessionProcesses() {
		const sessionId = sessionManager.getSessionId();
		const held = heldShellProcesses(sessionId).map(proc => proc.pid);
		const tag = bashSessionTag(sessionId);
		const tagged = listProcessesWithEnvPrefix(BASH_SESSION_ENV, tag).filter(proc => proc.envValue === tag);
		return [...tagged, ...processInfo(held)];
	}

	async function pidOf(match: (command: string) => boolean, what: string): Promise<number> {
		let pid = 0;
		await waitFor(() => {
			pid = sessionProcesses().find(proc => match(proc.command))?.pid ?? 0;
			return pid > 0;
		}, what);
		spawned.push(pid);
		return pid;
	}

	/**
	 * Leftovers of every shape. macOS hides the env of Apple-signed binaries (`/bin/sh`,
	 * `/bin/sleep`), so the env-tag cases run bun children; `/bin/sleep &` on the session's own
	 * shell is found through the shell's held pids instead.
	 */
	async function spawnLeftovers(): Promise<{
		plain: number;
		sub: number;
		subChild: number;
		nohup: number;
		held: number;
		heldNohup: number;
	}> {
		const dir = tempDir.path();
		await Bun.write(path.join(dir, "sleeper.ts"), "await Bun.sleep(300_000);\n");
		await Bun.write(
			path.join(dir, "parent.ts"),
			'Bun.spawn([process.execPath, `${import.meta.dir}/sleeper.ts`, "sub-child"], { stdio: ["ignore", "ignore", "ignore"] });\nawait Bun.sleep(300_000);\n',
		);
		const bun = `'${process.execPath}'`;
		// Orphaned by its `sh` at once: reparented to init/launchd.
		await runTagged(`sh -c "${bun} sleeper.ts plain >/dev/null 2>&1 &"`);
		// The `(cd X && server &)` subshell form, with a descendant of its own.
		await runTagged(`(cd '${dir}' && ${bun} parent.ts sub >/dev/null 2>&1 &)`);
		await runTagged(`sh -c "nohup ${bun} sleeper.ts nohup >/dev/null 2>&1 &"`);
		await runTagged("/bin/sleep 304 >/dev/null 2>&1 &");
		// The shell's own `nohup` (case B) leaves SIGHUP unmasked: the shell's held pids say it.
		await runTagged("nohup /bin/sleep 305 >/dev/null 2>&1 &");
		return {
			plain: await pidOf(command => command.endsWith("sleeper.ts plain"), "the `&` leftover"),
			sub: await pidOf(command => command.endsWith("parent.ts sub"), "the subshell-form leftover"),
			subChild: await pidOf(command => command.endsWith("sub-child"), "the subshell-form leftover's child"),
			nohup: await pidOf(command => command.endsWith("sleeper.ts nohup"), "the nohup leftover"),
			held: await pidOf(command => command === "/bin/sleep 304", "the shell-held /bin/sleep"),
			heldNohup: await pidOf(command => command === "/bin/sleep 305", "the shell's nohup /bin/sleep"),
		};
	}

	function textOnlyStop(session: AgentSession): void {
		const msg: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "done" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "stop",
			usage: {
				input: 100,
				output: 20,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 120,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};
		session.agent.emitExternalEvent({ type: "message_end", message: msg });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [msg] });
	}

	function reminders(): string[] {
		const out: string[] = [];
		for (const entry of sessionManager.getBranch()) {
			if (entry.type !== "message" || entry.message.role !== "developer") continue;
			const { content } = entry.message;
			if (!Array.isArray(content)) continue;
			for (const item of content as TextContent[]) {
				if (item.type === "text" && item.text.includes("Your bash calls left")) out.push(item.text);
			}
		}
		return out;
	}

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-leftover-processes-");
		sessionManager = SessionManager.inMemory(tempDir.path());
		sessions = [];
		spawned = [];
	});

	afterEach(async () => {
		for (const session of sessions) {
			try {
				await session.dispose();
			} catch {}
		}
		// Every leftover a case started, and whatever else still carries the session's tag (a
		// disposed session's shells stop listing what they held).
		for (const pid of [...spawned, ...sessionProcesses().map(proc => proc.pid)]) {
			try {
				process.kill(pid, "SIGKILL");
			} catch {}
		}
		vi.restoreAllMocks();
		try {
			await tempDir.remove();
		} catch {}
	});

	it("kills `&` leftovers and their `(cmd &)` descendants at session end, sparing nohup", async () => {
		const session = createSession({});
		const { plain, sub, subChild, nohup, held, heldNohup } = await spawnLeftovers();

		await session.dispose();

		await waitFor(() => !alive(plain) && !alive(sub) && !alive(subChild) && !alive(held), "the `&` leftovers to die");
		expect(alive(nohup)).toBe(true);
		expect(alive(heldNohup)).toBe(true);
	});

	it("reaps nothing with the setting forced off as RPC mode does", async () => {
		const session = createSession({});
		cfgBashReapBackground.override(session.settings, false);
		const { plain, sub, subChild } = await spawnLeftovers();

		await session.dispose();

		expect([alive(plain), alive(sub), alive(subChild)]).toEqual([true, true, true]);
	});

	it("reaps nothing and reminds nothing with bash.reapBackground off", async () => {
		const session = createSession({ settings: { "bash.reapBackground": false } });
		vi.spyOn(session.agent, "continue").mockResolvedValue();
		const { plain } = await spawnLeftovers();

		textOnlyStop(session);
		await session.waitForIdle();
		expect(reminders()).toEqual([]);

		await session.dispose();
		expect(alive(plain)).toBe(true);
	});

	it("reminds the main agent once per leftover root, with kind and registration advice", async () => {
		const session = createSession({});
		vi.spyOn(session.agent, "continue").mockResolvedValue();
		const { plain, sub, subChild, nohup, held, heldNohup } = await spawnLeftovers();

		textOnlyStop(session);
		await session.waitForIdle();
		const [first, ...rest] = reminders();
		expect(rest).toEqual([]);
		expect(first).toContain(`pid ${plain} (&,`);
		expect(first).toContain(`pid ${sub} (&,`);
		expect(first).toContain(`pid ${held} (&,`);
		expect(first).toContain(`pid ${nohup} (nohup,`);
		expect(first).toContain(`pid ${heldNohup} (nohup,`);
		// A root's descendants belong to it.
		expect(first).not.toContain(`pid ${subChild} `);
		expect(first).toContain("o2ctl services add <name> <pid>");
		expect(first).toContain("killed when this session ends");
		expect(first).toContain("must be registered as a service");

		textOnlyStop(session);
		await session.waitForIdle();
		expect(reminders()).toHaveLength(1);
	});

	it("leaves service processes out of the reminder and the session-end kill", async () => {
		const toolSession = { cwd: tempDir.path(), getSessionId: () => sessionManager.getSessionId() } as ToolSession;
		const session = createSession({ toolSession });
		vi.spyOn(session.agent, "continue").mockResolvedValue();
		const { plain, sub, subChild } = await spawnLeftovers();
		vi.spyOn(services, "listServices").mockResolvedValue([{ pids: [sub] } as UnitSnapshot]);

		textOnlyStop(session);
		await session.waitForIdle();
		const [reminder] = reminders();
		expect(reminder).not.toContain(`pid ${sub} `);
		expect(reminder).toContain(`pid ${plain} `);

		await session.dispose();
		await waitFor(() => !alive(plain), "the unregistered leftover to die");
		expect([alive(sub), alive(subChild)]).toEqual([true, true]);
	});

	it("does not remind subagents", async () => {
		const session = createSession({ agentKind: "sub" });
		vi.spyOn(session.agent, "continue").mockResolvedValue();
		await spawnLeftovers();

		textOnlyStop(session);
		await session.waitForIdle();
		expect(reminders()).toEqual([]);
	});
});
