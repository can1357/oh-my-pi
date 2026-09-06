import { describe, expect, it, vi } from "bun:test";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import {
	ACP_BUILTIN_SLASH_COMMANDS,
	executeAcpBuiltinSlashCommand,
} from "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import type { SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";

function acpRuntime() {
	const pruneEmptyBranches = vi.fn(async () => 5);
	const archiveEmptyBranches = vi.fn(async () => ({ branches: 2, entries: 5 }));
	const restoreArchived = vi.fn(async () => 2);
	const getArchivedRootIds = vi.fn(() => ["abc123"]);
	const output = vi.fn();
	const runtime = {
		session: { pruneEmptyBranches, archiveEmptyBranches, restoreArchived, getArchivedRootIds },
		output,
	} as unknown as SlashCommandRuntime;
	return { pruneEmptyBranches, archiveEmptyBranches, restoreArchived, getArchivedRootIds, output, runtime };
}

function tuiRuntime() {
	const handlePruneCommand = vi.fn(async () => {});
	const setText = vi.fn();
	const runtime = {
		ctx: {
			editor: { setText } as unknown as InteractiveModeContext["editor"],
			handlePruneCommand,
		} as unknown as InteractiveModeContext,
	};
	return { handlePruneCommand, setText, runtime };
}

describe("/prune dispatch (ACP)", () => {
	it("archives rather than deletes by default", async () => {
		const h = acpRuntime();
		await executeAcpBuiltinSlashCommand("/prune", h.runtime);
		expect(h.archiveEmptyBranches).toHaveBeenCalled();
		expect(h.pruneEmptyBranches).not.toHaveBeenCalled();
		const said = h.output.mock.calls[0]?.[0] as string;
		expect(said).toContain("Archived 2 empty branches");
		expect(said).toContain("nothing deleted");
	});

	it("deletes only when asked to", async () => {
		const h = acpRuntime();
		await executeAcpBuiltinSlashCommand("/prune delete", h.runtime);
		expect(h.pruneEmptyBranches).toHaveBeenCalled();
		expect(h.archiveEmptyBranches).not.toHaveBeenCalled();
		expect(h.output.mock.calls[0]?.[0] as string).toContain("Deleted 5 empty branch entries.");
	});

	it("points at /unarchive for getting a branch back", async () => {
		const h = acpRuntime();
		await executeAcpBuiltinSlashCommand("/prune", h.runtime);
		expect(h.output.mock.calls[0]?.[0] as string).toContain("/unarchive");
	});

	it("no longer restores or lists — that moved to /unarchive", async () => {
		const h = acpRuntime();
		await executeAcpBuiltinSlashCommand("/prune restore", h.runtime);
		expect(h.restoreArchived).not.toHaveBeenCalled();
		expect(h.output.mock.calls[0]?.[0] as string).toContain("Unknown /prune mode");
	});

	it("rejects an unknown mode without touching the session", async () => {
		const h = acpRuntime();
		await executeAcpBuiltinSlashCommand("/prune nonsense", h.runtime);
		expect(h.pruneEmptyBranches).not.toHaveBeenCalled();
		expect(h.archiveEmptyBranches).not.toHaveBeenCalled();
		expect(h.output.mock.calls[0]?.[0] as string).toContain("Unknown /prune mode");
	});

	it("is advertised to ACP clients", () => {
		const advertised = ACP_BUILTIN_SLASH_COMMANDS.find(c => c.name === "prune");
		expect(advertised).toBeDefined();
		expect(advertised?.description).toContain("Hide empty conversation branches");
	});
});

describe("/unarchive dispatch (ACP)", () => {
	it("restores every archived branch by default", async () => {
		const h = acpRuntime();
		await executeAcpBuiltinSlashCommand("/unarchive", h.runtime);
		expect(h.restoreArchived).toHaveBeenCalledWith();
		expect(h.output.mock.calls[0]?.[0] as string).toContain("Restored 2 archived branches.");
	});

	it("restores one branch by id", async () => {
		const h = acpRuntime();
		await executeAcpBuiltinSlashCommand("/unarchive abc123", h.runtime);
		expect(h.restoreArchived).toHaveBeenCalledWith("abc123");
		expect(h.output.mock.calls[0]?.[0] as string).toContain("Restored branch abc123.");
	});

	it("lists what is hidden without restoring it", async () => {
		const h = acpRuntime();
		await executeAcpBuiltinSlashCommand("/unarchive list", h.runtime);
		expect(h.restoreArchived).not.toHaveBeenCalled();
		expect(h.output.mock.calls[0]?.[0] as string).toContain("abc123");
	});

	it("reports an id that is not archived instead of claiming success", async () => {
		const h = acpRuntime();
		h.restoreArchived.mockImplementation(async () => 0);
		await executeAcpBuiltinSlashCommand("/unarchive nope", h.runtime);
		expect(h.output.mock.calls[0]?.[0] as string).toContain("No archived branch nope");
	});

	it("is advertised to ACP clients", () => {
		const advertised = ACP_BUILTIN_SLASH_COMMANDS.find(c => c.name === "unarchive");
		expect(advertised?.description).toContain("Restore archived conversation branches");
	});
});

describe("/prune dispatch (TUI)", () => {
	it("routes to handlePruneCommand and clears the editor", async () => {
		const h = tuiRuntime();
		const handled = await executeBuiltinSlashCommand("/prune", h.runtime);
		expect(handled).toBe(true);
		expect(h.setText).toHaveBeenCalledWith("");
		expect(h.handlePruneCommand).toHaveBeenCalledWith("archive");
	});

	it("forwards the requested mode", async () => {
		const h = tuiRuntime();
		await executeBuiltinSlashCommand("/prune delete", h.runtime);
		expect(h.handlePruneCommand).toHaveBeenCalledWith("delete");
	});
});
