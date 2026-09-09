/**
 * Lightweight protobuf (.proto) parser and TypeScript code generator for @oh-my-pi/pi-catalog.
 *
 * Generates type-safe schema definitions and message types using the discovery/protobuf runtime codecs.
 */

export type ProtoScalarType =
	| "bool"
	| "bytes"
	| "double"
	| "float"
	| "int32"
	| "int64"
	| "uint32"
	| "uint64"
	| "sint32"
	| "sint64"
	| "fixed32"
	| "fixed64"
	| "sfixed32"
	| "sfixed64"
	| "string";

export const PROTO_SCALAR_TYPES: Record<string, true> = {
	bool: true,
	bytes: true,
	double: true,
	float: true,
	int32: true,
	int64: true,
	uint32: true,
	uint64: true,
	sint32: true,
	sint64: true,
	fixed32: true,
	fixed64: true,
	sfixed32: true,
	sfixed64: true,
	string: true,
};

export interface ProtoOption {
	name: string;
	value: unknown;
}

export interface ProtoImport {
	path: string;
	kind: "standard" | "public" | "weak";
}

export interface ProtoEnumValue {
	name: string;
	number: number;
	comment?: string;
	options: ProtoOption[];
}

export interface ProtoEnum {
	name: string;
	fullName: string;
	comment?: string;
	values: ProtoEnumValue[];
	options: ProtoOption[];
	parentMessage?: string;
}

export interface ProtoBaseField {
	name: string;
	jsonName: string;
	number: number;
	rule?: "optional" | "required" | "repeated";
	comment?: string;
	options: ProtoOption[];
}

export interface ProtoScalarField extends ProtoBaseField {
	kind: "scalar";
	scalarType: ProtoScalarType;
}

export interface ProtoMessageField extends ProtoBaseField {
	kind: "message";
	typeName: string;
	resolvedTypeName?: string;
}

export interface ProtoEnumField extends ProtoBaseField {
	kind: "enum";
	typeName: string;
	resolvedTypeName?: string;
}

export interface ProtoMapField extends ProtoBaseField {
	kind: "map";
	keyType: string;
	valueType: string;
	valueKind: "scalar" | "message" | "enum";
	resolvedValueTypeName?: string;
}

export type ProtoField = ProtoScalarField | ProtoMessageField | ProtoEnumField | ProtoMapField;

export interface ProtoOneof {
	name: string;
	comment?: string;
	fields: (ProtoScalarField | ProtoMessageField | ProtoEnumField)[];
}

export interface ProtoMessage {
	name: string;
	fullName: string;
	comment?: string;
	fields: ProtoField[];
	oneofs: ProtoOneof[];
	nestedEnums: ProtoEnum[];
	nestedMessages: ProtoMessage[];
	options: ProtoOption[];
	reserved: (number | string | [number, number])[];
	parentMessage?: string;
}

export interface ProtoRpc {
	name: string;
	comment?: string;
	requestType: string;
	requestStream: boolean;
	responseType: string;
	responseStream: boolean;
	options: ProtoOption[];
}

export interface ProtoService {
	name: string;
	fullName: string;
	comment?: string;
	rpcs: ProtoRpc[];
	options: ProtoOption[];
}

export interface ProtoFile {
	syntax: "proto2" | "proto3";
	package: string;
	imports: ProtoImport[];
	options: ProtoOption[];
	enums: ProtoEnum[];
	messages: ProtoMessage[];
	services: ProtoService[];
	filename?: string;
}

interface Token {
	type: "ident" | "int" | "float" | "string" | "symbol" | "eof";
	value: string | number;
	line: number;
	col: number;
	comment?: string;
}

class Tokenizer {
	readonly #source: string;
	readonly #filename: string;
	#cursor = 0;
	#line = 1;
	#col = 1;
	#pendingComment: string | undefined;

	constructor(source: string, filename = "<anonymous>") {
		this.#source = source;
		this.#filename = filename;
	}

	next(): Token {
		this.#skipWhitespaceAndComments();

		if (this.#cursor >= this.#source.length) {
			return {
				type: "eof",
				value: "",
				line: this.#line,
				col: this.#col,
				comment: this.#consumePendingComment(),
			};
		}

		const startLine = this.#line;
		const startCol = this.#col;
		const comment = this.#consumePendingComment();
		const ch = this.#source[this.#cursor];

		if (ch === '"' || ch === "'") {
			const strVal = this.#readString(ch);
			let combined = strVal;
			while (true) {
				const saveCursor = this.#cursor;
				const saveLine = this.#line;
				const saveCol = this.#col;
				this.#skipWhitespaceAndComments();
				if (
					this.#cursor < this.#source.length &&
					(this.#source[this.#cursor] === '"' || this.#source[this.#cursor] === "'")
				) {
					combined += this.#readString(this.#source[this.#cursor]);
				} else {
					this.#cursor = saveCursor;
					this.#line = saveLine;
					this.#col = saveCol;
					break;
				}
			}
			return { type: "string", value: combined, line: startLine, col: startCol, comment };
		}

		if (this.#isDigit(ch) || (ch === "-" && this.#isDigit(this.#peek(1)))) {
			return this.#readNumber(startLine, startCol, comment);
		}

		if (this.#isIdentStart(ch)) {
			let ident = "";
			while (this.#cursor < this.#source.length) {
				const c = this.#source[this.#cursor];
				if (this.#isIdentPart(c) || c === ".") {
					ident += c;
					this.#advance();
				} else {
					break;
				}
			}
			return { type: "ident", value: ident, line: startLine, col: startCol, comment };
		}

		this.#advance();
		return { type: "symbol", value: ch, line: startLine, col: startCol, comment };
	}

	#consumePendingComment(): string | undefined {
		const c = this.#pendingComment;
		this.#pendingComment = undefined;
		return c;
	}

	#skipWhitespaceAndComments(): void {
		while (this.#cursor < this.#source.length) {
			const ch = this.#source[this.#cursor];
			if (ch === " " || ch === "\t" || ch === "\r") {
				this.#advance();
			} else if (ch === "\n") {
				this.#advance();
			} else if (ch === "/" && this.#peek(1) === "/") {
				this.#advance();
				this.#advance();
				let commentText = "";
				while (this.#cursor < this.#source.length && this.#source[this.#cursor] !== "\n") {
					commentText += this.#source[this.#cursor];
					this.#advance();
				}
				commentText = commentText.replace(/^\/?\s?/, "").trimEnd();
				this.#pendingComment = this.#pendingComment ? `${this.#pendingComment}\n${commentText}` : commentText;
			} else if (ch === "/" && this.#peek(1) === "*") {
				this.#advance();
				this.#advance();
				let commentText = "";
				while (
					this.#cursor < this.#source.length &&
					!(this.#source[this.#cursor] === "*" && this.#peek(1) === "/")
				) {
					commentText += this.#source[this.#cursor];
					this.#advance();
				}
				if (this.#cursor < this.#source.length) {
					this.#advance();
					this.#advance();
				}
				const clean = commentText
					.split("\n")
					.map(l => l.replace(/^\s*\*?\s?/, "").trimEnd())
					.join("\n")
					.trim();
				this.#pendingComment = this.#pendingComment ? `${this.#pendingComment}\n${clean}` : clean;
			} else {
				break;
			}
		}
	}

	#readString(quote: string): string {
		this.#advance();
		let result = "";
		while (this.#cursor < this.#source.length) {
			const ch = this.#source[this.#cursor];
			if (ch === quote) {
				this.#advance();
				return result;
			}
			if (ch === "\\") {
				this.#advance();
				if (this.#cursor >= this.#source.length) break;
				const esc = this.#source[this.#cursor];
				this.#advance();
				switch (esc) {
					case "n":
						result += "\n";
						break;
					case "r":
						result += "\r";
						break;
					case "t":
						result += "\t";
						break;
					case "b":
						result += "\b";
						break;
					case "f":
						result += "\f";
						break;
					case "v":
						result += "\v";
						break;
					case "0":
						result += "\0";
						break;
					case "\\":
						result += "\\";
						break;
					case '"':
						result += '"';
						break;
					case "'":
						result += "'";
						break;
					case "x":
					case "X": {
						const hex = this.#source.slice(this.#cursor, this.#cursor + 2);
						if (/^[0-9a-fA-F]{1,2}$/.test(hex)) {
							this.#cursor += hex.length;
							this.#col += hex.length;
							result += String.fromCharCode(Number.parseInt(hex, 16));
						} else {
							result += "x";
						}
						break;
					}
					case "u": {
						const hex = this.#source.slice(this.#cursor, this.#cursor + 4);
						if (/^[0-9a-fA-F]{4}$/.test(hex)) {
							this.#cursor += 4;
							this.#col += 4;
							result += String.fromCharCode(Number.parseInt(hex, 16));
						} else {
							result += "u";
						}
						break;
					}
					case "U": {
						const hex = this.#source.slice(this.#cursor, this.#cursor + 8);
						if (/^[0-9a-fA-F]{8}$/.test(hex)) {
							this.#cursor += 8;
							this.#col += 8;
							result += String.fromCodePoint(Number.parseInt(hex, 16));
						} else {
							result += "U";
						}
						break;
					}
					default:
						if (esc >= "0" && esc <= "7") {
							let oct = esc;
							while (
								oct.length < 3 &&
								this.#cursor < this.#source.length &&
								this.#source[this.#cursor] >= "0" &&
								this.#source[this.#cursor] <= "7"
							) {
								oct += this.#source[this.#cursor];
								this.#advance();
							}
							result += String.fromCharCode(Number.parseInt(oct, 8));
						} else {
							result += esc;
						}
						break;
				}
			} else {
				result += ch;
				this.#advance();
			}
		}
		throw new Error(`Unterminated string literal in ${this.#filename}:${this.#line}:${this.#col}`);
	}

	#readNumber(startLine: number, startCol: number, comment?: string): Token {
		let numStr = "";
		if (this.#source[this.#cursor] === "-") {
			numStr += "-";
			this.#advance();
		}

		if (this.#source[this.#cursor] === "0" && (this.#peek(1) === "x" || this.#peek(1) === "X")) {
			numStr += this.#source.slice(this.#cursor, this.#cursor + 2);
			this.#advance();
			this.#advance();
			while (this.#cursor < this.#source.length && /[0-9a-fA-F]/.test(this.#source[this.#cursor])) {
				numStr += this.#source[this.#cursor];
				this.#advance();
			}
			return { type: "int", value: Number.parseInt(numStr, 16), line: startLine, col: startCol, comment };
		}

		let isFloat = false;
		while (this.#cursor < this.#source.length) {
			const ch = this.#source[this.#cursor];
			if (this.#isDigit(ch)) {
				numStr += ch;
				this.#advance();
			} else if (ch === "." && this.#isDigit(this.#peek(1))) {
				isFloat = true;
				numStr += ch;
				this.#advance();
			} else if (
				(ch === "e" || ch === "E") &&
				(this.#isDigit(this.#peek(1)) || this.#peek(1) === "-" || this.#peek(1) === "+")
			) {
				isFloat = true;
				numStr += ch;
				this.#advance();
				if (this.#source[this.#cursor] === "-" || this.#source[this.#cursor] === "+") {
					numStr += this.#source[this.#cursor];
					this.#advance();
				}
			} else {
				break;
			}
		}

		const val = isFloat ? Number.parseFloat(numStr) : Number.parseInt(numStr, 10);
		return { type: isFloat ? "float" : "int", value: val, line: startLine, col: startCol, comment };
	}

	#isDigit(ch: string | undefined): boolean {
		return ch !== undefined && ch >= "0" && ch <= "9";
	}

	#isIdentStart(ch: string | undefined): boolean {
		return ch !== undefined && (ch === "_" || (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || ch === ".");
	}

	#isIdentPart(ch: string | undefined): boolean {
		return (
			ch !== undefined &&
			(ch === "_" || (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || (ch >= "0" && ch <= "9"))
		);
	}

	#peek(offset: number): string | undefined {
		const pos = this.#cursor + offset;
		return pos < this.#source.length ? this.#source[pos] : undefined;
	}

	#advance(): void {
		if (this.#source[this.#cursor] === "\n") {
			this.#line++;
			this.#col = 1;
		} else {
			this.#col++;
		}
		this.#cursor++;
	}
}

class Parser {
	readonly #tokenizer: Tokenizer;
	readonly #filename: string;
	#current: Token;
	get #isEof(): boolean {
		return this.#current.type === "eof";
	}

	constructor(source: string, filename = "<anonymous>") {
		this.#filename = filename;
		this.#tokenizer = new Tokenizer(source, filename);
		this.#current = this.#tokenizer.next();
	}

	parse(): ProtoFile {
		const file: ProtoFile = {
			syntax: "proto3",
			package: "",
			imports: [],
			options: [],
			enums: [],
			messages: [],
			services: [],
			filename: this.#filename,
		};

		while (!this.#isEof) {
			if (this.#matchIdent("syntax")) {
				this.#expectSymbol("=");
				const syn = this.#expectString();
				file.syntax = syn === "proto2" ? "proto2" : "proto3";
				this.#expectSymbol(";");
			} else if (this.#matchIdent("package")) {
				file.package = this.#expectIdent();
				this.#expectSymbol(";");
			} else if (this.#matchIdent("import")) {
				let kind: ProtoImport["kind"] = "standard";
				if (this.#matchIdent("public")) kind = "public";
				else if (this.#matchIdent("weak")) kind = "weak";
				const importPath = this.#expectString();
				file.imports.push({ path: importPath, kind });
				this.#expectSymbol(";");
			} else if (this.#matchIdent("option")) {
				file.options.push(this.#parseOption());
				this.#expectSymbol(";");
			} else if (this.#matchIdent("enum")) {
				file.enums.push(this.#parseEnum(file.package));
			} else if (this.#matchIdent("message")) {
				file.messages.push(this.#parseMessage(file.package));
			} else if (this.#matchIdent("service")) {
				file.services.push(this.#parseService(file.package));
			} else if (this.#matchIdent("extend")) {
				this.#skipExtendBlock();
			} else if (this.#matchSymbol(";")) {
				// empty top-level semicolon
			} else {
				throw new Error(
					`Unexpected token '${this.#current.value}' at ${this.#filename}:${this.#current.line}:${this.#current.col}`,
				);
			}
		}

		return file;
	}

	#parseEnum(packagePrefix: string, parentMessage?: string): ProtoEnum {
		const comment = this.#current.comment;
		const name = this.#expectIdent();
		const fullName = parentMessage ? `${parentMessage}_${name}` : packagePrefix ? `${packagePrefix}.${name}` : name;

		this.#expectSymbol("{");
		const enumObj: ProtoEnum = {
			name,
			fullName,
			comment,
			values: [],
			options: [],
			parentMessage,
		};
		while (!this.#checkSymbol("}") && !this.#isEof) {
			if (this.#matchIdent("option")) {
				enumObj.options.push(this.#parseOption());
				this.#expectSymbol(";");
			} else if (this.#matchIdent("reserved")) {
				this.#skipUntilSemicolon();
			} else if (this.#matchSymbol(";")) {
				// extra semicolon
			} else {
				const valComment = this.#current.comment;
				const valName = this.#expectIdent();
				this.#expectSymbol("=");
				const valNumber = this.#expectNumber();
				const options = this.#parseFieldOptions();
				this.#expectSymbol(";");
				enumObj.values.push({
					name: valName,
					number: valNumber,
					comment: valComment,
					options,
				});
			}
		}

		this.#expectSymbol("}");
		this.#matchSymbol(";");
		return enumObj;
	}

	#parseMessage(packagePrefix: string, parentMessage?: string): ProtoMessage {
		const comment = this.#current.comment;
		const name = this.#expectIdent();
		const fullName = parentMessage ? `${parentMessage}_${name}` : packagePrefix ? `${packagePrefix}.${name}` : name;

		this.#expectSymbol("{");
		const message: ProtoMessage = {
			name,
			fullName,
			comment,
			fields: [],
			oneofs: [],
			nestedEnums: [],
			nestedMessages: [],
			options: [],
			reserved: [],
			parentMessage,
		};
		while (!this.#checkSymbol("}") && !this.#isEof) {
			if (this.#matchIdent("option")) {
				message.options.push(this.#parseOption());
				this.#expectSymbol(";");
			} else if (this.#matchIdent("reserved")) {
				this.#parseReserved(message);
			} else if (this.#matchIdent("extensions")) {
				this.#skipUntilSemicolon();
			} else if (this.#matchIdent("extend")) {
				this.#skipExtendBlock();
			} else if (this.#matchIdent("enum")) {
				message.nestedEnums.push(this.#parseEnum(packagePrefix, fullName));
			} else if (this.#matchIdent("message")) {
				message.nestedMessages.push(this.#parseMessage(packagePrefix, fullName));
			} else if (this.#matchIdent("oneof")) {
				message.oneofs.push(this.#parseOneof());
			} else if (this.#matchIdent("map")) {
				message.fields.push(this.#parseMapField());
			} else if (this.#matchIdent("group")) {
				this.#skipGroupBlock();
			} else if (this.#matchSymbol(";")) {
				// empty semicolon
			} else {
				message.fields.push(this.#parseField());
			}
		}

		this.#expectSymbol("}");
		this.#matchSymbol(";");
		return message;
	}

	#parseField(): ProtoField {
		const comment = this.#current.comment;
		let rule: "optional" | "required" | "repeated" | undefined;
		if (this.#matchIdent("optional")) rule = "optional";
		else if (this.#matchIdent("required")) rule = "required";
		else if (this.#matchIdent("repeated")) rule = "repeated";

		const typeName = this.#expectIdent();
		const fieldName = this.#expectIdent();
		this.#expectSymbol("=");
		const fieldNumber = this.#expectNumber();
		const options = this.#parseFieldOptions();
		this.#expectSymbol(";");

		const jsonName = this.#findOptionString(options, "json_name") || protoToCamelCase(fieldName);

		if (PROTO_SCALAR_TYPES[typeName]) {
			return {
				kind: "scalar",
				name: fieldName,
				jsonName,
				number: fieldNumber,
				rule,
				scalarType: normalizeScalarType(typeName),
				comment,
				options,
			};
		}

		return {
			kind: "message",
			name: fieldName,
			jsonName,
			number: fieldNumber,
			rule,
			typeName,
			comment,
			options,
		};
	}

	#parseMapField(): ProtoMapField {
		const comment = this.#current.comment;
		this.#expectSymbol("<");
		const keyType = this.#expectIdent();
		this.#expectSymbol(",");
		const valueType = this.#expectIdent();
		this.#expectSymbol(">");

		const fieldName = this.#expectIdent();
		this.#expectSymbol("=");
		const fieldNumber = this.#expectNumber();
		const options = this.#parseFieldOptions();
		this.#expectSymbol(";");

		const jsonName = this.#findOptionString(options, "json_name") || protoToCamelCase(fieldName);
		const valueKind = PROTO_SCALAR_TYPES[valueType] ? "scalar" : "message";

		return {
			kind: "map",
			name: fieldName,
			jsonName,
			number: fieldNumber,
			keyType,
			valueType,
			valueKind,
			comment,
			options,
		};
	}

	#parseOneof(): ProtoOneof {
		const comment = this.#current.comment;
		const name = protoToCamelCase(this.#expectIdent());
		this.#expectSymbol("{");

		const fields: (ProtoScalarField | ProtoMessageField | ProtoEnumField)[] = [];
		while (!this.#checkSymbol("}") && !this.#isEof) {
			if (this.#matchIdent("option")) {
				this.#parseOption();
				this.#expectSymbol(";");
			} else if (this.#matchSymbol(";")) {
				// empty semicolon
			} else {
				const fieldComment = this.#current.comment;
				const typeName = this.#expectIdent();
				const fieldName = this.#expectIdent();
				this.#expectSymbol("=");
				const fieldNumber = this.#expectNumber();
				const options = this.#parseFieldOptions();
				this.#expectSymbol(";");

				const jsonName = this.#findOptionString(options, "json_name") || protoToCamelCase(fieldName);

				if (PROTO_SCALAR_TYPES[typeName]) {
					fields.push({
						kind: "scalar",
						name: fieldName,
						jsonName,
						number: fieldNumber,
						scalarType: normalizeScalarType(typeName),
						comment: fieldComment,
						options,
					});
				} else {
					fields.push({
						kind: "message",
						name: fieldName,
						jsonName,
						number: fieldNumber,
						typeName,
						comment: fieldComment,
						options,
					});
				}
			}
		}

		this.#expectSymbol("}");
		this.#matchSymbol(";");
		return { name, comment, fields };
	}

	#parseService(packagePrefix: string): ProtoService {
		const comment = this.#current.comment;
		const name = this.#expectIdent();
		const fullName = packagePrefix ? `${packagePrefix}.${name}` : name;
		this.#expectSymbol("{");

		const service: ProtoService = {
			name,
			fullName,
			comment,
			rpcs: [],
			options: [],
		};
		while (!this.#checkSymbol("}") && !this.#isEof) {
			if (this.#matchIdent("option")) {
				service.options.push(this.#parseOption());
				this.#expectSymbol(";");
			} else if (this.#matchIdent("rpc")) {
				const rpcComment = this.#current.comment;
				const rpcName = this.#expectIdent();
				this.#expectSymbol("(");
				const reqStream = this.#matchIdent("stream");
				const reqType = this.#expectIdent();
				this.#expectSymbol(")");
				this.#expectIdent("returns");
				this.#expectSymbol("(");
				const resStream = this.#matchIdent("stream");
				const resType = this.#expectIdent();
				this.#expectSymbol(")");

				const options: ProtoOption[] = [];
				if (this.#matchSymbol("{")) {
					while (!this.#checkSymbol("}") && !this.#isEof) {
						if (this.#matchIdent("option")) {
							options.push(this.#parseOption());
							this.#expectSymbol(";");
						} else if (this.#matchSymbol(";")) {
							// skip
						} else {
							this.#skipUntilSemicolon();
						}
					}
					this.#expectSymbol("}");
					this.#matchSymbol(";");
				} else {
					this.#expectSymbol(";");
				}

				service.rpcs.push({
					name: rpcName,
					comment: rpcComment,
					requestType: reqType,
					requestStream: reqStream,
					responseType: resType,
					responseStream: resStream,
					options,
				});
			} else if (this.#matchSymbol(";")) {
				// empty semicolon
			} else {
				this.#skipUntilSemicolon();
			}
		}

		this.#expectSymbol("}");
		this.#matchSymbol(";");
		return service;
	}

	#parseOption(): ProtoOption {
		let name = "";
		if (this.#matchSymbol("(")) {
			name = `(${this.#expectIdent()})`;
			this.#expectSymbol(")");
		} else {
			name = this.#expectIdent();
		}
		while (this.#matchSymbol(".")) {
			name += ".";
			if (this.#matchSymbol("(")) {
				name += `(${this.#expectIdent()})`;
				this.#expectSymbol(")");
			} else {
				name += this.#expectIdent();
			}
		}

		this.#expectSymbol("=");
		const value = this.#parseOptionValue();
		return { name, value };
	}

	#parseOptionValue(): unknown {
		if (this.#current.type === "string" || this.#current.type === "int" || this.#current.type === "float") {
			const v = this.#current.value;
			this.#current = this.#tokenizer.next();
			return v;
		}
		if (this.#current.type === "ident") {
			const v = this.#current.value as string;
			this.#current = this.#tokenizer.next();
			if (v === "true") return true;
			if (v === "false") return false;
			return v;
		}
		if (this.#matchSymbol("{")) {
			const obj: Record<string, unknown> = {};
			while (!this.#checkSymbol("}") && !this.#isEof) {
				let key = "";
				if (this.#matchSymbol("(")) {
					key = `(${this.#expectIdent()})`;
					this.#expectSymbol(")");
				} else {
					key = this.#expectIdent();
				}
				if (this.#matchSymbol(":")) {
					obj[key] = this.#parseOptionValue();
				} else {
					obj[key] = this.#parseOptionValue();
				}
				this.#matchSymbol(",");
				this.#matchSymbol(";");
			}
			this.#expectSymbol("}");
			return obj;
		}
		if (this.#matchSymbol("[")) {
			const list: unknown[] = [];
			while (!this.#checkSymbol("]") && !this.#isEof) {
				list.push(this.#parseOptionValue());
				this.#matchSymbol(",");
			}
			this.#expectSymbol("]");
			return list;
		}
		if (this.#matchSymbol("-")) {
			const num = this.#expectNumber();
			return -num;
		}
		const fallback = this.#current.value;
		this.#current = this.#tokenizer.next();
		return fallback;
	}

	#parseFieldOptions(): ProtoOption[] {
		if (!this.#matchSymbol("[")) return [];
		const options: ProtoOption[] = [];
		while (!this.#checkSymbol("]") && !this.#isEof) {
			options.push(this.#parseOption());
			this.#matchSymbol(",");
		}
		this.#expectSymbol("]");
		return options;
	}

	#parseReserved(message: ProtoMessage): void {
		while (!this.#checkSymbol(";") && !this.#isEof) {
			if (this.#current.type === "int") {
				const start = this.#current.value as number;
				this.#current = this.#tokenizer.next();
				if (this.#matchIdent("to")) {
					if (this.#matchIdent("max")) {
						message.reserved.push([start, 536870911]);
					} else {
						const end = this.#expectNumber();
						message.reserved.push([start, end]);
					}
				} else {
					message.reserved.push(start);
				}
			} else if (this.#current.type === "string") {
				message.reserved.push(this.#current.value as string);
				this.#current = this.#tokenizer.next();
			} else {
				this.#current = this.#tokenizer.next();
			}
			this.#matchSymbol(",");
		}
		this.#expectSymbol(";");
	}

	#skipExtendBlock(): void {
		this.#expectIdent();
		this.#expectSymbol("{");
		let depth = 1;
		while (depth > 0 && !this.#isEof) {
			if (this.#matchSymbol("{")) depth++;
			else if (this.#matchSymbol("}")) depth--;
			else this.#current = this.#tokenizer.next();
		}
		this.#matchSymbol(";");
	}
	#skipGroupBlock(): void {
		this.#expectIdent();
		this.#expectSymbol("=");
		this.#expectNumber();
		this.#expectSymbol("{");
		let depth = 1;
		while (depth > 0 && !this.#isEof) {
			if (this.#matchSymbol("{")) depth++;
			else if (this.#matchSymbol("}")) depth--;
			else this.#current = this.#tokenizer.next();
		}
		this.#matchSymbol(";");
	}

	#skipUntilSemicolon(): void {
		while (!this.#checkSymbol(";") && !this.#isEof) {
			this.#current = this.#tokenizer.next();
		}
		this.#matchSymbol(";");
	}

	#matchIdent(expected?: string): boolean {
		if (this.#current.type === "ident" && (expected === undefined || this.#current.value === expected)) {
			this.#current = this.#tokenizer.next();
			return true;
		}
		return false;
	}

	#expectIdent(expected?: string): string {
		if (this.#current.type === "ident" && (expected === undefined || this.#current.value === expected)) {
			const val = this.#current.value as string;
			this.#current = this.#tokenizer.next();
			return val;
		}
		throw new Error(
			`Expected identifier ${expected ? `'${expected}'` : ""}, got '${this.#current.value}' at ${this.#filename}:${this.#current.line}:${this.#current.col}`,
		);
	}

	#expectString(): string {
		if (this.#current.type === "string") {
			const val = this.#current.value as string;
			this.#current = this.#tokenizer.next();
			return val;
		}
		throw new Error(
			`Expected string, got '${this.#current.value}' at ${this.#filename}:${this.#current.line}:${this.#current.col}`,
		);
	}

	#expectNumber(): number {
		if (this.#current.type === "int" || this.#current.type === "float") {
			const val = this.#current.value as number;
			this.#current = this.#tokenizer.next();
			return val;
		}
		if (this.#matchSymbol("-")) {
			return -this.#expectNumber();
		}
		throw new Error(
			`Expected number, got '${this.#current.value}' at ${this.#filename}:${this.#current.line}:${this.#current.col}`,
		);
	}

	#checkSymbol(sym: string): boolean {
		return this.#current.type === "symbol" && this.#current.value === sym;
	}

	#matchSymbol(sym: string): boolean {
		if (this.#checkSymbol(sym)) {
			this.#current = this.#tokenizer.next();
			return true;
		}
		return false;
	}

	#expectSymbol(sym: string): void {
		if (!this.#matchSymbol(sym)) {
			throw new Error(
				`Expected '${sym}', got '${this.#current.value}' at ${this.#filename}:${this.#current.line}:${this.#current.col}`,
			);
		}
	}

	#findOptionString(options: ProtoOption[], name: string): string | undefined {
		const opt = options.find(o => o.name === name);
		return typeof opt?.value === "string" ? opt.value : undefined;
	}
}

/** Parses a protobuf definition source string into a ProtoFile AST. */
export function parseProto(source: string, filename?: string): ProtoFile {
	return new Parser(source, filename).parse();
}

function normalizeScalarType(t: string): ProtoScalarType {
	switch (t) {
		case "sint32":
		case "sfixed32":
			return "int32";
		case "sint64":
		case "sfixed64":
			return "int64";
		case "fixed32":
			return "uint32";
		case "fixed64":
			return "uint64";
		default:
			return t as ProtoScalarType;
	}
}

/** Converts snake_case protobuf identifiers to camelCase TypeScript property names. */
export function protoToCamelCase(name: string): string {
	if (!name.includes("_")) return name;
	return name.replace(/_([a-zA-Z0-9])/g, (_, ch: string) => ch.toUpperCase());
}

/** Converts PascalCase or camelCase to SCREAMING_SNAKE_CASE. */
function toScreamingSnake(name: string): string {
	return name
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
		.toUpperCase();
}

/** Context managing parsed proto files and symbol resolution. */
export class ProtoContext {
	readonly files: ProtoFile[] = [];
	readonly #enumsByFullName = new Map<string, ProtoEnum>();
	readonly #enumsByShortName = new Map<string, ProtoEnum>();
	readonly #messagesByFullName = new Map<string, ProtoMessage>();
	readonly #messagesByShortName = new Map<string, ProtoMessage>();
	readonly wellKnownMessages: ProtoMessage[] = [];
	constructor() {
		this.#initWellKnownTypes();
	}

	#initWellKnownTypes(): void {
		const googleTypes: ProtoMessage[] = [
			{
				name: "Timestamp",
				fullName: "google.protobuf.Timestamp",
				fields: [
					{ kind: "scalar", name: "seconds", jsonName: "seconds", number: 1, scalarType: "int64", options: [] },
					{ kind: "scalar", name: "nanos", jsonName: "nanos", number: 2, scalarType: "int32", options: [] },
				],
				oneofs: [],
				nestedEnums: [],
				nestedMessages: [],
				options: [],
				reserved: [],
			},
			{
				name: "Duration",
				fullName: "google.protobuf.Duration",
				fields: [
					{ kind: "scalar", name: "seconds", jsonName: "seconds", number: 1, scalarType: "int64", options: [] },
					{ kind: "scalar", name: "nanos", jsonName: "nanos", number: 2, scalarType: "int32", options: [] },
				],
				oneofs: [],
				nestedEnums: [],
				nestedMessages: [],
				options: [],
				reserved: [],
			},
			{
				name: "Empty",
				fullName: "google.protobuf.Empty",
				fields: [],
				oneofs: [],
				nestedEnums: [],
				nestedMessages: [],
				options: [],
				reserved: [],
			},
			{
				name: "Any",
				fullName: "google.protobuf.Any",
				fields: [
					{ kind: "scalar", name: "type_url", jsonName: "typeUrl", number: 1, scalarType: "string", options: [] },
					{ kind: "scalar", name: "value", jsonName: "value", number: 2, scalarType: "bytes", options: [] },
				],
				oneofs: [],
				nestedEnums: [],
				nestedMessages: [],
				options: [],
				reserved: [],
			},
			{
				name: "FieldMask",
				fullName: "google.protobuf.FieldMask",
				fields: [
					{
						kind: "scalar",
						name: "paths",
						jsonName: "paths",
						number: 1,
						rule: "repeated",
						scalarType: "string",
						options: [],
					},
				],
				oneofs: [],
				nestedEnums: [],
				nestedMessages: [],
				options: [],
				reserved: [],
			},
		];
		for (const msg of googleTypes) {
			this.wellKnownMessages.push(msg);
			this.#messagesByFullName.set(msg.fullName, msg);
			this.#messagesByShortName.set(msg.name, msg);
		}
	}

	addFile(file: ProtoFile): void {
		this.files.push(file);
		this.#indexFile(file);
	}

	#indexFile(file: ProtoFile): void {
		for (const enm of file.enums) {
			this.#enumsByFullName.set(enm.fullName, enm);
			this.#enumsByShortName.set(enm.name, enm);
		}
		for (const msg of file.messages) {
			this.#indexMessage(msg);
		}
	}

	#indexMessage(msg: ProtoMessage): void {
		this.#messagesByFullName.set(msg.fullName, msg);
		this.#messagesByShortName.set(msg.name, msg);
		for (const enm of msg.nestedEnums) {
			this.#enumsByFullName.set(enm.fullName, enm);
			this.#enumsByShortName.set(enm.name, enm);
		}
		for (const child of msg.nestedMessages) {
			this.#indexMessage(child);
		}
	}

	resolveAll(): void {
		for (const file of this.files) {
			for (const msg of file.messages) {
				this.#resolveMessage(msg, file.package);
			}
		}
	}

	#resolveMessage(msg: ProtoMessage, pkg: string): void {
		for (const field of msg.fields) {
			this.#resolveField(field, msg, pkg);
		}
		for (const oneof of msg.oneofs) {
			for (const field of oneof.fields) {
				this.#resolveField(field, msg, pkg);
			}
		}
		for (const nested of msg.nestedMessages) {
			this.#resolveMessage(nested, pkg);
		}
	}

	#resolveField(field: ProtoField, parentMsg: ProtoMessage, pkg: string): void {
		if (field.kind === "message") {
			const resolved = this.lookupType(field.typeName, parentMsg, pkg);
			if (resolved.kind === "enum") {
				const enumField = field as unknown as ProtoEnumField;
				enumField.kind = "enum";
				enumField.resolvedTypeName = resolved.target.name;
			} else if (resolved.kind === "message") {
				field.resolvedTypeName = this.getEmittedName(resolved.target);
			}
		} else if (field.kind === "map") {
			if (!PROTO_SCALAR_TYPES[field.valueType]) {
				const resolved = this.lookupType(field.valueType, parentMsg, pkg);
				if (resolved.kind === "enum") {
					field.valueKind = "enum";
					field.resolvedValueTypeName = resolved.target.name;
				} else if (resolved.kind === "message") {
					field.valueKind = "message";
					field.resolvedValueTypeName = this.getEmittedName(resolved.target);
				}
			}
		}
	}

	lookupType(
		typeName: string,
		parentMsg?: ProtoMessage,
		pkg?: string,
	): { kind: "message"; target: ProtoMessage } | { kind: "enum"; target: ProtoEnum } | { kind: "none" } {
		const clean = typeName.startsWith(".") ? typeName.slice(1) : typeName;

		// Check nested in parent message
		if (parentMsg) {
			const nestedName = `${parentMsg.fullName}_${clean}`;
			const nestedMsg = this.#messagesByFullName.get(nestedName);
			if (nestedMsg) return { kind: "message", target: nestedMsg };
			const nestedEnm = this.#enumsByFullName.get(nestedName);
			if (nestedEnm) return { kind: "enum", target: nestedEnm };
		}

		// Check full name with package
		if (pkg) {
			const qualified = `${pkg}.${clean}`;
			const msg = this.#messagesByFullName.get(qualified);
			if (msg) return { kind: "message", target: msg };
			const enm = this.#enumsByFullName.get(qualified);
			if (enm) return { kind: "enum", target: enm };
		}

		// Check full name direct
		const directMsg = this.#messagesByFullName.get(clean);
		if (directMsg) return { kind: "message", target: directMsg };
		const directEnm = this.#enumsByFullName.get(clean);
		if (directEnm) return { kind: "enum", target: directEnm };

		// Check short name
		const shortMsg = this.#messagesByShortName.get(clean);
		if (shortMsg) return { kind: "message", target: shortMsg };
		const shortEnm = this.#enumsByShortName.get(clean);
		if (shortEnm) return { kind: "enum", target: shortEnm };

		return { kind: "none" };
	}

	getEmittedName(msg: ProtoMessage): string {
		return msg.fullName.split(".").pop() || msg.name;
	}
}

export interface GenerateProtoOptions {
	packagePrefix?: string;
	protobufImportPath?: string;
	stripEnumPrefixes?: boolean;
	includeMessages?: string[] | Set<string>;
	includeEnums?: string[] | Set<string>;
	excludeMessages?: string[] | Set<string>;
	includeDependencies?: boolean;
	headerComment?: string;
	sortAlphabetically?: boolean;
}

/** Generates TypeScript definitions and protobuf schemas from parsed Proto files or a ProtoContext. */
export function generateProtoTs(
	input: ProtoFile | ProtoFile[] | ProtoContext,
	options: GenerateProtoOptions = {},
): string {
	const ctx = input instanceof ProtoContext ? input : new ProtoContext();
	if (!(input instanceof ProtoContext)) {
		const files = Array.isArray(input) ? input : [input];
		for (const f of files) ctx.addFile(f);
	}
	ctx.resolveAll();

	const stripEnumPrefix = options.stripEnumPrefixes ?? true;
	const sortAlpha = options.sortAlphabetically ?? true;
	const protobufPath = options.protobufImportPath ?? "./protobuf";
	const pkgPrefix = options.packagePrefix ?? "Cursor agent";

	// Collect all flat enums and messages
	const allEnums: ProtoEnum[] = [];
	const allMessages: ProtoMessage[] = [];

	const collectEnums = (e: ProtoEnum) => allEnums.push(e);
	const collectMessages = (m: ProtoMessage) => {
		allMessages.push(m);
		for (const e of m.nestedEnums) collectEnums(e);
		for (const child of m.nestedMessages) collectMessages(child);
	};

	for (const file of ctx.files) {
		for (const e of file.enums) collectEnums(e);
		for (const m of file.messages) collectMessages(m);
	}
	for (const msg of ctx.wellKnownMessages) {
		const emittedName = ctx.getEmittedName(msg);
		if (!allMessages.some(m => ctx.getEmittedName(m) === emittedName)) {
			collectMessages(msg);
		}
	}
	let targetMessages = allMessages;
	let targetEnums = allEnums;

	const neededEnumFullNames = new Set<string>();

	if (options.includeMessages) {
		const msgFilter =
			options.includeMessages instanceof Set ? options.includeMessages : new Set(options.includeMessages);
		const neededMsgFullNames = new Set<string>();

		const queue: ProtoMessage[] = [];
		for (const spec of msgFilter) {
			const match =
				allMessages.find(m => m.fullName === spec) ||
				allMessages.find(m => ctx.getEmittedName(m) === spec || m.name === spec);
			if (!match) throw new Error(`Requested protobuf message '${spec}' was not found`);
			neededMsgFullNames.add(match.fullName);
			queue.push(match);
		}

		if (options.includeDependencies ?? true) {
			const visited = new Set<string>();
			while (queue.length > 0) {
				const msg = queue.shift()!;
				if (visited.has(msg.fullName)) continue;
				visited.add(msg.fullName);
				neededMsgFullNames.add(msg.fullName);

				for (const field of msg.fields) {
					if (field.kind === "message" || field.kind === "enum") {
						const resolved = ctx.lookupType(
							field.typeName,
							msg,
							msg.fullName.includes(".") ? msg.fullName.slice(0, msg.fullName.lastIndexOf(".")) : undefined,
						);
						if (resolved.kind === "message" && !visited.has(resolved.target.fullName)) {
							queue.push(resolved.target);
						} else if (resolved.kind === "enum") {
							neededEnumFullNames.add(resolved.target.fullName);
						}
					} else if (field.kind === "map") {
						if (field.valueKind === "message" || field.valueKind === "enum") {
							const resolved = ctx.lookupType(
								field.valueType,
								msg,
								msg.fullName.includes(".") ? msg.fullName.slice(0, msg.fullName.lastIndexOf(".")) : undefined,
							);
							if (resolved.kind === "message" && !visited.has(resolved.target.fullName)) {
								queue.push(resolved.target);
							} else if (resolved.kind === "enum") {
								neededEnumFullNames.add(resolved.target.fullName);
							}
						}
					}
				}
				for (const oneof of msg.oneofs) {
					for (const field of oneof.fields) {
						if (field.kind === "message" || field.kind === "enum") {
							const resolved = ctx.lookupType(
								field.typeName,
								msg,
								msg.fullName.includes(".") ? msg.fullName.slice(0, msg.fullName.lastIndexOf(".")) : undefined,
							);
							if (resolved.kind === "message" && !visited.has(resolved.target.fullName)) {
								queue.push(resolved.target);
							} else if (resolved.kind === "enum") {
								neededEnumFullNames.add(resolved.target.fullName);
							}
						}
					}
				}
			}
		}

		targetMessages = allMessages.filter(m => neededMsgFullNames.has(m.fullName));
		if (!options.includeEnums) {
			targetEnums = allEnums.filter(e => neededEnumFullNames.has(e.fullName) || neededEnumFullNames.has(e.name));
		}
	}

	if (options.includeEnums) {
		const enumFilter = options.includeEnums instanceof Set ? options.includeEnums : new Set(options.includeEnums);
		for (const spec of enumFilter) {
			const match = allEnums.some(e => e.name === spec || e.fullName === spec);
			if (!match) throw new Error(`Requested protobuf enum '${spec}' was not found`);
		}
		targetEnums = allEnums.filter(
			e =>
				enumFilter.has(e.name) ||
				enumFilter.has(e.fullName) ||
				neededEnumFullNames.has(e.fullName) ||
				neededEnumFullNames.has(e.name),
		);
	}

	if (options.excludeMessages) {
		const exclude =
			options.excludeMessages instanceof Set ? options.excludeMessages : new Set(options.excludeMessages);
		targetMessages = targetMessages.filter(
			m => !exclude.has(ctx.getEmittedName(m)) && !exclude.has(m.name) && !exclude.has(m.fullName),
		);
	}

	if (sortAlpha) {
		targetEnums.sort((a, b) => a.name.localeCompare(b.name));
		targetMessages.sort((a, b) => ctx.getEmittedName(a).localeCompare(ctx.getEmittedName(b)));
	}

	const lines: string[] = [];

	lines.push("// @generated by packages/catalog/scripts/proto-parser.ts - DO NOT EDIT");
	lines.push("");

	if (options.headerComment) {
		lines.push(options.headerComment);
	} else {
		lines.push("/**");
		lines.push(` * ${pkgPrefix} protocol declarations used by Oh My Pi.`);
		lines.push(" *");
		lines.push(" * Each declaration retains only fields consumed by the client or its protocol tests.");
		lines.push(" */");
	}

	lines.push(`import { pb, type MessageCodec, type ProtoMessage } from "${protobufPath}";`);
	lines.push("");

	// Emit Enums
	for (const enm of targetEnums) {
		lines.push(`/** ${pkgPrefix} enum ${enm.name}. */`);
		lines.push(`export enum ${enm.name} {`);

		const fullPrefix = `${toScreamingSnake(enm.name)}_`;
		const simpleName = enm.name.split("_").pop() || enm.name;
		const simplePrefix = `${toScreamingSnake(simpleName)}_`;

		for (const val of enm.values) {
			let valName = val.name;
			if (stripEnumPrefix) {
				if (valName.startsWith(fullPrefix) && valName.length > fullPrefix.length) {
					const stripped = valName.slice(fullPrefix.length);
					if (!/^[0-9]/.test(stripped)) valName = stripped;
				} else if (valName.startsWith(simplePrefix) && valName.length > simplePrefix.length) {
					const stripped = valName.slice(simplePrefix.length);
					if (!/^[0-9]/.test(stripped)) valName = stripped;
				}
			}
			lines.push(`\t${valName} = ${val.number},`);
		}
		lines.push("}");
		lines.push("");
	}

	// Emit Messages
	for (const msg of targetMessages) {
		const emittedName = ctx.getEmittedName(msg);
		const schemaName = `${emittedName}Schema`;

		lines.push(`/** ${pkgPrefix} message ${msg.fullName}. */`);
		lines.push(`export interface ${emittedName} extends ProtoMessage {`);
		for (const field of msg.fields) {
			const isOptional =
				field.rule !== "required" &&
				(field.rule === "optional" || (field.kind === "message" && field.rule !== "repeated"));
			const optionalMark = isOptional ? "?" : "";
			const tsType = getFieldTypeScriptType(field);
			lines.push(`\t${field.jsonName}${optionalMark}: ${tsType};`);
		}
		for (const oneof of msg.oneofs) {
			lines.push(`\t${oneof.name}:`);
			lines.push("\t\t| { case: undefined; value?: undefined }");
			for (const vf of oneof.fields) {
				const vType = getVariantTypeScriptType(vf);
				lines.push(`\t\t| { case: "${vf.jsonName}"; value: ${vType} }`);
			}
			lines[lines.length - 1] += ";";
		}
		lines.push("}");
		lines.push("");

		lines.push(`export const ${schemaName}: MessageCodec<${emittedName}> = pb<${emittedName}>("${msg.fullName}", [`);

		for (const field of msg.fields) {
			const descStr = emitFieldDescriptor(field);
			lines.push(`\t${descStr},`);
		}

		for (const oneof of msg.oneofs) {
			lines.push(`\t{`);
			lines.push(`\t\tkind: "oneof",`);
			lines.push(`\t\tname: "${oneof.name}",`);
			lines.push(`\t\tvariants: [`);
			for (const vf of oneof.fields) {
				const vDesc = emitVariantDescriptor(vf);
				lines.push(`\t\t\t${vDesc},`);
			}
			lines.push(`\t\t],`);
			lines.push(`\t},`);
		}

		lines.push("]);");
		lines.push("");
	}

	return lines.join("\n");
}

function emitFieldDescriptor(field: ProtoField): string {
	const repeatStr = field.rule === "repeated" ? ", repeat: true" : "";
	const optionalStr = field.rule === "optional" ? ", optional: true" : "";

	if (field.kind === "scalar") {
		return `{ no: ${field.number}, name: "${field.jsonName}", kind: "${field.scalarType}"${optionalStr}${repeatStr} }`;
	}
	if (field.kind === "enum") {
		return `{ no: ${field.number}, name: "${field.jsonName}", kind: "enum"${optionalStr}${repeatStr} }`;
	}
	if (field.kind === "message") {
		const targetSchema = `${cleanTypeName(field.resolvedTypeName || field.typeName)}Schema`;
		return `{ no: ${field.number}, name: "${field.jsonName}", kind: "message", T: () => ${targetSchema}${repeatStr} }`;
	}
	if (field.kind === "map") {
		if (field.valueKind === "message") {
			const targetSchema = `${cleanTypeName(field.resolvedValueTypeName || field.valueType)}Schema`;
			return `{ no: ${field.number}, name: "${field.jsonName}", kind: "map", K: "string", V: () => ${targetSchema} }`;
		}
		const valKind = field.valueKind === "enum" ? "enum" : field.valueType;
		return `{ no: ${field.number}, name: "${field.jsonName}", kind: "map", K: "string", V: "${valKind}" }`;
	}
	return "";
}

function emitVariantDescriptor(field: ProtoScalarField | ProtoMessageField | ProtoEnumField): string {
	if (field.kind === "message") {
		const targetSchema = `${cleanTypeName(field.resolvedTypeName || field.typeName)}Schema`;
		return `{ no: ${field.number}, name: "${field.jsonName}", kind: "message", T: () => ${targetSchema} }`;
	}
	if (field.kind === "enum") {
		return `{ no: ${field.number}, name: "${field.jsonName}", kind: "enum" }`;
	}
	return `{ no: ${field.number}, name: "${field.jsonName}", kind: "${field.scalarType}" }`;
}

function getFieldTypeScriptType(field: ProtoField): string {
	const repeated = field.rule === "repeated";
	let baseType = "unknown";

	if (field.kind === "scalar") {
		switch (field.scalarType) {
			case "bool":
				baseType = "boolean";
				break;
			case "bytes":
				baseType = "Uint8Array";
				break;
			case "string":
				baseType = "string";
				break;
			case "int64":
			case "uint64":
				baseType = "bigint";
				break;
			default:
				baseType = "number";
				break;
		}
	} else if (field.kind === "enum") {
		baseType = cleanTypeName(field.resolvedTypeName || field.typeName) || "number";
	} else if (field.kind === "message") {
		baseType = cleanTypeName(field.resolvedTypeName || field.typeName) || "ProtoMessage";
	} else if (field.kind === "map") {
		let valType = "unknown";
		if (field.valueKind === "scalar") {
			switch (field.valueType) {
				case "bool":
					valType = "boolean";
					break;
				case "bytes":
					valType = "Uint8Array";
					break;
				case "string":
					valType = "string";
					break;
				case "int64":
				case "uint64":
					valType = "bigint";
					break;
				default:
					valType = "number";
					break;
			}
		} else if (field.valueKind === "enum") {
			valType = cleanTypeName(field.resolvedValueTypeName || field.valueType) || "number";
		} else {
			valType = cleanTypeName(field.resolvedValueTypeName || field.valueType) || "ProtoMessage";
		}
		return `Record<string, ${valType}>`;
	}

	return repeated ? `${baseType}[]` : baseType;
}

function getVariantTypeScriptType(field: ProtoScalarField | ProtoMessageField | ProtoEnumField): string {
	if (field.kind === "scalar") {
		switch (field.scalarType) {
			case "bool":
				return "boolean";
			case "bytes":
				return "Uint8Array";
			case "string":
				return "string";
			case "int64":
			case "uint64":
				return "bigint";
			default:
				return "number";
		}
	}
	if (field.kind === "enum") return cleanTypeName(field.resolvedTypeName || field.typeName) || "number";
	return cleanTypeName(field.resolvedTypeName || field.typeName) || "ProtoMessage";
}

function cleanTypeName(name: string): string {
	const clean = name.startsWith(".") ? name.slice(1) : name;
	const parts = clean.split(".");
	return parts[parts.length - 1] || clean;
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
		console.log(`Usage: bun proto-parser.ts <proto-files...> [options]

Options:
  --out <file>             Output TypeScript file path (defaults to stdout)
  --prefix <prefix>        Package prefix for comments (e.g. "Cursor agent", "Devin")
  --import-path <path>     Import path for discovery/protobuf (default: "./protobuf")
  --include <msg1,msg2>    Comma-separated message names to include (with transitive deps)
  --exclude <msg1,msg2>    Comma-separated message names to exclude
  --no-strip-enum-prefix   Disable stripping redundant enum name prefixes
`);
		process.exit(0);
	}

	let outPath: string | undefined;
	let prefix: string | undefined;
	let importPath: string | undefined;
	let includeMsgs: string[] | undefined;
	let excludeMsgs: string[] | undefined;
	let stripEnum = true;
	const inputPaths: string[] = [];

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--out" && i + 1 < args.length) {
			outPath = args[++i];
		} else if (arg === "--prefix" && i + 1 < args.length) {
			prefix = args[++i];
		} else if (arg === "--import-path" && i + 1 < args.length) {
			importPath = args[++i];
		} else if (arg === "--include" && i + 1 < args.length) {
			includeMsgs = args[++i].split(",").map(s => s.trim());
		} else if (arg === "--exclude" && i + 1 < args.length) {
			excludeMsgs = args[++i].split(",").map(s => s.trim());
		} else if (arg === "--no-strip-enum-prefix") {
			stripEnum = false;
		} else if (!arg.startsWith("-")) {
			inputPaths.push(arg);
		}
	}

	const ctx = new ProtoContext();
	for (const inputPath of inputPaths) {
		if (inputPath.includes("*")) {
			for await (const file of new Bun.Glob(inputPath).scan({ cwd: process.cwd() })) {
				const text = await Bun.file(file).text();
				ctx.addFile(parseProto(text, file));
			}
		} else {
			const text = await Bun.file(inputPath).text();
			ctx.addFile(parseProto(text, inputPath));
		}
	}

	const code = generateProtoTs(ctx, {
		packagePrefix: prefix,
		protobufImportPath: importPath,
		includeMessages: includeMsgs,
		excludeMessages: excludeMsgs,
		stripEnumPrefixes: stripEnum,
	});

	if (outPath) {
		await Bun.write(outPath, code);
		console.log(`Generated ${outPath} (${code.split("\n").length} lines)`);
	} else {
		process.stdout.write(code);
	}
}
