import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { type McpAttachRequest, type McpEra, mcpIdentity } from "@oh-my-pi/pi-coding-agent/mcp/host/contract";
import { LocalMcpHost } from "@oh-my-pi/pi-coding-agent/mcp/host/local";
import { MCP_ERA_RECHECK_MS, McpStore } from "@oh-my-pi/pi-coding-agent/mcp/host/store";
import { McpEraResolver } from "@oh-my-pi/pi-coding-agent/mcp/host/endpoint";
import { linkOver, ScriptedUpstreams, settle, stdioSpec, until } from "./scripted";

function attachRequest(era: McpEra, instance: string, idleMs = 60_000): McpAttachRequest {
	return { spec: stdioSpec("scripted"), era, name: "scripted", instance, idleMs };
}

describe("LocalMcpHost", () => {
	let store: McpStore;
	let upstreams: ScriptedUpstreams;
	let host: LocalMcpHost;

	beforeEach(() => {
		store = McpStore.memory();
		upstreams = new ScriptedUpstreams();
		host = new LocalMcpHost({ store, upstreams });
	});

	afterEach(async () => {
		await host.dispose();
	});

	it("puts every session of a modern server on one unit and stops it with the last lease", async () => {
		const first = await host.attach(attachRequest("modern", "manager-1"));
		const second = await host.attach(attachRequest("modern", "manager-2"));
		const a = linkOver(first.tunnel);
		const b = linkOver(second.tunnel);
		await a.call(1, "tools/call", { name: "alpha", arguments: { from: "a" } });
		await b.call(1, "tools/call", { name: "alpha", arguments: { from: "b" } });
		expect(upstreams.peers).toHaveLength(1);
		const peer = upstreams.last;
		await b.status({ state: "running", pid: peer.pid, links: 2 });

		first.release();
		first.release();
		expect(await b.call(2, "tools/call", { name: "alpha" })).toHaveProperty("result");
		expect(peer.gone).toBe(false);

		second.release();
		await until(() => peer.gone, "upstream stopped");
		expect(peer.closeReasons).toEqual(["released"]);
		await until(() => a.closed && b.closed, "tunnels closed");

		const again = await host.attach(attachRequest("modern", "manager-1"));
		await linkOver(again.tunnel).call(1, "tools/call", { name: "alpha" });
		expect(upstreams.peers).toHaveLength(2);
		again.release();
	});

	it("waits for a released unit to finish its work before stopping it", async () => {
		const gate = Promise.withResolvers<void>();
		upstreams.handler = async method => {
			if (method === "tools/call") await gate.promise;
			return undefined;
		};
		const attachment = await host.attach(attachRequest("modern", "manager-1"));
		const link = linkOver(attachment.tunnel);
		link.request(1, "tools/call", { name: "alpha" });
		await until(() => upstreams.peers.length === 1 && upstreams.last.count("tools/call") === 1, "call upstream");
		const peer = upstreams.last;

		attachment.release();
		expect(peer.gone).toBe(false);
		gate.resolve();
		expect(await link.response(1)).toHaveProperty("result");
		await until(() => peer.gone, "upstream stopped");
	});

	it("gives each manager of a handshake-era server its own unit", async () => {
		const first = await host.attach(attachRequest("legacy", "manager-1"));
		const second = await host.attach(attachRequest("legacy", "manager-2"));
		const a = linkOver(first.tunnel);
		const b = linkOver(second.tunnel);
		await a.call(1, "tools/call", { name: "alpha" });
		await b.call(1, "tools/call", { name: "alpha" });
		expect(upstreams.peers).toHaveLength(2);
		await a.status({ era: "legacy", state: "running", pid: upstreams.peers[0].pid, links: 1 });
		await b.status({ era: "legacy", state: "running", pid: upstreams.peers[1].pid, links: 1 });

		first.release();
		await until(() => upstreams.peers[0].gone, "first manager's upstream stopped");
		expect(upstreams.peers[1].gone).toBe(false);
	});

	it("stops the idle upstream of a held modern unit and starts another on the next request", async () => {
		const attachment = await host.attach(attachRequest("modern", "manager-1", 30));
		const link = linkOver(attachment.tunnel);
		await link.call(1, "tools/call", { name: "alpha" });
		const first = upstreams.last;
		link.clear();
		await link.status({ state: "idle" });
		expect(first.closeReasons).toEqual(["idle"]);
		await link.call(2, "tools/call", { name: "alpha" });
		expect(upstreams.last.pid).not.toBe(first.pid);
	});

	it("probes a server once for concurrent resolves and answers later ones from the store", async () => {
		const gate = Promise.withResolvers<void>();
		upstreams.probeGate = gate.promise;
		upstreams.probeResult = {
			era: "modern",
			discover: { ...upstreams.discoverResult(), supportedVersions: ["2026-07-28"], capabilities: {} },
		};
		const spec = stdioSpec("scripted");
		const pending = [host.resolve(spec), host.resolve(spec)];
		await until(() => upstreams.probes === 1, "the probe");
		gate.resolve();
		expect(await Promise.all(pending)).toEqual([{ era: "modern" }, { era: "modern" }]);
		expect(await host.resolve(spec)).toEqual({ era: "modern" });
		expect(upstreams.probes).toBe(1);

		const attachment = await host.attach(attachRequest("modern", "manager-1"));
		const discover = await linkOver(attachment.tunnel).call(1, "server/discover");
		expect(discover).toMatchObject({ result: { supportedVersions: ["2026-07-28"] } });
		expect(upstreams.startAttempts).toBe(0);
	});

	it("lets one caller abandon a shared probe without failing the other", async () => {
		const gate = Promise.withResolvers<void>();
		upstreams.probeGate = gate.promise;
		const spec = stdioSpec("scripted");
		const controller = new AbortController();
		const abandoned = host.resolve(spec, controller.signal);
		const kept = host.resolve(spec);
		controller.abort(new Error("gave up"));
		await expect(abandoned).rejects.toThrow("gave up");
		gate.resolve();
		expect(await kept).toEqual({ era: "modern" });
		expect(upstreams.probes).toBe(1);
		expect(upstreams.probeAborts).toBe(0);
	});

	it("keeps a recent handshake-era verdict and probes an old one again", async () => {
		const spec = stdioSpec("scripted");
		store.setEra(mcpIdentity(spec), "legacy");
		expect(await host.resolve(spec)).toEqual({ era: "legacy" });
		expect(upstreams.probes).toBe(0);

		const realNow = Date.now;
		Date.now = () => realNow() + MCP_ERA_RECHECK_MS + 1;
		try {
			expect(await host.resolve(spec)).toEqual({ era: "modern" });
		} finally {
			Date.now = realNow;
		}
		expect(upstreams.probes).toBe(1);
	});

	it("stops every unit on dispose", async () => {
		const attachment = await host.attach(attachRequest("modern", "manager-1"));
		const link = linkOver(attachment.tunnel);
		await link.call(1, "tools/call", { name: "alpha" });
		await host.dispose();
		expect(upstreams.last.closeReasons).toEqual(["host disposed"]);
		await until(() => link.closed, "tunnel closed");
		await expect(host.attach(attachRequest("modern", "manager-1"))).rejects.toThrow("disposed");
	});
	it("aborts a probe its only caller gave up on, so the next resolve probes anew", async () => {
		upstreams.probeGate = new Promise(() => {});
		const spec = stdioSpec("scripted");
		const controller = new AbortController();
		const first = host.resolve(spec, controller.signal);
		await until(() => upstreams.probes === 1, "the probe");
		controller.abort(new Error("connect timed out"));
		await expect(first).rejects.toThrow("connect timed out");
		expect(upstreams.probeAborts).toBe(1);

		upstreams.probeGate = undefined;
		expect(await host.resolve(spec)).toEqual({ era: "modern" });
		expect(upstreams.probes).toBe(2);
	});

	it("aborts probes in flight on dispose", async () => {
		upstreams.probeGate = new Promise(() => {});
		const spec = stdioSpec("scripted");
		const pending = host.resolve(spec);
		pending.catch(() => {});
		await until(() => upstreams.probes === 1, "the probe");
		await host.dispose();
		expect(upstreams.probeAborts).toBe(1);
		await expect(pending).rejects.toThrow("shutting down");
		await expect(host.resolve(spec)).rejects.toThrow("disposed");
	});

	it("returns from dispose only when a unit it was already collecting has stopped", async () => {
		const closeGate = Promise.withResolvers<void>();
		upstreams.closeGate = closeGate.promise;
		const attachment = await host.attach(attachRequest("modern", "manager-1"));
		await linkOver(attachment.tunnel).call(1, "tools/call", { name: "alpha" });
		const peer = upstreams.last;
		attachment.release();
		await until(() => peer.closeReasons.length === 1, "unit being collected");

		let disposed = false;
		const disposing = host.dispose().then(() => {
			disposed = true;
		});
		await settle();
		expect(disposed).toBe(false);
		expect(peer.gone).toBe(false);
		closeGate.resolve();
		await disposing;
		expect(peer.gone).toBe(true);
	});
});

describe("McpEraResolver", () => {
	it("writes nothing to the store for a probe that finishes after dispose", async () => {
		const store = McpStore.memory();
		const upstreams = new ScriptedUpstreams();
		const gate = Promise.withResolvers<void>();
		upstreams.probeGate = gate.promise;
		upstreams.probeIgnoresAbort = true;
		upstreams.probeResult = { era: "legacy" };
		const resolver = new McpEraResolver(store, upstreams, () => {
			throw new Error("scripted upstreams never spawn");
		});
		const spec = stdioSpec("scripted");
		try {
			const pending = resolver.resolve(spec);
			pending.catch(() => {});
			await until(() => upstreams.probes === 1, "the probe");

			let disposed = false;
			const disposing = resolver.dispose().then(() => {
				disposed = true;
			});
			await settle();
			expect(disposed).toBe(false);
			gate.resolve();
			await disposing;
			await expect(pending).rejects.toThrow("shutting down");
			expect(store.era(mcpIdentity(spec))).toBeUndefined();
		} finally {
			store.close();
		}
	});
});
