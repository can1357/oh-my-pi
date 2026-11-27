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
test.skipIf(!available && Bun.env.OMP_REQUIRE_TERN !== "1")(
	"real Tern pointer controls preserve the draft and annotate a highlighted source line",
	async () => {
		if (!tern || !available)
			throw new Error("test:tern requires Tern with `serve` and `ctl` on PATH and a POSIX shell");
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
		const annotationSource = ['const greeting = "hello";', "const answer = 42;", "console.log(greeting);", ""].join(
			"\n",
		);
		const annotationNote = "Check this exact value.";
		await Bun.write(dir.join("sample-source.ts"), annotationSource);
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
		const log = Bun.file(dir.join("server.log"));
		const server = Bun.spawn([tern, "serve", "--control", socket, "--out", dir.path()], {
			cwd: dir.path(),
			env,
			stdin: "ignore",
			stdout: "ignore",
			stderr: log,
			timeout: 90_000,
		});

		async function ctl(...args: string[]) {
			const response = await $`${tern} ctl --control ${socket} ${args}`.env(env).quiet();
			const data = reply.assert(response.json());
			if (!data.ok) throw new Error(`${args[0]}: ${data.error}`);
			return data;
		}

		async function visible(
			selector: string,
			match: (node: Element) => boolean,
			description: string,
		): Promise<Element> {
			const deadline = performance.now() + 10_000;
			let nodes: Element[] = [];
			do {
				nodes = (await ctl("tree", selector)).nodes ?? [];
				const found = nodes.find(match);
				if (found) return found;
				await Bun.sleep(25);
			} while (performance.now() < deadline && server.exitCode === null);
			throw new Error(`Expected ${description}; visible ${selector}: ${JSON.stringify(nodes).slice(0, 1000)}`);
		}

		function click({ rect: [x, y, w, h] }: Element) {
			return ctl("click", String(x + w / 2), String(y + h / 2));
		}
		const enterText = (text: string) => ctl("type", JSON.stringify(text));
		const draft = (text: string) =>
			visible(".sf-editor", n => n.text === text, `composer draft ${JSON.stringify(text)}`);
		const chip = (name: string) =>
			visible(".sf-row.sf-act", n => n.text === `Smoke ${name}`, `model chip Smoke ${name}`);

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
			await ctl("ready");
			// The temporary cwd and HOME isolate discovery. --no-extensions also hides bundled /annotate.
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
					// Test runtime: keeps omp off the OS keychain.
					"PI_TEST_RUNTIME=1",
					process.execPath,
					path.resolve(import.meta.dir, "../src/cli.ts"),
					"--no-skills",
					"--no-rules",
					"--no-lsp",
					"--no-session",
					"--model",
					"smoke/alpha",
					"--thinking",
					"high",
				])}`,
			);
			await ctl("key", "Enter");
			await chip("alpha");
			await enterText("discard me");
			await draft("discard me");
			await ctl("key", process.platform === "darwin" ? "Meta+a" : "Ctrl+a");
			await enterText("keep @sample-no");
			await click(await visible(".pk-row", n => n.text?.includes("sample-note.txt") === true, "file suggestion"));
			const kept = "keep @sample-note.txt";
			await draft(kept);

			// The nested ring is a different target from the model name, despite sharing its chip.
			const effort = await visible(".sf-effort.sf-act", n => Boolean(n.title), "interactive effort ring");
			await click(effort);
			await visible(".sf-effort.sf-act", n => Boolean(n.title) && n.title !== effort.title, "changed effort level");
			await click(await chip("alpha"));
			await visible(".sf-layer > .sf-picker", n => n.rect[2] > 0 && n.rect[3] > 0, "visible session model picker");
			await enterText("smoke/beta");
			// Beta is visible in the unfiltered list too, at a different coordinate. Wait until
			// the new query is displayed and the filtered row is selected before clicking it.
			await visible(".pk-search", n => n.text === "smoke/beta", "rendered model search");
			await click(await visible(".pk-row.sel", n => n.text?.includes("beta") === true, "selected beta result"));
			await chip("beta");
			await draft(kept);
			// The chip update and closing the native picker are separate frames.
			const closeDeadline = performance.now() + 10_000;
			let pickers = (await ctl("tree", ".sf-layer > .sf-picker")).nodes;
			while (pickers?.length && performance.now() < closeDeadline && server.exitCode === null) {
				await Bun.sleep(25);
				pickers = (await ctl("tree", ".sf-layer > .sf-picker")).nodes;
			}
			expect(pickers).toEqual([]);
			await ctl("key", process.platform === "darwin" ? "Meta+a" : "Ctrl+a");
			await enterText("/annotate sample-source.ts");
			await ctl("key", "Enter");

			const reviewList = '.sf-list[data-role="omp.review.text"]';
			await visible(`${reviewList} .sf-t-info`, node => node.text === "const", "highlighted TypeScript keyword");
			await ctl("size", "850", "700", "2");
			const isSecondLine = (node: Element) => node.text?.includes("const answer = 42;") === true;
			await click(await visible(`${reviewList} .sf-item`, isSecondLine, "visible source line 2"));
			await visible(`${reviewList} .sf-item[aria-selected="true"]`, isSecondLine, "selected source line 2");
			await ctl("key", "a");
			await visible(".sf-text", node => node.text === "Note on line 2", "note editor for the selected line");
			await enterText(annotationNote);
			await ctl("key", "Enter");
			await visible(`${reviewList} .sf-item`, node => node.text?.includes(annotationNote) === true, "saved note");
			await click(
				await visible(
					'[data-role="omp.actions"] [data-role="omp.btn"]',
					node => node.text === "Paste into prompt",
					"paste annotations action",
				),
			);
			await visible(
				'.sf-card[data-role="omp.composer.chip"]',
				node => node.text?.includes("Feedback on") === true,
				"annotation feedback pasted into the composer",
			);
		} catch (error) {
			if (await log.exists()) console.error((await log.text()).slice(-1600));
			throw error;
		} finally {
			if (server.exitCode === null) await ctl("quit").catch(() => server.kill());
			await server.exited;
		}
	},
	100_000,
);
