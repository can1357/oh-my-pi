import { describe, expect, test } from "bun:test";
import { Settings } from "../../src/config/settings";
import { EditTool, resolveEditToolSurface } from "../../src/edit";
import type { ToolSession } from "../../src/tools";
import { ReadTool, resolveReadToolSurface } from "../../src/tools/read";
import { resolveToolProfile } from "../../src/tools/tool-profiles";

function createSession(): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		settings: Settings.isolated({}),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		hasEditTool: true,
	} as unknown as ToolSession;
}

describe("tool-profile grammar selectors", () => {
	test("light/mid/frontier receive enforced read schemas and descriptions", () => {
		const light = resolveToolProfile({ tier: "light", autonomy: "bound" });
		const mid = resolveToolProfile({ tier: "mid", autonomy: "supervised", editMode: "replace" });
		const frontier = resolveToolProfile({
			tier: "frontier",
			autonomy: "independent",
			editMode: "apply-patch",
		});

		const lightSurface = resolveReadToolSurface(light);
		const midSurface = resolveReadToolSurface(mid);
		const frontierSurface = resolveReadToolSurface(frontier);
		const legacySurface = resolveReadToolSurface(undefined);

		expect(lightSurface.grammar.tier).toBe("light");
		expect(lightSurface.pathDescription).toContain("Local workspace path only");
		expect(midSurface.grammar.tier).toBe("standard");
		expect(frontierSurface.grammar.tier).toBe("standard");
		expect(legacySurface.grammar.tier).toBe("legacy");

		const lightRead = new ReadTool(createSession(), light);
		const midRead = new ReadTool(createSession(), mid);
		expect(lightRead.grammar.tier).toBe("light");
		expect(lightRead.description).toContain("Light grammar only");
		expect(midRead.grammar.tier).toBe("standard");
		expect(lightRead.parameters).not.toBe(midRead.parameters);
	});

	test("edit grammar selects replace for mid and apply_patch/hashline for frontier", () => {
		const mid = resolveToolProfile({ tier: "mid", autonomy: "supervised", editMode: "hashline" });
		const frontierHash = resolveToolProfile({
			tier: "frontier",
			autonomy: "independent",
			editMode: "hashline",
		});
		const frontierPatch = resolveToolProfile({
			tier: "frontier",
			autonomy: "independent",
			editMode: "apply-patch",
		});
		const light = resolveToolProfile({ tier: "light", autonomy: "bound", editMode: "replace" });

		expect(resolveEditToolSurface(mid).runtimeMode).toBe("replace");
		expect(resolveEditToolSurface(frontierHash).runtimeMode).toBe("hashline");
		expect(resolveEditToolSurface(frontierPatch).runtimeMode).toBe("apply_patch");
		expect(resolveEditToolSurface(light).descriptionKind).toBe("none");

		const midEdit = new EditTool(createSession(), mid);
		const frontierEdit = new EditTool(createSession(), frontierPatch);
		expect(midEdit.mode).toBe("replace");
		expect(frontierEdit.mode).toBe("apply_patch");
		expect(midEdit.description.toLowerCase()).toContain("replace");
		expect(frontierEdit.description.toLowerCase()).toContain("patch");
	});

	test("legacy edit/read construction without profile preserves prior behavior", () => {
		const session = createSession();
		const read = new ReadTool(session);
		const edit = new EditTool(session);
		expect(read.grammar.tier).toBe("legacy");
		expect(edit.grammar.descriptionKind).toBe("hashline");
	});
});
