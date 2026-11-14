import { afterEach, describe, expect, it } from "bun:test";
import { TernError } from "@oh-my-pi/pi-coding-agent/tools/browser/tern/wire";
import { WebKitHost, WebKitUnavailableError } from "@oh-my-pi/pi-coding-agent/tools/browser/webkit/host";
import { createFakeHost, type FakeHost, isProcessAlive } from "./webkit-fake-host";

let fake: FakeHost | undefined;
let host: WebKitHost | undefined;

afterEach(async () => {
	await host?.close();
	host = undefined;
	await fake?.remove();
	fake = undefined;
});

describe("WebKitHost", () => {
	it("greets a child process over its standard streams and correlates its answers by id", async () => {
		fake = await createFakeHost();
		host = await WebKitHost.launch(fake.executable);
		// The welcome's ops arrived through stdout: native DOM reads are on for this host.
		expect(host.client.supports("dom")).toBe(true);

		const [first, second, missing] = await Promise.all([
			host.client.request({ op: "echo", value: "one" }),
			host.client.request({ op: "echo", value: { nested: [2] } }),
			host.client.request({ op: "missing", block: 9 }).catch((error: unknown) => error),
		]);
		expect(first).toEqual({ echo: "one" });
		expect(second).toEqual({ echo: { nested: [2] } });
		expect(missing).toBeInstanceOf(TernError);
		expect((missing as TernError).kind).toBe("not_found");
		expect(await fake.requests()).toEqual([
			{ op: "echo", value: "one" },
			{ op: "echo", value: { nested: [2] } },
			{ op: "missing", block: 9 },
		]);

		// Closing ends the host's input, which is how it is told to exit.
		const pid = await fake.pid();
		await host.close();
		expect(await fake.sawEndOfInput()).toBe(true);
		expect(isProcessAlive(pid)).toBe(false);
	});

	it("fails pending and later requests as a dropped connection when the child exits", async () => {
		fake = await createFakeHost();
		host = await WebKitHost.launch(fake.executable);
		const pending = host.client.request({ op: "hang" }).catch((error: unknown) => error);
		const dying = host.client.request({ op: "die" }).catch((error: unknown) => error);

		for (const failure of [await pending, await dying]) {
			expect(failure).toBeInstanceOf(TernError);
			expect((failure as TernError).kind).toBe("closed");
			expect((failure as TernError).message).toContain("exited with code 7");
		}
		expect(host.client.connected).toBe(false);
		const later = await host.client.request({ op: "state", block: 1 }).catch((error: unknown) => error);
		expect((later as TernError).kind).toBe("closed");
	});

	it("reports a host that exits before greeting, or cannot be started, as unavailable", async () => {
		fake = await createFakeHost("exit-on-hello");
		const exited = await WebKitHost.launch(fake.executable).catch((error: unknown) => error);
		expect(exited).toBeInstanceOf(WebKitUnavailableError);
		expect((exited as Error).message).toContain("exited with code 3");

		const absent = await WebKitHost.launch(`${fake.dir}/no-such-host`).catch((error: unknown) => error);
		expect(absent).toBeInstanceOf(WebKitUnavailableError);
	});

	it("kills a host that keeps running after its input closed", async () => {
		fake = await createFakeHost("ignore-eof");
		host = await WebKitHost.launch(fake.executable);
		const pid = await fake.pid();
		await host.close();
		expect(await fake.sawEndOfInput()).toBe(true);
		expect(isProcessAlive(pid)).toBe(false);
	}, 15_000);
});
