/** Drive an installed Tern by screen coordinates; no user panes, credentials, or model requests. */
import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { $which, isEnoent, TempDir } from "@oh-my-pi/pi-utils";
import { $ } from "bun";
import { quotePosixArgv } from "../src/utils/shell-quote";

const element = type({ "text?": "string", "title?": "string", rect: ["number", "number", "number", "number"] });
const reply = type({ ok: "boolean", "error?": "string", "nodes?": element.array() });
type Element = typeof element.infer;

const tern = $which("tern");
const available = Boolean(tern) && process.platform !== "win32";
type ControlReply = typeof reply.infer;
type TernHarness = {
	ctl: (...args: string[]) => Promise<ControlReply>;
	visible(
		selector: string,
		match: (node: Element) => boolean,
		description: string,
		viewport?: readonly [number, number],
	): Promise<Element>;
	click(node: Element): Promise<ControlReply>;
	enterText(text: string): Promise<ControlReply>;
};

async function withTern(
	run: (harness: TernHarness) => Promise<void>,
	session?: (cwd: string) => readonly unknown[],
): Promise<void> {
	if (!tern || !available) throw new Error("test:tern requires Tern with `serve` and `ctl` on PATH and a POSIX shell");
	await using dir = await TempDir.create("@omp-tern-");
	const socket = dir.join("control.sock");
	const home = dir.join("home");
	const agent = dir.join("agent");
	const env = {
		PATH: Bun.env.PATH,
		LANG: "en_US.UTF-8",
		SHELL: "/bin/sh",
		HOME: home,
		TERN_CONFIG_DIR: dir.join("tern"),
	};
	await fs.mkdir(home);
	await Bun.write(dir.join("sample-note.txt"), "Local completion target\n");
	await Bun.write(
		path.join(agent, "models.yml"),
		JSON.stringify({
			providers: {
				smoke: {
					baseUrl: "http://127.0.0.1:1/v1",
					apiKey: "unused",
					api: "openai-completions",
					models: ["alpha", "beta"].map(id => ({
						id,
						name: `Smoke ${id}`,
						reasoning: true,
						input: ["text"],
						contextWindow: 32768,
						maxTokens: 4096,
					})),
				},
			},
		}),
	);
	const sessionPath = dir.join("fixture.jsonl");
	const entries = session?.(dir.path());
	if (entries) await Bun.write(sessionPath, entries.map(entry => JSON.stringify(entry)).join("\n") + "\n");
	const log = Bun.file(dir.join("server.log"));
	const server = Bun.spawn([tern, "serve", "--control", socket, "--out", dir.path()], {
		cwd: dir.path(),
		env,
		stdin: "ignore",
		stdout: "ignore",
		stderr: log,
		timeout: 90_000,
	});

	async function ctl(...args: string[]): Promise<ControlReply> {
		const response = await $`${tern} ctl --control ${socket} ${args}`.env(env).quiet();
		const data = reply.assert(response.json());
		if (!data.ok) throw new Error(`${args[0]}: ${data.error}`);
		return data;
	}
	async function visible(
		selector: string,
		match: (node: Element) => boolean,
		description: string,
		viewport?: readonly [number, number],
	): Promise<Element> {
		const deadline = performance.now() + 10_000;
		let nodes: Element[] = [];
		do {
			nodes = (await ctl("tree", selector)).nodes ?? [];
			const found = nodes.find(node => {
				if (!match(node)) return false;
				if (!viewport) return true;
				const [x, y, w, h] = node.rect;
				return w > 0 && h > 0 && x >= 0 && y >= 0 && x + w <= viewport[0] && y + h <= viewport[1];
			});
			if (found) return found;
			await Bun.sleep(25);
		} while (performance.now() < deadline && server.exitCode === null);
		throw new Error(`Expected ${description}; visible ${selector}: ${JSON.stringify(nodes).slice(0, 1000)}`);
	}
	const click = ({ rect: [x, y, w, h] }: Element) => ctl("click", String(x + w / 2), String(y + h / 2));
	const enterText = (text: string) => ctl("type", JSON.stringify(text));

	try {
		const deadline = performance.now() + 10_000;
		for (;;) {
			try {
				await fs.access(socket);
				break;
			} catch (error) {
				if (!isEnoent(error) || performance.now() >= deadline || server.exitCode !== null) throw error;
				await Bun.sleep(25);
			}
		}
		await ctl("size", "1200", "800", "2");
		await ctl("reduce-motion", "on");
		await ctl("ready");
		await enterText(
			`${quotePosixArgv(["cd", dir.path()])} && exec ${quotePosixArgv([
				"env",
				"-i",
				`PATH=${env.PATH}`,
				`HOME=${home}`,
				`LANG=${env.LANG}`,
				`PI_CODING_AGENT_DIR=${agent}`,
				"TERM=xterm-256color",
				"TERM_PROGRAM=tern",
				"OMP_SKIP_SETUP=1",
				process.execPath,
				path.resolve(import.meta.dir, "../src/cli.ts"),
				...(entries ? [] : ["--no-extensions"]),
				"--no-skills",
				"--no-rules",
				"--no-lsp",
				...(entries ? ["--session", sessionPath] : ["--no-session"]),
				"--model",
				"smoke/alpha",
				"--thinking",
				"high",
			])}`,
		);
		await ctl("key", "Enter");
		await visible(".sf-row.sf-act", node => node.text === "Smoke alpha", "launched session");
		await run({ ctl, visible, click, enterText });
	} catch (error) {
		if (await log.exists()) console.error((await log.text()).slice(-1600));
		throw error;
	} finally {
		if (server.exitCode === null) await ctl("quit").catch(() => server.kill());
		await server.exited;
	}
}

test.skipIf(!available && Bun.env.OMP_REQUIRE_TERN !== "1")(
	"real Tern pointer controls change the model without losing the composed draft",
	async () => {
		await withTern(async ({ ctl, visible, click, enterText }) => {
			const draft = (text: string) =>
				visible(".sf-editor", node => node.text === text, `composer draft ${JSON.stringify(text)}`);
			const chip = (name: string) =>
				visible(".sf-row.sf-act", node => node.text === `Smoke ${name}`, `model chip Smoke ${name}`);

			await chip("alpha");
			await enterText("discard me");
			await draft("discard me");
			await ctl("key", process.platform === "darwin" ? "Meta+a" : "Ctrl+a");
			await enterText("keep @sample-no");
			await click(
				await visible(".sf-item", node => node.text?.includes("sample-note.txt") === true, "file suggestion"),
			);
			const kept = "keep @sample-note.txt";
			await draft(kept);

			// The nested ring is a different target from the model name, despite sharing its chip.
			const effort = await visible(".sf-effort.sf-act", node => Boolean(node.title), "interactive effort ring");
			await click(effort);
			await visible(
				".sf-effort.sf-act",
				node => Boolean(node.title) && node.title !== effort.title,
				"changed effort level",
			);
			await click(await chip("alpha"));
			await visible(
				".sf-layer > .sf-picker",
				node => node.rect[2] > 0 && node.rect[3] > 0,
				"visible session model picker",
			);
			await enterText("smoke/beta");
			// Beta is visible in the unfiltered list too, at a different coordinate. Wait until
			// the new query is displayed and the filtered row is selected before clicking it.
			await visible(".pk-search", node => node.text === "smoke/beta", "rendered model search");
			await click(
				await visible(".pk-row.sel", node => node.text?.includes("beta") === true, "selected beta result"),
			);
			await chip("beta");
			await draft(kept);
			expect((await ctl("tree", ".sf-layer > .sf-picker")).nodes).toEqual([]);
		});
	},
	100_000,
);

function annotationSession(cwd: string): readonly unknown[] {
	const timestamp = new Date().toISOString();
	const userMessage = (id: string, parentId: string | null, text: string) => ({
		type: "message",
		id,
		parentId,
		timestamp,
		message: { role: "user", content: [{ type: "text", text }], timestamp: Date.now() },
	});
	return [
		{ type: "session", version: 3, id: crypto.randomUUID(), timestamp, cwd },
		userMessage(
			"11111111",
			null,
			[
				"sessionWholeTurnOnly",
				"",
				"```ts",
				'const sessionBlockOne = "first";',
				"```",
				"",
				"```ts",
				'const sessionBlockTwo = "second";',
				"```",
			].join("\n"),
		),
		userMessage("22222222", "11111111", "newerTurnWithoutBlocks"),
	];
}

test.skipIf(!available && Bun.env.OMP_REQUIRE_TERN !== "1")(
	"`/copy` and `/annotate session` preserve block previews and exact selection on desktop and phone",
	async () => {
		for (const command of ["/copy", "/annotate session"] as const) {
			await withTern(async ({ ctl, visible, click, enterText }) => {
				for (const mode of ["desktop", "phone"] as const) {
					const viewport = mode === "phone" ? ([390, 844] as const) : ([1200, 800] as const);
					async function pressVisible(selector: string, match: (node: Element) => boolean, description: string) {
						const node = await visible(selector, match, description, viewport);
						if (mode === "desktop") {
							await click(node);
							return;
						}
						const [x, y, w, h] = node.rect;
						const coords = [String(x + w / 2), String(y + h / 2)];
						await ctl("touch", "down", "1", ...coords);
						await ctl("touch", "up", "1", ...coords);
					}

					if (mode === "phone") {
						await ctl("size", String(viewport[0]), String(viewport[1]), "2");
						await ctl("phone", "on");
					}
					const context = `${mode} ${command}`;
					if (mode === "phone")
						await pressVisible(".sf-editor", node => node.text === "What are we cooking?", "phone composer");
					await enterText(command);
					if (mode === "phone")
						await pressVisible("[title]", node => node.title?.startsWith("Send") === true, "phone Send button");
					else await ctl("key", "Enter");
					await visible(
						".sf-picker .pk-row.sel",
						node => node.text?.includes("newerTurnWithoutBlocks") === true,
						`${context}: latest turn initially selected`,
						viewport,
					);
					const isEarlierTurn = (node: Element) => node.text?.includes("sessionWholeTurnOnly") === true;
					await pressVisible(".sf-picker .pk-row", isEarlierTurn, `${context}: earlier turn with two blocks`);
					await visible(".sf-picker .pk-row.sel", isEarlierTurn, `${context}: earlier turn highlighted`, viewport);
					await pressVisible('.sf-picker .pk-btn[title^="Blocks"]', () => true, `${context}: Blocks action`);

					const preview = '.sf-section[data-role="omp.picker.block.focused"]';
					if (mode === "desktop")
						await visible(
							preview,
							node => node.text?.includes("sessionBlockOne") === true,
							`${context}: full first-block preview beside the list`,
							viewport,
						);
					// The timeline label also contains this snippet; match a descended block row.
					const isSecondBlock = (node: Element) =>
						node.text?.startsWith("ts ·") === true && node.text.includes("sessionBlockTwo");
					if (command === "/copy") {
						// Browse without changing the system clipboard.
						await visible(".sf-picker .pk-row", isSecondBlock, `${context}: second block row`, viewport);
						await pressVisible('.sf-picker .pk-btn[title^="Back"]', () => true, `${context}: Back action`);
						await visible(
							".sf-picker .pk-row.sel",
							isEarlierTurn,
							`${context}: Back restores the turn`,
							viewport,
						);
						if (mode === "phone") continue;
						await pressVisible('.sf-picker .pk-btn[title^="Close"]', () => true, `${context}: Close action`);
						const deadline = performance.now() + 2_000;
						while ((await ctl("tree", ".sf-layer > .sf-picker")).nodes?.length) {
							if (performance.now() > deadline) throw new Error(`${context}: picker did not close`);
							await Bun.sleep(25);
						}
						continue;
					}
					await pressVisible(".sf-picker .pk-row", isSecondBlock, `${context}: second block row`);
					if (mode === "desktop")
						await pressVisible(
							preview,
							node => node.text?.includes("sessionBlockTwo") === true,
							`${context}: click the second-block side preview`,
						);
					const source = await visible(
						'.sf-list[data-role="omp.review.text"]',
						node => node.text?.includes("sessionBlockTwo") === true,
						`${context}: annotation contains the second snippet`,
						viewport,
					);
					expect(source.text).not.toContain("sessionWholeTurnOnly");
					expect(source.text).not.toContain("sessionBlockOne");
					if (mode === "desktop") await ctl("key", "Escape");
				}
			}, annotationSession);
		}
	},
	100_000,
);
