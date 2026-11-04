import { afterAll, beforeAll, describe, expect, it, type Mock, spyOn } from "bun:test";
import * as os from "node:os";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { buildSessionOptions } from "@oh-my-pi/pi-coding-agent/main";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { DATE_CWD_REMINDER_CUSTOM_TYPE } from "@oh-my-pi/pi-coding-agent/session/date-cwd-reminder";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { __resetDirsFromEnvForTests, getAgentDir, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";

const ENV_KEYS = ["PI_CODING_AGENT_DIR", "OMP_PROFILE", "PI_PROFILE"] as const;
// The reminder's fixed wording; its date and cwd vary.
const REMINDER_MARKER = "current working directory:";

interface ObservedRequests {
	/** Serialized message lists of every provider request the session sent. */
	requests: string[];
	/** Reminder placements the session journaled. */
	journaled: number;
}

describe("--no-date-cwd-reminder", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let homedirSpy: Mock<typeof os.homedir>;
	const originalEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));

	beforeAll(async () => {
		tempDir = await TempDir.create("@cli-no-date-cwd-reminder-");
		setAgentDir(tempDir.join("home/.omp/agent"));
		homedirSpy = spyOn(os, "homedir").mockReturnValue(tempDir.join("home"));
		await Bun.write(tempDir.join("project/README.md"), "project\n");
		authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		authStorage.keys.setRuntime("openai", "test-key");
		modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
	});

	afterAll(async () => {
		authStorage.close();
		closeModelCache();
		homedirSpy.mockRestore();
		for (const key of ENV_KEYS) {
			if (originalEnv[key] === undefined) delete process.env[key];
			else process.env[key] = originalEnv[key];
		}
		__resetDirsFromEnvForTests();
		await tempDir.remove();
	});

	async function createSession(flags: string[]) {
		const settings = Settings.isolated({
			"async.enabled": false,
			"task.isolation.enabled": false,
			"task.enableLsp": false,
			"advisor.enabled": false,
			"compaction.enabled": false,
			"retry.enabled": false,
		});
		// `--no-extensions`: the plugins root resolves from the real home directory read at module load, so the
		// machine's own plugin extensions would otherwise join the requests this test reads.
		const args = parseArgs(["--cwd", tempDir.join("project"), "--no-context-files", "--no-extensions", ...flags]);
		const options = await buildSessionOptions(args, [], SessionManager.inMemory(args.cwd), modelRegistry, settings);
		const { session } = await sdkModule.createAgentSession({
			...options,
			agentDir: getAgentDir(),
			modelRegistry,
			settings,
			model: getBundledModel("openai", "gpt-4o-mini"),
			enableLsp: false,
			skipPythonPreflight: true,
		});
		return session;
	}

	/** Sends one prompt through a mock provider and reports what reached the provider and the journal. */
	async function observeRequests(session: AgentSession): Promise<ObservedRequests> {
		const mock = createMockModel({ handler: { content: ["ok"] } });
		session.agent.streamFn = mock.stream;
		await session.prompt("Say ok.");
		return {
			requests: mock.calls.map(call => JSON.stringify(call.context.messages)),
			journaled: session.sessionManager
				.getEntries()
				.filter(entry => entry.type === "custom" && entry.customType === DATE_CWD_REMINDER_CUSTOM_TYPE).length,
		};
	}

	/** Spawns one `task` subagent through the session's task tool and returns what its first request carried. */
	async function observeSubagentRequests(session: AgentSession): Promise<ObservedRequests> {
		const createChild = sdkModule.createAgentSession;
		let observed: ObservedRequests | undefined;
		const createSpy = spyOn(sdkModule, "createAgentSession").mockImplementation(async childOptions => {
			const created = await createChild(childOptions);
			try {
				observed = await observeRequests(created.session);
			} finally {
				await created.session.dispose();
			}
			throw new Error("child requests captured");
		});
		try {
			await session.getToolByName("task")?.execute("no-date-cwd-reminder-child", {
				agent: "task",
				name: "ReminderProbe",
				task: "Report.",
				solutionSpace: "one fix: probe only",
			});
		} finally {
			createSpy.mockRestore();
		}
		if (observed === undefined) throw new Error("task tool did not create a subagent session");
		return observed;
	}

	it("sends and journals no date/cwd reminder from the session or its subagents", async () => {
		const ambient = await createSession([]);
		try {
			const parent = await observeRequests(ambient);
			expect(parent.requests.length).toBeGreaterThan(0);
			expect(parent.requests[0]).toContain(REMINDER_MARKER);
			expect(parent.journaled).toBeGreaterThan(0);
			const child = await observeSubagentRequests(ambient);
			expect(child.requests[0]).toContain(REMINDER_MARKER);
		} finally {
			await ambient.dispose();
		}

		const session = await createSession(["--no-date-cwd-reminder"]);
		try {
			const parent = await observeRequests(session);
			expect(parent.requests.length).toBeGreaterThan(0);
			for (const request of parent.requests) expect(request).not.toContain(REMINDER_MARKER);
			expect(parent.journaled).toBe(0);
			const child = await observeSubagentRequests(session);
			expect(child.requests.length).toBeGreaterThan(0);
			for (const request of child.requests) expect(request).not.toContain(REMINDER_MARKER);
		} finally {
			await session.dispose();
		}
	}, 60_000);
});
