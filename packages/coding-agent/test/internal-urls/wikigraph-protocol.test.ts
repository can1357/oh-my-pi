import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, setAgentDir } from "@pk-nerdsaver-ai/pi-utils/dirs";
import { Settings } from "../../src/config/settings";
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

	it("allows wikigraph path reads only from cwd and configured wiki roots", async () => {
		const project = path.join(cleanupRoot, "project");
		const wikiRoot = path.join(project, ".ompk", "wiki");
		const configuredRoot = path.join(cleanupRoot, "configured-wiki");
		await fs.mkdir(wikiRoot, { recursive: true });
		await fs.mkdir(configuredRoot, { recursive: true });
		await fs.writeFile(path.join(wikiRoot, "allowed.md"), "# Allowed\n\nAllowed wiki body.");
		await fs.writeFile(path.join(configuredRoot, "configured.md"), "# Configured\n\nConfigured wiki body.");
		await fs.writeFile(path.join(project, "session.md"), "# Session\n\nSession body.");
		await fs.writeFile(path.join(cleanupRoot, "secret.md"), "secret body");
		const settings = Settings.isolated({ "wikigraph.roots": [configuredRoot, "<cwd>/.ompk/wiki"] });

		const router = InternalUrlRouter.instance();
		const allowedWiki = await router.resolve("wikigraph://path/.ompk/wiki/allowed.md#L1-L2", {
			cwd: project,
			settings,
		});
		expect(allowedWiki.content).toContain("# Allowed");
		const allowedConfigured = await router.resolve(
			`wikigraph://path/${encodeURIComponent(path.join(configuredRoot, "configured.md"))}#L1-L1`,
			{ cwd: project, settings },
		);
		expect(allowedConfigured.content).toBe("# Configured");
		const allowedCwd = await router.resolve("wikigraph://path/session.md#L1-L1", { cwd: project, settings });
		expect(allowedCwd.content).toBe("# Session");

		await expect(router.resolve("wikigraph://path/../secret.md#L1-L1", { cwd: project, settings })).rejects.toThrow(
			/outside allowed roots/,
		);
		await expect(
			router.resolve(`wikigraph://path/${encodeURIComponent(path.join(cleanupRoot, "secret.md"))}#L1-L1`, {
				cwd: project,
				settings,
			}),
		).rejects.toThrow(/outside allowed roots/);
	});
});
