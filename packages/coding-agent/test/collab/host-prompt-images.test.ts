/**
 * Contract: a guest prompt's images reach the agent. The side panel attaches screenshots and region crops to
 * collab prompts; the host must hand them to the session alongside the text, not just the text.
 */
import { afterEach, expect, it } from "bun:test";
import { importRoomKey } from "@oh-my-pi/pi-coding-agent/collab/crypto";
import { CollabHost } from "@oh-my-pi/pi-coding-agent/collab/host";
import { COLLAB_PROTO, type CollabFrame, parseCollabLink } from "@oh-my-pi/pi-coding-agent/collab/protocol";
import { CollabSocket } from "@oh-my-pi/pi-coding-agent/collab/relay-client";
import type { ImageContent } from "@oh-my-pi/pi-wire";
import { installInMemoryRelay, uninstallInMemoryRelay } from "./helpers/in-memory-relay";
import { type HostObservations, instrumentRelay, makeHostContext, makeSnapshot, waitFor } from "./helpers/throttled-host";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
	try {
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	} finally {
		uninstallInMemoryRelay();
	}
});

it("prompts the session with the guest's text and images", async () => {
	const relay = installInMemoryRelay();
	instrumentRelay(relay, { throttle: false });
	const seen: HostObservations = { notices: [], participantCounts: [] };
	const ctx = makeHostContext(makeSnapshot(), seen);
	const prompted: unknown[] = [];
	ctx.session.promptCustomMessage = async message => {
		prompted.push(message.content);
		return true;
	};
	const host = new CollabHost(ctx);
	cleanups.push(() => host.stop("test done"));

	await host.start("ws://localhost:8788");
	const parsed = parseCollabLink(host.link);
	if ("error" in parsed) throw new Error(parsed.error);
	const key = await importRoomKey(parsed.key);
	const writeToken = parsed.writeToken ? Buffer.from(parsed.writeToken).toString("base64url") : undefined;

	const guest = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key });
	cleanups.push(() => guest.close());
	const received: CollabFrame[] = [];
	guest.onFrame = frame => received.push(frame);
	guest.onOpen = () => guest.send({ t: "hello", proto: COLLAB_PROTO, name: "panel", writeToken });
	guest.connect();
	await waitFor(() => received.some(frame => frame.t === "welcome"), "the guest was never welcomed");

	const image: ImageContent = { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" };
	guest.send({ t: "prompt", text: "what is on this page?", images: [image] });
	await waitFor(() => prompted.length > 0, "the host never prompted the session");

	expect(prompted).toEqual([[{ type: "text", text: "what is on this page?" }, image]]);
}, 20_000);
