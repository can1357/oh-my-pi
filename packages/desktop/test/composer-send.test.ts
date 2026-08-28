import { describe, expect, test } from "bun:test";
import {
	type Attachment,
	type DraftContents,
	type DraftSink,
	sendDraft,
} from "../src/components/composer/useComposerDraft";

/**
 * The complaint these answer: the composer cleared the draft, revoked every
 * preview and swallowed the rejection *before* the send had landed. A send
 * refused because the sidecar was still coming up â or evicted mid-flight to
 * free a pool slot â took the message with it and said nothing at all.
 */
function attachment(id: string): Attachment {
	return { id, name: `${id}.png`, mimeType: "image/png", data: "AA==", previewUrl: `blob:${id}` };
}

function contents(overrides: Partial<DraftContents> = {}): DraftContents {
	return { draft: "ship it", attachments: [attachment("a1")], references: ["/tmp/notes.md"], ...overrides };
}

function recorder(send: DraftSink["send"]) {
	const cleared: DraftContents[] = [];
	const restored: DraftContents[] = [];
	const reported: unknown[] = [];
	const echoed: string[] = [];
	const retracted: string[] = [];
	const sink: DraftSink = {
		send,
		echo: message => {
			echoed.push(message);
			return `echo-${echoed.length}`;
		},
		retract: token => retracted.push(token),
		clear: sent => cleared.push(sent),
		restore: sent => restored.push(sent),
		reportError: cause => reported.push(cause),
	};
	return { sink, cleared, restored, reported, echoed, retracted };
}

describe("sendDraft", () => {
	test("does not give the draft up until the send has landed", async () => {
		const gate = Promise.withResolvers<void>();
		const { sink, cleared } = recorder(async () => {
			await gate.promise;
			return true;
		});
		const draft = contents();

		const done = sendDraft("ship it", draft, sink);
		await Promise.resolve();
		// The whole defect in one assertion: the message is still in the composer
		// while it is on the wire.
		expect(cleared).toHaveLength(0);

		gate.resolve();
		await done;
		expect(cleared).toEqual([draft]);
	});

	test("a rejected send keeps the message and says why", async () => {
		const { sink, cleared, reported, echoed, retracted } = recorder(() =>
			Promise.reject(new Error("session suspended to free a slot")),
		);

		await sendDraft("ship it", contents(), sink);

		// Drawn the instant it was sent, and taken straight back out: the
		// transcript never shows a message the session refused to take.
		expect(echoed).toEqual(["ship it"]);
		expect(retracted).toEqual(["echo-1"]);
		// Nothing was cleared, so nothing was revoked either: the chips keep their
		// previews and the draft is where the user left it.
		expect(cleared).toHaveLength(0);
		expect(reported).toHaveLength(1);
		expect(String(reported[0])).toContain("session suspended to free a slot");
		expect(String(reported[0])).toContain("still in the composer");
	});

	test("hands attachments over as image content, and omits them when there are none", async () => {
		const seen: unknown[] = [];
		const { sink } = recorder(async (_message, images) => {
			seen.push(images);
			return true;
		});

		await sendDraft("ship it", contents(), sink);
		await sendDraft("ship it", contents({ attachments: [] }), sink);

		expect(seen[0]).toEqual([{ type: "image", data: "AA==", mimeType: "image/png" }]);
		expect(seen[1]).toBeUndefined();
	});
});

/**
 * `prompt` is answered twice: the server acknowledges the frame and only then
 * starts the turn, so a turn that will not start — no model selected, no API
 * key for the provider — refuses on a second frame that arrives after the send
 * has already resolved. The composer is the only thing still holding the
 * message at that point.
 */
describe("a prompt refused after its acknowledgement", () => {
	test("hands the message back when the draft has already been given up", async () => {
		let refuse: ((cause: Error) => void) | undefined;
		const { sink, cleared, restored, reported } = recorder(async (_message, _images, refused) => {
			refuse = refused;
			return true;
		});
		const draft = contents();

		await sendDraft("ship it", draft, sink);
		expect(cleared).toEqual([draft]);

		refuse?.(new Error("No model selected"));

		expect(restored).toHaveLength(1);
		expect(restored[0]?.draft).toBe("ship it");
		expect(restored[0]?.references).toEqual(["/tmp/notes.md"]);
		// The object URL went with the clear, so the chip comes back on the base64
		// the send itself carried.
		expect(restored[0]?.attachments[0]?.previewUrl).toBe("data:image/png;base64,AA==");
		expect(String(reported[0])).toContain("No model selected");
		expect(String(reported[0])).toContain("still in the composer");
	});

	test("leaves it where it is when the refusal arrives before the clear", async () => {
		// Both frames can reach the webview in one relay batch, which is read
		// synchronously — the refusal then lands a microtask before the send's
		// own resolution is observed.
		const { sink, cleared, restored, reported } = recorder(async (_message, _images, refused) => {
			refused(new Error("No API key found for anthropic"));
			return true;
		});

		await sendDraft("ship it", contents(), sink);

		expect(cleared).toHaveLength(0);
		expect(restored).toHaveLength(0);
		expect(reported).toHaveLength(1);
	});

	test("says nothing twice when the send had already failed on the wire", async () => {
		let refuse: ((cause: Error) => void) | undefined;
		const { sink, cleared, restored, reported } = recorder(async (_message, _images, refused) => {
			refuse = refused;
			throw new Error("session suspended to free a slot");
		});

		await sendDraft("ship it", contents(), sink);
		refuse?.(new Error("No model selected"));

		expect(cleared).toHaveLength(0);
		expect(restored).toHaveLength(0);
		expect(reported).toHaveLength(1);
	});
});
