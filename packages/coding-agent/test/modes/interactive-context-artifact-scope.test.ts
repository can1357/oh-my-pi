import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { refreshAssistantMessageLinkTargets } from "@oh-my-pi/pi-tui/prompt/interactive-context-helpers";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { ArtifactManager } from "@oh-my-pi/pi-coding-agent/session/artifacts";

describe("interactive artifact link targets", () => {
	const roots: string[] = [];

	afterEach(async () => {
		for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
	});

	it("keeps producer scope when rendering a focused child transcript", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "interactive-artifact-scope-"));
		roots.push(root);
		const manager = new ArtifactManager(root);
		const parentId = await manager.save("parent", "read", "controller-main");
		const childId = await manager.save("child", "read", "controller-child");
		const localProtocolOptions = {
			getArtifactsDir: () => root,
			// Structured children inherit the parent's options object; the active
			// view session ID must override this callback during link resolution.
			getSessionId: () => "controller-main",
			artifactResolutionScope: "producer" as const,
		};
		const session = {
			sessionManager: {
				getCwd: () => root,
				getSessionId: () => "controller-child",
			},
			sessionFile: undefined,
			settings: undefined,
			localProtocolOptions,
			skills: [],
			ttsrManager: undefined,
		};
		const ctx = {
			viewSession: session,
			resolveAssistantMessageLinks: InteractiveMode.prototype.resolveAssistantMessageLinks,
		} as unknown as InteractiveModeContext;
		const ownHref = `artifact://${childId}`;
		const parentHref = `artifact://${parentId}`;
		const targets = await refreshAssistantMessageLinkTargets(ctx, [
			{
				role: "assistant",
				content: [{ type: "text", text: `[own](${ownHref}) [parent](${parentHref})` }],
				api: "anthropic-messages",
				provider: "test",
				model: "test",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			},
		]);

		expect(targets.get(ownHref)).toBe(Bun.pathToFileURL(path.join(root, `${childId}.read.log`)).href);
		expect(targets.has(parentHref)).toBe(false);
	});
});
