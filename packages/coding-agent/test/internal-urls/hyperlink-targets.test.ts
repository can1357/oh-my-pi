import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { getDocsDiskRoot } from "@oh-my-pi/pi-coding-agent/internal-urls/docs-index";
import { resolveMarkdownLinkHrefs } from "@oh-my-pi/pi-coding-agent/internal-urls/hyperlink-targets";
import type { ResolveContext } from "@oh-my-pi/pi-coding-agent/internal-urls/types";
import { LocalProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls/local-protocol";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls/router";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { refreshAssistantMessageLinkTargets } from "@oh-my-pi/pi-coding-agent/session/transcript/link-targets";
import { rewriteLinkDestinations } from "../../src/ui/transcript/messages/links";
import { currentTheme, setCurrentTheme } from "@oh-my-pi/pi-tui/theme/runtime";

const restoreTheme = currentTheme();
afterAll(() => setCurrentTheme(restoreTheme));

/**
 * The local targets of the links an assistant reply authored in `text`, through the
 * transcript's own extraction (`refreshAssistantMessageLinkTargets`) and resolution.
 */
async function replyLinkTargets(text: string, options?: ResolveContext): Promise<ReadonlyMap<string, string>> {
	const message = { role: "assistant", content: [{ type: "text", text }] } as unknown as AssistantMessage;
	return refreshAssistantMessageLinkTargets(
		{ viewSession: {}, resolveAssistantMessageLinkHrefs: hrefs => resolveMarkdownLinkHrefs(hrefs, options) },
		[message],
	);
}

/** `text` as the assistant message renders it: resolved destinations swapped in. */
function linked(text: string, targets: ReadonlyMap<string, string>): string {
	return rewriteLinkDestinations(text, href => targets.get(href));
}

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
});

afterAll(() => {
	resetSettingsForTest();
});

describe("InternalUrlRouter.locateSync", () => {
	// The "no session options" contract below asserts on process-global state
	// (AgentRegistry main session, LocalProtocolHandler override) that sibling
	// test files in the same worker may have populated. Pin the premise
	// explicitly so the test is full-suite safe, not just file-local safe.
	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		LocalProtocolHandler.resetOverrideForTests();
	});

	afterEach(() => {
		AgentRegistry.resetGlobalForTests();
		LocalProtocolHandler.resetOverrideForTests();
	});

	it("returns undefined for non-internal URLs", () => {
		const router = InternalUrlRouter.builtins();
		expect(router.locateSync("/abs/path/file.ts")).toBeUndefined();
		expect(router.locateSync("relative/path.ts")).toBeUndefined();
		expect(router.locateSync("https://example.com/foo")).toBeUndefined();
	});

	it("returns undefined when local:// resolution has no session options", () => {
		// No AgentRegistry main session in this unit test, no override installed.
		expect(InternalUrlRouter.builtins().locateSync("local://foo.md")).toBeUndefined();
	});

	it("swallows errors from malformed URLs", () => {
		// Malformed input should not throw, just return undefined.
		expect(InternalUrlRouter.builtins().locateSync("local://%ZZ")).toBeUndefined();
	});
});

describe("resource links in assistant replies", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-markdown-links-"));
	});

	afterEach(async () => {
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	it("expands labeled, reference, and table links to real local and spill files", async () => {
		const localFile = path.join(tempDir, "local", "reviewed findings#.json");
		const artifactFile = path.join(tempDir, "local", "42.log");
		await Bun.write(localFile, '{"reviewed":true}');
		await Bun.write(artifactFile, "artifact output");
		const href = "local://reviewed%20findings%23.json";
		const text = [
			`[Reviewed findings](${href})`,
			"",
			"| Report |",
			"| --- |",
			"| [Artifact][output] |",
			"",
			"[output]: local://42.log",
		].join("\n");
		const targets = await replyLinkTargets(text, { localProtocolOptions: { getArtifactsDir: () => tempDir } });
		const localUri = url.pathToFileURL(await fs.realpath(localFile)).href;
		const artifactUri = url.pathToFileURL(await fs.realpath(artifactFile)).href;
		expect(Object.fromEntries(targets)).toEqual({ [href]: localUri, "local://42.log": artifactUri });
		const rendered = linked(text, targets);
		expect(rendered).toContain(`[Reviewed findings](${localUri})`);
		expect(rendered).toContain(`[output]: ${artifactUri}`);
	});

	it("links ordinary paths against the session cwd while preserving source anchors", async () => {
		const file = path.join(tempDir, "src", "my file.ts");
		await Bun.write(file, "export const value = 1;");
		const relative = "src/my%20file.ts#L7";
		const absolute = file.replaceAll("\\", "/").replaceAll(" ", "%20");
		const text = `[Source](${relative}) and [Absolute](${absolute}) and [Missing](src/missing.ts) and [Heading](#heading)`;
		const targets = await replyLinkTargets(text, { cwd: tempDir });
		const fileUri = url.pathToFileURL(file).href;
		expect(Object.fromEntries(targets)).toEqual({ [relative]: `${fileUri}#L7`, [absolute]: fileUri });
		expect(linked(text, targets)).toBe(
			`[Source](${fileUri}#L7) and [Absolute](${fileUri}) and [Missing](src/missing.ts) and [Heading](#heading)`,
		);
	});

	it("links omp:// docs to the file the active corpus was read from", async () => {
		// `omp://` docs are embedded in the shipped build, so a link only exists
		// where the corpus is read from the repo `docs/` tree.
		const docPath = "tools/read.md";
		const href = `omp://${docPath}`;
		const root = getDocsDiskRoot();
		const onDisk = root === null ? undefined : path.join(root, docPath);
		const targets = await replyLinkTargets(`[read docs](${href}) and [missing docs](omp://no-such-doc.md)`);
		// The unknown doc keeps its plain URL instead of gaining a file link.
		expect([...targets]).toEqual(onDisk === undefined ? [] : [[href, url.pathToFileURL(onDisk).href]]);
	});

	it("stops linking a file once it is deleted", async () => {
		const file = path.join(tempDir, "gone.txt");
		await Bun.write(file, "x");
		const text = "[Gone](gone.txt)";
		expect([...(await resolveMarkdownLinkHrefs(["gone.txt"], { cwd: tempDir })).keys()]).toEqual(["gone.txt"]);
		await fs.rm(file);
		expect([...(await resolveMarkdownLinkHrefs(["gone.txt"], { cwd: tempDir })).keys()]).toEqual([]);
		expect([...(await replyLinkTargets(text, { cwd: tempDir })).keys()]).toEqual([]);
	});

	it("leaves missing, escaping, remote, and non-link destinations unexpanded", async () => {
		await Bun.write(path.join(tempDir, "local", "report.json"), "{}");
		await Bun.write(path.join(tempDir, "outside.json"), "{}");
		await fs.symlink(path.join(tempDir, "outside.json"), path.join(tempDir, "local", "escape.json"));
		const text = [
			"`[code](local://report.json)`",
			"![image](local://report.json)",
			"```md",
			"[fenced](local://report.json)",
			"```",
			"[missing](local://missing.json)",
			"[escape](local://escape.json)",
			"[remote](mcp://server/resource)",
			"[web](https://example.com/report)",
		].join("\n\n");
		const targets = await replyLinkTargets(text, { localProtocolOptions: { getArtifactsDir: () => tempDir } });
		expect([...targets]).toEqual([]);
		expect(linked(text, targets)).toBe(text);
	});

	it("pins identical local links to their calling sessions", async () => {
		const text = "[Report](local://report.json)";
		const outputs: string[] = [];
		for (const session of ["a", "b"]) {
			const artifactsDir = path.join(tempDir, session);
			const file = path.join(artifactsDir, "local", "report.json");
			await Bun.write(file, session);
			const targets = await replyLinkTargets(text, {
				localProtocolOptions: { getArtifactsDir: () => artifactsDir },
			});
			const output = linked(text, targets);
			expect(output).toBe(`[Report](${url.pathToFileURL(await fs.realpath(file)).href})`);
			outputs.push(output);
		}
		expect(outputs[0]).not.toBe(outputs[1]);
	});
});
