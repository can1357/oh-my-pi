import { afterAll, describe, expect, it } from "bun:test";
import { redactSensitiveCredentials } from "@oh-my-pi/pi-ai/providers/transform-messages";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { bindEffects } from "@oh-my-pi/pi-coding-agent/config/registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAcpSessionFactory } from "@oh-my-pi/pi-coding-agent/main";
import type { CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const authStorage = createInMemoryAuthStorage();
const modelRegistry = new ModelRegistry(authStorage);
const GITHUB_TOKEN = "ghp_AbCd1234EfGh5678IjKl9012MnOp3456QrSt";

afterAll(() => {
	authStorage.close();
});

// An ACP client can open `session/new` for a workspace other than the launch cwd. That
// project's settings — notably `secrets.enabled` outbound credential redaction — must
// govern process-wide effects while its session lives, and hand them back on dispose.
describe("ACP sessions for another project", () => {
	it("apply that project's secrets.enabled to outbound redaction until disposed", async () => {
		using launchDir = TempDir.createSync("@pi-acp-effects-launch-");
		using projectDir = TempDir.createSync("@pi-acp-effects-project-");
		await Bun.write(projectDir.join(".omp/config.yml"), "secrets:\n  enabled: true\n");
		const launchSettings = await Settings.loadIsolated({
			cwd: launchDir.path(),
			agentDir: launchDir.join("agent"),
		});
		const releaseLaunch = bindEffects(launchSettings);
		try {
			expect(redactSensitiveCredentials(GITHUB_TOKEN)).toBe(GITHUB_TOKEN);

			const disposers: Array<() => void> = [];
			const fakeSession = {
				extensionRunner: undefined,
				getAllToolNames: () => [],
				addDisposer: (dispose: () => void) => disposers.push(dispose),
				dispose: async () => {
					for (const dispose of disposers.splice(0)) dispose();
				},
			} as unknown as AgentSession;
			const factory = createAcpSessionFactory({
				baseOptions: {},
				settings: launchSettings,
				sessionDir: launchDir.join("sessions"),
				authStorage,
				modelRegistry,
				parsedArgs: {},
				rawArgs: [],
				createSession: async () => ({ session: fakeSession }) as CreateAgentSessionResult,
			});

			const { session } = await factory(projectDir.path());
			expect(redactSensitiveCredentials(GITHUB_TOKEN)).toBe("[github_token_redacted]");

			await session.dispose();
			expect(redactSensitiveCredentials(GITHUB_TOKEN)).toBe(GITHUB_TOKEN);
		} finally {
			releaseLaunch();
			launchSettings.cancelPendingSaves();
			// The persisted instance opened agent storage under the temp dir removed below.
			AgentStorage.close();
		}
	});
});
