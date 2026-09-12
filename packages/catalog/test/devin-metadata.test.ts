import { describe, expect, it } from "bun:test";
import { MetadataSchema } from "../src/discovery/devin-proto";
import { create, fromBinary, toBinary } from "../src/discovery/protobuf";
import { devinCliMetadata, devinDiscoveryMetadata } from "../src/wire/devin";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function readIdentityFields(bytes: Uint8Array): { sessionId?: string; requestId?: bigint } {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const out: { sessionId?: string; requestId?: bigint } = {};
	let pos = 0;
	const varint = (): bigint => {
		let shift = 0n;
		let value = 0n;
		for (;;) {
			const byte = view.getUint8(pos++);
			value |= BigInt(byte & 0x7f) << shift;
			if ((byte & 0x80) === 0) return value;
			shift += 7n;
		}
	};
	while (pos < bytes.byteLength) {
		const tag = varint();
		const field = Number(tag >> 3n);
		const wireType = tag & 7n;
		if (field === 10 && wireType === 2n) {
			const len = Number(varint());
			out.sessionId = new TextDecoder().decode(bytes.subarray(pos, pos + len));
			pos += len;
			continue;
		}
		if (field === 9 && wireType === 0n) {
			out.requestId = varint();
			continue;
		}
		switch (wireType) {
			case 0n:
				varint();
				break;
			case 1n:
				pos += 8;
				break;
			case 2n: {
				const len = Number(varint());
				pos += len;
				break;
			}
			case 5n:
				pos += 4;
				break;
			default:
				throw new Error(`unsupported wire type ${wireType} at field ${field}`);
		}
	}
	return out;
}

describe("devinCliMetadata", () => {
	it("mints per-process sessionId and monotonic requestId with released chisel version", () => {
		const first = devinCliMetadata("api-key-abc", "jwt-value");
		const second = devinCliMetadata("api-key-abc", "jwt-value");

		expect(typeof first.sessionId).toBe("string");
		expect(first.sessionId).toMatch(UUID_V4);
		expect(second.sessionId).toBe(first.sessionId);
		expect(first.ideVersion).toBe("3000.10.23");
		expect(first.extensionVersion).toBe("3000.10.23");
		expect(first.extensionName).toBe("chisel");
		expect(first.ideType).toBe("chisel");

		expect(typeof first.requestId).toBe("bigint");
		expect(second.requestId - first.requestId).toBe(1n);

		const third = devinCliMetadata(undefined);
		expect(third.requestId - second.requestId).toBe(1n);
	});

	it("preserves pass-through behavior and normalizes session tokens", () => {
		const first = devinCliMetadata("api-key-abc", "jwt-value");
		expect(first.apiKey).toBe("devin-session-token$api-key-abc");
		expect(first.userJwt).toBe("jwt-value");

		const empty = devinCliMetadata(undefined);
		expect(empty.apiKey).toBe("");

		const already = devinCliMetadata("devin-session-token$already");
		expect(already.apiKey).toBe("devin-session-token$already");
	});

	it("encodes sessionId at field 10 and requestId at field 9 on wire protobuf", () => {
		const meta = devinCliMetadata("api-key-abc", "jwt-value");
		const encoded = toBinary(MetadataSchema, create(MetadataSchema, meta as never));
		const onWire = readIdentityFields(encoded);

		expect(onWire.sessionId).toBe(meta.sessionId);
		expect(onWire.requestId).toBe(meta.requestId);

		const decoded = fromBinary(MetadataSchema, encoded);
		expect(decoded.sessionId).toBe(meta.sessionId);
		expect(decoded.requestId).toBe(meta.requestId);
		expect(decoded.ideVersion).toBe("3000.10.23");
		expect(decoded.apiKey).toBe("devin-session-token$api-key-abc");
		expect(decoded.userJwt).toBe("jwt-value");
	});

	it("keeps discovery metadata separate without session/request identity", () => {
		const discovery = devinDiscoveryMetadata("api-key-abc") as Record<string, unknown>;
		expect("sessionId" in discovery).toBe(false);
		expect("requestId" in discovery).toBe(false);
		expect(discovery.ideVersion).toBe("0.0.0-dev");
		expect(discovery.extensionVersion).toBe("0.0.0-dev");
	});
});
