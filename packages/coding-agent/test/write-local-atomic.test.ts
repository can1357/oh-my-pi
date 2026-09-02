import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { computeFileHash } from "@oh-my-pi/hashline";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { canonicalSnapshotKey, getFileSnapshotStore } from "@oh-my-pi/pi-coding-agent/edit/file-snapshot-store";
import * as localProtocol from "@oh-my-pi/pi-coding-agent/internal-urls";
import type { ClientBridge } from "@oh-my-pi/pi-coding-agent/session/client-bridge";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import * as fsCache from "@oh-my-pi/pi-coding-agent/tools/fs-cache-invalidation";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";
import { logger, removeWithRetries } from "@oh-my-pi/pi-utils";

interface SessionLocalOptions {
	getArtifactsDir: () => string | null;
	getSessionId: () => string | null;
}

interface SessionOptions {
	bridge?: ClientBridge;
	bumpFileMutationVersion?: NonNullable<ToolSession["bumpFileMutationVersion"]>;
}
function displayPath(cwd: string, target: string): string {
	return path.relative(cwd, target).split(path.sep).join("/");
}

function createSession(
	cwd: string,
	localProtocolOptions: SessionLocalOptions,
	options: SessionOptions = {},
): ToolSession {
	return {
		cwd,
		hasUI: false,
		enableLsp: false,
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getSessionSpawns: () => "*",
		getArtifactsDir: localProtocolOptions.getArtifactsDir,
		getSessionId: localProtocolOptions.getSessionId,
		localProtocolOptions,
		allocateOutputArtifact: async () => ({ id: "artifact-1", path: path.join(cwd, "artifact-1.log") }),
		settings: Settings.isolated(),
		getClientBridge: options.bridge ? () => options.bridge : undefined,
		bumpFileMutationVersion: options.bumpFileMutationVersion,
	};
}

describe("write tool atomic local routing", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "write-local-atomic-test-"));
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await removeWithRetries(tmpDir);
	});

	it("routes a selected whole local file through the native adapter with caller-owned state", async () => {
		const localUrl = "local://nested/trace.sh";
		const requestedPath = `${localUrl}:raw`;
		const artifactsDir = path.join(tmpDir, "caller-artifacts");
		const localOptions: SessionLocalOptions = {
			getArtifactsDir: () => artifactsDir,
			getSessionId: () => "caller-session",
		};
		const absolutePath = localProtocol.resolveLocalUrlToPath(localUrl, localOptions);
		const expectedDisplayPath = displayPath(tmpDir, absolutePath);
		const content = "#!/bin/sh\nprintf 'π\\n'\n";
		const mutationPaths: string[] = [];
		const bridge: ClientBridge = {
			capabilities: { writeTextFile: true },
			writeTextFile: async () => {
				throw new Error("local:// must not reach ACP");
			},
		};
		const bridgeSpy = vi.spyOn(bridge, "writeTextFile");
		const session = createSession(tmpDir, localOptions, {
			bridge,
			bumpFileMutationVersion: targetPath => {
				mutationPaths.push(targetPath);
				return mutationPaths.length;
			},
		});
		const atomicWriteSpy = vi
			.spyOn(localProtocol, "writeLocalUrlAtomically")
			.mockImplementation(async (input, writtenContent, options, signal) => {
				expect(input).toBe(localUrl);
				expect(writtenContent).toBe(content);
				expect(options).toBe(localOptions);
				expect(signal).toBeUndefined();
				return {
					absolutePath,
					bytesWritten: Buffer.byteLength(content),
					madeExecutable: true,
					commitState: "COMMITTED",
				};
			});
		const invalidateSpy = vi.spyOn(fsCache, "invalidateFsScanAfterWrite").mockImplementation(() => {});
		const genericWriteSpy = vi.spyOn(Bun, "write");
		const updates: AgentToolResult[] = [];
		const tool = new WriteTool(session);

		expect(tool.approval({ path: requestedPath, content })).toBe("read");
		const result = await tool.execute("atomic-local", { path: requestedPath, content }, undefined, update => {
			updates.push(update);
		});
		const text = result.content
			.filter(
				(block): block is { type: "text"; text: string } => block.type === "text" && typeof block.text === "string",
			)
			.map(block => block.text)
			.join("\n");
		const hash = computeFileHash(content);

		expect(atomicWriteSpy).toHaveBeenCalledTimes(1);
		expect(genericWriteSpy).not.toHaveBeenCalled();
		expect(bridgeSpy).not.toHaveBeenCalled();
		expect(invalidateSpy).toHaveBeenCalledWith(absolutePath);
		expect(mutationPaths).toEqual([absolutePath]);
		expect(updates).toEqual([
			{
				content: [{ type: "text", text: `Writing ${content.length} bytes to ${expectedDisplayPath}...` }],
				details: { resolvedPath: absolutePath },
			},
		]);
		expect(result.isError).toBeUndefined();
		expect(result.details?.resolvedPath).toBe(absolutePath);
		expect(result.details?.madeExecutable).toBe(true);
		expect(text).toContain(`[${expectedDisplayPath}#${hash}]`);
		expect(text).toContain(`Successfully wrote ${content.length} bytes to ${expectedDisplayPath}`);
		expect(text).toContain("[Notice: Made executable via chmod +x]");
		expect(getFileSnapshotStore(session).byHash(canonicalSnapshotKey(absolutePath), hash)?.text).toBe(content);
	});

	it("keeps a COMMITTED local write successful when cancellation and bookkeeping failure arrive afterward", async () => {
		const localUrl = "local://committed.txt";
		const artifactsDir = path.join(tmpDir, "artifacts");
		const localOptions: SessionLocalOptions = {
			getArtifactsDir: () => artifactsDir,
			getSessionId: () => "session-a",
		};
		const absolutePath = localProtocol.resolveLocalUrlToPath(localUrl, localOptions);
		const content = "committed content\n";
		const controller = new AbortController();
		const session = createSession(tmpDir, localOptions, {
			bumpFileMutationVersion: () => {
				throw new Error("mutation ledger unavailable");
			},
		});
		const atomicWriteSpy = vi
			.spyOn(localProtocol, "writeLocalUrlAtomically")
			.mockImplementation(async (_input, _content, _options, signal) => {
				expect(signal).toBe(controller.signal);
				controller.abort(new Error("cancelled after native commit"));
				return {
					absolutePath,
					bytesWritten: Buffer.byteLength(content),
					madeExecutable: false,
					commitState: "COMMITTED",
				};
			});
		vi.spyOn(fsCache, "invalidateFsScanAfterWrite").mockImplementation(() => {});
		vi.spyOn(logger, "warn").mockImplementation(() => {});

		const result = await new WriteTool(session).execute(
			"atomic-committed",
			{ path: localUrl, content },
			controller.signal,
		);
		const text = result.content
			.filter(
				(block): block is { type: "text"; text: string } => block.type === "text" && typeof block.text === "string",
			)
			.map(block => block.text)
			.join("\n");
		const hash = computeFileHash(content);

		expect(controller.signal.aborted).toBe(true);
		expect(atomicWriteSpy).toHaveBeenCalledTimes(1);
		expect(result.isError).toBeUndefined();
		expect(result.details?.resolvedPath).toBe(absolutePath);
		expect(text).toContain(`Successfully wrote ${content.length} bytes to ${displayPath(tmpDir, absolutePath)}`);
		expect(text).toContain("Warning: write committed but mutation-version update failed.");
		expect(getFileSnapshotStore(session).byHash(canonicalSnapshotKey(absolutePath), hash)?.text).toBe(content);
	});
});
