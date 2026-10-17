/**
 * Links the host's assistant wrote mean what they meant on the host: a relative path is a file in the host's
 * directory, and `local://` is the root the host itself resolved for its session (its artifact directory, or its own
 * temp directory for an in-memory session). The terminal's directories stay its own (footer, completion, `@file`),
 * so these tests run a real `InteractiveMode` and its real link resolver against real session hosts, with a file of
 * the same name in every project and an artifact only the host holds.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { resolveLocalRoot } from "@oh-my-pi/pi-coding-agent/internal-urls/local-protocol";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { RpcServer } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-server";
import * as prediction from "@oh-my-pi/pi-coding-agent/predict/client";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { HostedClientLink } from "@oh-my-pi/pi-coding-agent/session-host/hosted-client";
import { attachHostedUi, hostedReplicaDir } from "@oh-my-pi/pi-coding-agent/session-host/hosted-startup";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import { getAssistantMessageLinkTargets } from "@oh-my-pi/pi-tui/prompt/interactive-context-helpers";
import { setWordPredictionHost } from "@oh-my-pi/pi-tui/prompt/word-completion";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { createAssistantMessage } from "../helpers/agent-session-setup";
import { createTestSession } from "../helpers/rpc-server-harness";
import {
	type IsolatedConfigRoot,
	isolateConfigRoot,
	listTree,
	SessionHostFixture,
	type TestSessionHost,
	waitFor,
} from "../helpers/session-host-harness";

const SOURCE = "src/index.ts";
const REPORT = "local://report.md";
const ONLY_ON_FIRST = "src/only-on-first.ts";

let fixture: SessionHostFixture;
let config: IsolatedConfigRoot;
const terminals: Terminal[] = [];
let originalTmpdir: string | undefined;

beforeAll(async () => {
	await initTheme();
});

beforeEach(async () => {
	resetSettingsForTest();
	originalTmpdir = process.env.TMPDIR;
	// The policy, not the flag: a terminal's `init()` re-applies the policy and would undo a hand-set flag.
	await Settings.init({ inMemory: true, overrides: { "tui.hyperlinks": "always" } });
	fixture = await SessionHostFixture.create();
	config = isolateConfigRoot();
});

afterEach(async () => {
	for (const terminal of terminals.splice(0)) await terminal.close();
	if (originalTmpdir === undefined) delete process.env.TMPDIR;
	else process.env.TMPDIR = originalTmpdir;
	setWordPredictionHost(undefined);
	vi.restoreAllMocks();
	await config.restore();
	await fixture.dispose();
	resetSettingsForTest();
});

async function writeFile(file: string, content: string): Promise<string> {
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, content);
	return file;
}

/** The directory a host's tools run in. */
function projectOf(host: TestSessionHost): string {
	return host.session.sessionManager.getCwd();
}

/** The host session's `local://` root, which only the host's side of the machine knows about. */
function localRootOf(host: TestSessionHost): string {
	return path.join(host.session.sessionManager.getArtifactsDir()!, "local");
}

/** What the resolver maps a file to: a `file:` URI of its real path, as the other link tests expect it. */
async function fileUri(file: string): Promise<string> {
	return url.pathToFileURL(await fs.realpath(file)).href;
}

/** A host whose transcript holds one assistant message linking `hrefs`, with a source file named like every other project's. */
async function seededHost(label: string, hrefs: string[] = [SOURCE, REPORT]): Promise<TestSessionHost> {
	const host = await fixture.startHost();
	await writeFile(path.join(projectOf(host), SOURCE), `export const owner = "${label}";\n`);
	await writeFile(path.join(localRootOf(host), "report.md"), `report of ${label}\n`);
	await say(host, hrefs);
	return host;
}

/** The host's assistant writes a message with these links. */
async function say(host: TestSessionHost, hrefs: string[]): Promise<void> {
	host.session.sessionManager.appendMessage(createAssistantMessage(hrefs.map(href => `[${href}](${href})`).join(" ")));
}

/** A real terminal in hosted client mode, in a project of its own that also has a `src/index.ts`. */
class Terminal {
	readonly project: string;

	private constructor(
		readonly mode: InteractiveMode,
		readonly local: AgentSession,
	) {
		this.project = local.sessionManager.getCwd();
	}

	static async open(): Promise<Terminal> {
		const dir = await fs.mkdtemp(path.join(fixture.dir, "terminal-"));
		await writeFile(path.join(dir, SOURCE), 'export const owner = "terminal";\n');
		const local = await createTestSession(dir, { handler: { content: ["never asked"] } }, undefined, {
			passiveReplica: true,
		});
		vi.spyOn(prediction, "textPredictionBackend").mockReturnValue({ complete: async () => null, feedback: () => {} });
		vi.spyOn(prediction, "syncTextPrediction").mockImplementation(() => {});
		const mode = new InteractiveMode(local, "test");
		mode.hostedClientMode = true;
		mode.ui.requestRender = vi.fn();
		mode.ui.terminal.drainInput = async () => {};
		await mode.init({ suppressWelcomeIntro: true });
		const terminal = new Terminal(mode, local);
		terminals.push(terminal);
		return terminal;
	}

	/** `omp attach`: the transcript is painted, links included, before this resolves. */
	async attach(entry: Parameters<typeof attachHostedUi>[1]["entry"]): Promise<void> {
		await attachHostedUi(this.mode, {
			entry,
			launch: { cwd: fixture.dir, args: [], registryDir: fixture.registryDir },
		});
	}

	/** What the real resolver, asked as the transcript renderer asks it, maps `hrefs` to. */
	async resolve(hrefs: string[]): Promise<Record<string, string>> {
		const targets = await this.mode.resolveAssistantMessageLinkHrefs(hrefs);
		return Object.fromEntries(targets);
	}

	/** The destinations the painted transcript's links carry. */
	painted(): Record<string, string> {
		return Object.fromEntries(getAssistantMessageLinkTargets(this.mode));
	}

	/** The transcript as the user reads it. */
	visibleTranscript(): string {
		return Bun.stripANSI(this.mode.chatContainer.render(200).join("\n"));
	}

	/** The destinations of the hyperlinks in the painted transcript, as the terminal receives them. */
	rendered(): string[] {
		const output = this.mode.chatContainer.render(200).join("\n");
		const uris = [...output.matchAll(/\x1b\]8;[^;\x07\x1b]*;([^\x1b\x07]+)(?:\x1b\\|\x07)/g)].map(match => match[1]!);
		return [...new Set(uris)].sort();
	}

	async close(): Promise<void> {
		await this.mode.hostedClient?.detach();
		if (!this.mode.isShuttingDown) this.mode.stop();
		await this.local.dispose();
	}
}

async function attached(host: TestSessionHost): Promise<Terminal> {
	const terminal = await Terminal.open();
	await terminal.attach(await fixture.entry(host));
	return terminal;
}

describe("host-authored links in a hosted terminal", () => {
	it("open the host's file and artifact from the first snapshot's transcript, never the terminal's own", async () => {
		const host = await seededHost("first");
		const terminal = await attached(host);

		const expected = {
			[SOURCE]: await fileUri(path.join(projectOf(host), SOURCE)),
			[REPORT]: await fileUri(path.join(localRootOf(host), "report.md")),
		};
		// Painted before the link was registered on the terminal: what the first repaint resolved.
		expect(terminal.painted()).toEqual(expected);
		expect(await terminal.resolve([SOURCE, REPORT])).toEqual(expected);
		// The terminal's own directory is untouched, and its same-named file is not what the link means.
		expect(terminal.mode.sessionManager.getCwd()).toBe(terminal.project);
		expect(expected[SOURCE]).not.toBe(await fileUri(path.join(terminal.project, SOURCE)));
	}, 20_000);

	it("move to the next host on /attach, with nothing of the previous host left to resolve", async () => {
		const first = await seededHost("first", [SOURCE, REPORT, ONLY_ON_FIRST]);
		await writeFile(path.join(projectOf(first), ONLY_ON_FIRST), "only here\n");
		const second = await seededHost("second");
		const terminal = await attached(first);
		expect(Object.keys(terminal.painted())).toContain(ONLY_ON_FIRST);

		await executeBuiltinSlashCommand(`/attach ${second.hostId}`, { ctx: terminal.mode });

		const expected = {
			[SOURCE]: await fileUri(path.join(projectOf(second), SOURCE)),
			[REPORT]: await fileUri(path.join(localRootOf(second), "report.md")),
		};
		expect(terminal.painted()).toEqual(expected);
		expect(await terminal.resolve([SOURCE, REPORT, ONLY_ON_FIRST])).toEqual(expected);
		expect(terminal.mode.sessionManager.getCwd()).toBe(terminal.project);
	}, 20_000);

	it("follow the host's own session replacement to its new artifact root", async () => {
		const host = await seededHost("before");
		// The mock reply's model id is not registered; record ones the switches between the two sessions can restore.
		host.session.sessionManager.appendModelChange("anthropic/claude-sonnet-4-5");
		await host.session.sessionManager.flush();
		const beforeFile = host.session.sessionManager.getSessionFile()!;
		// The host's second session has a report of its own, and links to it.
		await host.session.newSession();
		await writeFile(path.join(localRootOf(host), "report.md"), "report of after\n");
		await say(host, [SOURCE, REPORT]);
		host.session.sessionManager.appendModelChange("anthropic/claude-sonnet-4-5");
		await host.session.sessionManager.flush();
		const afterFile = host.session.sessionManager.getSessionFile()!;
		await host.session.switchSession(beforeFile);
		const terminal = await attached(host);
		const before = await fileUri(path.join(localRootOf(host), "report.md"));
		expect(terminal.painted()[REPORT]).toBe(before);

		await host.session.switchSession(afterFile);
		await waitFor(() => terminal.painted()[REPORT] !== before);

		const expected = {
			[SOURCE]: await fileUri(path.join(projectOf(host), SOURCE)),
			[REPORT]: await fileUri(path.join(localRootOf(host), "report.md")),
		};
		expect(expected[REPORT]).not.toBe(before);
		expect(await terminal.resolve([SOURCE, REPORT])).toEqual(expected);
		expect(terminal.painted()).toEqual(expected);
	}, 20_000);

	it("repoint the links already on screen when the host's session is relocated, without moving the terminal", async () => {
		const host = await seededHost("moved");
		const terminal = await attached(host);
		const before = {
			[SOURCE]: await fileUri(path.join(projectOf(host), SOURCE)),
			[REPORT]: await fileUri(path.join(localRootOf(host), "report.md")),
		};
		// The first paint: the cache and the hyperlinks the transcript carries name the host's files.
		expect(terminal.painted()).toEqual(before);
		// The host's reply is on screen (with the label the link was written with) before its hyperlinks are read.
		expect(terminal.visibleTranscript()).toContain("src/index.ts");
		expect(terminal.rendered()).toEqual(expect.arrayContaining(Object.values(before)));
		const moved = path.join(fixture.dir, "moved-project");
		await writeFile(path.join(moved, SOURCE), 'export const owner = "moved";\n');

		// A bare move: no new entry, no replacement, no repaint of the transcript.
		await host.session.moveSession(moved);

		const after = {
			[SOURCE]: await fileUri(path.join(moved, SOURCE)),
			[REPORT]: await fileUri(path.join(localRootOf(host), "report.md")),
		};
		expect(after[SOURCE]).not.toBe(before[SOURCE]);
		expect(after[REPORT]).not.toBe(before[REPORT]);
		await waitFor(() => terminal.rendered().includes(after[SOURCE]) && terminal.rendered().includes(after[REPORT]));
		expect(terminal.painted()).toEqual(after);
		const rendered = terminal.rendered();
		expect(rendered).toEqual(expect.arrayContaining(Object.values(after)));
		for (const stale of Object.values(before)) expect(rendered).not.toContain(stale);
		expect(await terminal.resolve([SOURCE, REPORT])).toEqual(after);
		expect(terminal.mode.sessionManager.getCwd()).toBe(terminal.project);
	}, 20_000);

	it("resolve nothing for a host's links once the terminal has left that host", async () => {
		const host = await seededHost("left");
		const terminal = await attached(host);
		expect((await terminal.resolve([SOURCE]))[SOURCE]).toBe(await fileUri(path.join(projectOf(host), SOURCE)));

		await terminal.mode.hostedClient?.detach();

		// Its same-named file in the terminal's own directory is not what the host's link meant.
		expect(await terminal.resolve([SOURCE, REPORT])).toEqual({});
	}, 20_000);

	it("are not unmade by a link that ends after another link took the view", async () => {
		const first = await seededHost("first");
		const second = await seededHost("second");
		const terminal = await attached(first);
		const firstLink = terminal.mode.hostedClient!;
		const secondLink = await HostedClientLink.connect({
			ctx: terminal.mode,
			entry: await fixture.entry(second),
			replicaDir: hostedReplicaDir(),
			onClosed: () => {},
		});
		terminal.mode.hostedClient = secondLink;

		await firstLink.detach();

		expect((await terminal.resolve([SOURCE]))[SOURCE]).toBe(await fileUri(path.join(projectOf(second), SOURCE)));
	}, 20_000);

	it("refuse a host that cannot say where its session lives, leaving nothing of it on the terminal", async () => {
		const host = await seededHost("old build");
		const snapshot = RpcServer.prototype.snapshot;
		vi.spyOn(RpcServer.prototype, "snapshot").mockImplementation(function (this: RpcServer) {
			const { origin: _origin, ...withoutOrigin } = snapshot.call(this);
			return withoutOrigin;
		});
		const terminal = await Terminal.open();

		await expect(terminal.attach(await fixture.entry(host))).rejects.toThrow(/origin/);

		expect(terminal.mode.hostedClient).toBeUndefined();
		expect(terminal.mode.hostOrigin).toBeUndefined();
		expect(await listTree(hostedReplicaDir())).toEqual([]);
	}, 20_000);

	it("resolve local:// in the host's own temp root when its session has no artifact directory, whatever this terminal's temp is", async () => {
		const hostTmp = await fs.mkdtemp(path.join(fixture.dir, "host-tmp-"));
		const terminalTmp = await fs.mkdtemp(path.join(fixture.dir, "terminal-tmp-"));
		const host = await fixture.startHost({}, undefined, { inMemory: true });
		expect(host.session.sessionManager.getArtifactsDir()).toBeNull();
		const sessionId = host.session.sessionManager.getSessionId();
		const rootInTemp = () => resolveLocalRoot({ getArtifactsDir: () => null, getSessionId: () => sessionId });
		await say(host, [REPORT]);
		const terminal = await Terminal.open();

		// The host resolves its root where its own temp directory is, and the artifact is there.
		process.env.TMPDIR = hostTmp;
		const hostFile = await writeFile(path.join(rootInTemp(), "report.md"), "report of the host\n");
		await terminal.attach(await fixture.entry(host));
		// The terminal's temp directory is somewhere else, and holds an artifact of the same name and session id.
		process.env.TMPDIR = terminalTmp;
		expect(os.tmpdir()).toBe(terminalTmp);
		const decoy = await writeFile(path.join(rootInTemp(), "report.md"), "report of the terminal\n");
		expect(await fs.realpath(decoy)).not.toBe(await fs.realpath(hostFile));

		const expected = { [REPORT]: await fileUri(hostFile) };
		expect(terminal.painted()).toEqual(expected);
		expect(await terminal.resolve([REPORT])).toEqual(expected);
	}, 20_000);
});
