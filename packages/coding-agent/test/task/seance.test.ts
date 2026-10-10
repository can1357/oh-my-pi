import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { CURRENT_SESSION_VERSION } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { resolveSeanceSource } from "@oh-my-pi/pi-coding-agent/task/seance";
import { TempDir } from "@oh-my-pi/pi-utils";

function sessionHeader(id: string, cwd: string) {
	return {
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id,
		timestamp: "2026-10-01T00:00:00.000Z",
		cwd,
	};
}

function modelChange(id: string, parentId: string | null, model: string, role: string) {
	return {
		type: "model_change",
		id,
		parentId,
		timestamp: "2026-10-01T00:00:01.000Z",
		model,
		role,
	};
}

async function writeSession(file: string, id: string, cwd: string, entries: unknown[] = []): Promise<void> {
	await fs.mkdir(path.dirname(file), { recursive: true });
	await Bun.write(file, `${[sessionHeader(id, cwd), ...entries].map(entry => JSON.stringify(entry)).join("\n")}\n`);
}

describe("seance source resolution", () => {
	it("resolves paths and stored IDs to read-only source metadata with the active model and default fallback", async () => {
		using tempDir = TempDir.createSync("@omp-seance-source-");
		const cwd = path.join(tempDir.path(), "project");
		const sessionDir = path.join(tempDir.path(), "sessions");
		const file = path.join(sessionDir, "saved.jsonl");
		await writeSession(file, "saved-source-id", cwd, [
			modelChange("default-model", null, "anthropic/claude-sonnet-4-5", "default"),
			modelChange("active-model", "default-model", "anthropic/claude-sonnet-4-6", "fast"),
		]);
		const original = await fs.readFile(file);
		const options = { cwd, sessionDirHint: sessionDir };

		await expect(resolveSeanceSource(file, options)).resolves.toEqual({
			file,
			id: "saved-source-id",
			modelSelectors: ["anthropic/claude-sonnet-4-6", "anthropic/claude-sonnet-4-5"],
		});
		await expect(resolveSeanceSource("saved-source-id", options)).resolves.toEqual({
			file,
			id: "saved-source-id",
			modelSelectors: ["anthropic/claude-sonnet-4-6", "anthropic/claude-sonnet-4-5"],
		});
		expect(await fs.readFile(file)).toEqual(original);
	});

	it("fails closed for missing paths and IDs, ambiguous prefixes, and files without a session header", async () => {
		using tempDir = TempDir.createSync("@omp-seance-source-invalid-");
		const cwd = path.join(tempDir.path(), "project");
		const sessionDir = path.join(tempDir.path(), "sessions");
		const options = { cwd, sessionDirHint: sessionDir };
		await writeSession(path.join(sessionDir, "first.jsonl"), "ambiguous-first", cwd);
		await writeSession(path.join(sessionDir, "second.jsonl"), "ambiguous-second", cwd);
		const malformedFile = path.join(sessionDir, "malformed.jsonl");
		await Bun.write(malformedFile, `${JSON.stringify({ type: "session", version: CURRENT_SESSION_VERSION })}\n`);

		await expect(resolveSeanceSource(path.join(sessionDir, "missing.jsonl"), options)).rejects.toThrow(
			"The selected session file was not found or could not be accessed.",
		);
		await expect(resolveSeanceSource("not-present", options)).rejects.toThrow('Session "not-present" was not found.');
		await expect(resolveSeanceSource("ambiguous", options)).rejects.toThrow(
			'Session selector "ambiguous" is ambiguous.',
		);
		await expect(resolveSeanceSource(malformedFile, options)).rejects.toThrow(
			"The selected file does not contain a valid session header.",
		);
	});
});
