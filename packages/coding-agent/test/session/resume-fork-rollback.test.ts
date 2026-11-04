import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

class ForeignTargetStorage extends FileSessionStorage {
	contestedId = "";
	override claimSession(id: string, file: string): (() => void) | null {
		return id === this.contestedId ? null : super.claimSession(id, file);
	}
}

async function fixture(missingModel = false, allowFallback = false) {
	const temp = TempDir.createSync("@resume-fork-rollback-");
	const sourceDir = temp.join("source");
	const targetDir = temp.join("target");
	await fs.mkdir(sourceDir);
	await fs.mkdir(targetDir);
	const target = SessionManager.create(targetDir, targetDir, new FileSessionStorage());
	target.appendMessage({ role: "user", content: "target artifact://0 agent://Child", timestamp: 0 });
	if (missingModel) target.appendModelChange("nonexistent-provider/nonexistent-model");
	await target.ensureOnDisk();
	const targetFile = target.getSessionFile();
	const artifacts = target.getArtifactsDir();
	if (!targetFile || !artifacts) throw new Error("Expected a file-backed target");
	await Bun.write(path.join(artifacts, "0.bash.log"), "inherited artifact");
	const storage = new ForeignTargetStorage();
	storage.contestedId = target.getSessionId();
	await target.close();
	const auth = await AuthStorage.create(":memory:");
	auth.keys.setRuntime("anthropic", "test-key");
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected bundled model");
	const manager = SessionManager.create(sourceDir, sourceDir, storage);
	const session = new AgentSession({
		agent: new Agent({ initialState: { model, systemPrompt: ["test"], tools: [] } }),
		sessionManager: manager,
		modelRegistry: new ModelRegistry(auth, temp.join("models.yml")),
		settings: Settings.isolated({ "compaction.enabled": false, "todo.enabled": false, "retry.modelFallback": true }),
		allowSessionModelFallback: allowFallback,
		memoryEnabled: false,
	});
	await manager.ensureOnDisk();
	await manager.flush();
	const sourceFile = manager.getSessionFile();
	const before = (await fs.readdir(targetDir)).sort();
	return {
		session,
		manager,
		sourceFile,
		targetFile,
		targetDir,
		before,
		artifacts,
		async [Symbol.asyncDispose]() {
			await session.dispose();
			auth.close();
			await temp.remove();
		},
	};
}

for (const failure of ["cwd rejected", "model restore failed", "host callback threw"] as const) {
	test(`a contested resume leaves no fork files or artifact directories when ${failure}`, async () => {
		await using f = await fixture(failure !== "cwd rejected", failure === "host callback threw");
		if (failure === "cwd rejected") {
			expect(await f.session.switchSession(f.targetFile, { onCwdChange: async () => false })).toBe(false);
		} else if (failure === "model restore failed") {
			await expect(
				f.session.switchSession(f.targetFile, {
					onCwdChange: async () => true,
				}),
			).rejects.toThrow("Could not restore model nonexistent-provider/nonexistent-model");
		} else {
			await expect(
				f.session.switchSession(f.targetFile, {
					onCwdChange: async () => true,
					onModelFallback: () => {
						throw new Error("host callback failed");
					},
				}),
			).rejects.toThrow("host callback failed");
		}
		expect(f.manager.getSessionFile()).toBe(f.sourceFile);
		expect((await fs.readdir(f.targetDir)).sort()).toEqual(f.before);
		expect(await Bun.file(path.join(f.artifacts, "0.bash.log")).text()).toBe("inherited artifact");
	}, 60_000);
}

test("a committed contested resume publishes its fork and inherited artifacts", async () => {
	await using f = await fixture();
	expect(
		await f.session.switchSession(f.targetFile, {
			onCwdChange: async () => {
				await f.manager.whenArtifactsSettled();
				const inherited = f.manager.getArtifactsDir();
				if (!inherited) throw new Error("Expected fork artifacts before the switch commits");
				expect(await Bun.file(path.join(inherited, "0.bash.log")).text()).toBe("inherited artifact");
				return true;
			},
		}),
	).toBe(true);
	const fork = f.manager.getSessionFile();
	const artifacts = f.manager.getArtifactsDir();
	if (!fork || !artifacts) throw new Error("Expected a committed fork");
	expect(fork).not.toBe(f.targetFile);
	await f.manager.flush();
	expect(await Bun.file(fork).exists()).toBe(true);
	expect(await Bun.file(path.join(artifacts, "0.bash.log")).text()).toBe("inherited artifact");
}, 60_000);

test("rolling back a fork leaves a replacement journal and artifacts alone", async () => {
	await using f = await fixture();
	let foreignFile: string | undefined;
	let foreignArtifacts: string | null = null;
	expect(
		await f.session.switchSession(f.targetFile, {
			onCwdChange: async () => {
				foreignFile = f.manager.getSessionFile();
				foreignArtifacts = f.manager.getArtifactsDir();
				if (!foreignFile || !foreignArtifacts) throw new Error("Expected proposed fork paths");
				await Bun.write(foreignFile, "foreign transcript");
				await Bun.write(path.join(foreignArtifacts, "foreign.txt"), "foreign artifact");
				return false;
			},
		}),
	).toBe(false);
	if (!foreignFile || !foreignArtifacts) throw new Error("Expected the host to place its objects");
	expect(await Bun.file(foreignFile).text()).toBe("foreign transcript");
	expect(await Bun.file(path.join(foreignArtifacts, "foreign.txt")).text()).toBe("foreign artifact");
}, 60_000);

test("a switch callback can await inherited artifacts before refusing the resume", async () => {
	await using f = await fixture();
	expect(
		await f.session.switchSession(f.targetFile, {
			onCwdChange: async () => {
				await f.manager.whenArtifactsSettled();
				const inherited = f.manager.getArtifactsDir();
				if (!inherited) throw new Error("Expected fork artifacts");
				expect(await Bun.file(path.join(inherited, "0.bash.log")).text()).toBe("inherited artifact");
				return false;
			},
		}),
	).toBe(false);
	expect(f.manager.getSessionFile()).toBe(f.sourceFile);
	expect((await fs.readdir(f.targetDir)).sort()).toEqual(f.before);
}, 60_000);

test("rollback keeps a replacement artifacts directory even when its fork journal is still ours", async () => {
	await using f = await fixture();
	let fork: string | undefined;
	let replacement: string | null = null;
	expect(
		await f.session.switchSession(f.targetFile, {
			onCwdChange: async () => {
				await f.manager.whenArtifactsSettled();
				fork = f.manager.getSessionFile();
				replacement = f.manager.getArtifactsDir();
				if (!fork || !replacement) throw new Error("Expected fork paths");
				await fs.rename(replacement, `${replacement}-kept`);
				await Bun.write(path.join(replacement, "foreign.txt"), "foreign artifact");
				return false;
			},
		}),
	).toBe(false);
	if (!fork || !replacement) throw new Error("Expected replacement paths");
	expect(await Bun.file(fork).exists()).toBe(false);
	expect(await Bun.file(path.join(replacement, "foreign.txt")).text()).toBe("foreign artifact");
}, 60_000);
