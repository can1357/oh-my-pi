import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, AgentBusyError, type AgentMessage, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { createAssistantMessage, createUserMessage } from "./helpers";

function userTexts(messages: readonly AgentMessage[]): string[] {
	return messages.flatMap(message => {
		if (message.role !== "user") return [];
		return typeof message.content === "string"
			? [message.content]
			: message.content.filter(block => block.type === "text").map(block => block.text);
	});
}

describe("queued message preparation", () => {
	it("prepares a fresh opening steering batch after independent gates and appends context exactly once", async () => {
		const mock = createMockModel({ handler: { content: ["done"] } });
		const agent = new Agent({ streamFn: mock.stream, initialState: { model: mock.model }, steeringMode: "all" });
		const first = createUserMessage("first");
		const second = createUserMessage("second");
		const context = createUserMessage("prepared context");
		const order: string[] = [];
		const batches: (readonly AgentMessage[])[] = [];
		const remove = agent.addBeforeQueuedMessageDequeueHook(() => {
			order.push("removed gate");
		});
		remove();
		agent.addBeforeQueuedMessageDequeueHook(() => {
			order.push("gate");
			agent.steer(second);
		});
		agent.prepareQueuedMessages = messages => {
			order.push("prepare");
			batches.push(messages);
			return {
				commit: () => {
					order.push("commit");
					agent.setSystemPrompt(["prepared policy"]);
					return [context];
				},
			};
		};
		agent.steer(first);

		await agent.continue();

		expect(order).toEqual(["gate", "prepare", "commit"]);
		expect(batches).toEqual([[first, second]]);
		expect(mock.calls).toHaveLength(1);
		expect(userTexts(mock.calls[0].context.messages)).toEqual(["first", "second", "prepared context"]);
		expect(mock.calls[0].context.systemPrompt).toEqual(["prepared policy"]);
		expect(agent.state.messages[0]).toBe(first);
		expect(agent.state.messages[1]).toBe(second);
		expect(agent.state.messages[2]).toBe(context);
		expect(agent.hasQueuedMessages()).toBe(false);
	});

	it("prepares idle follow-up batches separately in one-at-a-time mode", async () => {
		const mock = createMockModel({ handler: { content: ["done"] } });
		const agent = new Agent({ streamFn: mock.stream, initialState: { model: mock.model } });
		agent.replaceMessages([createAssistantMessage([{ type: "text", text: "ready" }])]);
		const first = createUserMessage("first");
		const second = createUserMessage("second");
		const batches: (readonly AgentMessage[])[] = [];
		agent.prepareQueuedMessages = messages => {
			batches.push(messages);
			return { commit: () => [createUserMessage(`context ${batches.length}`)] };
		};
		agent.followUp(first);
		agent.followUp(second);

		await agent.continue();

		expect(batches).toEqual([[first], [second]]);
		expect(mock.calls.map(call => userTexts(call.context.messages))).toEqual([
			["first", "context 1"],
			["first", "context 1", "second", "context 2"],
		]);
	});

	it("prepares live steering and follow-up delivery, but not the ordinary prompt", async () => {
		const mock = createMockModel({ handler: { content: ["done"] } });
		const agent = new Agent({ streamFn: mock.stream, initialState: { model: mock.model } });
		const steer = createUserMessage("steering");
		const followUp = createUserMessage("follow-up");
		const prepared: string[][] = [];
		agent.prepareQueuedMessages = messages => {
			prepared.push(userTexts(messages));
			return { commit: () => [createUserMessage(`context ${prepared.length}`)] };
		};
		const unsubscribe = agent.subscribe(event => {
			if (event.type !== "turn_end") return;
			unsubscribe();
			agent.steer(steer);
			agent.followUp(followUp);
		});

		await agent.prompt("ordinary");

		expect(prepared).toEqual([["steering"], ["follow-up"]]);
		expect(mock.calls.map(call => userTexts(call.context.messages))).toEqual([
			["ordinary"],
			["ordinary", "steering", "context 1", "follow-up", "context 2"],
		]);
	});

	it.each(["abort", "throw", "replace"] as const)(
		"restores only owned earlier batches when later preparation ends with %s",
		async failure => {
			const mock = createMockModel({ handler: { content: ["done"] } });
			const agent = new Agent({
				streamFn: mock.stream,
				initialState: { model: mock.model },
				steeringMode: "all",
				followUpMode: "all",
			});
			const steering = createUserMessage("late steering");
			const followUp = createUserMessage("following batch");
			const laterSteering = createUserMessage("newer steering");
			const laterFollowUp = createUserMessage("newer follow-up");
			const started = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			agent.setOnBeforeYield(() => {
				agent.setOnBeforeYield(undefined);
				agent.steer(steering);
				agent.steer(steering);
				agent.followUp(followUp);
			});
			agent.prepareQueuedMessages = async messages => {
				if (messages.includes(steering))
					return { commit: () => [createUserMessage("undelivered generated context")] };
				started.resolve();
				await release.promise;
				if (failure === "throw") throw new Error("later preparation failed");
				return { commit: () => [] };
			};
			const running = agent.prompt("ordinary");
			await started.promise;
			agent.steer(laterSteering);
			agent.followUp(laterFollowUp);
			if (failure === "replace") agent.replaceQueues([laterSteering], [laterFollowUp]);
			if (failure !== "throw") agent.abort();
			release.resolve();
			await running;

			expect(userTexts(agent.state.messages)).toEqual(["ordinary"]);
			expect(agent.peekSteeringQueue()).toEqual(
				failure === "replace" ? [laterSteering] : [steering, steering, laterSteering],
			);
			expect(agent.peekFollowUpQueue()).toEqual(failure === "replace" ? [laterFollowUp] : [followUp, laterFollowUp]);
			agent.prepareQueuedMessages = undefined;
			await agent.continue();
			expect(userTexts(mock.calls.at(-1)!.context.messages)).toEqual([
				"ordinary",
				...(failure === "replace" ? [] : ["late steering", "late steering"]),
				"newer steering",
				...(failure === "replace" ? [] : ["following batch"]),
				"newer follow-up",
			]);
			expect(agent.state.messages.filter(message => message === steering)).toHaveLength(
				failure === "replace" ? 0 : 2,
			);
			expect(agent.state.messages.filter(message => message === followUp)).toHaveLength(
				failure === "replace" ? 0 : 1,
			);
			expect(agent.hasQueuedMessages()).toBe(false);
		},
	);

	it("restores an aborted idle claim ahead of new enqueues without committing stale context", async () => {
		const mock = createMockModel({ handler: { content: ["done"] } });
		const agent = new Agent({ streamFn: mock.stream, initialState: { model: mock.model }, followUpMode: "all" });
		const started = Promise.withResolvers<AbortSignal>();
		const release = Promise.withResolvers<void>();
		let commits = 0;
		agent.prepareQueuedMessages = async (_messages, signal) => {
			started.resolve(signal);
			await release.promise;
			return {
				commit: () => {
					commits++;
					return [createUserMessage("stale")];
				},
			};
		};
		const first = createUserMessage("first");
		const second = createUserMessage("second");
		const later = createUserMessage("later");
		agent.followUp(first);
		agent.followUp(second);
		const running = agent.continue();
		const outcome = running.catch(error => error);
		const signal = await started.promise;
		expect(agent.hasQueuedMessages()).toBe(true);
		await expect(agent.continue()).rejects.toBeInstanceOf(AgentBusyError);
		agent.followUp(later);
		agent.abort();
		expect(signal.aborted).toBe(true);
		release.resolve();
		await outcome;

		expect(commits).toBe(0);
		expect(mock.calls).toHaveLength(0);
		expect(agent.peekFollowUpQueue()).toEqual([first, second, later]);
		expect(agent.state.messages).toEqual([]);
		agent.prepareQueuedMessages = undefined;
		await agent.continue();
		expect(userTexts(mock.calls[0].context.messages)).toEqual(["first", "second", "later"]);
		expect(agent.state.messages[0]).toBe(first);
		expect(agent.state.messages[1]).toBe(second);
	});

	it("restores a live claim on preparation failure and preserves it for the next run", async () => {
		const mock = createMockModel({ handler: { content: ["done"] } });
		const agent = new Agent({ streamFn: mock.stream, initialState: { model: mock.model }, steeringMode: "all" });
		const original = createUserMessage("retry me");
		const later = createUserMessage("later");
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		agent.prepareQueuedMessages = async () => {
			started.resolve();
			await release.promise;
			throw new Error("preparation failed");
		};
		agent.steer(original);
		const running = agent.prompt("ordinary");
		await started.promise;
		agent.steer(later);
		release.resolve();
		await running;

		expect(mock.calls).toHaveLength(0);
		expect(agent.peekSteeringQueue()).toEqual([original, later]);
		expect(userTexts(agent.state.messages)).toEqual(["ordinary"]);
		agent.prepareQueuedMessages = undefined;
		await agent.continue();
		expect(userTexts(mock.calls[0].context.messages)).toEqual(["ordinary", "retry me", "later"]);
	});

	it("clearing a claimed steering queue aborts preparation and never resurrects it", async () => {
		const mock = createMockModel({ handler: { content: ["done"] } });
		const agent = new Agent({ streamFn: mock.stream, initialState: { model: mock.model } });
		const started = Promise.withResolvers<AbortSignal>();
		const release = Promise.withResolvers<void>();
		let commits = 0;
		agent.prepareQueuedMessages = async (_messages, signal) => {
			started.resolve(signal);
			await release.promise;
			return {
				commit: () => {
					commits++;
					return [];
				},
			};
		};
		agent.steer(createUserMessage("cancelled"));
		const running = agent.prompt("ordinary");
		const signal = await started.promise;
		agent.clearSteeringQueue();
		expect(signal.aborted).toBe(true);
		release.resolve();
		await running;

		expect(commits).toBe(0);
		expect(agent.peekSteeringQueue()).toEqual([]);
		expect(userTexts(mock.calls[0].context.messages)).toEqual(["ordinary"]);
	});

	it("queue replacement promotes a claimed follow-up without allowing its stale commit", async () => {
		const mock = createMockModel({ handler: { content: ["done"] } });
		const agent = new Agent({ streamFn: mock.stream, initialState: { model: mock.model } });
		const original = createUserMessage("promoted");
		const started = Promise.withResolvers<AbortSignal>();
		const release = Promise.withResolvers<void>();
		let commits = 0;
		agent.prepareQueuedMessages = async (_messages, signal) => {
			started.resolve(signal);
			await release.promise;
			return {
				commit: () => {
					commits++;
					return [];
				},
			};
		};
		agent.followUp(original);
		const outcome = agent.continue().catch(error => error);
		const signal = await started.promise;
		agent.replaceQueues([...agent.peekFollowUpQueue()], []);
		expect(signal.aborted).toBe(true);
		release.resolve();
		await outcome;

		expect(commits).toBe(0);
		expect(agent.peekFollowUpQueue()).toEqual([]);
		expect(agent.peekSteeringQueue()).toEqual([original]);
		agent.prepareQueuedMessages = undefined;
		await agent.continue();
		expect(userTexts(mock.calls[0].context.messages)).toEqual(["promoted"]);
	});

	it("LIFO editor restoration removes claimed originals and preserves the rest of the batch", async () => {
		const mock = createMockModel({ handler: { content: ["done"] } });
		const agent = new Agent({ streamFn: mock.stream, initialState: { model: mock.model }, followUpMode: "all" });
		const first = createUserMessage("first");
		const second = createUserMessage("second");
		const later = createUserMessage("later");
		const started = Promise.withResolvers<AbortSignal>();
		const release = Promise.withResolvers<void>();
		let commits = 0;
		agent.prepareQueuedMessages = async (_messages, signal) => {
			started.resolve(signal);
			await release.promise;
			return {
				commit: () => {
					commits++;
					return [];
				},
			};
		};
		agent.followUp(first);
		agent.followUp(second);
		const outcome = agent.continue().catch(error => error);
		const signal = await started.promise;
		agent.followUp(later);
		expect(agent.popLastFollowUp()).toBe(later);
		expect(signal.aborted).toBe(false);
		expect(agent.popLastFollowUp()).toBe(second);
		expect(signal.aborted).toBe(true);
		release.resolve();
		await outcome;

		expect(commits).toBe(0);
		expect(agent.peekFollowUpQueue()).toEqual([first]);
		agent.prepareQueuedMessages = undefined;
		await agent.continue();
		expect(userTexts(mock.calls[0].context.messages)).toEqual(["first"]);
	});

	it("reset cancels a live preparation without contaminating a successor prompt", async () => {
		const mock = createMockModel({ handler: { content: ["done"] } });
		const agent = new Agent({ streamFn: mock.stream, initialState: { model: mock.model } });
		const started = Promise.withResolvers<AbortSignal>();
		const release = Promise.withResolvers<void>();
		let commits = 0;
		agent.prepareQueuedMessages = async (_messages, signal) => {
			started.resolve(signal);
			await release.promise;
			return {
				commit: () => {
					commits++;
					return [createUserMessage("stale")];
				},
			};
		};
		agent.steer(createUserMessage("cancelled"));
		const oldRun = agent.prompt("old prompt");
		const signal = await started.promise;
		agent.reset();
		expect(signal.aborted).toBe(true);
		agent.prepareQueuedMessages = undefined;
		await agent.prompt("new prompt");
		release.resolve();
		await oldRun;

		expect(commits).toBe(0);
		expect(mock.calls).toHaveLength(1);
		expect(userTexts(mock.calls[0].context.messages)).toEqual(["new prompt"]);
		expect(userTexts(agent.state.messages)).toEqual(["new prompt"]);
		expect(agent.state.messages.map(message => message.role)).toEqual(["user", "assistant"]);
		expect(agent.hasQueuedMessages()).toBe(false);
	});

	it("preserves handlerless delivery, undefined preparations, and successful empty additions", async () => {
		const mock = createMockModel({ handler: { content: ["done"] } });
		const agent = new Agent({ streamFn: mock.stream, initialState: { model: mock.model } });
		agent.followUp(createUserMessage("handlerless"));
		await agent.continue();
		agent.prepareQueuedMessages = () => undefined;
		agent.followUp(createUserMessage("unchanged"));
		await agent.continue();
		agent.prepareQueuedMessages = () => ({ commit: () => [] });
		agent.followUp(createUserMessage("empty additions"));
		await agent.continue();

		expect(mock.calls.map(call => userTexts(call.context.messages))).toEqual([
			["handlerless"],
			["handlerless", "unchanged"],
			["handlerless", "unchanged", "empty additions"],
		]);
		expect(agent.hasQueuedMessages()).toBe(false);
	});

	it("does not prepare a steering peek until the running tool reaches its delivery boundary", async () => {
		const toolStarted = Promise.withResolvers<void>();
		const releaseTool = Promise.withResolvers<void>();
		const parameters = type({});
		const queued = createUserMessage("queued during tool");
		let preparations = 0;
		const tool: AgentTool<typeof parameters> = {
			name: "wait",
			label: "Wait",
			description: "Wait for release",
			parameters,
			async execute() {
				agent.steer(queued);
				toolStarted.resolve();
				await releaseTool.promise;
				return { content: [{ type: "text", text: "released" }], details: {} };
			},
		};
		const mock = createMockModel({
			responses: [
				{ content: [{ type: "toolCall", id: "wait-1", name: "wait", arguments: {} }] },
				{ content: ["done"] },
			],
		});
		const agent = new Agent({ streamFn: mock.stream, initialState: { model: mock.model, tools: [tool] } });
		agent.prepareQueuedMessages = () => {
			preparations++;
			return { commit: () => [createUserMessage("prepared after tool")] };
		};
		const running = agent.prompt("start");
		await toolStarted.promise;
		expect(agent.peekSteeringQueue()).toEqual([queued]);
		expect(preparations).toBe(0);
		releaseTool.resolve();
		await running;

		expect(preparations).toBe(1);
		expect(mock.calls).toHaveLength(2);
		expect(userTexts(mock.calls[1].context.messages)).toEqual(["start", "queued during tool", "prepared after tool"]);
		expect(mock.calls[1].context.messages.some(message => message.role === "toolResult")).toBe(true);
	});

	it("does not prepare a batch cleared by a before-dequeue gate", async () => {
		const mock = createMockModel({ handler: { content: ["done"] } });
		const agent = new Agent({ streamFn: mock.stream, initialState: { model: mock.model } });
		let preparations = 0;
		agent.prepareQueuedMessages = () => {
			preparations++;
			return { commit: () => [] };
		};
		agent.addBeforeQueuedMessageDequeueHook(() => agent.clearSteeringQueue());
		agent.steer(createUserMessage("cancelled before claim"));

		await agent.prompt("ordinary");

		expect(preparations).toBe(0);
		expect(userTexts(mock.calls[0].context.messages)).toEqual(["ordinary"]);
	});

	it("aborting live follow-up preparation leaves the original for a later response", async () => {
		const mock = createMockModel({ handler: { content: ["done"] } });
		const agent = new Agent({ streamFn: mock.stream, initialState: { model: mock.model } });
		const started = Promise.withResolvers<AbortSignal>();
		const release = Promise.withResolvers<void>();
		const original = createUserMessage("follow-up");
		let commits = 0;
		agent.prepareQueuedMessages = async (_messages, signal) => {
			started.resolve(signal);
			await release.promise;
			return {
				commit: () => {
					commits++;
					return [];
				},
			};
		};
		agent.followUp(original);
		const running = agent.prompt("ordinary");
		const signal = await started.promise;
		agent.abort();
		expect(signal.aborted).toBe(true);
		release.resolve();
		await running;

		expect(commits).toBe(0);
		expect(mock.calls).toHaveLength(1);
		expect(userTexts(agent.state.messages)).toEqual(["ordinary"]);
		expect(agent.peekFollowUpQueue()).toEqual([original]);
		agent.prepareQueuedMessages = undefined;
		await agent.continue();
		expect(userTexts(mock.calls[1].context.messages)).toEqual(["ordinary", "follow-up"]);
	});

	for (const clear of ["clearFollowUpQueue", "clearAllQueues"] as const) {
		it(`${clear} cancels a pending follow-up with the correct cross-queue scope`, async () => {
			const mock = createMockModel({ handler: { content: ["done"] } });
			const agent = new Agent({ streamFn: mock.stream, initialState: { model: mock.model } });
			const started = Promise.withResolvers<AbortSignal>();
			const release = Promise.withResolvers<void>();
			let commits = 0;
			agent.prepareQueuedMessages = async (_messages, signal) => {
				started.resolve(signal);
				await release.promise;
				return {
					commit: () => {
						commits++;
						return [];
					},
				};
			};
			agent.followUp(createUserMessage("cancelled"));
			const outcome = agent.continue().catch(error => error);
			const signal = await started.promise;
			const steering = createUserMessage("independent steering");
			agent.steer(steering);
			agent[clear]();
			expect(signal.aborted).toBe(true);
			release.resolve();
			await outcome;

			expect(commits).toBe(0);
			expect(mock.calls).toHaveLength(0);
			expect(agent.peekFollowUpQueue()).toEqual([]);
			expect(agent.peekSteeringQueue()).toEqual(clear === "clearAllQueues" ? [] : [steering]);
		});
	}

	it("a cancelled commit retains originals and unwinds instead of immediately preparing them again", async () => {
		const mock = createMockModel({ handler: { content: ["done"] } });
		const agent = new Agent({ streamFn: mock.stream, initialState: { model: mock.model } });
		const original = createUserMessage("retry after cancellation");
		let preparations = 0;
		agent.prepareQueuedMessages = () => {
			preparations++;
			return { commit: () => undefined };
		};
		agent.steer(original);
		await agent.prompt("ordinary");

		expect(preparations).toBe(1);
		expect(mock.calls).toHaveLength(0);
		expect(agent.peekSteeringQueue()).toEqual([original]);
		expect(userTexts(agent.state.messages)).toEqual(["ordinary"]);
		agent.prepareQueuedMessages = undefined;
		await agent.continue();
		expect(userTexts(mock.calls[0].context.messages)).toEqual(["ordinary", "retry after cancellation"]);
	});

	it("a throwing synchronous commit restores the idle claim rather than losing user work", async () => {
		const mock = createMockModel({ handler: { content: ["done"] } });
		const agent = new Agent({ streamFn: mock.stream, initialState: { model: mock.model } });
		const original = createUserMessage("retry failed commit");
		agent.prepareQueuedMessages = () => ({
			commit: () => {
				throw new Error("commit failed");
			},
		});
		agent.followUp(original);

		await expect(agent.continue()).rejects.toThrow("commit failed");

		expect(agent.peekFollowUpQueue()).toEqual([original]);
		expect(mock.calls).toHaveLength(0);
		agent.prepareQueuedMessages = undefined;
		await agent.continue();
		expect(userTexts(mock.calls[0].context.messages)).toEqual(["retry failed commit"]);
	});

	it("prepares fresh follow-ups and later idle steering without replaying prior batches", async () => {
		const mock = createMockModel({ handler: { content: ["done"] } });
		const agent = new Agent({ streamFn: mock.stream, initialState: { model: mock.model } });
		const prepared: string[][] = [];
		agent.prepareQueuedMessages = messages => {
			prepared.push(userTexts(messages));
			return { commit: () => [createUserMessage(`context ${prepared.length}`)] };
		};
		agent.followUp(createUserMessage("opening follow-up"));
		await agent.continue();
		agent.steer(createUserMessage("idle steering"));
		await agent.continue();

		expect(prepared).toEqual([["opening follow-up"], ["idle steering"]]);
		expect(mock.calls.map(call => userTexts(call.context.messages))).toEqual([
			["opening follow-up", "context 1"],
			["opening follow-up", "context 1", "idle steering", "context 2"],
		]);
	});
});
