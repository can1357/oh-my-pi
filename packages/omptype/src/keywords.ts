import type { IR, MorphContext } from "./ir";

const NUMERIC = /^(?:(?!^-0\.?0*$)(?:-?(?:(?:0|[1-9]\d*)(?:\.\d+)?)|\.\d+?))$/;
const INTEGER = /^[+-]?(?:0|[1-9]\d*)$/;
const EMAIL = /^[\w%+.-]+@[\d.A-Za-z-]+\.[A-Za-z]{2,}$/;
const SEMVER =
	/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][\dA-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][\dA-Za-z-]*))*))?(?:\+([\dA-Za-z-]+(?:\.[\dA-Za-z-]+)*))?$/;
const UUID = /^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i;
const IPV4_SEGMENT = "(?:[0-9]|[1-9][0-9]|1[0-9][0-9]|2[0-4][0-9]|25[0-5])";
const IPV4_ADDRESS = `(?:${IPV4_SEGMENT}[.]){3}${IPV4_SEGMENT}`;
const IPV4 = new RegExp(`^${IPV4_ADDRESS}$`);
const IPV6_SEGMENT = "(?:[0-9a-fA-F]{1,4})";
const IPV6 = new RegExp(
	"^(" +
		`(?:${IPV6_SEGMENT}:){7}(?:${IPV6_SEGMENT}|:)|` +
		`(?:${IPV6_SEGMENT}:){6}(?:${IPV4_ADDRESS}|:${IPV6_SEGMENT}|:)|` +
		`(?:${IPV6_SEGMENT}:){5}(?::${IPV4_ADDRESS}|(:${IPV6_SEGMENT}){1,2}|:)|` +
		`(?:${IPV6_SEGMENT}:){4}(?:(:${IPV6_SEGMENT}){0,1}:${IPV4_ADDRESS}|(:${IPV6_SEGMENT}){1,3}|:)|` +
		`(?:${IPV6_SEGMENT}:){3}(?:(:${IPV6_SEGMENT}){0,2}:${IPV4_ADDRESS}|(:${IPV6_SEGMENT}){1,4}|:)|` +
		`(?:${IPV6_SEGMENT}:){2}(?:(:${IPV6_SEGMENT}){0,3}:${IPV4_ADDRESS}|(:${IPV6_SEGMENT}){1,5}|:)|` +
		`(?:${IPV6_SEGMENT}:){1}(?:(:${IPV6_SEGMENT}){0,4}:${IPV4_ADDRESS}|(:${IPV6_SEGMENT}){1,6}|:)|` +
		`(?::((?::${IPV6_SEGMENT}){0,5}:${IPV4_ADDRESS}|(?::${IPV6_SEGMENT}){1,7}|:))` +
		")(?:%[\\d.A-Za-z]{1,})?$",
);
const ISO_DATE =
	/^([+-]?\d{4}(?!\d{2}\b))((-?)((0[1-9]|1[0-2])(\3([12]\d|0[1-9]|3[01]))?|W([0-4]\d|5[0-3])(-?[1-7])?|(00[1-9]|0[1-9]\d|[12]\d{2}|3([0-5]\d|6[1-6])))(T((([01]\d|2[0-3])((:?)[0-5]\d)?|24:?00)([,.]\d+(?!:))?)?(\17[0-5]\d([,.]\d+)?)?([Zz]|([+-])([01]\d|2[0-3]):?([0-5]\d)?)?)?)?$/;

function pattern(regex: RegExp, expected: string, format?: string): IR {
	return {
		k: "refine",
		base: { k: "string" },
		pred: value => {
			regex.lastIndex = 0;
			return regex.test(value as string);
		},
		expected,
		json: format === undefined ? { pattern: regex.source } : { pattern: regex.source, format },
	};
}

function morph(input: IR, fn: (value: string, context: MorphContext) => unknown, out?: IR): IR {
	return { k: "morph", input, fn: (value, context) => fn(value as string, context), out };
}

function parsableJson(): IR {
	return {
		k: "refine",
		base: { k: "string" },
		pred: value => {
			try {
				JSON.parse(value as string);
				return true;
			} catch {
				return false;
			}
		},
		expected: "a JSON string",
		json: { contentMediaType: "application/json" },
	};
}

function parsableDate(expected = "a parsable date"): IR {
	return {
		k: "refine",
		base: { k: "string" },
		pred: value => !Number.isNaN(new Date(value as string).valueOf()),
		expected,
		json: { format: "date-time" },
	};
}

function normalize(form: "NFC" | "NFD" | "NFKC" | "NFKD"): IR {
	return morph({ k: "string" }, value => value.normalize(form), patternForNormalized(form));
}

function patternForNormalized(form: "NFC" | "NFD" | "NFKC" | "NFKD"): IR {
	return {
		k: "refine",
		base: { k: "string" },
		pred: value => (value as string).normalize(form) === value,
		expected: `${form}-normalized unicode`,
	};
}

function uuidVersion(version: string): IR {
	return pattern(
		new RegExp(`^[\\da-f]{8}-[\\da-f]{4}-${version}[\\da-f]{3}-[89ab][\\da-f]{3}-[\\da-f]{12}$`, "i"),
		`a UUIDv${version}`,
		"uuid",
	);
}

function isLuhnValid(input: string): boolean {
	const value = input.replace(/[ -]+/g, "");
	let sum = 0;
	let double = false;
	for (let index = value.length - 1; index >= 0; index--) {
		let digit = Number(value[index]);
		if (double) {
			digit *= 2;
			if (digit > 9) digit -= 9;
		}
		sum += digit;
		double = !double;
	}
	return value.length > 0 && sum % 10 === 0;
}

function finiteNumber(expected = "a number"): IR {
	return {
		k: "refine",
		base: { k: "unknown" },
		pred: value => typeof value === "number" && !Number.isNaN(value),
		expected,
	};
}

function jsonObject(): IR {
	const value: { current?: IR } = {};
	const resolveValue = (): IR => value.current as IR;
	const object: IR = {
		k: "object",
		props: [],
		index: { k: "alias", name: "$jsonValue", resolve: resolveValue },
		extras: "keep",
	};
	const array: IR = {
		k: "array",
		el: { k: "alias", name: "$jsonValue", resolve: resolveValue },
		desc: "an object",
	};
	value.current = {
		k: "union",
		members: [
			object,
			array,
			{ k: "number" },
			{ k: "string" },
			{ k: "lit", v: false },
			{ k: "null" },
			{ k: "lit", v: true },
		],
	};
	return object;
}

function instance(ctor: new (...args: never[]) => object, name: string): IR {
	return { k: "instance", ctor, expected: `${/^[AEIOU]/.test(name) ? "an" : "a"} ${name} instance` };
}

const keywordFactories: Record<string, () => IR> = {
	string: () => ({ k: "string" }),
	Key: () => ({ k: "union", members: [{ k: "string" }, { k: "symbol" }] }),
	"unknown.any": () => ({ k: "unknown" }),
	Array: () => ({ k: "array", el: { k: "unknown" } }),
	Function: () => instance(Function as unknown as new (...args: never[]) => object, "Function"),
	RegExp: () => instance(RegExp, "RegExp"),
	File: () => instance(File, "File"),
	Error: () => instance(Error, "Error"),
	Set: () => instance(Set, "Set"),
	Map: () => instance(Map, "Map"),
	WeakSet: () => instance(WeakSet, "WeakSet"),
	WeakMap: () => instance(WeakMap, "WeakMap"),
	Promise: () => instance(Promise, "Promise"),
	FormData: () => instance(FormData, "FormData"),
	"FormData.parse": () => ({
		k: "morph",
		input: instance(FormData, "FormData"),
		fn: value => {
			const out: Record<string, Bun.FormDataEntryValue | Bun.FormDataEntryValue[]> = {};
			for (const [key, entry] of (value as FormData).entries()) {
				const current = out[key];
				out[key] = current === undefined ? entry : Array.isArray(current) ? [...current, entry] : [current, entry];
			}
			return out;
		},
		out: { k: "object", props: [], index: { k: "unknown" }, extras: "keep" },
	}),
	"object.json": jsonObject,
	"object.json.stringify": () => ({
		k: "morph",
		input: jsonObject(),
		fn: value => JSON.stringify(value),
		out: { k: "string" },
	}),
	"number.epoch": () => ({
		k: "refine",
		base: {
			k: "refine",
			base: {
				k: "refine",
				base: finiteNumber("a number representing a Unix timestamp"),
				pred: value => Number.isInteger(value),
				expected: "an integer representing a Unix timestamp",
			},
			pred: value => (value as number) >= -8_640_000_000_000_000,
			expected: "a Unix timestamp after -8640000000000000",
		},
		pred: value => (value as number) <= 8_640_000_000_000_000,
		expected: "a Unix timestamp before 8640000000000000",
	}),
	"number.safe": () => ({
		k: "refine",
		base: {
			k: "refine",
			base: finiteNumber(),
			pred: value => (value as number) >= Number.MIN_SAFE_INTEGER,
			expected: `at least ${Number.MIN_SAFE_INTEGER}`,
		},
		pred: value => (value as number) <= Number.MAX_SAFE_INTEGER,
		expected: `at most ${Number.MAX_SAFE_INTEGER}`,
	}),
	"number.NaN": () => ({
		k: "refine",
		base: { k: "unknown" },
		pred: Number.isNaN,
		expected: "NaN",
	}),
	"number.Infinity": () => ({ k: "lit", v: Number.POSITIVE_INFINITY }),
	"number.NegativeInfinity": () => ({ k: "lit", v: Number.NEGATIVE_INFINITY }),
	"string.alpha": () => pattern(/^[A-Za-z]*$/, "only letters"),
	"string.alphanumeric": () => pattern(/^[\dA-Za-z]*$/, "only letters and digits 0-9"),
	"string.hex": () => pattern(/^[\dA-Fa-f]+$/, "hex characters only"),
	"string.base64": () => pattern(/^(?:[\d+/A-Za-z]{4})*(?:[\d+/A-Za-z]{2}==|[\d+/A-Za-z]{3}=)?$/, "base64-encoded"),
	"string.base64.url": () =>
		pattern(/^(?:[\w-]{4})*(?:[\w-]{2}(?:==|%3D%3D)?|[\w-]{3}(?:=|%3D)?)?$/, "base64url-encoded"),
	"string.capitalize": () => morph({ k: "string" }, value => value.charAt(0).toUpperCase() + value.slice(1)),
	"string.capitalize.preformatted": () => pattern(/^[A-Z].*$/, "capitalized"),
	"string.creditCard": () => ({
		k: "refine",
		base: pattern(
			/^(?:4\d{12}(?:\d{3,6})?|5[1-5]\d{14}|3[47]\d{13}|6(?:011|5\d\d)\d{12,15})$/,
			"a credit card number",
		),
		pred: value => isLuhnValid(value as string),
		expected: "a credit card number",
	}),
	"string.date": () => parsableDate(),
	"string.date.parse": () =>
		morph(parsableDate(), value => new Date(value), { k: "instance", ctor: Date, expected: "a Date" }),
	"string.date.iso": () => pattern(ISO_DATE, "an ISO 8601 date", "date-time"),
	"string.date.iso.parse": () =>
		morph(pattern(ISO_DATE, "an ISO 8601 date", "date-time"), value => new Date(value), {
			k: "instance",
			ctor: Date,
			expected: "a Date",
		}),
	"string.date.epoch": () => pattern(INTEGER, "an integer string representing a Unix timestamp"),
	"string.date.epoch.parse": () =>
		morph(pattern(INTEGER, "an integer string representing a Unix timestamp"), value => new Date(Number(value)), {
			k: "instance",
			ctor: Date,
			expected: "a Date",
		}),
	"string.digits": () => pattern(/^\d*$/, "only digits 0-9"),
	"string.email": () => pattern(EMAIL, "an email address", "email"),
	"string.integer": () => pattern(INTEGER, "a well-formed integer string"),
	"string.integer.parse": () =>
		morph(
			pattern(INTEGER, "a well-formed integer string"),
			(value, context) => {
				const parsed = Number.parseInt(value, 10);
				return Number.isSafeInteger(parsed) ? parsed : context.error("a safe integer string");
			},
			{ k: "number", int: true },
		),
	"string.ip": () => ({
		k: "union",
		members: [pattern(IPV4, "an IPv4 address", "ipv4"), pattern(IPV6, "an IPv6 address", "ipv6")],
	}),
	"string.ip.v4": () => pattern(IPV4, "an IPv4 address", "ipv4"),
	"string.ip.v6": () => pattern(IPV6, "an IPv6 address", "ipv6"),
	"string.json": () => parsableJson(),
	"string.json.parse": () =>
		morph(parsableJson(), (value, context) => {
			try {
				return JSON.parse(value);
			} catch {
				return context.error("a JSON string");
			}
		}),
	"string.lower": () => morph({ k: "string" }, value => value.toLowerCase()),
	"string.lower.preformatted": () => pattern(/^[a-z]*$/, "only lowercase letters"),
	"string.normalize": () => normalize("NFC"),
	"string.normalize.NFC": () => normalize("NFC"),
	"string.normalize.NFC.preformatted": () => patternForNormalized("NFC"),
	"string.normalize.NFD": () => normalize("NFD"),
	"string.normalize.NFD.preformatted": () => patternForNormalized("NFD"),
	"string.normalize.NFKC": () => normalize("NFKC"),
	"string.normalize.NFKC.preformatted": () => patternForNormalized("NFKC"),
	"string.normalize.NFKD": () => normalize("NFKD"),
	"string.normalize.NFKD.preformatted": () => patternForNormalized("NFKD"),
	"string.numeric": () => pattern(NUMERIC, "a well-formed numeric string"),
	"string.numeric.parse": () =>
		morph(pattern(NUMERIC, "a well-formed numeric string"), value => Number.parseFloat(value), { k: "number" }),
	"string.regex": () => ({
		k: "refine",
		base: { k: "string" },
		pred: value => {
			try {
				new RegExp(value as string);
				return true;
			} catch {
				return false;
			}
		},
		expected: "a regex pattern",
		json: { format: "regex" },
	}),
	"string.semver": () => pattern(SEMVER, "a semantic version"),
	"string.trim": () => morph({ k: "string" }, value => value.trim()),
	"string.trim.preformatted": () => pattern(/^\S.*\S$|^\S?$/, "trimmed"),
	"string.upper": () => morph({ k: "string" }, value => value.toUpperCase()),
	"string.upper.preformatted": () => pattern(/^[A-Z]*$/, "only uppercase letters"),
	"string.url": () => ({ k: "string", url: true }),
	"string.url.parse": () =>
		morph({ k: "string", url: true }, value => new URL(value), { k: "instance", ctor: URL, expected: "a URL" }),
	"string.uuid": () => pattern(UUID, "a UUID", "uuid"),
	"string.uuid.v1": () => uuidVersion("1"),
	"string.uuid.v2": () => uuidVersion("2"),
	"string.uuid.v3": () => uuidVersion("3"),
	"string.uuid.v4": () => uuidVersion("4"),
	"string.uuid.v5": () => uuidVersion("5"),
	"string.uuid.v6": () => uuidVersion("6"),
	"string.uuid.v7": () => uuidVersion("7"),
	"string.uuid.v8": () => uuidVersion("8"),
	"parse.number": () =>
		morph(pattern(NUMERIC, "a well-formed numeric string"), value => Number.parseFloat(value), { k: "number" }),
	"parse.integer": () =>
		morph(pattern(INTEGER, "a well-formed integer string"), value => Number.parseInt(value, 10), {
			k: "number",
			int: true,
		}),
	"parse.json": () => keywordFactories["string.json.parse"](),
	"parse.date": () => keywordFactories["string.date.parse"](),
	"parse.url": () => keywordFactories["string.url.parse"](),
	"parse.boolean": () =>
		morph(pattern(/^(?:true|false)$/, "a boolean string"), value => value === "true", { k: "boolean" }),
	"parse.bigint": () => morph(pattern(INTEGER, "an integer string"), value => BigInt(value), { k: "bigint" }),
};

/** Lower a built-in keyword into fresh validation IR. */
export function keywordIR(name: string): IR | undefined {
	return keywordFactories[name]?.();
}

/** Lower a regular expression into a string refinement. */
export function patternIR(regex: RegExp): IR {
	return pattern(regex, `a string matching ${regex}`);
}

/** Lower an ArkType-style template literal into a string pattern. */
export function templateIR(source: string): IR {
	let patternSource = "^";
	let index = 0;
	const placeholder = /\$\{(string|number|bigint|boolean)\}/g;
	for (let match = placeholder.exec(source); match; match = placeholder.exec(source)) {
		patternSource += escapeRegex(source.slice(index, match.index));
		switch (match[1]) {
			case "number":
				patternSource += "[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)";
				break;
			case "bigint":
				patternSource += "[+-]?\\d+";
				break;
			case "boolean":
				patternSource += "(?:true|false)";
				break;
			default:
				patternSource += ".*";
		}
		index = match.index + match[0].length;
	}
	patternSource += `${escapeRegex(source.slice(index))}$`;
	return pattern(new RegExp(patternSource), `a string matching \`${source}\``);
}

function escapeRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
