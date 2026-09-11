import { describe, expect, it, vi } from "bun:test";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";

function createRuntimeHarness(options?: {
	showSessionPinSelector?: InteractiveModeContext["showSessionPinSelector"];
	session?: Partial<AgentSession>;
}) {
	const setText = vi.fn();
	const showStatus = vi.fn();
	const showSessionPinSelector =
		options?.showSessionPinSelector ??
		vi.fn(async () => {
			return;
		});

	return {
		setText,
		showStatus,
		showSessionPinSelector,
		runtime: {
			ctx: {
				editor: { setText } as unknown as InteractiveModeContext["editor"],
				showSessionPinSelector,
				showStatus,
				statusLine: { invalidate: vi.fn() },
				ui: { requestRender: vi.fn() },
				session: (options?.session ?? {}) as AgentSession,
			} as unknown as InteractiveModeContext,
		},
	};
}

describe("/switchaccount slash command", () => {
	it("with no argument, opens the same account picker as /session pin", async () => {
		const deferred = Promise.withResolvers<void>();
		const showSessionPinSelector = vi.fn(() => deferred.promise);
		const harness = createRuntimeHarness({ showSessionPinSelector });

		let settled = false;
		const execution = executeBuiltinSlashCommand("/switchaccount", harness.runtime).then(result => {
			settled = true;
			return result;
		});

		await Promise.resolve();
		expect(showSessionPinSelector).toHaveBeenCalledTimes(1);
		expect(harness.setText).toHaveBeenCalledWith("");
		expect(settled).toBe(false);

		deferred.resolve();
		expect(await execution).toBe(true);
		expect(settled).toBe(true);
	});

	it("with an argument, pins the matching account directly without opening the picker", async () => {
		const listCurrentProviderOAuthAccounts = vi.fn(async () => ({
			provider: "anthropic",
			accounts: [
				{ position: 0, credentialId: 1, email: "a@example.com", active: false },
				{ position: 1, credentialId: 2, email: "b@example.com", active: false },
			],
		}));
		const pinCurrentProviderOAuthAccount = vi.fn(() => true);
		const showSessionPinSelector = vi.fn(async () => {
			return;
		});
		const harness = createRuntimeHarness({
			showSessionPinSelector,
			session: {
				isStreaming: false,
				listCurrentProviderOAuthAccounts,
				pinCurrentProviderOAuthAccount,
			},
		});

		const result = await executeBuiltinSlashCommand("/switchaccount b@example.com", harness.runtime);

		expect(result).toBe(true);
		expect(showSessionPinSelector).not.toHaveBeenCalled();
		expect(pinCurrentProviderOAuthAccount).toHaveBeenCalledWith(2);
		expect(harness.showStatus).toHaveBeenCalledWith(expect.stringContaining("b@example.com"));
		expect(harness.setText).toHaveBeenCalledWith("");
	});
});
