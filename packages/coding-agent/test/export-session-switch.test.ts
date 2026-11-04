import { afterEach, expect, mock, spyOn, test } from "bun:test";
import * as path from "node:path";
import * as utils from "@oh-my-pi/pi-utils";
import { exportSessionToHtml, type SessionData } from "../src/export/html";
import { copySessionArtifacts, SessionManager } from "../src/session/session-manager";

afterEach(() => mock.restore());

function child(id: string): string {
	return `${JSON.stringify({ type: "session", version: 3, id, timestamp: new Date(0).toISOString(), cwd: "/tmp" })}\n${JSON.stringify(
		{
			type: "message",
			id: `${id}-entry`,
			parentId: null,
			timestamp: new Date(1).toISOString(),
			message: { role: "user", content: id, timestamp: 1 },
		},
	)}\n`;
}

for (const pendingNewCopy of [false, true]) {
	test(`export after a switch keeps the header and children together${pendingNewCopy ? " and waits for the new session's copy" : ""}`, async () => {
		const temp = utils.TempDir.createSync("@export-session-switch-");
		// Exercise the product's release-viewer branch without generating checkout assets.
		const bundled = spyOn(utils, "isCompiledBinary").mockReturnValue(true);
		const make = async (label: string) => {
			const manager = SessionManager.create(temp.path(), temp.join(label));
			manager.appendMessage({ role: "user", content: label, timestamp: 0 });
			await manager.ensureOnDisk();
			await manager.flush();
			return manager;
		};
		const a = await make("a");
		const b = await make("b");
		const source = await make("source");
		const sourceB = await make("source-b");
		const aFile = a.getSessionFile();
		const bFile = b.getSessionFile();
		const sourceFile = source.getSessionFile();
		const sourceBFile = sourceB.getSessionFile();
		const sourceArtifacts = source.getArtifactsDir();
		const newArtifacts = pendingNewCopy ? sourceB.getArtifactsDir() : b.getArtifactsDir();
		if (!aFile || !bFile || !sourceFile || !sourceBFile || !sourceArtifacts || !newArtifacts) {
			throw new Error("Expected file-backed session trees");
		}
		const bId = b.getSessionId();
		await Bun.write(path.join(sourceArtifacts, "OldChild.jsonl"), child("old-child"));
		await Bun.write(path.join(newArtifacts, "NewChild.jsonl"), child("new-child"));
		await source.close();
		await sourceB.close();
		await b.close();
		const copyingA = Promise.withResolvers<void>();
		const releaseA = Promise.withResolvers<void>();
		const copyingB = Promise.withResolvers<void>();
		const releaseB = Promise.withResolvers<void>();
		const copyA = copySessionArtifacts(sourceFile, aFile, {
			onSettled: async () => {
				copyingA.resolve();
				await releaseA.promise;
			},
		});
		const copyB = pendingNewCopy
			? copySessionArtifacts(sourceBFile, bFile, {
					onSettled: async () => {
						copyingB.resolve();
						await releaseB.promise;
					},
				})
			: undefined;
		let exporting: Promise<string> | undefined;
		const waitingB = Promise.withResolvers<void>();
		const settle = a.whenArtifactsSettled.bind(a);
		const observe = spyOn(a, "whenArtifactsSettled").mockImplementation(signal => {
			if (a.getSessionFile() === bFile) waitingB.resolve();
			return settle(signal);
		});
		try {
			await copyingA.promise;
			if (copyB) await copyingB.promise;
			let finished = false;
			exporting = exportSessionToHtml(a, undefined, { outputPath: temp.join("export.html") }).finally(() => {
				finished = true;
			});
			await Promise.resolve();
			expect(finished).toBe(false);
			await a.setSessionFile(bFile);
			releaseA.resolve();
			await copyA;
			if (copyB) {
				await Promise.race([waitingB.promise, exporting]);
				expect(finished).toBe(false);
				releaseB.resolve();
				await copyB;
			}
			const html = await Bun.file(await exporting).text();
			const encoded = html.match(/<script id="session-data" type="application\/json">([^<]+)<\/script>/)?.[1];
			if (!encoded) throw new Error("Expected embedded session data");
			const data = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as SessionData;
			expect(data.header?.id).toBe(bId);
			expect(Object.keys(data.subSessions ?? {})).toEqual(["NewChild"]);
		} finally {
			releaseA.resolve();
			releaseB.resolve();
			await copyA;
			await copyB;
			await exporting?.catch(() => undefined);
			observe.mockRestore();
			bundled.mockRestore();
			await a.close();
			await temp.remove();
		}
	}, 60_000);
}
