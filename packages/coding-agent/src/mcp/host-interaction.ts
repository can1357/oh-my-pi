import type {
	MCPHostInteraction,
	MCPInputCollectionContext,
	MCPInputResponses,
	MCPModernClientCapabilities,
} from "./types";

type MCPPrimitive = string | number | boolean | null;
type MCPPrimitiveType = "string" | "number" | "integer" | "boolean" | "null";

export interface MCPHostInteractionFormField {
	name: string;
	title: string;
	description?: string;
	type: MCPPrimitiveType;
	required: boolean;
	enum?: readonly MCPPrimitive[];
	default?: MCPPrimitive;
}

export interface MCPHostInteractionFormRequest {
	serverName: string;
	message: string;
	fields: readonly MCPHostInteractionFormField[];
}

export interface MCPHostInteractionUrlRequest {
	serverName: string;
	message: string;
	url: string;
	origin: string;
}

export type MCPHostInteractionPresentation =
	| { action: "accept"; content?: unknown }
	| { action: "decline" }
	| { action: "cancel" };

/**
 * UI-facing adapter for a host interaction policy. The bridge owns protocol
 * validation and consent semantics; presenters only render requests and open a
 * URL after the user explicitly chooses Open.
 */
export interface MCPHostInteractionPresenter {
	presentForm(request: MCPHostInteractionFormRequest, signal?: AbortSignal): Promise<MCPHostInteractionPresentation>;
	presentUrl(request: MCPHostInteractionUrlRequest, signal?: AbortSignal): Promise<MCPHostInteractionPresentation>;
	openUrl(url: string): void | Promise<void>;
}

type ValidatedRequest =
	| { key: string; kind: "form"; request: MCPHostInteractionFormRequest }
	| { key: string; kind: "url"; request: MCPHostInteractionUrlRequest };

type FormFieldDefinition = Omit<MCPHostInteractionFormField, "required">;

const NO_CAPABILITIES: MCPModernClientCapabilities = Object.freeze({});
const INTERACTIVE_CAPABILITIES: MCPModernClientCapabilities = Object.freeze({
	elicitation: Object.freeze({ form: Object.freeze({}), url: Object.freeze({}) }),
});
const MAX_FORM_FIELDS = 20;
const MAX_ENUM_OPTIONS = 50;
const MAX_MESSAGE_LENGTH = 4096;
const MAX_TITLE_LENGTH = 512;
const MAX_DESCRIPTION_LENGTH = 1024;
const MAX_URL_LENGTH = 2048;
const MAX_NAME_LENGTH = 256;
const MAX_STRING_OPTION_LENGTH = 1024;

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function isPrimitive(value: unknown): value is MCPPrimitive {
	return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function isValidPrimitiveForType(value: unknown, type: MCPPrimitiveType): value is MCPPrimitive {
	if (!isPrimitive(value)) return false;
	if (type === "null") return value === null;
	if (type === "number") return typeof value === "number" && Number.isFinite(value);
	if (type === "integer") return typeof value === "number" && Number.isInteger(value);
	return typeof value === type;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
	return Object.keys(value).every(key => allowed.includes(key));
}

function parseFormField(name: string, value: unknown): FormFieldDefinition | undefined {
	if (name.length > MAX_NAME_LENGTH) return undefined;
	const field = asRecord(value);
	if (!field || !hasOnlyKeys(field, ["type", "title", "description", "enum", "default"])) return undefined;
	if (
		field.type !== "string" &&
		field.type !== "number" &&
		field.type !== "integer" &&
		field.type !== "boolean" &&
		field.type !== "null"
	) {
		return undefined;
	}
	const type = field.type as MCPPrimitiveType;
	if (field.title !== undefined && (typeof field.title !== "string" || field.title.length > MAX_TITLE_LENGTH)) {
		return undefined;
	}
	if (
		field.description !== undefined &&
		(typeof field.description !== "string" || field.description.length > MAX_DESCRIPTION_LENGTH)
	) {
		return undefined;
	}
	if (field.default !== undefined) {
		if (!isValidPrimitiveForType(field.default, type)) return undefined;
		if (typeof field.default === "string" && field.default.length > MAX_STRING_OPTION_LENGTH) return undefined;
	}

	let enumValues: MCPPrimitive[] | undefined;
	if (field.enum !== undefined) {
		if (
			!Array.isArray(field.enum) ||
			field.enum.length === 0 ||
			field.enum.length > MAX_ENUM_OPTIONS ||
			!field.enum.every(item => isValidPrimitiveForType(item, type))
		) {
			return undefined;
		}
		if (field.enum.some(item => typeof item === "string" && item.length > MAX_STRING_OPTION_LENGTH)) {
			return undefined;
		}
		enumValues = [...field.enum];
		if (field.default !== undefined && !enumValues.some(item => Object.is(item, field.default))) return undefined;
	}

	return {
		name,
		title: typeof field.title === "string" ? field.title : name,
		...(typeof field.description === "string" ? { description: field.description } : {}),
		type,
		...(enumValues ? { enum: enumValues } : {}),
		...(field.default !== undefined ? { default: field.default } : {}),
	};
}

function parseFormRequest(
	serverName: string,
	params: Record<string, unknown>,
): MCPHostInteractionFormRequest | undefined {
	if (typeof params.message !== "string" || !params.message.trim() || params.message.length > MAX_MESSAGE_LENGTH)
		return undefined;
	const schema = asRecord(params.requestedSchema);
	if (
		!schema ||
		!hasOnlyKeys(schema, [
			"type",
			"properties",
			"required",
			"additionalProperties",
			"title",
			"description",
			"$schema",
		]) ||
		(schema.type !== undefined && schema.type !== "object") ||
		(schema.additionalProperties !== undefined && schema.additionalProperties !== false)
	) {
		return undefined;
	}
	const properties = asRecord(schema.properties);
	if (!properties || Object.keys(properties).length === 0 || Object.keys(properties).length > MAX_FORM_FIELDS)
		return undefined;

	const required = schema.required;
	if (required !== undefined && (!Array.isArray(required) || !required.every(item => typeof item === "string"))) {
		return undefined;
	}
	const requiredNames = new Set(required ?? []);
	if ([...requiredNames].some(name => !Object.hasOwn(properties, name))) return undefined;

	const fields: MCPHostInteractionFormField[] = [];
	for (const [name, value] of Object.entries(properties)) {
		const field = parseFormField(name, value);
		if (!field) return undefined;
		fields.push({ ...field, required: requiredNames.has(name) });
	}
	return { serverName, message: params.message, fields };
}

/** Parse only absolute HTTPS links safe to display and send to the system opener. */
export function parseMCPHostInteractionUrl(value: unknown): { url: string; origin: string } | undefined {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > MAX_URL_LENGTH ||
		value.trim() !== value ||
		/[\u0000-\u001F\u007F-\u009F]/.test(value)
	) {
		return undefined;
	}
	try {
		const parsed = new URL(value);
		if (parsed.protocol !== "https:" || !parsed.hostname || parsed.username || parsed.password) return undefined;
		return { url: parsed.href, origin: parsed.origin };
	} catch {
		return undefined;
	}
}

function parseUrlRequest(
	serverName: string,
	params: Record<string, unknown>,
): MCPHostInteractionUrlRequest | undefined {
	if (typeof params.message !== "string" || !params.message.trim() || params.message.length > MAX_MESSAGE_LENGTH)
		return undefined;
	const target = parseMCPHostInteractionUrl(params.url);
	return target ? { serverName, message: params.message, ...target } : undefined;
}

function cancelResponses(context: MCPInputCollectionContext): MCPInputResponses {
	return Object.fromEntries(
		Object.keys(context.inputRequired.inputRequests ?? {}).map(key => [key, { action: "cancel" }]),
	);
}

function normalizePrimitive(value: unknown, type: MCPPrimitiveType): MCPPrimitive | undefined {
	if (isValidPrimitiveForType(value, type)) return value;
	if (typeof value !== "string") return undefined;
	if (type === "string") return value;
	if (type === "boolean") return value === "true" ? true : value === "false" ? false : undefined;
	if (type === "null") return value === "null" ? null : undefined;
	if (!value.trim()) return undefined;
	const numeric = Number(value);
	return isValidPrimitiveForType(numeric, type) ? numeric : undefined;
}

function normalizeFormContent(
	value: unknown,
	fields: readonly MCPHostInteractionFormField[],
): Record<string, MCPPrimitive> | undefined {
	const content = asRecord(value);
	if (!content) return undefined;
	const fieldsByName = new Map(fields.map(field => [field.name, field]));
	if (Object.keys(content).some(name => !fieldsByName.has(name))) return undefined;

	const normalized: Record<string, MCPPrimitive> = Object.create(null);
	for (const field of fields) {
		if (!Object.hasOwn(content, field.name)) {
			if (field.required) return undefined;
			continue;
		}
		const normalizedValue = normalizePrimitive(content[field.name], field.type);
		if (normalizedValue === undefined || (field.enum && !field.enum.some(item => Object.is(item, normalizedValue)))) {
			return undefined;
		}
		normalized[field.name] = normalizedValue;
	}
	return normalized;
}

function validateRequests(context: MCPInputCollectionContext): ValidatedRequest[] | undefined {
	const inputRequests = context.inputRequired.inputRequests;
	if (!inputRequests) return undefined;
	const serverName = context.connection.name;
	if (typeof serverName !== "string" || !serverName) return undefined;
	const validated: ValidatedRequest[] = [];
	for (const [key, inputRequest] of Object.entries(inputRequests)) {
		const request = asRecord(inputRequest);
		const params = request ? asRecord(request.params) : undefined;
		if (!params || request?.method !== "elicitation/create") return undefined;
		const mode = params.mode ?? "form";
		if (mode === "form") {
			const form = parseFormRequest(serverName, params);
			if (!form) return undefined;
			validated.push({ key, kind: "form", request: form });
		} else if (mode === "url") {
			const url = parseUrlRequest(serverName, params);
			if (!url) return undefined;
			validated.push({ key, kind: "url", request: url });
		} else {
			return undefined;
		}
	}
	return validated;
}

/**
 * Consent-safe MRTR elicitation policy. It is deliberately inert until a real
 * interactive presenter is bound, so SDK and headless hosts cannot accidentally
 * advertise or satisfy server-directed input.
 */
export class MCPHostInteractionBridge implements MCPHostInteraction {
	#presenter: MCPHostInteractionPresenter | undefined;

	get clientCapabilities(): MCPModernClientCapabilities {
		return this.#presenter ? INTERACTIVE_CAPABILITIES : NO_CAPABILITIES;
	}

	bind(presenter: MCPHostInteractionPresenter): void {
		this.#presenter = presenter;
	}

	unbind(): void {
		this.#presenter = undefined;
	}

	async collectInput(context: MCPInputCollectionContext): Promise<MCPInputResponses> {
		const presenter = this.#presenter;
		if (!presenter || context.signal?.aborted) return cancelResponses(context);
		const requests = validateRequests(context);
		if (!requests) return cancelResponses(context);

		const responses: Array<[string, unknown]> = [];
		for (const item of requests) {
			if (context.signal?.aborted || this.#presenter !== presenter) return cancelResponses(context);
			try {
				if (item.kind === "form") {
					const response = await presenter.presentForm(item.request, context.signal);
					if (context.signal?.aborted || this.#presenter !== presenter) return cancelResponses(context);
					if (response.action === "accept") {
						const content = normalizeFormContent(response.content, item.request.fields);
						responses.push([item.key, content ? { action: "accept", content } : { action: "cancel" }]);
					} else {
						responses.push([item.key, { action: response.action }]);
					}
				} else {
					const response = await presenter.presentUrl(item.request, context.signal);
					if (context.signal?.aborted || this.#presenter !== presenter) return cancelResponses(context);
					if (response.action === "accept") {
						await presenter.openUrl(item.request.url);
						if (context.signal?.aborted || this.#presenter !== presenter) return cancelResponses(context);
						responses.push([item.key, { action: "accept" }]);
					} else {
						responses.push([item.key, { action: response.action }]);
					}
				}
			} catch {
				if (context.signal?.aborted || this.#presenter !== presenter) return cancelResponses(context);
				responses.push([item.key, { action: "cancel" }]);
			}
		}
		return Object.fromEntries(responses);
	}
}

export function createMCPHostInteractionBridge(): MCPHostInteractionBridge {
	return new MCPHostInteractionBridge();
}
