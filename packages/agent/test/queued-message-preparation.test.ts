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

interface QueueView {
	steering: AgentMessage[];
	followUp: AgentMessage[];
	liveSteered: AgentMessage[];
}

/** The queue display's source of truth: pending queue contents plus live steering
 *  the provider already holds. Listeners recompute this on every notification. */
function queueView(agent: Agent): QueueView {
	return {
		steering: [...agent.peekSteeringQueue()],
		followUp: [...agent.peekFollowUpQueue()],
		liveSteered: [...agent.peekLiveSteeredMessages()],
	};
}

function trackQueueViews(agent: Agent): { views: QueueView[]; latest: () => QueueView | undefined } {
	const views: QueueView[] = [];
	agent.onQueueChange(() => views.push(queueView(agent)));
	return { views, latest: () => views.at(-1) };
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

	it.each(["steering", "followUp"] as const)(
		"does not leave a stale queue notification listing a delivered batch when a later %s arrives during preparation",
		async queue => {
			const mock = createMockModel({ handler: { content: ["done"] } });
			const agent = new Agent({
				streamFn: mock.stream,
				initialState: { model: mock.model },
				steeringMode: "all",
				followUpMode: "all",
			});
			const first = createUserMessage("first");
			const second = createUserMessage("second");
			const later = createUserMessage("later");
			const enqueue = (message: AgentMessage) =>
				queue === "steering" ? agent.steer(message) : agent.followUp(message);
			const peek = () => (queue === "steering" ? agent.peekSteeringQueue() : agent.peekFollowUpQueue());
			const otherPeek = () => (queue === "steering" ? agent.peekFollowUpQueue() : agent.peekSteeringQueue());
			const tracked = trackQueueViews(agent);
			const started = Promise.withResolvers<void>();
			const releasePreparation = Promise.withResolvers<void>();
			const atFirstModelCall = Promise.withResolvers<void>();
			const releaseModel = Promise.withResolvers<void>();
			const prepared: string[][] = [];
			agent.prepareQueuedMessages = async messages => {
				prepared.push(userTexts(messages));
				if (prepared.length === 1) {
					started.resolve();
					await releasePreparation.promise;
				}
				return { commit: () => [createUserMessage(`prepared ${prepared.length}`)] };
			};
			let modelCalls = 0;
			agent.addBeforeModelCallHook(async () => {
				if (modelCalls++ > 0) return;
				atFirstModelCall.resolve();
				await releaseModel.promise;
			});
			enqueue(first);
			enqueue(second);
			const running = agent.continue();
			await started.promise;

			let assertionFailed = false;
			try {
				// The claim must be visible before the later enqueue: a notification
				// emitted before the claim is installed would leave an empty snapshot
				// that the enqueue below then contradicts.
				expect(peek()).toEqual([first, second]);
				expect(tracked.latest()).toEqual(queueView(agent));

				enqueue(later);
				expect(peek()).toEqual([first, second, later]);
				expect(otherPeek()).toEqual([]);
				expect(tracked.latest()).toEqual(queueView(agent));
				expect(prepared).toEqual([["first", "second"]]);

				releasePreparation.resolve();
				await atFirstModelCall.promise;

				// The batch committed; the new notification must show only `later`,
				// never resurrect the two originals that are already on their way to
				// the transcript.
				expect(prepared).toEqual([["first", "second"]]);
				expect(mock.calls).toHaveLength(0);
				expect(peek()).toEqual([later]);
				expect(otherPeek()).toEqual([]);
				const committedView = tracked.latest();
				expect(committedView).toEqual(queueView(agent));
				expect([...(committedView?.steering ?? []), ...(committedView?.followUp ?? [])]).not.toContain(first);
				expect([...(committedView?.steering ?? []), ...(committedView?.followUp ?? [])]).not.toContain(second);

				releaseModel.resolve();
				await running;

				expect(prepared).toEqual([["first", "second"], ["later"]]);
				expect(mock.calls.map(call => userTexts(call.context.messages))).toEqual([
					["first", "second", "prepared 1"],
					["first", "second", "prepared 1", "later", "prepared 2"],
				]);
				expect(agent.state.messages.map(message => message.role)).toEqual([
					"user",
					"user",
					"user",
					"assistant",
					"user",
					"user",
					"assistant",
				]);
				expect(agent.state.messages.filter(message => message === first)).toHaveLength(1);
				expect(agent.state.messages.filter(message => message === second)).toHaveLength(1);
				expect(agent.state.messages.filter(message => message === later)).toHaveLength(1);
				expect(userTexts(agent.state.messages)).toEqual(["first", "second", "prepared 1", "later", "prepared 2"]);
				expect(queueView(agent)).toEqual({ steering: [], followUp: [], liveSteered: [] });
				expect(tracked.latest()).toEqual(queueView(agent));
				expect(agent.peekUndeliveredQueuedMessages()).toEqual([]);
				expect(agent.hasQueuedMessages()).toBe(false);
			} catch (error) {
				assertionFailed = true;
				throw error;
			} finally {
				releasePreparation.resolve();
				releaseModel.resolve();
				await running.catch(error => {
					if (!assertionFailed) throw error;
				});
			}
		},
	);

	it("notifies an accurate pending view on the no-preparation fast path and records delivered messages once", async () => {
		const mock = createMockModel({ handler: { content: ["done"] } });
		const agent = new Agent({
			streamFn: mock.stream,
			initialState: { model: mock.model },
			steeringMode: "all",
			followUpMode: "all",
		});
		const tracked = trackQueueViews(agent);
		const steering = createUserMessage("fast steering");
		const followUp = createUserMessage("fast follow-up");
		agent.steer(steering);
		agent.followUp(followUp);

		await agent.continue();

		expect(mock.calls.map(call => userTexts(call.context.messages))).toEqual([
			["fast steering"],
			["fast steering", "fast follow-up"],
		]);
		expect(userTexts(agent.state.messages)).toEqual(["fast steering", "fast follow-up"]);
		expect(agent.state.messages.filter(message => message === steering)).toHaveLength(1);
		expect(agent.state.messages.filter(message => message === followUp)).toHaveLength(1);
		expect(queueView(agent)).toEqual({ steering: [], followUp: [], liveSteered: [] });
		expect(tracked.latest()).toEqual(queueView(agent));
		expect(agent.peekUndeliveredQueuedMessages()).toEqual([]);
		expect(agent.hasQueuedMessages()).toBe(false);

		// Once the fast path has drained both queues, a normal run must not
		// restore anything it already recorded (no message reappears in a later
		// notification).
		const firstEmpty = tracked.views.findIndex(
			view => view.steering.length === 0 && view.followUp.length === 0 && view.liveSteered.length === 0,
		);
		expect(firstEmpty).toBeGreaterThanOrEqual(0);
		expect(
			tracked.views
				.slice(firstEmpty)
				.every(view => view.steering.length === 0 && view.followUp.length === 0 && view.liveSteered.length === 0),
		).toBe(true);
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
			const tracked = trackQueueViews(agent);
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
			expect(tracked.latest()).toEqual(queueView(agent));
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
			expect(agent.state.messages.filter(message => message === laterSteering)).toHaveLength(1);
			expect(agent.state.messages.filter(message => message === laterFollowUp)).toHaveLength(1);
			expect(agent.hasQueuedMessages()).toBe(false);
			expect(queueView(agent)).toEqual({ steering: [], followUp: [], liveSteered: [] });
			expect(tracked.latest()).toEqual(queueView(agent));
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

	it("single-queue replacement cancels the live claim it filtered a message out of", async () => {
		const mock = createMockModel({ handler: { content: ["done"] } });
		const agent = new Agent({ streamFn: mock.stream, initialState: { model: mock.model } });
		const original = createUserMessage("removed while claimed");
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
		// The removal path peeks (the peek prepends the claimed batch), drops the
		// target, and installs the rest. The claim must not survive that and
		// deliver the removed message anyway.
		agent.replaceQueue(
			"followUp",
			agent.peekFollowUpQueue().filter(message => message !== original),
		);
		expect(signal.aborted).toBe(true);
		release.resolve();
		await outcome;

		expect(commits).toBe(0);
		expect(agent.peekFollowUpQueue()).toEqual([]);
		expect(mock.calls.flatMap(call => userTexts(call.context.messages))).not.toContain("removed while claimed");
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
		const tracked = trackQueueViews(agent);
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
		expect(tracked.latest()).toEqual(queueView(agent));
		agent.prepareQueuedMessages = undefined;
		await agent.continue();
		expect(userTexts(mock.calls[1].context.messages)).toEqual(["ordinary", "follow-up"]);
		expect(agent.state.messages.filter(message => message === original)).toHaveLength(1);
		expect(queueView(agent)).toEqual({ steering: [], followUp: [], liveSteered: [] });
		expect(tracked.latest()).toEqual(queueView(agent));
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

	it("withdrawn batches stay out of the aborted run but a later run records them", async () => {
		// Esc between dequeue and the next model call: the aborted run records neither the withdrawn
		// input nor its prepared context — in the transcript or in agent_end — yet the same message
		// queued again is a later run's input.
		const mock = createMockModel({ handler: { content: ["done"] } });
		const agent = new Agent({ streamFn: mock.stream, initialState: { model: mock.model }, steeringMode: "all" });
		const first = createUserMessage("first steer");
		const second = createUserMessage("second steer");
		const followUp = createUserMessage("follow-up");
		agent.setOnBeforeYield(() => {
			agent.setOnBeforeYield(undefined);
			agent.steer(first);
			agent.steer(second);
			agent.followUp(followUp);
		});
		agent.prepareQueuedMessages = messages => ({
			commit: () => [createUserMessage(`context for ${userTexts(messages).join(" + ")}`)],
		});
		const reached = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let calls = 0;
		const removeGate = agent.addBeforeModelCallHook(async () => {
			if (calls++ === 0) return;
			reached.resolve();
			await release.promise;
		});
		const ends: AgentMessage[][] = [];
		agent.subscribe(event => {
			if (event.type === "agent_end") ends.push(event.messages);
		});
		const running = agent.prompt("ordinary");
		await reached.promise;

		expect(agent.withdrawUndeliveredQueuedMessages()).toEqual({ steering: [first, second], followUp: [followUp] });
		agent.abort();
		release.resolve();
		await running;
		removeGate();

		expect(userTexts(agent.state.messages)).toEqual(["ordinary"]);
		expect(userTexts(ends[0])).toEqual(["ordinary"]);
		expect(agent.hasQueuedMessages()).toBe(false);

		agent.prepareQueuedMessages = undefined;
		agent.steer(first);
		await agent.continue();
		expect(userTexts(agent.state.messages)).toEqual(["ordinary", "first steer"]);
		expect(ends[1]).toContain(first);
	});
});

describe("queued message gate", () => {
	it("drops the candidates it vetoes and delivers the recomputed batch", async () => {
		const mock = createMockModel({ handler: { content: ["done"] } });
		const agent = new Agent({ streamFn: mock.stream, initialState: { model: mock.model } });
		agent.replaceMessages([createAssistantMessage([{ type: "text", text: "ready" }])]);
		const first = createUserMessage("first");
		const second = createUserMessage("second");
		const candidates: AgentMessage[][] = [];
		const released: AgentMessage[] = [];
		agent.queuedMessageGate = {
			claim: (queue, batch) => {
				expect(queue).toBe("followUp");
				candidates.push([...batch]);
				return batch.filter(message => message === first);
			},
			release: messages => released.push(...messages),
		};
		agent.followUp(first);
		agent.followUp(second);

		await agent.continue();

		expect(candidates).toEqual([[first], [second]]);
		expect(released).toEqual([]);
		expect(mock.calls.map(call => userTexts(call.context.messages))).toEqual([["second"]]);
		expect(agent.hasQueuedMessages()).toBe(false);
	});

	it("releases what it claimed when the final batch no longer holds it", async () => {
		const mock = createMockModel({ handler: { content: ["done"] } });
		const agent = new Agent({ streamFn: mock.stream, initialState: { model: mock.model } });
		agent.replaceMessages([createAssistantMessage([{ type: "text", text: "ready" }])]);
		const lead = createUserMessage("lead");
		const vetoed = createUserMessage("vetoed");
		const tail = createUserMessage("tail");
		// One delivery unit while `vetoed` sits between the others; `lead` and `tail` alone are separate units.
		agent.setQueuedMessageGrouping((previous, next) => (previous === lead && next === vetoed) || previous === vetoed);
		const released: AgentMessage[] = [];
		agent.queuedMessageGate = {
			claim: (_queue, batch) => batch.filter(message => message === vetoed),
			release: messages => released.push(...messages),
		};
		agent.followUp(lead);
		agent.followUp(vetoed);
		agent.followUp(tail);

		await agent.continue();

		expect(released).toEqual([tail]);
		expect(mock.calls.map(call => userTexts(call.context.messages))).toEqual([["lead"], ["lead", "tail"]]);
	});

	it("releases a claimed batch that goes back to its queue undelivered", async () => {
		const mock = createMockModel({ handler: { content: ["done"] } });
		const agent = new Agent({ streamFn: mock.stream, initialState: { model: mock.model } });
		agent.replaceMessages([createAssistantMessage([{ type: "text", text: "ready" }])]);
		const first = createUserMessage("first");
		const released: AgentMessage[][] = [];
		const preparing = Promise.withResolvers<void>();
		agent.queuedMessageGate = { claim: () => [], release: messages => released.push([...messages]) };
		agent.prepareQueuedMessages = async (_messages, signal) => {
			preparing.resolve();
			const { promise, resolve } = Promise.withResolvers<void>();
			signal.addEventListener("abort", () => resolve(), { once: true });
			await promise;
			return undefined;
		};
		agent.followUp(first);
		const running = agent.continue();
		await preparing.promise;

		expect(agent.popLastFollowUp()).toBe(first);
		// Nothing is left to continue with once the only follow-up is taken back.
		await expect(running).rejects.toThrow("Cannot continue");

		expect(released).toEqual([[first]]);
		expect(mock.calls).toHaveLength(0);
	});
});
