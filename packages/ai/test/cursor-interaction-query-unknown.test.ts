// Contract: unnamed interaction-query auto-approval is limited to verified
// WebFetch field 9; other unknown length-delimited variants stay unanswered.
import { describe, expect, it } from "bun:test";
import type * as http2 from "node:http2";
import { create, fromBinary } from "@bufbuild/protobuf";
import { handleInteractionQuery } from "@oh-my-pi/pi-ai/providers/cursor/interaction-query";
import {
	type AgentClientMessage,
	AgentClientMessageSchema,
	type InteractionQuery,
	InteractionQuerySchema,
} from "@oh-my-pi/pi-catalog/discovery/cursor-gen/agent_pb";

type ProtoUnknownField = { no: number; wireType: number; data: Uint8Array };
type ProtoUnknownBag = { $unknown?: ProtoUnknownField[] };

function isProtoUnknownField(value: unknown): value is ProtoUnknownField {
	if (!value || typeof value !== "object") return false;
	if (!("no" in value) || !("wireType" in value) || !("data" in value)) return false;
	return typeof value.no === "number" && typeof value.wireType === "number" && value.data instanceof Uint8Array;
}

function protoUnknownFields(message: object): ProtoUnknownField[] {
	if (!("$unknown" in message) || !Array.isArray(message.$unknown)) return [];
	return message.$unknown.filter(isProtoUnknownField);
}

function decodeConnectFrame(frame: Buffer): AgentClientMessage {
	const flags = frame[0]!;
	const length = frame.readUInt32BE(1);
	expect(flags & 0b1).toBe(0); // not compressed
	return fromBinary(AgentClientMessageSchema, frame.subarray(5, 5 + length));
}

function dispatchQuery(query: InteractionQuery): Promise<Buffer[]> {
	const frames: Buffer[] = [];
	const h2Request = {
		write(chunk: Buffer) {
			frames.push(Buffer.from(chunk));
			return true;
		},
	} as unknown as http2.ClientHttp2Stream;
	handleInteractionQuery(query, h2Request);
	return Promise.resolve(frames);
}

describe("cursor interaction query unknown-field fallback", () => {
	it("approves unnamed field-9 permission queries used by hosted WebFetch", async () => {
		const query = create(InteractionQuerySchema, { id: 18 });
		const bag: ProtoUnknownBag = query;
		bag.$unknown = [{ no: 9, wireType: 2, data: new Uint8Array([0x02, 0x0a, 0x00]) }];
		const frames = await dispatchQuery(query);
		expect(frames).toHaveLength(1);
		const client = decodeConnectFrame(frames[0]!);
		expect(client.message.case).toBe("interactionResponse");
		if (client.message.case !== "interactionResponse") {
			throw new Error("expected interactionResponse");
		}
		expect(client.message.value.id).toBe(18);
		// Field 9 is still unnamed on this generated schema, so the approved
		// reply round-trips as the same unknown LEN field rather than a named
		// webFetchRequestResponse case.
		expect(client.message.value.result.case).toBeUndefined();
		const responseUnknown = protoUnknownFields(client.message.value);
		expect(responseUnknown.some(field => field.no === 9 && field.wireType === 2)).toBe(true);
	});

	it("leaves unknown non-WebFetch interaction query fields unanswered", async () => {
		const query = create(InteractionQuerySchema, { id: 21 });
		const bag: ProtoUnknownBag = query;
		bag.$unknown = [{ no: 12, wireType: 2, data: new Uint8Array([0x02, 0x0a, 0x00]) }];
		expect(await dispatchQuery(query)).toEqual([]);
	});
});
