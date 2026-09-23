import { isRecord } from "@oh-my-pi/pi-utils";

/**
 * High-performance, zero-builder protobuf wire codecs for @oh-my-pi/pi-catalog.
 *
 * Schemas are declared as static IR descriptors with near-zero module load overhead
 * and lazy compilation on first encode/decode/create invocation.
 */

/** JSON values carried by `google.protobuf.Value` fields. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

/** An unrecognised wire field retained for forward-compatible round-trips. */
export interface ProtoUnknownField {
	no: number;
	wireType: number;
	data: Uint8Array;
}

/** Shared internal metadata present on every decoded protocol message. */
export interface ProtoMessage {
	$typeName?: string;
	$unknown?: ProtoUnknownField[];
}

/** A bidirectional codec for one protobuf message type. */
export interface MessageCodec<T extends ProtoMessage = ProtoMessage> {
	(value: T): Uint8Array;
	(value: Uint8Array): T;
	/** Creates a message with protobuf defaults for omitted fields. */
	create(value?: Partial<T>): T;
	/** Encodes one message into protobuf wire bytes. */
	encode(value: T): Uint8Array;
	/** Decodes one protobuf message from wire bytes. */
	decode(value: Uint8Array): T;
	/** Converts a message to its protobuf JSON representation. */
	toJson(value: T): JsonValue;
}

/** Infers a message shape from a codec result. */
export type InferMessage<TCodec> = TCodec extends MessageCodec<infer TMessage> ? TMessage : never;

/** Erases a referenced message's concrete shape for static field descriptors. */
export interface MessageReference {
	encode(value: unknown): Uint8Array;
	decode(value: Uint8Array): ProtoMessage;
	toJson(value: unknown): JsonValue;
}

export type ScalarKind =
	| "bool"
	| "bytes"
	| "double"
	| "enum"
	| "float"
	| "int32"
	| "int64"
	| "string"
	| "uint32"
	| "uint64";

export type WireType = 0 | 1 | 2 | 5;

export interface ScalarFieldDesc {
	readonly no: number;
	readonly name: string;
	readonly kind: ScalarKind;
	readonly optional?: boolean;
	readonly repeat?: boolean;
}

export interface MessageFieldDesc {
	readonly no: number;
	readonly name: string;
	readonly kind: "message";
	readonly T: () => MessageReference;
	readonly repeat?: boolean;
}

export interface EnumFieldDesc {
	readonly no: number;
	readonly name: string;
	readonly kind: "enum";
	readonly optional?: boolean;
	readonly repeat?: boolean;
}

export interface MapFieldDesc {
	readonly no: number;
	readonly name: string;
	readonly kind: "map";
	readonly K: "string";
	readonly V: ScalarKind | (() => MessageReference);
}

export type VariantDesc =
	| { readonly no: number; readonly name: string; readonly kind: ScalarKind }
	| { readonly no: number; readonly name: string; readonly kind: "message"; readonly T: () => MessageReference };

export interface OneofFieldDesc {
	readonly kind: "oneof";
	readonly name: string;
	readonly variants: readonly VariantDesc[];
}

export type FieldDesc = ScalarFieldDesc | MessageFieldDesc | EnumFieldDesc | MapFieldDesc | OneofFieldDesc;

/** Runtime representation shared by fields and variants. */
interface ValueCodec<TValue> {
	readonly wireType: WireType;
	readonly defaultValue: TValue | undefined;
	encode(value: unknown, writer: Writer): void;
	decode(reader: Reader): TValue;
	toJson(value: unknown): JsonValue;
	isDefault(value: unknown): boolean;
}

interface CompiledField {
	readonly number: number;
	encode(message: object, writer: Writer): void;
	decode(message: object, reader: Reader, wireType: WireType, fieldNumber: number): void;
	toJson(message: object, output: { [key: string]: JsonValue }): void;
	initDefault(message: object): void;
}

/** Creates a high-performance, lazy protobuf message codec from an IR field descriptor list. */
export function pb<T extends ProtoMessage = ProtoMessage>(
	typeName: string,
	fields: readonly FieldDesc[] = [],
): MessageCodec<T> {
	let compiled: MessageCodec<T> | undefined;

	function getCodec(): MessageCodec<T> {
		if (!compiled) compiled = compileCodec<T>(typeName, fields);
		return compiled;
	}

	const codec = ((arg: T | Uint8Array) => {
		if (arg instanceof Uint8Array) return getCodec().decode(arg);
		return getCodec().encode(arg);
	}) as MessageCodec<T>;

	codec.create = (value?: Partial<T>): T => getCodec().create(value);
	codec.encode = (value: T): Uint8Array => getCodec().encode(value);
	codec.decode = (value: Uint8Array): T => getCodec().decode(value);
	codec.toJson = (value: T): JsonValue => getCodec().toJson(value);

	return codec;
}

/** Creates a message using its codec's protobuf defaults. */
export function create<TMessage extends ProtoMessage>(
	codec: MessageCodec<TMessage>,
	value?: Partial<TMessage>,
): TMessage {
	return codec.create(value);
}

/** Encodes a message using its codec. */
export function toBinary<TMessage extends ProtoMessage>(codec: MessageCodec<TMessage>, value: TMessage): Uint8Array {
	return codec.encode(value);
}

/** Decodes wire bytes using a message codec. */
export function fromBinary<TMessage extends ProtoMessage>(codec: MessageCodec<TMessage>, value: Uint8Array): TMessage {
	return codec.decode(value);
}

/** Converts a message to protobuf JSON using its codec. */
export function toJson<TMessage extends ProtoMessage>(codec: MessageCodec<TMessage>, value: TMessage): JsonValue {
	return codec.toJson(value);
}

/** Encodes a JSON value as `google.protobuf.Value`. */
export function encodeJsonValue(value: JsonValue): Uint8Array {
	const writer = new Writer();
	writeJsonValue(writer, value);
	return writer.finish();
}

/** Decodes `google.protobuf.Value` wire bytes into a JSON value. */
export function decodeJsonValue(value: Uint8Array): JsonValue {
	return readJsonValue(new Reader(value));
}

function compileCodec<T extends ProtoMessage>(typeName: string, fieldDescs: readonly FieldDesc[]): MessageCodec<T> {
	const compiledFields: CompiledField[] = [];
	const byNumber = new Map<number, CompiledField>();

	for (const desc of fieldDescs) {
		if (desc.kind === "oneof") {
			const oneofHandler = compileOneofField(desc);
			compiledFields.push(oneofHandler);
			for (const v of desc.variants) {
				byNumber.set(v.no, oneofHandler);
			}
		} else if (desc.kind === "map") {
			const mapHandler = compileMapField(desc);
			compiledFields.push(mapHandler);
			byNumber.set(desc.no, mapHandler);
		} else if (desc.kind === "message") {
			const msgHandler = desc.repeat
				? compileRepeatedField(desc.name, desc.no, messageValue(desc.T))
				: compileSingularField(desc.name, desc.no, messageValue(desc.T));
			compiledFields.push(msgHandler);
			byNumber.set(desc.no, msgHandler);
		} else {
			const valCodec = scalarValue(desc.kind);
			const scalarHandler = desc.repeat
				? compileRepeatedField(desc.name, desc.no, valCodec)
				: compileSingularField(desc.name, desc.no, valCodec, desc.optional);
			compiledFields.push(scalarHandler);
			byNumber.set(desc.no, scalarHandler);
		}
	}

	const codec: MessageCodec<T> = ((arg: T | Uint8Array) => {
		if (arg instanceof Uint8Array) return codec.decode(arg);
		return codec.encode(arg);
	}) as MessageCodec<T>;

	codec.create = (value?: Partial<T>): T => {
		const message = (typeName ? { $typeName: typeName } : {}) as T;
		for (const f of compiledFields) {
			f.initDefault(message);
		}
		if (value) {
			for (const key in value) {
				const v = Reflect.get(value, key);
				if (v !== undefined) {
					Reflect.set(message, key, v);
				}
			}
		}
		return message;
	};

	codec.encode = (value: T): Uint8Array => {
		const writer = new Writer();
		for (const f of compiledFields) {
			f.encode(value, writer);
		}
		writeUnknownFields(value, writer);
		return writer.finish();
	};

	codec.decode = (value: Uint8Array): T => {
		const reader = new Reader(value);
		const message = (typeName ? { $typeName: typeName } : {}) as T;
		for (const f of compiledFields) {
			f.initDefault(message);
		}

		while (reader.pos < reader.len) {
			const tag = reader.uint32();
			const fieldNumber = tag >>> 3;
			const wireType = tag & 7;
			if (!isWireType(wireType)) {
				throw new Error(`Unsupported protobuf wire type ${wireType} at byte ${reader.pos}`);
			}
			const field = byNumber.get(fieldNumber);
			if (field) {
				field.decode(message, reader, wireType, fieldNumber);
			} else {
				const start = reader.pos;
				reader.skip(wireType);
				appendUnknownField(message, {
					no: fieldNumber,
					wireType,
					data: reader.slice(start, reader.pos),
				});
			}
		}
		return message;
	};

	codec.toJson = (value: T): JsonValue => {
		const output: { [key: string]: JsonValue } = {};
		for (const f of compiledFields) {
			f.toJson(value, output);
		}
		return output;
	};

	return codec;
}

function compileSingularField(
	name: string,
	number: number,
	value: ValueCodec<unknown>,
	optional = false,
): CompiledField {
	return {
		number,
		initDefault(message) {
			if (!optional && value.defaultValue !== undefined) {
				Reflect.set(message, name, value.defaultValue);
			}
		},
		encode(message, writer) {
			const input = Reflect.get(message, name);
			if (input === undefined || (!optional && value.isDefault(input))) return;
			writer.tag(number, value.wireType);
			value.encode(input, writer);
		},
		decode(message, reader, wireType, _fieldNumber) {
			assertWireType(wireType, value.wireType);
			Reflect.set(message, name, value.decode(reader));
		},
		toJson(message, output) {
			const input = Reflect.get(message, name);
			if (input === undefined || (!optional && value.isDefault(input))) return;
			output[name] = value.toJson(input);
		},
	};
}

function compileRepeatedField(name: string, number: number, value: ValueCodec<unknown>): CompiledField {
	return {
		number,
		initDefault(message) {
			Reflect.set(message, name, []);
		},
		encode(message, writer) {
			const items = Reflect.get(message, name);
			if (!Array.isArray(items) || items.length === 0) return;

			if (value.wireType !== 2 && isPackableScalar(value)) {
				const packed = new Writer();
				for (const item of items) {
					value.encode(item, packed);
				}
				writer.tag(number, 2);
				writer.lengthDelimited(packed.finish());
				return;
			}

			for (const item of items) {
				writer.tag(number, value.wireType);
				value.encode(item, writer);
			}
		},
		decode(message, reader, wireType, _fieldNumber) {
			const target = arrayField(message, name);
			if (wireType === 2 && value.wireType !== 2 && isPackableScalar(value)) {
				const limit = reader.uint32();
				const end = reader.pos + limit;
				while (reader.pos < end) {
					target.push(value.decode(reader));
				}
				return;
			}
			assertWireType(wireType, value.wireType);
			target.push(value.decode(reader));
		},
		toJson(message, output) {
			const items = Reflect.get(message, name);
			if (!Array.isArray(items) || items.length === 0) return;
			output[name] = items.map(item => value.toJson(item));
		},
	};
}

function compileMapField(desc: MapFieldDesc): CompiledField {
	const name = desc.name;
	const number = desc.no;
	const key = scalarValue("string");
	const valCodec = typeof desc.V === "function" ? messageValue(desc.V) : scalarValue(desc.V);

	return {
		number,
		initDefault(message) {
			Reflect.set(message, name, Object.create(null));
		},
		encode(message, writer) {
			const input = Reflect.get(message, name);
			if (!isMessageObject(input)) return;
			for (const entryKey in input) {
				const entry = new Writer();
				if (!key.isDefault(entryKey)) {
					entry.tag(1, key.wireType);
					key.encode(entryKey, entry);
				}
				const entryValue = input[entryKey];
				if (!valCodec.isDefault(entryValue)) {
					entry.tag(2, valCodec.wireType);
					valCodec.encode(entryValue, entry);
				}
				writer.tag(number, 2);
				writer.lengthDelimited(entry.finish());
			}
		},
		decode(message, reader, wireType, _fieldNumber) {
			assertWireType(wireType, 2);
			const target = mapField(message, name);
			const limit = reader.uint32();
			const end = reader.pos + limit;
			let entryKey = "";
			let entryValue: unknown = valCodec.defaultValue;

			while (reader.pos < end) {
				const tag = reader.uint32();
				const entryNumber = tag >>> 3;
				const entryWireType = tag & 7;
				if (!isWireType(entryWireType)) {
					throw new Error(`Unsupported wire type ${entryWireType} in map entry`);
				}
				if (entryNumber === 1) {
					assertWireType(entryWireType, key.wireType);
					entryKey = requireString(key.decode(reader));
				} else if (entryNumber === 2) {
					assertWireType(entryWireType, valCodec.wireType);
					entryValue = valCodec.decode(reader);
				} else {
					reader.skip(entryWireType);
				}
			}

			target[entryKey] = entryValue;
		},
		toJson(message, output) {
			const input = Reflect.get(message, name);
			if (!isMessageObject(input)) return;
			const mapOutput: { [key: string]: JsonValue } = Object.create(null);
			for (const entryKey in input) {
				mapOutput[entryKey] = valCodec.toJson(input[entryKey]);
			}
			output[name] = mapOutput;
		},
	};
}

function compileOneofField(desc: OneofFieldDesc): CompiledField {
	const name = desc.name;
	const variantsByName = new Map<string, { no: number; codec: ValueCodec<unknown> }>();
	const variantsByNumber = new Map<number, { name: string; codec: ValueCodec<unknown> }>();

	for (const variant of desc.variants) {
		const codec = variant.kind === "message" ? messageValue(variant.T) : scalarValue(variant.kind);
		variantsByName.set(variant.name, { no: variant.no, codec });
		variantsByNumber.set(variant.no, { name: variant.name, codec });
	}

	return {
		number: 0,
		initDefault(message) {
			Reflect.set(message, name, { case: undefined });
		},
		encode(message, writer) {
			const oneof = Reflect.get(message, name);
			if (!oneof || typeof oneof !== "object" || !("case" in oneof) || typeof oneof.case !== "string") return;
			const variant = variantsByName.get(oneof.case);
			if (!variant) return;
			const value = Reflect.get(oneof, "value");
			if (value === undefined) return;
			writer.tag(variant.no, variant.codec.wireType);
			variant.codec.encode(value, writer);
		},
		decode(message, reader, wireType, fieldNumber) {
			const variant = variantsByNumber.get(fieldNumber);
			if (!variant) throw new Error(`Unknown oneof field ${fieldNumber}`);
			assertWireType(wireType, variant.codec.wireType);
			Reflect.set(message, name, { case: variant.name, value: variant.codec.decode(reader) });
		},
		toJson(message, output) {
			const oneof = Reflect.get(message, name);
			if (!oneof || typeof oneof !== "object" || !("case" in oneof) || typeof oneof.case !== "string") return;
			const variant = variantsByName.get(oneof.case);
			if (!variant) return;
			const value = Reflect.get(oneof, "value");
			if (value === undefined) return;
			output[oneof.case] = variant.codec.toJson(value);
		},
	};
}

function isPackableScalar(value: ValueCodec<unknown>): boolean {
	return value.wireType === 0 || value.wireType === 1 || value.wireType === 5;
}

function scalarValue(kind: ScalarKind): ValueCodec<unknown> {
	switch (kind) {
		case "bool":
			return scalar(
				0,
				false,
				requireBoolean,
				(value, writer) => writer.bool(value),
				reader => reader.bool(),
				value => value,
			);
		case "bytes":
			return scalar(
				2,
				new Uint8Array(0),
				requireBytes,
				(value, writer) => writer.bytes(value),
				reader => reader.bytes(),
				value => value.toBase64(),
				value => value.byteLength === 0,
			);
		case "double":
			return scalar(
				1,
				0,
				requireNumber,
				(value, writer) => writer.double(value),
				reader => reader.double(),
				value => value,
			);
		case "enum":
			return scalar(
				0,
				0,
				requireInt32,
				(value, writer) => writer.int32(value),
				reader => reader.int32(),
				value => value,
			);
		case "float":
			return scalar(
				5,
				0,
				requireNumber,
				(value, writer) => writer.float(value),
				reader => reader.float(),
				value => value,
			);
		case "int32":
			return scalar(
				0,
				0,
				requireInt32,
				(value, writer) => writer.int32(value),
				reader => reader.int32(),
				value => value,
			);
		case "int64":
			return scalar(
				0,
				0n,
				requireBigInt,
				(value, writer) => writer.int64(value),
				reader => reader.int64(),
				value => value.toString(),
			);
		case "string":
			return scalar(
				2,
				"",
				requireString,
				(value, writer) => writer.string(value),
				reader => reader.string(),
				value => value,
			);
		case "uint32":
			return scalar(
				0,
				0,
				requireUint32,
				(value, writer) => writer.uint32(value),
				reader => reader.uint32(),
				value => value,
			);
		case "uint64":
			return scalar(
				0,
				0n,
				requireUnsignedBigInt,
				(value, writer) => writer.uint64(value),
				reader => reader.uint64(),
				value => value.toString(),
			);
	}
}

function scalar<TValue>(
	wireType: WireType,
	defaultValue: TValue,
	validate: (value: unknown) => TValue,
	write: (value: TValue, writer: Writer) => void,
	read: (reader: Reader) => TValue,
	toJson: (value: TValue) => JsonValue,
	isDefault: (value: TValue) => boolean = value => value === defaultValue,
): ValueCodec<TValue> {
	return {
		wireType,
		defaultValue,
		encode(value, writer) {
			write(validate(value), writer);
		},
		decode(reader) {
			return read(reader);
		},
		toJson(value) {
			return toJson(validate(value));
		},
		isDefault(value) {
			return isDefault(validate(value));
		},
	};
}

function messageValue(factory: () => MessageReference): ValueCodec<unknown> {
	let cached: MessageReference | undefined;

	function getCodec(): MessageReference {
		if (!cached) cached = factory();
		return cached;
	}

	return {
		wireType: 2,
		defaultValue: undefined,
		encode(value, writer) {
			writer.lengthDelimited(getCodec().encode(value));
		},
		decode(reader) {
			return getCodec().decode(reader.bytes());
		},
		toJson(value) {
			return getCodec().toJson(value);
		},
		isDefault(value) {
			return value === undefined;
		},
	};
}

function requireBoolean(value: unknown): boolean {
	if (typeof value === "boolean") return value;
	throw new Error(`Expected boolean, got ${typeof value}`);
}

function requireBytes(value: unknown): Uint8Array {
	if (value instanceof Uint8Array) return value;
	throw new Error("Expected Uint8Array");
}

function requireNumber(value: unknown): number {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	throw new Error(`Expected number, got ${typeof value}`);
}

function requireInt32(value: unknown): number {
	if (typeof value === "number" && Number.isInteger(value)) return value | 0;
	throw new Error(`Expected int32, got ${typeof value}`);
}
function requireString(value: unknown): string {
	if (typeof value === "string") return value;
	throw new Error(`Expected string, got ${typeof value}`);
}

function requireBigInt(value: unknown): bigint {
	if (typeof value === "bigint") return value;
	if (typeof value === "number" && Number.isInteger(value)) return BigInt(value);
	if (typeof value === "string") return BigInt(value);
	throw new Error(`Expected bigint, got ${typeof value}`);
}

function requireUint32(value: unknown): number {
	if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value >>> 0;
	throw new Error(`Expected uint32, got ${typeof value}`);
}

function requireUnsignedBigInt(value: unknown): bigint {
	const b = requireBigInt(value);
	if (b < 0n) throw new Error("Expected unsigned bigint");
	return b;
}

function arrayField(message: object, name: string): unknown[] {
	let arr = Reflect.get(message, name);
	if (!Array.isArray(arr)) {
		arr = [];
		Reflect.set(message, name, arr);
	}
	return arr;
}

function mapField(message: object, name: string): Record<string, unknown> {
	const value = Reflect.get(message, name);
	if (isRecord(value)) return value;
	const map: Record<string, unknown> = Object.create(null);
	Reflect.set(message, name, map);
	return map;
}

function appendUnknownField(message: object, field: ProtoUnknownField): void {
	const existing = Reflect.get(message, "$unknown");
	if (isUnknownFields(existing)) {
		existing.push(field);
		return;
	}
	Reflect.set(message, "$unknown", [field]);
}

function isUnknownFields(value: unknown): value is ProtoUnknownField[] {
	return Array.isArray(value) && value.every(isUnknownField);
}

function writeUnknownFields(message: object, writer: Writer): void {
	const bag = Reflect.get(message, "$unknown");
	if (!Array.isArray(bag)) return;
	for (const field of bag) {
		if (isUnknownField(field)) {
			writer.tag(field.no, field.wireType);
			writer.raw(field.data);
		}
	}
}

function isUnknownField(value: unknown): value is ProtoUnknownField & { wireType: WireType } {
	return (
		isRecord(value) &&
		typeof value.no === "number" &&
		typeof value.wireType === "number" &&
		isWireType(value.wireType) &&
		value.data instanceof Uint8Array
	);
}

function isMessageObject(value: unknown): value is { [key: string]: unknown } {
	return isRecord(value) && !(value instanceof Uint8Array);
}

function isWireType(value: number): value is WireType {
	return value === 0 || value === 1 || value === 2 || value === 5;
}

function assertWireType(actual: WireType, expected: WireType): void {
	if (actual !== expected) throw new Error(`Unexpected protobuf wire type ${actual}; expected ${expected}`);
}

class Writer {
	#chunks: Uint8Array[] = [];
	#length = 0;

	tag(number: number, wireType: WireType): void {
		this.uint32((number << 3) | wireType);
	}

	uint32(value: number): void {
		let v = value >>> 0;
		const buffer = new Uint8Array(5);
		let pos = 0;
		while (v > 0x7f) {
			buffer[pos++] = (v & 0x7f) | 0x80;
			v >>>= 7;
		}
		buffer[pos++] = v;
		this.raw(buffer.subarray(0, pos));
	}

	int32(value: number): void {
		if (value >= 0) {
			this.uint32(value);
			return;
		}
		this.int64(BigInt(value));
	}

	int64(value: bigint): void {
		let v = BigInt.asUintN(64, value);
		const buffer = new Uint8Array(10);
		let pos = 0;
		while (v > 0x7fn) {
			buffer[pos++] = Number(v & 0x7fn) | 0x80;
			v >>= 7n;
		}
		buffer[pos++] = Number(v);
		this.raw(buffer.subarray(0, pos));
	}

	uint64(value: bigint): void {
		this.int64(value);
	}

	bool(value: boolean): void {
		this.raw(new Uint8Array([value ? 1 : 0]));
	}

	float(value: number): void {
		const buffer = new Uint8Array(4);
		new DataView(buffer.buffer).setFloat32(0, value, true);
		this.raw(buffer);
	}

	double(value: number): void {
		const buffer = new Uint8Array(8);
		new DataView(buffer.buffer).setFloat64(0, value, true);
		this.raw(buffer);
	}

	string(value: string): void {
		this.lengthDelimited(textEncoder.encode(value));
	}

	bytes(value: Uint8Array): void {
		this.lengthDelimited(value);
	}

	lengthDelimited(value: Uint8Array): void {
		this.uint32(value.byteLength);
		this.raw(value);
	}

	raw(chunk: Uint8Array): void {
		this.#chunks.push(chunk);
		this.#length += chunk.byteLength;
	}

	finish(): Uint8Array {
		if (this.#chunks.length === 1) return this.#chunks[0];
		const result = new Uint8Array(this.#length);
		let offset = 0;
		for (const chunk of this.#chunks) {
			result.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return result;
	}
}

class Reader {
	readonly buf: Uint8Array;
	readonly len: number;
	pos = 0;

	constructor(buf: Uint8Array) {
		this.buf = buf;
		this.len = buf.byteLength;
	}

	uint32(): number {
		let result = 0;
		let shift = 0;
		while (this.pos < this.len) {
			const byte = this.buf[this.pos++];
			result |= (byte & 0x7f) << shift;
			if ((byte & 0x80) === 0) return result >>> 0;
			shift += 7;
			if (shift >= 32) throw new Error("Varint exceeds 32 bits");
		}
		throw new Error("Unexpected end of protobuf varint");
	}

	int32(): number {
		return Number(BigInt.asIntN(32, this.uint64()));
	}

	int64(): bigint {
		let result = 0n;
		let shift = 0n;
		while (this.pos < this.len) {
			const byte = this.buf[this.pos++];
			result |= BigInt(byte & 0x7f) << shift;
			if ((byte & 0x80) === 0) return BigInt.asIntN(64, result);
			shift += 7n;
			if (shift >= 64n) throw new Error("Varint exceeds 64 bits");
		}
		throw new Error("Unexpected end of protobuf 64-bit varint");
	}

	uint64(): bigint {
		return BigInt.asUintN(64, this.int64());
	}

	bool(): boolean {
		return this.uint32() !== 0;
	}

	float(): number {
		if (this.pos + 4 > this.len) throw new Error("Unexpected EOF reading float");
		const view = new DataView(this.buf.buffer, this.buf.byteOffset + this.pos, 4);
		this.pos += 4;
		return view.getFloat32(0, true);
	}

	double(): number {
		if (this.pos + 8 > this.len) throw new Error("Unexpected EOF reading double");
		const view = new DataView(this.buf.buffer, this.buf.byteOffset + this.pos, 8);
		this.pos += 8;
		return view.getFloat64(0, true);
	}

	string(): string {
		return textDecoder.decode(this.bytes());
	}

	bytes(): Uint8Array {
		const length = this.uint32();
		if (this.pos + length > this.len) throw new Error("Unexpected EOF reading bytes");
		const result = this.buf.subarray(this.pos, this.pos + length);
		this.pos += length;
		return result;
	}

	slice(start: number, end: number): Uint8Array {
		return this.buf.subarray(start, end);
	}

	skip(wireType: WireType): void {
		switch (wireType) {
			case 0:
				this.int64();
				return;
			case 1:
				if (this.pos + 8 > this.len) throw new Error("Unexpected EOF skipping 64-bit");
				this.pos += 8;
				return;
			case 2:
				this.bytes();
				return;
			case 5:
				if (this.pos + 4 > this.len) throw new Error("Unexpected EOF skipping 32-bit");
				this.pos += 4;
				return;
		}
	}
}

function writeJsonValue(writer: Writer, value: JsonValue): void {
	if (value === null) {
		writer.tag(1, 0);
		writer.uint32(0);
		return;
	}
	if (typeof value === "number") {
		writer.tag(2, 1);
		writer.double(value);
		return;
	}
	if (typeof value === "string") {
		writer.tag(3, 2);
		writer.string(value);
		return;
	}
	if (typeof value === "boolean") {
		writer.tag(4, 0);
		writer.bool(value);
		return;
	}
	if (Array.isArray(value)) {
		const listWriter = new Writer();
		for (const item of value) {
			listWriter.tag(1, 2);
			const itemWriter = new Writer();
			writeJsonValue(itemWriter, item);
			listWriter.lengthDelimited(itemWriter.finish());
		}
		writer.tag(6, 2);
		writer.lengthDelimited(listWriter.finish());
		return;
	}
	if (isRecord(value)) {
		const structWriter = new Writer();
		for (const key in value) {
			const item = value[key];
			const entryWriter = new Writer();
			entryWriter.tag(1, 2);
			entryWriter.string(key);
			entryWriter.tag(2, 2);
			const valueWriter = new Writer();
			writeJsonValue(valueWriter, item);
			entryWriter.lengthDelimited(valueWriter.finish());
			structWriter.tag(1, 2);
			structWriter.lengthDelimited(entryWriter.finish());
		}
		writer.tag(5, 2);
		writer.lengthDelimited(structWriter.finish());
	}
}

function readJsonValue(reader: Reader): JsonValue {
	let value: JsonValue = null;
	while (reader.pos < reader.len) {
		const tag = reader.uint32();
		const fieldNumber = tag >>> 3;
		const wireType = tag & 7;
		if (!isWireType(wireType)) {
			throw new Error(`Unsupported wire type ${wireType} in google.protobuf.Value`);
		}
		switch (fieldNumber) {
			case 1:
				assertWireType(wireType, 0);
				reader.uint32();
				value = null;
				break;
			case 2:
				assertWireType(wireType, 1);
				value = reader.double();
				break;
			case 3:
				assertWireType(wireType, 2);
				value = reader.string();
				break;
			case 4:
				assertWireType(wireType, 0);
				value = reader.bool();
				break;
			case 5:
				assertWireType(wireType, 2);
				value = readJsonStruct(new Reader(reader.bytes()));
				break;
			case 6:
				assertWireType(wireType, 2);
				value = readJsonList(new Reader(reader.bytes()));
				break;
			default:
				reader.skip(wireType);
				break;
		}
	}
	return value;
}

function readJsonStruct(reader: Reader): { [key: string]: JsonValue } {
	const output: { [key: string]: JsonValue } = {};
	while (reader.pos < reader.len) {
		const tag = reader.uint32();
		const fieldNumber = tag >>> 3;
		const wireType = tag & 7;
		if (!isWireType(wireType)) {
			throw new Error(`Unsupported wire type ${wireType} in Struct`);
		}
		if (fieldNumber === 1) {
			assertWireType(wireType, 2);
			const entryReader = new Reader(reader.bytes());
			let entryKey = "";
			let entryVal: JsonValue = null;
			while (entryReader.pos < entryReader.len) {
				const entryTag = entryReader.uint32();
				const entryNo = entryTag >>> 3;
				const entryWire = entryTag & 7;
				if (entryNo === 1) {
					entryKey = entryReader.string();
				} else if (entryNo === 2) {
					entryVal = readJsonValue(new Reader(entryReader.bytes()));
				} else if (isWireType(entryWire)) {
					entryReader.skip(entryWire);
				}
			}
			output[entryKey] = entryVal;
		} else {
			reader.skip(wireType);
		}
	}
	return output;
}

function readJsonList(reader: Reader): JsonValue[] {
	const list: JsonValue[] = [];
	while (reader.pos < reader.len) {
		const tag = reader.uint32();
		const fieldNumber = tag >>> 3;
		const wireType = tag & 7;
		if (!isWireType(wireType)) {
			throw new Error(`Unsupported wire type ${wireType} in ListValue`);
		}
		if (fieldNumber === 1) {
			assertWireType(wireType, 2);
			list.push(readJsonValue(new Reader(reader.bytes())));
		} else {
			reader.skip(wireType);
		}
	}
	return list;
}
