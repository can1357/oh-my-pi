import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Server, Subprocess } from "bun";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import type { RpcCommand, RpcExtensionUIResponse } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import { normalizeModelContextImages } from "@oh-my-pi/pi-coding-agent/utils/image-loading";
import { isRecord, readJsonl, TempDir } from "@oh-my-pi/pi-utils";

type Frame = Record<string, unknown>;
type ProviderRequest = { body: Frame; release: () => void };

/** Localhost wire server + source CLI: the focused test command is also the CLI probe. */
class NativeInputProbe {
	readonly temp = TempDir.createSync("@omp-native-input-");
	readonly frames: Frame[] = [];
	readonly events: Frame[] = [];
	readonly requests: ProviderRequest[] = [];
	readonly #listeners = new Set<() => void>();
	readonly #gates = new Map<string, () => void>();
	#serial = 0;
	#child?: Subprocess<"pipe", "pipe", "pipe">;
	#server?: Server<undefined>;
	#stderr = "";
	#readers: Promise<void>[] = [];
	#failure?: Error;

	async start(mode: "rpc" | "rpc-ui", pipedCommands?: RpcCommand[]): Promise<void> {
		this.#server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: async request => {
				const body: unknown = await request.json();
				if (!isRecord(body)) return new Response("Expected object", { status: 400 });
				if (new URL(request.url).pathname === "/gates" && typeof body.name === "string") {
					const gate = Promise.withResolvers<void>();
					this.#gates.set(body.name, gate.resolve);
					this.#notify();
					await gate.promise;
					return new Response("ok");
				}
				if (new URL(request.url).pathname === "/events") {
					this.events.push(body);
					this.#notify();
					return new Response("ok");
				}
				if (new URL(request.url).pathname !== "/v1/chat/completions") {
					return new Response("Unexpected endpoint", { status: 404 });
				}
				const gate = Promise.withResolvers<void>();
				const id = `completion-${this.requests.length}`;
				this.requests.push({ body, release: gate.resolve });
				this.#notify();
				await gate.promise;
				const chunk = {
					id,
					object: "chat.completion.chunk",
					created: 1,
					model: "probe",
					choices: [
						{ index: 0, delta: { role: "assistant", content: "LOCAL_PROVIDER_DONE" }, finish_reason: null },
					],
				};
				const end = {
					...chunk,
					choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
					usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
				};
				return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(end)}\n\ndata: [DONE]\n\n`, {
					headers: { "Content-Type": "text/event-stream" },
				});
			},
		});
		await fs.mkdir(this.temp.join("home"));
		await Bun.write(
			this.temp.join("agent", "settings.json"),
			JSON.stringify({
				skills: { enableSkillCommands: true },
				compaction: { enabled: false },
				todo: { enabled: false },
			}),
		);
		await Bun.write(
			this.temp.join("agent", "skills", "native-probe", "SKILL.md"),
			"---\nname: native-probe\ndescription: Local input dispatch test\n---\n\nNATIVE_SKILL_BODY\n",
		);
		await Bun.write(this.temp.join("agent", "prompts", "native-template.md"), "NATIVE_TEMPLATE_BODY $ARGUMENTS\n");
		this.#child = Bun.spawn(
			[
				process.execPath,
				path.join(import.meta.dir, "..", "src", "cli.ts"),
				"--mode",
				mode,
				"--no-session",
				"--no-tools",
				"--no-lsp",
				"--no-rules",
				"--no-title",
				"--no-extensions",
				"--extension",
				path.join(import.meta.dir, "fixtures", "native-input-extension.ts"),
				"--model",
				"native-input-probe/probe",
			],
			{
				cwd: this.temp.path(),
				env: {
					PATH: process.env.PATH,
					HOME: this.temp.join("home"),
					PI_CODING_AGENT_DIR: this.temp.join("agent"),
					NATIVE_INPUT_PROBE_URL: `http://127.0.0.1:${this.#server.port}`,
					TERM: "dumb",
				},
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const child = this.#child;
		this.#readers = [
			(async () => {
				for await (const frame of readJsonl<unknown>(child.stdout)) {
					if (!isRecord(frame)) throw new Error("Non-object RPC frame");
					this.frames.push(frame);
					this.#notify();
				}
			})().catch(error => {
				this.#failure = new Error(String(error));
				this.#notify();
			}),
			(async () => {
				const decoder = new TextDecoder();
				for await (const bytes of child.stderr) this.#stderr += decoder.decode(bytes, { stream: true });
			})(),
		];
		void child.exited.then(() => this.#notify());
		if (pipedCommands) {
			child.stdin.write(pipedCommands.map(command => JSON.stringify(command)).join("\n") + "\n");
			child.stdin.end();
			await this.wait(() => this.frames.find(frame => frame.type === "ready"), "piped CLI ready");
		} else {
			await this.command({ type: "get_state" });
		}
	}

	#notify(): void {
		for (const listener of this.#listeners) listener();
	}

	async wait<T>(select: () => T | undefined, label: string): Promise<T> {
		const result = Promise.withResolvers<T>();
		const check = () => {
			const value = select();
			if (value !== undefined) result.resolve(value);
			else if (this.#failure) result.reject(this.#failure);
			else if (this.#child && this.#child.exitCode !== null) result.reject(new Error(`CLI exited: ${this.#stderr}`));
		};
		this.#listeners.add(check);
		// Deadlock watchdog only: successful checks advance on frames/HTTP handshakes, never elapsed time.
		const timeout = setTimeout(
			() =>
				result.reject(
					new Error(
						`Timed out: ${label}; stderr=${this.#stderr}; frames=${JSON.stringify(this.frames.slice(-8))}`,
					),
				),
			20000,
		);
		try {
			check();
			return await result.promise;
		} finally {
			clearTimeout(timeout);
			this.#listeners.delete(check);
		}
	}

	async send(command: RpcCommand | RpcExtensionUIResponse): Promise<string> {
		if (!this.#child) throw new Error("Probe not started");
		const id = command.id ?? `input-${++this.#serial}`;
		this.#child.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
		await this.#child.stdin.flush();
		return id;
	}

	response(id: string): Promise<Frame> {
		return this.wait(() => this.frames.find(frame => frame.type === "response" && frame.id === id), `response ${id}`);
	}

	async command(command: RpcCommand): Promise<Frame> {
		const response = await this.response(await this.send(command));
		expect(response.success).toBe(true);
		return response;
	}

	request(index = this.requests.length): Promise<ProviderRequest> {
		return this.wait(() => this.requests[index], `provider request ${index}`);
	}

	gate(name: string): Promise<() => void> {
		return this.wait(() => this.#gates.get(name), `extension gate ${name}`);
	}

	localResult(id: string): Promise<Frame> {
		return this.wait(
			() => this.frames.find(frame => frame.type === "prompt_result" && frame.id === id),
			`local result ${id}`,
		);
	}

	async finish(request: ProviderRequest): Promise<void> {
		const start = this.frames.length;
		request.release();
		await this.wait(() => this.frames.slice(start).find(frame => frame.type === "agent_end"), "agent end");
	}

	input(text: string): Frame[] {
		return this.events.filter(event => event.event === "input:A" && event.text === text);
	}

	async disconnect(): Promise<number> {
		if (!this.#child) throw new Error("Probe not started");
		this.#child.stdin.end();
		return this.exited();
	}

	exited(): Promise<number> {
		return this.wait(() => this.#child?.exitCode ?? undefined, "CLI shutdown after stdin EOF");
	}

	async close(): Promise<void> {
		if (this.#child) {
			if (this.#child.exitCode === null) {
				this.#child.stdin.end();
				this.#child.kill("SIGKILL");
			}
			await this.#child.exited;
			await Promise.all(this.#readers);
		}
		for (const request of this.requests) request.release();
		for (const release of this.#gates.values()) release();
		this.#server?.stop(true);
		this.temp[Symbol.dispose]();
	}
}

function userContent(request: ProviderRequest): string {
	if (!Array.isArray(request.body.messages)) throw new Error("Missing provider messages");
	return JSON.stringify(
		request.body.messages.filter(message => isRecord(message) && message.role === "user").slice(-1),
	);
}

for (const mode of ["rpc", "rpc-ui"] as const) {
	describe(`native external input through ${mode}`, () => {
		test("transforms a prompt once before it reaches the provider", async () => {
			const probe = new NativeInputProbe();
			try {
				await probe.start(mode);
				await probe.command({ type: "prompt", message: "rewrite:TRANSFORMED_PROMPT" });
				const request = await probe.request(0);
				expect(probe.input("rewrite:TRANSFORMED_PROMPT")).toEqual([
					{ event: "input:A", text: "rewrite:TRANSFORMED_PROMPT", source: "rpc" },
				]);
				expect(probe.events.filter(event => event.event === "input:B")).toEqual([
					{ event: "input:B", text: "TRANSFORMED_PROMPT", source: "rpc" },
				]);
				expect(userContent(request)).toContain("TRANSFORMED_PROMPT");
				expect(userContent(request)).not.toContain("rewrite:");
				await probe.finish(request);
			} finally {
				await probe.close();
			}
		}, 60000);

		test("consumes handled and transformed-empty input without commands, queues, or provider calls", async () => {
			const probe = new NativeInputProbe();
			try {
				await probe.start(mode);
				for (const type of ["prompt", "steer", "follow_up", "abort_and_prompt"] as const) {
					for (const message of ["/native-local blocked", "empty"]) {
						const before = probe.events.length;
						const response = await probe.command({ type, message });
						if (type === "prompt" || type === "abort_and_prompt") {
							expect(await probe.localResult(String(response.id))).toMatchObject({ agentInvoked: false });
						} else {
							expect(response.data).toBeUndefined();
							expect(
								probe.frames.some(frame => frame.type === "prompt_result" && frame.id === response.id),
							).toBe(false);
						}
						const input = probe.events.slice(before).filter(event => event.event === "input:A");
						expect(input).toEqual([{ event: "input:A", text: message, source: "rpc" }]);
						if (message.startsWith("/")) {
							expect(probe.events.slice(before).some(event => event.event === "input:B")).toBe(false);
						}
					}
				}
				const state = await probe.command({ type: "get_state" });
				expect(state.data).toMatchObject({ queuedMessageCount: 0, isStreaming: false, messageCount: 0 });
				expect(probe.events.some(event => event.event === "command")).toBe(false);
				expect(probe.requests).toHaveLength(0);
			} finally {
				await probe.close();
			}
		}, 60000);

		test("chains transformations and distinguishes omitted images from explicit clearing", async () => {
			const probe = new NativeInputProbe();
			const image: ImageContent = {
				type: "image",
				mimeType: "image/png",
				data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
			};
			try {
				await probe.start(mode);
				for (const row of [
					{
						text: "keep-images",
						images: [image],
						expectedText: "IMAGES_PRESERVED",
						expectedImages: [image],
						secondText: "IMAGES_PRESERVED",
					},
					{
						text: "clear-images",
						images: [image],
						expectedText: "IMAGES_CLEARED",
						expectedImages: [],
						secondText: "IMAGES_CLEARED",
					},
					{
						text: "images-only",
						images: [image],
						expectedText: "images-only",
						expectedImages: [],
						secondText: "images-only",
					},
					{
						text: "chain",
						images: [],
						expectedText: "CHAIN_FINAL",
						expectedImages: [],
						secondText: "CHAIN_STAGE",
					},
				]) {
					const index = probe.requests.length;
					const before = probe.events.length;
					await probe.command({ type: "prompt", message: row.text, images: row.images });
					const request = await probe.request(index);
					expect(probe.events.slice(before).filter(event => event.event === "input:A")).toEqual([
						{ event: "input:A", text: row.text, source: "rpc", images: row.images },
					]);
					expect(probe.events.slice(before).filter(event => event.event === "input:B")).toEqual([
						{ event: "input:B", text: row.secondText, source: "rpc", images: row.expectedImages },
					]);
					expect(userContent(request)).toContain(row.expectedText);
					expect(userContent(request).includes("image_url")).toBe(row.expectedImages.length > 0);
					await probe.finish(request);
				}
			} finally {
				await probe.close();
			}
		}, 60000);

		test("transforms before builtin, native command, skill, and template dispatch", async () => {
			const probe = new NativeInputProbe();
			const image: ImageContent = {
				type: "image",
				mimeType: "image/png",
				data: await new Bun.Image(
					Buffer.from(
						"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
						"base64",
					),
				)
					.resize(4096, 2048)
					.png()
					.toBase64(),
			};
			const normalized = (await normalizeModelContextImages([image]))?.[0];
			if (!normalized) throw new Error("Missing normalized attachment");
			expect(normalized.data).not.toBe(image.data);
			try {
				await probe.start(mode);
				const state = await probe.command({ type: "get_state" });
				if (!isRecord(state.data)) throw new Error("Missing session state");
				const builtin = await probe.command({ type: "prompt", message: "rewrite:/session info" });
				await probe.localResult(String(builtin.id));
				const output = probe.frames.find(frame => frame.type === "command_output");
				expect(String(output?.text)).toContain(String(state.data.sessionId));
				const local = await probe.command({
					type: "prompt",
					message: "rewrite:/native-local transformed-argument",
				});
				await probe.localResult(String(local.id));
				expect(probe.events.filter(event => event.event === "command")).toEqual([
					{ event: "command", args: "transformed-argument" },
				]);
				expect(probe.requests).toHaveLength(0);
				for (const row of [
					{ text: "/skill:native-probe skill-argument", body: "NATIVE_SKILL_BODY", argument: "skill-argument" },
					{
						text: "/native-template template-argument",
						body: "NATIVE_TEMPLATE_BODY",
						argument: "template-argument",
					},
				]) {
					const index = probe.requests.length;
					const response = await probe.command({
						type: "prompt",
						message: `rewrite:${row.text}`,
						images: [image],
					});
					const request = await probe.request(index);
					expect(userContent(request)).toContain(row.body);
					expect(userContent(request)).toContain(row.argument);
					expect(userContent(request)).not.toContain("rewrite:");
					expect(userContent(request)).toContain(`data:${normalized.mimeType};base64,${normalized.data}`);
					expect(probe.events.filter(event => event.event === "before_agent_start").at(-1)?.images).toEqual([
						normalized,
					]);
					expect(probe.input(`rewrite:${row.text}`)).toHaveLength(1);
					expect(probe.input(row.text)).toHaveLength(0);
					// Ack is already received while the local provider remains gated.
					expect(probe.frames.some(frame => frame.type === "prompt_result" && frame.id === response.id)).toBe(
						false,
					);
					await probe.finish(request);
				}
				expect(probe.events.filter(event => event.event === "input:A").every(event => event.source === "rpc")).toBe(
					true,
				);
			} finally {
				await probe.close();
			}
		}, 60000);

		test("reports a deleted skill through a same-id failure after prompt acknowledgement", async () => {
			const probe = new NativeInputProbe();
			try {
				await probe.start(mode);
				const commands = await probe.command({ type: "get_available_commands" });
				expect(JSON.stringify(commands.data)).toContain("native-probe");
				await fs.unlink(probe.temp.join("agent", "skills", "native-probe", "SKILL.md"));
				const response = await probe.command({ type: "prompt", message: "rewrite:/skill:native-probe" });
				const failure = await probe.wait(
					() =>
						probe.frames.find(
							frame => frame.type === "response" && frame.id === response.id && frame.success === false,
						),
					"deleted skill failure",
				);
				expect(failure.command).toBe("prompt");
				expect(String(failure.error)).toContain("SKILL.md");
				expect(probe.frames.indexOf(failure)).toBeGreaterThan(probe.frames.indexOf(response));
				expect(probe.input("rewrite:/skill:native-probe")).toHaveLength(1);
				expect(probe.requests).toHaveLength(0);
			} finally {
				await probe.close();
			}
		}, 60000);

		test("preserves explicit queue routes and never redispatches queued delivery", async () => {
			const probe = new NativeInputProbe();
			try {
				await probe.start(mode);
				await probe.command({ type: "set_interrupt_mode", mode: "wait" });
				for (const type of ["steer", "follow_up"] as const) {
					const index = probe.requests.length;
					await probe.command({ type: "prompt", message: `START_${type}` });
					const active = await probe.request(index);
					const text = type === "steer" ? "/session info" : "/skill:native-probe";
					const response = await probe.command({ type, message: `rewrite:${text}` });
					expect(response.data).toBeUndefined();
					expect((await probe.command({ type: "get_state" })).data).toMatchObject({ queuedMessageCount: 1 });
					const rejectedId = await probe.send({ type, message: "rewrite:/native-local forbidden" });
					expect(await probe.response(rejectedId)).toMatchObject({ command: type, success: false });
					active.release();
					const queued = await probe.request(index + 1);
					expect(userContent(queued)).toContain(text);
					expect(userContent(queued)).not.toContain("rewrite:");
					expect(userContent(queued)).not.toContain("NATIVE_SKILL_BODY");
					await probe.finish(queued);
					expect(probe.input(`rewrite:${text}`)).toHaveLength(1);
					expect(probe.input(text)).toHaveLength(0);
				}
				expect(probe.events.some(event => event.event === "command")).toBe(false);
				expect(probe.frames.some(frame => frame.type === "command_output")).toBe(false);
			} finally {
				await probe.close();
			}
		}, 60000);

		test("transforms streaming prompt steer and follow-up once before queue insertion", async () => {
			const probe = new NativeInputProbe();
			try {
				await probe.start(mode);
				await probe.command({ type: "set_interrupt_mode", mode: "wait" });
				for (const streamingBehavior of ["steer", "followUp"] as const) {
					const index = probe.requests.length;
					await probe.command({ type: "prompt", message: `START_${streamingBehavior}` });
					const active = await probe.request(index);
					const response = await probe.command({
						type: "prompt",
						message: `rewrite:QUEUED_${streamingBehavior}`,
						streamingBehavior,
					});
					// A following processed ingress is a deterministic barrier for prompt's async scheduling.
					await probe.command({ type: "follow_up", message: "handled" });
					expect((await probe.command({ type: "get_state" })).data).toMatchObject({ queuedMessageCount: 1 });
					active.release();
					const queued = await probe.request(index + 1);
					expect(userContent(queued)).toContain(`QUEUED_${streamingBehavior}`);
					expect(userContent(queued)).not.toContain("rewrite:");
					await probe.finish(queued);
					expect(probe.input(`rewrite:QUEUED_${streamingBehavior}`)).toHaveLength(1);
					expect(probe.input(`QUEUED_${streamingBehavior}`)).toHaveLength(0);
					expect(probe.frames.some(frame => frame.type === "prompt_result" && frame.id === response.id)).toBe(
						false,
					);
				}
			} finally {
				await probe.close();
			}
		}, 60000);

		test("preserves explicit streaming routes for prompts returned by builtins", async () => {
			const probe = new NativeInputProbe();
			try {
				await probe.start(mode);
				await probe.command({
					type: "set_host_tools",
					tools: [
						{ name: "probe_echo", description: "Probe tool", parameters: { type: "object", properties: {} } },
					],
				});
				await probe.command({ type: "set_interrupt_mode", mode: "wait" });
				for (const streamingBehavior of ["steer", "followUp"] as const) {
					const index = probe.requests.length;
					await probe.command({ type: "prompt", message: "ACTIVE_BUILTIN_TURN" });
					const active = await probe.request(index);
					await probe.command({
						type: "prompt",
						message: `rewrite:/force:probe_echo BUILTIN_${streamingBehavior}`,
						streamingBehavior,
					});
					await probe.command({ type: "follow_up", message: "handled" });
					expect((await probe.command({ type: "get_state" })).data).toMatchObject({ queuedMessageCount: 1 });
					active.release();
					const queued = await probe.request(index + 1);
					expect(userContent(queued)).toContain(`BUILTIN_${streamingBehavior}`);
					expect(userContent(queued)).not.toContain("/force:");
					await probe.finish(queued);
				}
			} finally {
				await probe.close();
			}
		}, 60000);

		test("keeps abort-and-prompt on its existing session prompt route", async () => {
			const probe = new NativeInputProbe();
			try {
				await probe.start(mode);
				for (const text of ["/session info", "/skill:native-probe"]) {
					const index = probe.requests.length;
					await probe.command({ type: "abort_and_prompt", message: `rewrite:${text}` });
					const request = await probe.request(index);
					expect(userContent(request)).toContain(text);
					expect(userContent(request)).not.toContain("NATIVE_SKILL_BODY");
					expect(userContent(request)).not.toContain("rewrite:");
					await probe.finish(request);
					expect(probe.input(`rewrite:${text}`)).toHaveLength(1);
				}
				expect(probe.frames.some(frame => frame.type === "command_output")).toBe(false);
				const local = await probe.command({
					type: "abort_and_prompt",
					message: "rewrite:/native-local existing-route",
				});
				expect(await probe.localResult(String(local.id))).toMatchObject({ agentInvoked: false });
				expect(probe.events.filter(event => event.event === "command")).toEqual([
					{ event: "command", args: "existing-route" },
				]);
			} finally {
				await probe.close();
			}
		}, 60000);

		test("attributes handler-generated work per request without redispatch or false completion", async () => {
			const probe = new NativeInputProbe();
			try {
				await probe.start(mode);
				for (const row of [
					{ text: "generated-user", body: "PROGRAMMATIC_USER" },
					{ text: "generated-custom", body: "PROGRAMMATIC_CUSTOM" },
					{ text: "/native-send", body: "PROGRAMMATIC_COMMAND" },
				]) {
					const index = probe.requests.length;
					const response = await probe.command({ type: "prompt", message: row.text });
					const request = await probe.request(index);
					expect(JSON.stringify(request.body.messages)).toContain(row.body);
					// Another local-only request overlaps the generated turn and must retain its own result.
					const local = await probe.command({ type: "prompt", message: "handled" });
					expect(await probe.localResult(String(local.id))).toMatchObject({ agentInvoked: false });
					expect(probe.frames.some(frame => frame.type === "prompt_result" && frame.id === response.id)).toBe(
						false,
					);
					await probe.finish(request);
					await probe.command({ type: "get_state" });
					expect(probe.frames.some(frame => frame.type === "prompt_result" && frame.id === response.id)).toBe(
						false,
					);
					expect(probe.input(row.text)).toHaveLength(1);
					expect(probe.input(row.body)).toHaveLength(0);
				}
			} finally {
				await probe.close();
			}
		}, 60000);

		test("aborts the active turn even when replacement is handled and preserves generated replacement work", async () => {
			const probe = new NativeInputProbe();
			try {
				await probe.start(mode);
				await probe.command({ type: "prompt", message: "FIRST_ACTIVE" });
				await probe.request(0);
				const replaced = await probe.command({ type: "abort_and_prompt", message: "handled" });
				expect(await probe.localResult(String(replaced.id))).toMatchObject({ agentInvoked: false });
				expect((await probe.command({ type: "get_state" })).data).toMatchObject({
					isStreaming: false,
					queuedMessageCount: 0,
				});
				expect(probe.requests).toHaveLength(1);
				await probe.command({ type: "prompt", message: "SECOND_ACTIVE" });
				await probe.request(1);
				const generated = await probe.command({ type: "abort_and_prompt", message: "generated-user" });
				const request = await probe.request(2);
				expect(userContent(request)).toContain("PROGRAMMATIC_USER");
				expect(probe.frames.some(frame => frame.type === "prompt_result" && frame.id === generated.id)).toBe(false);
				await probe.finish(request);
				await probe.command({ type: "get_state" });
				expect(probe.frames.some(frame => frame.type === "prompt_result" && frame.id === generated.id)).toBe(false);
				expect(probe.input("handled")).toEqual([{ event: "input:A", text: "handled", source: "rpc" }]);
				expect(probe.input("generated-user")).toEqual([
					{ event: "input:A", text: "generated-user", source: "rpc" },
				]);
				expect(probe.input("PROGRAMMATIC_USER")).toHaveLength(0);
			} finally {
				await probe.close();
			}
		}, 60000);

		test("a later abort invalidates a replacement already waiting for abort cleanup", async () => {
			const probe = new NativeInputProbe();
			try {
				await probe.start(mode);
				await probe.command({ type: "prompt", message: "HOLD_ABORT_CONTEXT" });
				const release = await probe.gate("abort-context");
				const replacement = await probe.send({
					type: "abort_and_prompt",
					message: "/native-local STALE_REPLACEMENT",
				});
				const stop = await probe.send({ type: "abort" });
				// Background bash is a reader handshake, not an ordinary command blocked by abort.
				await probe.command({ type: "bash", command: "true" });
				expect(probe.frames.some(frame => frame.type === "response" && frame.id === replacement)).toBe(false);
				release();
				expect(await probe.response(stop)).toMatchObject({ success: true });
				expect(await probe.response(replacement)).toMatchObject({ success: true });
				expect(await probe.localResult(replacement)).toMatchObject({ agentInvoked: false });
				expect(probe.events.filter(event => event.event === "command")).toEqual([]);
				expect((await probe.command({ type: "get_state" })).data).toMatchObject({
					isStreaming: false,
					queuedMessageCount: 0,
				});
				expect(probe.requests).toHaveLength(0);
			} finally {
				await probe.close();
			}
		}, 60000);

		test("only the newest replacement survives overlapping abort-and-prompt cleanup", async () => {
			const probe = new NativeInputProbe();
			try {
				await probe.start(mode);
				await probe.command({ type: "prompt", message: "HOLD_ABORT_CONTEXT" });
				const release = await probe.gate("abort-context");
				const stale = await probe.send({ type: "abort_and_prompt", message: "/native-local STALE_REPLACEMENT" });
				const current = await probe.send({ type: "abort_and_prompt", message: "rewrite:CURRENT_REPLACEMENT" });
				await probe.command({ type: "bash", command: "true" });
				release();
				expect(await probe.localResult(stale)).toMatchObject({ agentInvoked: false });
				expect(await probe.response(current)).toMatchObject({ success: true });
				const request = await probe.request(0);
				expect(userContent(request)).toContain("CURRENT_REPLACEMENT");
				expect(probe.events.filter(event => event.event === "command")).toEqual([]);
				await probe.finish(request);
			} finally {
				await probe.close();
			}
		}, 60000);

		test("drains a one-shot piped prompt through native hooks after stdin EOF", async () => {
			const probe = new NativeInputProbe();
			try {
				await probe.start(mode, [{ id: "piped", type: "prompt", message: "rewrite:PIPED_PROMPT" }]);
				const request = await probe.request(0);
				expect(userContent(request)).toContain("PIPED_PROMPT");
				expect(userContent(request)).not.toContain("rewrite:");
				request.release();
				expect(await probe.exited()).toBe(0);
				expect(probe.input("rewrite:PIPED_PROMPT")).toHaveLength(1);
			} finally {
				await probe.close();
			}
		}, 60000);

		test("EOF cancels UI-dependent ingress but drains an accepted non-UI prompt behind it", async () => {
			const probe = new NativeInputProbe();
			try {
				await probe.start(mode);
				await probe.command({ type: "prompt", message: "wait-ui:disconnect" });
				await probe.wait(
					() => probe.frames.find(frame => frame.type === "extension_ui_request" && frame.method === "confirm"),
					"pending dialog before piped prompt",
				);
				await probe.send({ type: "prompt", message: "rewrite:AFTER_DISCONNECTED_UI" });
				const exit = probe.disconnect();
				const request = await probe.request(0);
				expect(userContent(request)).toContain("AFTER_DISCONNECTED_UI");
				expect(userContent(request)).not.toContain("wait-ui:");
				expect(userContent(request)).not.toContain("AFTER_UI");
				request.release();
				expect(await exit).toBe(0);
				expect(probe.requests).toHaveLength(1);
			} finally {
				await probe.close();
			}
		}, 60000);

		test("EOF drains non-UI input even when an earlier piped handler catches its rejected dialog", async () => {
			const probe = new NativeInputProbe();
			try {
				await probe.start(mode, [
					{ id: "caught", type: "prompt", message: "caught-ui" },
					{ id: "plain", type: "prompt", message: "rewrite:PIPED_AFTER_CAUGHT_UI" },
				]);
				const request = await probe.request(0);
				expect(userContent(request)).toContain("PIPED_AFTER_CAUGHT_UI");
				expect(userContent(request)).not.toContain("CAUGHT_UI_MUST_NOT_FORWARD");
				request.release();
				expect(await probe.exited()).toBe(0);
				expect(probe.requests).toHaveLength(1);
			} finally {
				await probe.close();
			}
		}, 60000);

		for (const decision of ["commit", "cancel"] as const) {
			test(`suspends pending input during a session transition that will ${decision}`, async () => {
				const probe = new NativeInputProbe();
				try {
					await probe.start(mode);
					const armed = await probe.command({ type: "prompt", message: `/native-transition ${decision}` });
					await probe.localResult(String(armed.id));
					const pending = await probe.command({ type: "prompt", message: "wait-ui:transition" });
					const ui = await probe.wait(
						() => probe.frames.find(frame => frame.type === "extension_ui_request" && frame.method === "confirm"),
						"input dialog before transition",
					);
					const transition = await probe.send({ type: "new_session" });
					const release = await probe.gate("transition");
					await probe.send({ type: "extension_ui_response", id: String(ui.id), confirmed: true });
					await probe.wait(
						() => probe.events.find(event => event.event === "input:B" && event.text === "AFTER_UI"),
						"input hook finishes inside transition",
					);
					await probe.command({ type: "bash", command: "true" });
					expect(probe.requests).toHaveLength(0);
					release();
					expect(await probe.response(transition)).toMatchObject({
						success: true,
						data: { cancelled: decision === "cancel" },
					});
					if (decision === "cancel") {
						const request = await probe.request(0);
						expect(userContent(request)).toContain("AFTER_UI");
						await probe.finish(request);
					} else {
						expect(await probe.localResult(String(pending.id))).toMatchObject({ agentInvoked: false });
						expect((await probe.command({ type: "get_messages" })).data).toMatchObject({ messages: [] });
						expect(probe.requests).toHaveLength(0);
					}
					expect(probe.input("wait-ui:transition")).toHaveLength(1);
				} finally {
					await probe.close();
				}
			}, 60000);
		}

		for (const transitionType of ["new_session", "branch"] as const) {
			test(`abort waits for an active ${transitionType} transition before reporting completion`, async () => {
				const probe = new NativeInputProbe();
				try {
					await probe.start(mode);
					await probe.command({ type: "prompt", message: "BRANCH_SEED" });
					await probe.finish(await probe.request(0));
					const branches = await probe.command({ type: "get_branch_messages" });
					if (!isRecord(branches.data) || !Array.isArray(branches.data.messages))
						throw new Error("Missing branches");
					const entry = branches.data.messages[0];
					if (!isRecord(entry) || typeof entry.entryId !== "string") throw new Error("Missing branch entry");
					const armed = await probe.command({ type: "prompt", message: "/native-transition commit" });
					await probe.localResult(String(armed.id));
					const transition = await probe.send(
						transitionType === "branch" ? { type: "branch", entryId: entry.entryId } : { type: "new_session" },
					);
					const release = await probe.gate("transition");
					const abort = await probe.send({ type: "abort" });
					await probe.command({ type: "bash", command: "true" });
					expect(probe.frames.some(frame => frame.type === "response" && frame.id === abort)).toBe(false);
					release();
					expect(await probe.response(transition)).toMatchObject({ success: true, data: { cancelled: false } });
					expect(await probe.response(abort)).toMatchObject({ success: true });
					expect((await probe.command({ type: "get_messages" })).data).toMatchObject({ messages: [] });
					expect((await probe.command({ type: "get_state" })).data).toMatchObject({ isStreaming: false });
				} finally {
					await probe.close();
				}
			}, 60000);
		}

		test("acknowledges a delayed prompt and accepts its extension UI response", async () => {
			const probe = new NativeInputProbe();
			try {
				await probe.start(mode);
				const response = await probe.command({ type: "prompt", message: "wait-ui:prompt" });
				const ui = await probe.wait(
					() => probe.frames.find(frame => frame.type === "extension_ui_request" && frame.method === "confirm"),
					"input confirmation",
				);
				expect(probe.requests).toHaveLength(0);
				await probe.send({ type: "extension_ui_response", id: String(ui.id), confirmed: true });
				const request = await probe.request(0);
				expect(userContent(request)).toContain("AFTER_UI");
				expect(probe.events.find(event => event.event === "ui:resolved")).toMatchObject({ confirmed: true });
				expect(probe.input("wait-ui:prompt")).toHaveLength(1);
				await probe.finish(request);
				expect(probe.frames.some(frame => frame.type === "prompt_result" && frame.id === response.id)).toBe(false);
			} finally {
				await probe.close();
			}
		}, 60000);

		test("lets abort overtake delayed queue input without forwarding it after the dialog resolves", async () => {
			const probe = new NativeInputProbe();
			try {
				await probe.start(mode);
				await probe.command({ type: "prompt", message: "ACTIVE_DURING_UI" });
				await probe.request(0);
				const delayed = await probe.send({ type: "steer", message: "wait-ui:steer" });
				const ui = await probe.wait(
					() => probe.frames.find(frame => frame.type === "extension_ui_request" && frame.method === "confirm"),
					"delayed steering confirmation",
				);
				expect(probe.frames.some(frame => frame.type === "response" && frame.id === delayed)).toBe(false);
				await probe.command({ type: "abort" });
				await probe.send({ type: "extension_ui_response", id: String(ui.id), confirmed: true });
				expect(await probe.response(delayed)).toMatchObject({ command: "steer", success: true });
				expect(probe.events.find(event => event.event === "ui:resolved")).toMatchObject({ confirmed: true });
				expect((await probe.command({ type: "get_state" })).data).toMatchObject({
					isStreaming: false,
					queuedMessageCount: 0,
				});
				expect(probe.requests).toHaveLength(1);
				expect(probe.input("wait-ui:steer")).toEqual([{ event: "input:A", text: "wait-ui:steer", source: "rpc" }]);
			} finally {
				await probe.close();
			}
		}, 60000);

		test("shuts down on stdin EOF while an input handler awaits extension UI", async () => {
			const probe = new NativeInputProbe();
			try {
				await probe.start(mode);
				await probe.command({ type: "prompt", message: "wait-ui:disconnect" });
				await probe.wait(
					() => probe.frames.find(frame => frame.type === "extension_ui_request" && frame.method === "confirm"),
					"pending dialog before disconnect",
				);
				expect(await probe.disconnect()).toBe(0);
				expect(probe.requests).toHaveLength(0);
				expect(probe.input("wait-ui:disconnect")).toHaveLength(1);
			} finally {
				await probe.close();
			}
		}, 60000);
	});
}
