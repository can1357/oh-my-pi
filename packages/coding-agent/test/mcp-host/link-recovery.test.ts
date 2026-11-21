import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { encodeHostError, type McpRemoteSpec } from "@oh-my-pi/pi-coding-agent/mcp/host/contract";
import { HostLink, type HostLinkReattach } from "@oh-my-pi/pi-coding-agent/mcp/link";
import { rejectionOf } from "../helpers/rejection";
import { FakeHost, REMOTE_SPEC, settled, unauthorized } from "./link-fake-host";

const TIMEOUT_ENV = "OMP_MCP_TIMEOUT_MS";

function withToken(token: string): McpRemoteSpec {
	return { ...REMOTE_SPEC, headers: { Authorization: `Bearer ${token}` } };
}

/**
 * What a link does when its attachment or its credentials stop being good:
 * which server refreshed credentials may reach, how far one recovery goes,
 * and that every attachment taken along the way has exactly one owner.
 */
describe("HostLink recovery", () => {
	let host: FakeHost;
	let links: HostLink[];
	let savedTimeout: string | undefined;

	beforeEach(() => {
		host = new FakeHost();
		links = [];
		savedTimeout = Bun.env[TIMEOUT_ENV];
		delete Bun.env[TIMEOUT_ENV];
	});

	afterEach(async () => {
		for (const link of links) await link.close();
		if (savedTimeout === undefined) delete Bun.env[TIMEOUT_ENV];
		else Bun.env[TIMEOUT_ENV] = savedTimeout;
	});

	function detached(): HostLink {
		const link = new HostLink({
			name: "fixture",
			spec: REMOTE_SPEC,
			instance: "manager-1",
			roots: () => [],
			idleMs: 1_000,
			access: host,
		});
		links.push(link);
		return link;
	}

	async function connected(): Promise<HostLink> {
		const link = detached();
		await link.connect();
		return link;
	}

	it("refreshes credentials the era probe refuses, once, and attaches with them", async () => {
		host.resolveFailures.push(unauthorized());
		const link = detached();
		let refreshes = 0;
		link.onAuthError = async () => {
			refreshes++;
			return { Authorization: "Bearer new" };
		};

		await link.connect();

		expect(refreshes).toBe(1);
		expect(host.resolved).toEqual([REMOTE_SPEC, withToken("new")]);
		expect(host.tunnel.request.spec).toEqual(withToken("new"));
		expect(link.spec).toEqual(withToken("new"));
	});

	it("fails the connect when the refreshed credentials are refused by the probe too", async () => {
		host.resolveFailures.push(unauthorized(), unauthorized(403));
		const link = detached();
		let refreshes = 0;
		link.onAuthError = async () => {
			refreshes++;
			return { Authorization: "Bearer new" };
		};

		expect(await rejectionOf(link.connect())).toMatchObject({ failure: "http_status", code: 403 });
		expect(refreshes).toBe(1);
		expect(host.tunnels).toHaveLength(0);
	});

	it("leaves a probe without a refresh hook anonymous: its refusal is the answer", async () => {
		host.resolveFailures.push(unauthorized());
		const link = detached();

		expect(await rejectionOf(link.connect())).toMatchObject({ failure: "http_status", code: 401 });
		expect(host.resolved).toEqual([REMOTE_SPEC]);
		expect(host.tunnels).toHaveLength(0);
	});

	it("never applies refreshed credentials to a server the link was pointed at meanwhile", async () => {
		const link = await connected();
		const refreshed = Promise.withResolvers<Record<string, string> | null>();
		link.onAuthError = () => refreshed.promise;
		const elsewhere: McpRemoteSpec = {
			...REMOTE_SPEC,
			url: "https://other.example.test/mcp",
			headers: { Authorization: "Bearer other-account" },
		};

		const refused = rejectionOf(link.request("tools/list"));
		const first = host.tunnel;
		first.push({ id: (await first.next("tools/list")).id, error: encodeHostError(unauthorized()) });
		await settled();
		await link.retarget(elsewhere);
		refreshed.resolve(withToken("late").headers);

		expect(await refused).toMatchObject({ failure: "http_status", code: 401 });
		expect(host.tunnels).toHaveLength(2);
		expect(host.tunnel.request.spec).toEqual(elsewhere);
		expect(link.spec).toEqual(elsewhere);
	});

	it("ends a recovery whose fresh credentials are refused while the owner reloads, and starts a new one later", async () => {
		const link = await connected();
		let refreshes = 0;
		link.onAuthError = async () => ({ Authorization: `Bearer minted-${++refreshes}` });
		// The owner reloads the server on every new attachment, as the manager does.
		const reloads: Promise<unknown>[] = [];
		link.onReattach = () => {
			const reload = link.request("server/discover").then(
				() => undefined,
				error => error,
			);
			reloads.push(reload);
			return reload.then(() => {});
		};

		const call = link.request("tools/call", { name: "whoami" });
		const first = host.tunnel;
		first.push({ id: (await first.next("tools/call")).id, error: encodeHostError(unauthorized()) });
		const second = await host.attached(2);
		// The reload meets a server that refuses the credentials minted a moment ago.
		second.push({ id: (await second.next("server/discover")).id, error: encodeHostError(unauthorized()) });
		second.push({ id: (await second.next("tools/call")).id, result: { content: [] } });

		expect(await call).toEqual({ content: [] });
		expect(await reloads[0]).toMatchObject({ failure: "http_status", code: 401 });
		expect(refreshes).toBe(1);
		expect(host.tunnels).toHaveLength(2);

		// Long after that recovery ended, an expired token is refreshed like the first time.
		const later = link.request("tools/list");
		second.push({ id: (await second.next("tools/list")).id, error: encodeHostError(unauthorized()) });
		const third = await host.attached(3);
		third.push({ id: (await third.next("server/discover")).id, result: { capabilities: {} } });
		third.push({ id: (await third.next("tools/list")).id, result: { tools: [] } });

		expect(await later).toEqual({ tools: [] });
		expect(refreshes).toBe(2);
		expect(third.request.spec).toEqual(withToken("minted-2"));
	});

	it("tells its owner whether a new attachment reaches another identity", async () => {
		const link = await connected();
		const changes: HostLinkReattach[] = [];
		link.onReattach = change => {
			changes.push(change);
		};

		host.tunnel.drop();
		await host.attached(2);
		await settled();
		await link.retarget(withToken("someone-else"));

		expect(changes).toEqual([{ identityChanged: false }, { identityChanged: true }]);
	});

	it("keeps one attachment when retargets overlap a lost tunnel, and gives every other one back", async () => {
		const link = await connected();
		let reattached = 0;
		let closed = 0;
		link.onReattach = () => {
			reattached++;
		};
		link.onClose = () => closed++;
		const unit = Promise.withResolvers<void>();
		host.attachGate = unit.promise;

		// The link starts re-attaching on its own; two owners then point it elsewhere before any unit exists.
		host.tunnel.drop();
		const superseded = rejectionOf(link.retarget(withToken("a")));
		const winning = link.retarget(withToken("b"));
		host.attachGate = undefined;
		unit.resolve();
		await winning;

		expect(await superseded).toMatchObject({ failure: "closed", message: "MCP server connection was replaced" });
		await settled();
		const held = host.tunnels.filter(tunnel => !tunnel.released);
		expect(held).toHaveLength(1);
		expect(held[0]?.request.spec).toEqual(withToken("b"));
		expect(host.tunnels.filter(tunnel => tunnel.released).every(tunnel => tunnel.closed)).toBe(true);
		expect(link.spec).toEqual(withToken("b"));
		expect(link.connected).toBe(true);
		expect(reattached).toBe(1);
		expect(closed).toBe(0);
	});

	it("gives back a unit that arrives after the link was closed, and stops listening for the host", async () => {
		const unit = Promise.withResolvers<void>();
		host.attachGate = unit.promise;
		const link = detached();
		let reattached = 0;
		link.onReattach = () => {
			reattached++;
		};

		const connecting = rejectionOf(link.connect());
		await settled();
		await link.close();
		host.attachGate = undefined;
		unit.resolve();

		expect(await connecting).toMatchObject({ failure: "closed", message: "Transport closed" });
		expect(host.tunnels).toHaveLength(1);
		expect(host.tunnels[0]?.released).toBe(true);
		expect(host.tunnels[0]?.closed).toBe(true);
		expect(host.reconnectListeners).toBe(0);
		host.replace();
		await settled();
		expect(host.tunnels).toHaveLength(1);
		expect(reattached).toBe(0);
	});
});
