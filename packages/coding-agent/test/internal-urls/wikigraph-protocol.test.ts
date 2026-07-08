import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, setAgentDir } from "@pk-nerdsaver-ai/pi-utils/dirs";
import { InternalUrlRouter } from "../../src/internal-urls/router";
import { WikigraphProtocolHandler } from "../../src/internal-urls/wikigraph-protocol";
import { closeWikigraphDb } from "../../src/wikigraph/db";
import { refreshWikigraphIndex } from "../../src/wikigraph/refresh";

let previousAgentDir: string;
let cleanupRoot: string;

beforeEach(async () => {
	previousAgentDir = getAgentDir();
	cleanupRoot = await fs.mkdtemp(path.join(os.tmpdir(), "wikigraph-protocol-"));
	setAgentDir(path.join(cleanupRoot, "agent"));
	closeWikigraphDb();
	InternalUrlRouter.resetForTests();
	InternalUrlRouter.instance().register(new WikigraphProtocolHandler());
});

afterEach(async () => {
	closeWikigraphDb();
	InternalUrlRouter.resetForTests();
	setAgentDir(previousAgentDir);
	await fs.rm(cleanupRoot, { recursive: true, force: true });
});

describe("wikigraph:// protocol", () => {
	it("returns bounded search cards and unknown-node errors", async () => {
		const root = path.join(cleanupRoot, "wiki");
		await fs.mkdir(root, { recursive: true });
		await fs.writeFile(path.join(root, "old.md"), "# Old\n\nOld install procedure.");
		await fs.writeFile(
			path.join(root, "install.md"),
			"# Install\n\nInstall procedure summary.\n\n## Steps\nRun installer.",
		);
		await refreshWikigraphIndex([root]);
		const search = await InternalUrlRouter.instance().resolve("wikigraph://?q=install");
		expect(search.contentType).toBe("text/markdown");
		expect(search.content.length).toBeLessThanOrEqual(1200);
		expect(search.content).toContain("Install");
		await expect(InternalUrlRouter.instance().resolve("wikigraph://node/bad-id")).rejects.toThrow(
			/Unknown wiki node/,
		);
	});

	it("returns node card with grouped edges and expanded slices", async () => {
		const root = path.join(cleanupRoot, "wiki");
		await fs.mkdir(root, { recursive: true });
		await fs.writeFile(path.join(root, "old.md"), "# Old\n\nOld install procedure.");
		await fs.writeFile(
			path.join(root, "install.md"),
			"# Install\n\nInstall procedure summary.\n\n## Steps\nRun installer.\n[Old](old.md)",
		);
		await refreshWikigraphIndex([root]);
		const search = await InternalUrlRouter.instance().resolve("wikigraph://?q=Install");
		const id = search.content.match(/\(([a-f0-9]{12})\)/)?.[1];
		expect(id).toBeTruthy();
		const fullId = (await InternalUrlRouter.instance().complete("wikigraph", "Install"))?.[0]?.value.replace(
			"node/",
			"",
		);
		expect(fullId?.startsWith(id!)).toBe(true);
		const card = await InternalUrlRouter.instance().resolve(`wikigraph://node/${fullId}`);
		expect(card.content).toContain("edges:");
		expect(card.content).toContain("links_to:");
		const expanded = await InternalUrlRouter.instance().resolve(`wikigraph://node/${fullId}?expand=1`);
		expect(expanded.content).toContain("```markdown");
		expect(expanded.notes?.some(note => note.startsWith("expanded:"))).toBe(true);
	});
});
