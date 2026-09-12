import { afterAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Api, AssistantMessageEventStream, Context, Model } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import {
	COMMAND_PROVIDER_API,
	buildDefaultArgs,
	childEnvironment,
	commandProviderApiId,
	createCommandStreamSimple,
	type CommandProviderConfig,
	museShimExecutable,
	parseCommandArgs,
	registerCommandProvider,
	resolveCommandPath,
	resolveReasoningEffort,
} from "../../examples/extensions/command-provider";

const MODEL = { id: "stub-model", api: "command-subprocess-api:stub", provider: "stub" } as unknown as Model<Api>;

const tempDirectories: string[] = [];

afterAll(async () => {
	for (const directory of tempDirectories) await fs.promises.rm(directory, { recursive: true, force: true });
});

/**
 * Write a stub child script and build the adapter around it. The prompt-file
 * path arrives as `argv[2]` (`bun <script> <promptPath>`), so a stub can prove
 * what the child actually received.
 */
async function stubAdapter(body: string, overrides: Partial<CommandProviderConfig> = {}) {
	const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-command-provider-"));
	tempDirectories.push(directory);
	const scriptPath = path.join(directory, "stub.ts");
	await Bun.write(scriptPath, body);
	const streamSimple = createCommandStreamSimple({
		providerName: "stub",
		modelId: "stub-model",
		command: process.execPath,
		buildArgs: ({ promptPath }) => [scriptPath, promptPath],
		...overrides,
	});
	return { streamSimple, scriptPath };
}

async function drain(stream: AssistantMessageEventStream) {
	const types: string[] = [];
	let text = "";
	for await (const event of stream) {
		types.push(event.type);
		if (event.type === "text_delta") text += event.delta;
	}
	return { types, text, result: await stream.result() };
}

const REPORT_TEXT = (expression: string) =>
	`console.log(JSON.stringify({payload:{kind:"run_output_delta",text:${expression}}}));`;

describe("command-backed provider transport", () => {
	it("streams the child's JSONL text and settles the assistant message", async () => {
		const { streamSimple } = await stubAdapter(
			`${REPORT_TEXT('"hello from child"')}\nconsole.log(JSON.stringify({payload:{kind:"run_terminal",terminal:"completed"}}));`,
		);
		const stream = streamSimple(MODEL, { messages: [{ role: "user", content: "hi" }] } as Context, {
			sessionId: crypto.randomUUID(),
		});

		const { types, result } = await drain(stream);

		expect(types).toEqual(["start", "text_start", "text_delta", "text_end", "done"]);
		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([{ type: "text", text: "hello from child" }]);
	});

	it("resolves a terminal failure record as the error result instead of rejecting", async () => {
		const { streamSimple } = await stubAdapter(
			'console.log(JSON.stringify({payload:{kind:"run_terminal",terminal:"failed",reason:"child exploded"}}));',
		);
		const stream = streamSimple(MODEL, { messages: [{ role: "user", content: "hi" }] } as Context, {
			sessionId: crypto.randomUUID(),
		});

		const { types, result } = await drain(stream);

		// The canonical stream settles result() with the error message; the agent
		// loop reads that message back after observing the error event.
		expect(types).toEqual(["start", "error"]);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("child exploded");
	});

	it("turns a non-zero exit into an error result", async () => {
		const { streamSimple } = await stubAdapter("process.exit(3);");
		const stream = streamSimple(MODEL, { messages: [{ role: "user", content: "hi" }] } as Context, {
			sessionId: crypto.randomUUID(),
		});

		const { result } = await drain(stream);

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("exited with code 3");
	});

	it("kills the child and reports an aborted request", async () => {
		const { streamSimple } = await stubAdapter("await new Promise(resolve => setTimeout(resolve, 30_000));");
		const controller = new AbortController();
		const stream = streamSimple(MODEL, { messages: [{ role: "user", content: "hi" }] } as Context, {
			sessionId: crypto.randomUUID(),
			signal: controller.signal,
		});
		setTimeout(() => controller.abort(), 100);

		const { result } = await drain(stream);

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("aborted");
	});

	it("times out a hung command", async () => {
		const { streamSimple } = await stubAdapter("await new Promise(resolve => setTimeout(resolve, 30_000));", {
			timeoutMs: 150,
		});
		const stream = streamSimple(MODEL, { messages: [{ role: "user", content: "hi" }] } as Context, {
			sessionId: crypto.randomUUID(),
		});

		const { result } = await drain(stream);

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("timed out after 150 ms");
	});

	it("hands a prompt larger than the Windows command line to the child through its prompt file", async () => {
		const pending: Array<{ prompt: string; promptPath: string }> = [];
		const { streamSimple, scriptPath } = await stubAdapter(
			"const body = await Bun.file(process.argv[2]).text();\n" + REPORT_TEXT('String(body.endsWith("END-MARKER"))'),
			{
				buildArgs: input => {
					pending.push({ prompt: input.prompt, promptPath: input.promptPath });
					return [scriptPath, input.promptPath];
				},
			},
		);
		const prompt = `${"x".repeat(100_000)}END-MARKER`;
		const stream = streamSimple(MODEL, { messages: [{ role: "user", content: prompt }] } as Context, {
			sessionId: crypto.randomUUID(),
		});

		const { text, result } = await drain(stream);

		expect(result.stopReason).toBe("stop");
		// The child saw the whole prompt: 100k characters never fit an argv element.
		expect(text).toBe("true");
		expect(pending[0]?.prompt.endsWith(prompt)).toBe(true);
		await Bun.sleep(100);
		// The prompt travels by path only, and the temp file does not outlive the request.
		expect(pending[0]?.promptPath.endsWith(".txt")).toBe(true);
		expect(await Bun.file(pending[0]!.promptPath).exists()).toBe(false);
	});

	it("seeds a new child session with the retained context, then sends only the new turn", async () => {
		const { streamSimple } = await stubAdapter(
			"const body = await Bun.file(process.argv[2]).text();\n" + REPORT_TEXT("JSON.stringify(body)"),
		);
		const sessionId = crypto.randomUUID();
		const retained = {
			systemPrompt: ["be terse"],
			messages: [
				{ role: "user", content: "first question" },
				{ role: "assistant", content: "first answer" },
				{ role: "user", content: "second question" },
			],
		} as Context;

		const first = await drain(streamSimple(MODEL, retained, { sessionId }));
		const second = await drain(
			streamSimple(MODEL, { messages: [{ role: "user", content: "third question" }] } as Context, { sessionId }),
		);

		const seeded = JSON.parse(first.text) as string;
		expect(seeded).toContain("[system]\nbe terse");
		expect(seeded).toContain("first answer");
		expect(JSON.parse(second.text)).toBe("third question");
	});
});

describe("command-backed provider configuration", () => {
	it("keeps OMP credentials out of the child environment while passing MUSE_* through", () => {
		const previous = {
			OPENAI_API_KEY: process.env.OPENAI_API_KEY,
			META_API_KEY: process.env.META_API_KEY,
			MUSE_TEST_SWITCH: process.env.MUSE_TEST_SWITCH,
		};
		process.env.OPENAI_API_KEY = "sk-should-not-leak";
		process.env.META_API_KEY = "LLM|payg";
		process.env.MUSE_TEST_SWITCH = "1";
		try {
			const env = childEnvironment({ META_API_KEY: undefined });

			expect(env.OPENAI_API_KEY).toBeUndefined();
			expect(env.MUSE_TEST_SWITCH).toBe("1");
			expect(env.META_API_KEY).toBeUndefined();
			expect(typeof env.PATH).toBe("string");
		} finally {
			for (const [key, value] of Object.entries(previous)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	});

	it("parses command arguments as JSON when a value contains spaces", () => {
		expect(parseCommandArgs('["--config","C:\\\\Muse Config\\\\muse.json"]')).toEqual([
			"--config",
			"C:\\Muse Config\\muse.json",
		]);
		expect(parseCommandArgs("--verbose  --retries 2")).toEqual(["--verbose", "--retries", "2"]);
		expect(() => parseCommandArgs("[1,2]")).toThrow();
	});

	it("maps thinking levels onto the command's effort flag", () => {
		expect(resolveReasoningEffort({ reasoning: "low" })).toBe("low");
		expect(resolveReasoningEffort({ disableReasoning: true, reasoning: "high" })).toBe("none");
		expect(resolveReasoningEffort({ reasoning: "ultra" as never })).toBe("ultra");
		expect(resolveReasoningEffort({ reasoning: "bogus" as never })).toBe("max");
	});

	it("builds the prompt-file layout and switches to argv on request", () => {
		const base = { sessionId: "sid", cwd: "C:/work", prompt: "hello", effort: "high", promptPath: "/tmp/p.txt" };

		expect(buildDefaultArgs({ ...base, commandArgs: ["--extra"] })).toEqual([
			"exec",
			"--json",
			"--session-id",
			"sid",
			"--workspace",
			"C:/work",
			"--reasoning-effort",
			"high",
			"--prompt-file",
			"/tmp/p.txt",
			"--extra",
		]);
		expect(buildDefaultArgs({ ...base, transport: "argv" }).at(-1)).toBe("hello");
	});

	it("gives every registered command provider its own API id", () => {
		const registered: Array<{ name: string; api: string }> = [];
		const pi = {
			registerProvider: (name: string, config: { api: string }) => registered.push({ name, api: config.api }),
		} as unknown as ExtensionAPI;

		registerCommandProvider(pi, { providerName: "alpha", modelId: "shared-model" });
		registerCommandProvider(pi, { providerName: "beta", modelId: "shared-model" });

		// Custom APIs are keyed by id in one global registry: a shared id would
		// let the second provider run the first provider's command.
		expect(registered.map(entry => entry.api)).toEqual([commandProviderApiId("alpha"), commandProviderApiId("beta")]);
		expect(registered[0]?.api).toStartWith(`${COMMAND_PROVIDER_API}:`);
	});

	it("resolves the executable a Windows batch shim launches and reports a shim it cannot", async () => {
		const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-muse-shim-"));
		tempDirectories.push(directory);
		const shim = path.join(directory, "muse.cmd");
		const executable = path.join(directory, "muse-bin-1.1.1-R2514.1.exe");
		await Bun.write(shim, "@echo off\n");
		await Bun.write(executable, "");
		expect(await museShimExecutable(shim)).toBeUndefined();

		await Bun.write(path.join(directory, ".muse-version"), "1.1.1-R2514.1\n");
		expect(await museShimExecutable(shim)).toBe(executable);
	});

	it("reports a command it cannot find on PATH", async () => {
		await expect(resolveCommandPath("omp-command-provider-absent", { PATH: "" })).rejects.toThrow(/cannot find/);
	});
});
