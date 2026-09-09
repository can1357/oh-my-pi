import { describe, expect, it } from "bun:test";
import {
	generateRoomKey,
	generateWriteToken,
	importRoomKey,
	open,
	seal,
} from "@oh-my-pi/pi-coding-agent/collab/crypto";
import {
	type CollabFrame,
	DEFAULT_RELAY_URL,
	formatCollabLink,
	formatCollabWebLink,
	generateRoomId,
	packEnvelope,
	parseCollabLink,
	rewriteEnvelopePeer,
	unpackEnvelope,
} from "@oh-my-pi/pi-coding-agent/collab/protocol";

describe("collab crypto", () => {
	it("round-trips a frame through seal/open", async () => {
		const key = await importRoomKey(generateRoomKey());
		const frame: CollabFrame = { t: "prompt", text: "check bun.lock — and ünïcode 🚀" };
		const sealed = await seal(key, frame);
		expect(await open(key, sealed)).toEqual(frame);
	});

	it("rejects tampered ciphertext", async () => {
		const key = await importRoomKey(generateRoomKey());
		const sealed = await seal(key, { t: "abort" });
		sealed[sealed.length - 1]! ^= 0xff;
		expect(open(key, sealed)).rejects.toThrow();
	});

	it("rejects frames sealed with a different key", async () => {
		const sealed = await seal(await importRoomKey(generateRoomKey()), { t: "abort" });
		const otherKey = await importRoomKey(generateRoomKey());
		expect(open(otherKey, sealed)).rejects.toThrow();
	});
});

describe("collab link format", () => {
	const key = generateRoomKey();
	const roomId = generateRoomId();

	it("collapses the default relay to a bare roomId.key link", () => {
		const link = formatCollabLink(DEFAULT_RELAY_URL, roomId, key);
		expect(link).toBe(`${roomId}.${Buffer.from(key).toString("base64url")}`);
		const parsed = parseCollabLink(link);
		if ("error" in parsed) throw new Error(parsed.error);
		expect(parsed.wsUrl).toBe(`${DEFAULT_RELAY_URL}/r/${roomId}`);
		expect(parsed.roomId).toBe(roomId);
		expect(parsed.key).toEqual(key);
	});

	it("drops the wss scheme for custom relays and infers it on parse", () => {
		const link = formatCollabLink("wss://relay.example.com:8443", roomId, key);
		expect(link.startsWith("relay.example.com:8443/r/")).toBe(true);
		const parsed = parseCollabLink(link);
		if ("error" in parsed) throw new Error(parsed.error);
		expect(parsed.wsUrl).toBe(`wss://relay.example.com:8443/r/${roomId}`);
	});

	it("keeps full ws:// URLs for localhost relays", () => {
		const link = formatCollabLink("ws://localhost:7475", roomId, key);
		expect(link.startsWith("ws://localhost:7475/r/")).toBe(true);
		const parsed = parseCollabLink(link);
		if ("error" in parsed) throw new Error(parsed.error);
		expect(parsed.wsUrl).toBe(`ws://localhost:7475/r/${roomId}`);
	});

	it("rewrites https relay URLs to wss", () => {
		const parsed = parseCollabLink(`https://relay.example.com/r/${roomId}#${Buffer.from(key).toString("base64url")}`);
		if ("error" in parsed) throw new Error(parsed.error);
		expect(parsed.wsUrl).toBe(`wss://relay.example.com/r/${roomId}`);
	});

	it("rejects plain ws:// for non-localhost hosts", () => {
		const parsed = parseCollabLink(`ws://relay.example.com/r/${roomId}#${Buffer.from(key).toString("base64url")}`);
		expect("error" in parsed && parsed.error.includes("wss://")).toBe(true);
	});

	it("rejects keys that are not 32 base64url bytes", () => {
		expect("error" in parseCollabLink(`${roomId}.dG9vc2hvcnQ`)).toBe(true);
		expect("error" in parseCollabLink(`${roomId}.not+base64url/`)).toBe(true);
	});

	it("accepts legacy #-separated links", () => {
		const keyText = Buffer.from(key).toString("base64url");
		for (const legacy of [
			`${roomId}#${keyText}`,
			`relay.example.com:8443/r/${roomId}#${keyText}`,
			`https://my.omp.sh/#${roomId}#${keyText}`,
		]) {
			const parsed = parseCollabLink(legacy);
			if ("error" in parsed) throw new Error(`${legacy}: ${parsed.error}`);
			expect(parsed.roomId).toBe(roomId);
			expect(Buffer.from(parsed.key)).toEqual(Buffer.from(key));
		}
	});

	it("accepts %23-mangled legacy deep links (macOS Foundation re-encoding)", () => {
		const keyText = Buffer.from(key).toString("base64url");
		const parsed = parseCollabLink(`https://my.omp.sh/#${roomId}%23${keyText}`);
		if ("error" in parsed) throw new Error(parsed.error);
		expect(parsed.wsUrl).toBe(`${DEFAULT_RELAY_URL}/r/${roomId}`);
		expect(Buffer.from(parsed.key)).toEqual(Buffer.from(key));
	});

	it("renders web deep links that parse back to the same room", () => {
		for (const relay of [DEFAULT_RELAY_URL, "wss://relay.example.com:8443", "ws://localhost:7475"]) {
			const webLink = formatCollabWebLink(relay, roomId, key);
			const direct = parseCollabLink(formatCollabLink(relay, roomId, key));
			const viaWeb = parseCollabLink(webLink);
			if ("error" in direct) throw new Error(direct.error);
			if ("error" in viaWeb) throw new Error(viaWeb.error);
			expect(webLink.startsWith(relay === "ws://localhost:7475" ? "http://" : "https://")).toBe(true);
			expect(webLink.includes("/#")).toBe(true);
			expect(viaWeb.wsUrl).toBe(direct.wsUrl);
			expect(viaWeb.roomId).toBe(roomId);
			expect(Buffer.from(viaWeb.key)).toEqual(Buffer.from(key));
		}
	});

	it("wraps custom relay links in an explicit web UI origin", () => {
		const webLink = formatCollabWebLink(
			"wss://relay.example.com:8443",
			roomId,
			key,
			undefined,
			"https://web.example",
		);
		expect(webLink.startsWith("https://web.example/#relay.example.com:8443/r/")).toBe(true);
		const parsed = parseCollabLink(webLink);
		if ("error" in parsed) throw new Error(parsed.error);
		expect(parsed.wsUrl).toBe(`wss://relay.example.com:8443/r/${roomId}`);
	});

	it("parses non-local http web UI wrappers by their relay fragment", () => {
		const keyText = Buffer.from(key).toString("base64url");
		const parsed = parseCollabLink(`http://web.example/collab/#relay.example.com:8443/r/${roomId}.${keyText}`);
		if ("error" in parsed) throw new Error(parsed.error);
		expect(parsed.wsUrl).toBe(`wss://relay.example.com:8443/r/${roomId}`);
	});

	it("parses split web UI wrappers with full relay URLs in the fragment", () => {
		const keyText = Buffer.from(key).toString("base64url");
		const parsed = parseCollabLink(`https://web.example/collab/#wss://relay.example.com/r/${roomId}.${keyText}`);
		if ("error" in parsed) throw new Error(parsed.error);
		expect(parsed.wsUrl).toBe(`wss://relay.example.com/r/${roomId}`);
	});

	it("falls through invalid http wrapper fragments without reparsing them", () => {
		expect(parseCollabLink("https://web.example/#not-a-collab-link")).toEqual({
			error: "Collab link must contain a /r/<roomId> path",
		});
	});

	it("prefers browser wrapper fragments over relay-like web paths", () => {
		const inner = formatCollabLink("wss://relay.example.com", roomId, key);
		const parsed = parseCollabLink(`https://web.example/r/abcdefghij#${inner}`);
		if ("error" in parsed) throw new Error(parsed.error);
		expect(parsed.wsUrl).toBe(`wss://relay.example.com/r/${roomId}`);
	});

	it("parses the scheme-less display form of web deep links", () => {
		const parsed = parseCollabLink(`my.omp.sh/#${formatCollabLink(DEFAULT_RELAY_URL, roomId, key)}`);
		if ("error" in parsed) throw new Error(parsed.error);
		expect(parsed.wsUrl).toBe(`${DEFAULT_RELAY_URL}/r/${roomId}`);
		expect(Buffer.from(parsed.key)).toEqual(Buffer.from(key));
	});

	it("embeds the write token in full links and omits it from view links", () => {
		const token = generateWriteToken();
		const full = parseCollabLink(formatCollabLink(DEFAULT_RELAY_URL, roomId, key, token));
		if ("error" in full) throw new Error(full.error);
		expect(Buffer.from(full.key)).toEqual(Buffer.from(key));
		expect(Buffer.from(full.writeToken ?? new Uint8Array())).toEqual(Buffer.from(token));

		const view = parseCollabLink(formatCollabLink(DEFAULT_RELAY_URL, roomId, key));
		if ("error" in view) throw new Error(view.error);
		expect(Buffer.from(view.key)).toEqual(Buffer.from(key));
		expect(view.writeToken).toBeUndefined();
	});

	it("carries the write token through web deep links", () => {
		const token = generateWriteToken();
		const parsed = parseCollabLink(formatCollabWebLink(DEFAULT_RELAY_URL, roomId, key, token));
		if ("error" in parsed) throw new Error(parsed.error);
		expect(Buffer.from(parsed.key)).toEqual(Buffer.from(key));
		expect(Buffer.from(parsed.writeToken ?? new Uint8Array())).toEqual(Buffer.from(token));
	});

	it("rejects secrets that are neither 32 nor 48 bytes", () => {
		const bad = Buffer.alloc(40, 1).toString("base64url");
		expect("error" in parseCollabLink(`${roomId}#${bad}`)).toBe(true);
	});

	it("keeps the key out of web-link path and query", () => {
		const webLink = formatCollabWebLink(DEFAULT_RELAY_URL, roomId, key);
		const url = new URL(webLink);
		expect(url.origin).toBe("https://my.omp.sh");
		expect(url.pathname).toBe("/");
		expect(url.search).toBe("");
		expect(url.hash).toBe(`#${roomId}.${Buffer.from(key).toString("base64url")}`);
	});

	it("normalizes explicit web UI roots, paths, trailing slashes, and ports", () => {
		const rootLink = formatCollabWebLink(DEFAULT_RELAY_URL, roomId, key, undefined, " https://web.example/ ");
		expect(rootLink.startsWith("https://web.example/#")).toBe(true);

		const pathLink = formatCollabWebLink(
			DEFAULT_RELAY_URL,
			roomId,
			key,
			undefined,
			"https://web.example:8443/collab///",
		);
		expect(pathLink.startsWith("https://web.example:8443/collab/#")).toBe(true);

		const localHttpLink = formatCollabWebLink(
			DEFAULT_RELAY_URL,
			roomId,
			key,
			undefined,
			"http://localhost:5173/app/",
		);
		expect(localHttpLink.startsWith("http://localhost:5173/app/#")).toBe(true);
	});

	it("rejects web UI URLs without an http or https protocol", () => {
		expect(() => formatCollabWebLink(DEFAULT_RELAY_URL, roomId, key, undefined, "ftp://web.example")).toThrow(
			"collab.webUrl must start with http:// or https://",
		);
	});

	it("rejects non-local plain-http web UI URLs", () => {
		expect(() => formatCollabWebLink(DEFAULT_RELAY_URL, roomId, key, undefined, "http://web.example")).toThrow(
			"collab.webUrl must use https:// unless it targets localhost",
		);
	});
	it("rejects web UI URLs with query strings or fragments", () => {
		expect(() => formatCollabWebLink(DEFAULT_RELAY_URL, roomId, key, undefined, "https://web.example/?x=1")).toThrow(
			"collab.webUrl must not include a query string or fragment",
		);
	});
});

describe("collab wire envelope", () => {
	it("round-trips peer id and payload", () => {
		const payload = new Uint8Array([1, 2, 3, 250]);
		const packed = packEnvelope(0xdeadbeef, payload);
		const unpacked = unpackEnvelope(packed);
		expect(unpacked?.peerId).toBe(0xdeadbeef);
		expect(unpacked?.payload).toEqual(payload);
	});

	it("rewrites the peer id in place without touching the payload", () => {
		const packed = packEnvelope(0, new Uint8Array([9, 8, 7]));
		rewriteEnvelopePeer(packed, 42);
		const unpacked = unpackEnvelope(packed);
		expect(unpacked?.peerId).toBe(42);
		expect(unpacked?.payload).toEqual(new Uint8Array([9, 8, 7]));
	});

	it("returns null for frames shorter than the header", () => {
		expect(unpackEnvelope(new Uint8Array([0, 0]))).toBeNull();
	});
});
