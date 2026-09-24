import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { AsyncJobManager } from "../../src/async/job-manager";
import type { ToolSession } from "../../src/tools";
import { VibeListTool } from "../../src/tools/vibe";
import { VibeSessionRegistry } from "../../src/vibe/runtime";

const OWNER = "test-owner";

let manager: AsyncJobManager;
let session: ToolSession;

beforeEach(() => {
	manager = new AsyncJobManager({});
	session = {
		getAgentId: () => OWNER,
		getSessionId: () => "test-parent-session",
		getSessionFile: () => null,
		asyncJobManager: manager,
	} as unknown as ToolSession;
	const registry = VibeSessionRegistry.global();
	registry.registerRecordForTests({ id: "Killed1", ownerId: OWNER, state: "dead" });
	registry.registerRecordForTests({ id: "Live", ownerId: OWNER, state: "idle" });
	registry.registerRecordForTests({ id: "Killed2", ownerId: OWNER, state: "dead" });
});

afterEach(async () => {
	await manager.dispose({ timeoutMs: 100 });
	VibeSessionRegistry.resetGlobalForTests();
});

describe("vibe wall hides dead sessions", () => {
	it("vibe_list shows live sessions and collapses dead ones to a trailing id line", async () => {
		const result = await new VibeListTool(session).execute();
		const text = result.content.map(part => ("text" in part ? part.text : "")).join("\n");

		expect(result.details?.screens.map(screen => screen.id)).toEqual(["Live"]);
		expect(result.details?.hiddenDead).toEqual(["Killed1", "Killed2"]);
		expect(text).toContain("- `Live` [fast] idle");
		expect(text).not.toContain("- `Killed1`");
		expect(text).toContain("Dead (2, transcripts at history://<id>): `Killed1`, `Killed2`");
	});

	it("vibe_list with only dead sessions says so instead of offering a first spawn", async () => {
		VibeSessionRegistry.resetGlobalForTests();
		VibeSessionRegistry.global().registerRecordForTests({ id: "Killed1", ownerId: OWNER, state: "dead" });

		const result = await new VibeListTool(session).execute();
		const text = result.content.map(part => ("text" in part ? part.text : "")).join("\n");

		expect(result.details?.screens).toEqual([]);
		expect(text).toStartWith("No live vibe sessions.");
	});
});
