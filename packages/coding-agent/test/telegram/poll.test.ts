import { describe, expect, it } from "bun:test";
import { TelegramApiError } from "../../src/telegram/api";
import { ALLOWED_UPDATES, createPoller } from "../../src/telegram/poll";
import type { TelegramApi, TelegramBotCommand, TelegramPoller, TelegramUpdate } from "../../src/telegram/types";

const commands: readonly TelegramBotCommand[] = [{ command: "new", description: "new session" }];

/** Poll API whose `getUpdates` blocks until the poller aborts, as the real long poll does. */
function blockingApi(
	overrides: {
		setMyCommands?: () => Promise<boolean>;
		onGetUpdates?: (params: { offset?: number }) => TelegramUpdate[] | null;
		onCall?: (params: { offset?: number }) => void;
	} = {},
) {
	const calls: Array<{ offset?: number; timeout?: number; allowedUpdates?: readonly string[] }> = [];
	const started = Promise.withResolvers<void>();
	const api = {
		setMyCommands: overrides.setMyCommands ?? (async () => true),
		getUpdates: async (
			params: { offset?: number; timeout?: number; allowedUpdates?: readonly string[] },
			signal?: AbortSignal,
		) => {
			calls.push(params);
			started.resolve();
			overrides.onCall?.(params);
			const answer = overrides.onGetUpdates?.(params);
			if (answer !== null && answer !== undefined) return answer;
			if (signal?.aborted === true) return [];
			const { promise, resolve } = Promise.withResolvers<void>();
			signal?.addEventListener("abort", () => resolve(), { once: true });
			await promise;
			return [];
		},
	} as unknown as TelegramApi;
	return { calls, api, started: started.promise };
}

describe("TelegramPoller", () => {
	it("ends the loop from a backoff sleep without waiting it out", async () => {
		const sleeps: number[] = [];
		const held: Array<() => void> = [];
		const paused = Promise.withResolvers<void>();
		let attempts = 0;
		const api = {
			setMyCommands: async () => true,
			getUpdates: async () => {
				attempts += 1;
				throw new TelegramApiError("getUpdates", { code: 500, description: "Internal Server Error" });
			},
		} as unknown as TelegramApi;
		const poller = createPoller({
			api,
			commands,
			handleUpdate: async () => undefined,
			sleep: (ms: number, signal: AbortSignal) => {
				sleeps.push(ms);
				paused.resolve();
				if (signal.aborted) return Promise.resolve();
				const { promise, resolve } = Promise.withResolvers<void>();
				held.push(resolve);
				signal.addEventListener("abort", () => resolve(), { once: true });
				return promise;
			},
		});
		const answer = poller.run();
		await paused.promise;
		expect(held.length).toBe(1);
		poller.stop();
		await answer;
		expect(attempts).toBe(1);
		expect(sleeps).toEqual([1000]);
	});

	it("asks Telegram for the draft-stop event", async () => {
		const asked: Array<readonly string[] | undefined> = [];
		let poller: TelegramPoller | null = null;
		const api = {
			setMyCommands: async () => true,
			getUpdates: async (params: { allowedUpdates?: readonly string[] }) => {
				asked.push(params.allowedUpdates);
				poller?.stop();
				return [];
			},
		} as unknown as TelegramApi;
		poller = createPoller({ api, commands, handleUpdate: async () => undefined });
		await poller.run();
		expect(asked[0]).toEqual(["message", "callback_query", "stopped_message_generation"]);
		expect(ALLOWED_UPDATES).toContain("stopped_message_generation");
	});

	it("rejects run() on a 409 conflict, naming the other getUpdates consumer", async () => {
		const api = {
			setMyCommands: async () => true,
			getUpdates: async () => {
				throw new TelegramApiError("getUpdates", {
					code: 409,
					description:
						"Conflict: terminated by other getUpdates request; make sure that only one bot instance is running",
				});
			},
		} as unknown as TelegramApi;
		const poller = createPoller({ api, commands, handleUpdate: async () => undefined });
		await expect(poller.run()).rejects.toThrow(/other getUpdates|409/u);
	});

	it("rejects run() on a 401, naming the bot token setting", async () => {
		const api = {
			setMyCommands: async () => true,
			getUpdates: async () => {
				throw new TelegramApiError("getUpdates", { code: 401, description: "Unauthorized" });
			},
		} as unknown as TelegramApi;
		const poller = createPoller({ api, commands, handleUpdate: async () => undefined });
		await expect(poller.run()).rejects.toThrow(/401|bot token/u);
	});

	it("logs a handler failure for one update and keeps polling", async () => {
		const seen: number[] = [];
		let poller: TelegramPoller | null = null;
		const first: TelegramUpdate[] = [{ update_id: 7 }, { update_id: 9 }];
		let calls = 0;
		const b = blockingApi({
			onCall: () => {
				calls += 1;
				if (calls === 2) poller?.stop();
			},
			onGetUpdates: params => (params.offset === 0 ? first : null),
		});
		poller = createPoller({
			api: b.api,
			commands,
			handleUpdate: async (update: TelegramUpdate) => {
				seen.push(update.update_id);
				if (update.update_id === 7) throw new Error("handler exploded");
			},
		});
		await poller.run();
		expect(seen).toEqual([7, 9]);
		expect(b.calls.length).toBe(2);
		expect(b.calls[1]?.offset).toBe(10);
	});

	it("stops an in-flight long poll", async () => {
		const b = blockingApi();
		const poller = createPoller({ api: b.api, commands, handleUpdate: async () => undefined });
		const answer = poller.run();
		await b.started;
		poller.stop();
		await answer;
		expect(b.calls.length).toBe(1);
	});

	it("registers the command menu first and keeps polling when that fails", async () => {
		const registered: Array<readonly TelegramBotCommand[]> = [];
		const b = blockingApi({
			setMyCommands: async () => {
				throw new TelegramApiError("setMyCommands", { code: 500, description: "Internal Server Error" });
			},
		});
		const api = {
			setMyCommands: async (list: readonly TelegramBotCommand[]) => {
				registered.push(list);
				return b.api.setMyCommands(list);
			},
			getUpdates: b.api.getUpdates,
		} as unknown as TelegramApi;
		let poller: TelegramPoller | null = null;
		poller = createPoller({ api, commands, handleUpdate: async () => undefined });
		const answer = poller.run();
		await b.started;
		poller.stop();
		await answer;
		expect(registered[0]).toEqual(commands);
		expect(b.calls.length).toBe(1);
	});
});
