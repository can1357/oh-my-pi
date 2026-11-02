import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { type CreateAgentSessionOptions, createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { ImageProtocol, setTerminalImageProtocol, TERMINAL } from "@oh-my-pi/pi-tui/terminal-capabilities";
import { TempDir } from "@oh-my-pi/pi-utils";

/** The default system prompt of a session created with `options`. */
async function promptFor(options: CreateAgentSessionOptions): Promise<string> {
	using tempDir = TempDir.createSync("@omp-sdk-visuals-prompt-");
	const cwd = tempDir.join("project");
	const authStorage = await AuthStorage.create(":memory:");
	const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	const { session } = await createAgentSession({
		cwd,
		agentDir: tempDir.join("agent"),
		authStorage,
		modelRegistry,
		settings: Settings.isolated(),
		sessionManager: SessionManager.inMemory(cwd),
		model: getBundledModel("openai", "gpt-4o-mini"),
		disableExtensionDiscovery: true,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
		skipPythonPreflight: true,
		...options,
	});
	try {
		return session.systemPrompt.join("\n");
	} finally {
		await session.dispose();
		authStorage.close();
	}
}

describe("visuals guidance in the system prompt", () => {
	it("is offered to the top-level TUI session only, not to RPC or subagent sessions", async () => {
		const tui = await promptFor({ hasUI: true, tuiTranscript: true });
		expect(tui).toContain("```mermaid");
		expect(tui).toContain("```svg");
		expect(tui).toContain("it underneath");

		// rpc-ui: a UI for dialogs, but replies are read by the client as text.
		const rpc = await promptFor({ hasUI: true });
		const subagent = await promptFor({ hasUI: true, tuiTranscript: true, taskDepth: 1 });
		for (const prompt of [rpc, subagent]) {
			expect(prompt).not.toContain("```mermaid");
			expect(prompt).not.toContain("```svg");
			expect(prompt).not.toContain("it underneath");
		}
	});

	describe("on a terminal that draws images", () => {
		const original = TERMINAL.imageProtocol;
		afterEach(() => setTerminalImageProtocol(original));
		const tui = { hasUI: true, tuiTranscript: true } as const;
		const promptWith = (settings: Record<string, unknown>) => {
			setTerminalImageProtocol(ImageProtocol.Kitty);
			return promptFor({ ...tui, settings: Settings.isolated(settings) });
		};

		it("asks for one designed SVG figure, and names only the forms the UI draws", async () => {
			const canvas = await promptWith({});
			expect(canvas).toContain("Design the form this idea needs");
			expect(canvas).toContain("```mermaid");
			const svgOnly = await promptWith({ "tui.renderMermaid": false });
			expect(svgOnly).toContain("Design the form this idea needs");
			expect(svgOnly).not.toContain("```mermaid");
			// Without SVG figures an ```svg fence shows as source: Mermaid stays the figure form.
			const mermaidOnly = await promptWith({ "tui.renderSvg": false });
			expect(mermaidOnly).toContain("```mermaid");
			expect(mermaidOnly).not.toContain("```svg");
		});

		it("keeps lookup tables as tables without auto-graph, dropping only the chart claim", async () => {
			const charted = await promptWith({});
			expect(charted).toContain("Markdown table; the UI may chart it underneath.");
			const plain = await promptWith({ "tui.autoGraph": "off" });
			expect(plain).toContain("looks up row by row? Markdown table. Charting");
			expect(plain).not.toContain("underneath");
		});

		it("keeps the general routing when images are hidden", async () => {
			const hidden = await promptWith({ "terminal.showImages": false });
			expect(hidden).not.toContain("Design the form this idea needs");
			expect(hidden).toContain("first fit wins");
		});
	});

	it("keeps the general routing on a terminal with no known image protocol, where an svg fence shows as source", async () => {
		const original = TERMINAL.imageProtocol;
		setTerminalImageProtocol(null);
		try {
			const prompt = await promptFor({ hasUI: true, tuiTranscript: true });
			expect(prompt).not.toContain("Design the form this idea needs");
			expect(prompt).toContain("terminal renders ASCII");
		} finally {
			setTerminalImageProtocol(original);
		}
	});
});
