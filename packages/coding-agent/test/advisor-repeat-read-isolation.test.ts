import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import * as sessionAdvisors from "@oh-my-pi/pi-coding-agent/session/session-advisors";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { Snowflake } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

let tempDir: string;
let authStorage: AuthStorage;

beforeEach(() => {
	tempDir = path.join(os.tmpdir(), `pi-advisor-repeat-read-${Snowflake.next()}`);
	fs.mkdirSync(tempDir, { recursive: true });
	authStorage = createInMemoryAuthStorage();
});

afterEach(() => {
	authStorage.close();
	fs.rmSync(tempDir, { recursive: true, force: true });
});

// Issue #18834: advisors shared one tool session, so a sibling's reads counted
// toward another advisor's "identical output N times" warning.
test("each advisor's repeat-read warning counts only its own reads", async () => {
	const RealSessionAdvisors = sessionAdvisors.SessionAdvisors;
	let factory: sessionAdvisors.AdvisorToolFactory | undefined;
	const advisorsSpy = spyOn(sessionAdvisors, "SessionAdvisors").mockImplementation(function (
		host: sessionAdvisors.SessionAdvisorsHost,
		options: sessionAdvisors.SessionAdvisorsOptions,
	) {
		factory = options.tools;
		return new RealSessionAdvisors(host, options);
	} as never);
	const file = path.join(tempDir, "probe.txt");
	fs.writeFileSync(file, "unchanged\n");
	let session: AgentSession;
	try {
		({ session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			modelRegistry: new ModelRegistry(authStorage, path.join(tempDir, "models.yml")),
			settings: Settings.isolated(),
			sessionManager: SessionManager.inMemory(),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			rules: [],
			preloadedCustomToolPaths: [],
			toolNames: ["read"],
		}));
	} finally {
		advisorsSpy.mockRestore();
	}
	try {
		// A slate granted only `read` holds exactly that tool.
		const siblingSlate = factory!.create(new Set(["read"]));
		const [sibling] = siblingSlate.tools;
		const [own] = factory!.create(new Set(["read"])).tools;

		await sibling.execute("sibling-1", { path: file });
		await sibling.execute("sibling-2", { path: file });
		const ownFirst = await own.execute("own-1", { path: file });
		expect(JSON.stringify(ownFirst.content)).not.toContain("identical output");
		const siblingThird = await sibling.execute("sibling-3", { path: file });
		expect(JSON.stringify(siblingThird.content)).toContain("identical output 3 times");

		// A new conversation (/new) starts the count over.
		siblingSlate.resetState!();
		const afterReset = await sibling.execute("sibling-4", { path: file });
		expect(JSON.stringify(afterReset.content)).not.toContain("identical output");
	} finally {
		await session.dispose();
	}
});
