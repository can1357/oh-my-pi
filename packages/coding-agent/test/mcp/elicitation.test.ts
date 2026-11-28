import { describe, expect, it } from "bun:test";
import type { AgentToolContext } from "@oh-my-pi/pi-agent-core";
import type {
	ExtensionFormDialogResult,
	ExtensionUIContext,
	ExtensionUIDialogOptions,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { ELICIT_BACK, ELICIT_CANCEL, ELICIT_DECLINE, elicitHandler } from "@oh-my-pi/pi-coding-agent/mcp/elicitation";
import type { MCPElicitRequest, MCPElicitResult } from "@oh-my-pi/pi-coding-agent/mcp/protocol";
import type { MCPElicitHandler } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { defaultFormData, type HtmlFormData, textValue } from "@oh-my-pi/pi-coding-agent/tools/html-form/data";
import { type ChoiceField, parseHtmlForm } from "@oh-my-pi/pi-coding-agent/tools/html-form/parse";

type FormDialog = (
	html: string,
	dialogOptions?: ExtensionUIDialogOptions,
) => Promise<ExtensionFormDialogResult | undefined>;

/** A form dialog that opens the form as the TUI would and submits it with `answers` typed in over its defaults. */
function submitting(answers: Record<string, string | string[]>, seen?: { html?: string }): FormDialog {
	return async html => {
		if (seen) seen.html = html;
		const form = parseHtmlForm(html);
		const data: HtmlFormData = defaultFormData(form);
		for (const field of form.fields) {
			const answer = answers[field.name];
			if (answer === undefined) continue;
			data[field.name] = field.kind === "text" ? textValue(field, String(answer)) : answer;
		}
		return { data };
	};
}

function context(ui: Partial<ExtensionUIContext>, extra: Partial<AgentToolContext> = {}): AgentToolContext {
	// Tests need only the UI surface and the tool call's steering signal.
	return { hasUI: true, ui, ...extra } as unknown as AgentToolContext;
}

/** The context's handler, bound to one server for brevity. */
function handlerFor(
	ctx: AgentToolContext,
): (request: MCPElicitRequest, signal: AbortSignal | undefined) => Promise<MCPElicitResult> {
	const handler: MCPElicitHandler | undefined = elicitHandler(ctx);
	if (!handler) throw new Error("expected an elicitation handler");
	return (request, signal) => handler("deploy-server", request, signal);
}

const APPROVAL: MCPElicitRequest = {
	message: "Deploy to production?",
	requestedSchema: { type: "object", properties: { approve: { type: "boolean" } }, required: ["approve"] },
};

describe("MCP elicitation through the session UI", () => {
	it("types each answer as the schema declares and leaves unanswered optional fields out", async () => {
		const request: MCPElicitRequest = {
			message: "Release details",
			requestedSchema: {
				type: "object",
				properties: {
					name: { type: "string", title: "Release name" },
					contact: { type: "string", format: "email" },
					replicas: { type: "integer", minimum: 1 },
					ratio: { type: "number" },
					notify: { type: "boolean" },
					env: {
						type: "string",
						oneOf: [
							{ const: "stg", title: "Staging" },
							{ const: "prod", title: "Production" },
						],
					},
					regions: { type: "array", items: { enum: ["us", "eu", "ap"] } },
					nickname: { type: "string" },
				},
				required: ["name", "env"],
			},
		};
		const seen: { html?: string } = {};
		const formDialog = submitting(
			{
				name: "v2",
				contact: "ops@example.test",
				replicas: "3",
				ratio: "0.5",
				notify: "true",
				env: "prod",
				regions: ["us", "ap"],
			},
			seen,
		);

		const result = await handlerFor(context({ formDialog }))(request, undefined);

		expect(result).toEqual({
			action: "accept",
			content: {
				name: "v2",
				contact: "ops@example.test",
				replicas: 3,
				ratio: 0.5,
				notify: true,
				env: "prod",
				regions: ["us", "ap"],
			},
		});
		// Choices are selects offering exactly the schema's values after an empty "no answer yet" one:
		// the user cannot type an answer the schema does not allow.
		const env = parseHtmlForm(seen.html ?? "").fields.find(field => field.name === "env") as ChoiceField;
		expect(env.other).toBe(false);
		expect(env.options.map(option => option.value)).toEqual(["", "stg", "prod"]);
	});

	it("makes the user pick a required choice without a default: submitting untouched answers nothing", async () => {
		const request: MCPElicitRequest = {
			message: "Deploy?",
			requestedSchema: {
				type: "object",
				properties: { approve: { type: "boolean" }, env: { type: "string", enum: ["prod", "stg"] } },
				required: ["approve", "env"],
			},
		};
		const forms: string[] = [];
		const formDialog: FormDialog = async html => {
			forms.push(html);
			const data = defaultFormData(parseHtmlForm(html));
			return { data: forms.length === 1 ? data : { ...data, approve: "false", env: "stg" } };
		};

		const result = await handlerFor(context({ formDialog }))(request, undefined);

		expect(forms).toHaveLength(2);
		expect(forms[1]).toContain("Please fix:");
		expect(result).toEqual({ action: "accept", content: { approve: false, env: "stg" } });
	});

	it("sends cancel, not the form's defaults, when the host times the form out", async () => {
		const request: MCPElicitRequest = {
			message: "Deploy to production?",
			requestedSchema: { type: "object", properties: { approve: { type: "boolean", default: true } } },
		};
		const formDialog: FormDialog = async html => ({ data: defaultFormData(parseHtmlForm(html)), timedOut: true });

		expect(await handlerFor(context({ formDialog }))(request, undefined)).toEqual({ action: "cancel" });
	});

	it("asks a user who closed the form whether to decline or cancel, and reopens it on Back", async () => {
		const closedWith = async (picks: (string | undefined)[]) => {
			const forms: string[] = [];
			const formDialog: FormDialog = async html => {
				forms.push(html);
				// The form is closed the first time and answered after going back.
				return forms.length === 1 ? undefined : { data: { approve: "false" } };
			};
			const select = async () => picks.shift();
			const result = await handlerFor(context({ formDialog, select }))(APPROVAL, undefined);
			return { result, forms: forms.length };
		};

		expect(await closedWith([ELICIT_DECLINE])).toEqual({ result: { action: "decline" }, forms: 1 });
		expect(await closedWith([ELICIT_CANCEL])).toEqual({ result: { action: "cancel" }, forms: 1 });
		// Closing the choice itself sends no answer either.
		expect(await closedWith([undefined])).toEqual({ result: { action: "cancel" }, forms: 1 });
		expect(await closedWith([ELICIT_BACK])).toEqual({
			result: { action: "accept", content: { approve: false } },
			forms: 2,
		});
	});

	it("reopens a form whose answers break the schema as the user left it, stating the problem in it", async () => {
		const request: MCPElicitRequest = {
			message: "Where to deploy?",
			requestedSchema: {
				type: "object",
				properties: {
					owner: { type: "string" },
					note: { type: "string", default: "routine" },
					regions: { type: "array", minItems: 2, items: { enum: ["us", "eu", "ap"] } },
				},
				required: ["owner", "regions"],
			},
		};
		const forms: string[] = [];
		const formDialog: FormDialog = async html => {
			forms.push(html);
			const data = defaultFormData(parseHtmlForm(html));
			// First one region, which the form cannot reject, with the prefilled note cleared (left out, as ACP
			// clients send an empty optional field); then a second region.
			if (forms.length === 1) {
				const { note: _cleared, ...rest } = data;
				return { data: { ...rest, owner: "ops", regions: ["eu"] } };
			}
			return { data: { ...data, regions: [...(data.regions as string[]), "ap"] } };
		};

		const result = await handlerFor(context({ formDialog }))(request, undefined);

		expect(forms[1]).toContain("regions: Pick at least 2");
		// The cleared note stays cleared: the server's default does not come back.
		expect(defaultFormData(parseHtmlForm(forms[1] ?? ""))).toMatchObject({ owner: "ops", note: "", regions: ["eu"] });
		expect(result).toEqual({ action: "accept", content: { owner: "ops", regions: ["eu", "ap"] } });
	});

	it("sends a client's explicit decline or cancel as it is, without asking again", async () => {
		const dismissing =
			(action: "decline" | "cancel"): FormDialog =>
			async (_html, options) => {
				options?.onDismiss?.(action);
				return undefined;
			};
		const select = async () => {
			throw new Error("the user already answered");
		};

		expect(await handlerFor(context({ formDialog: dismissing("decline"), select }))(APPROVAL, undefined)).toEqual({
			action: "decline",
		});
		expect(await handlerFor(context({ formDialog: dismissing("cancel"), select }))(APPROVAL, undefined)).toEqual({
			action: "cancel",
		});
	});

	it("accepts an empty selection for a required list that allows one", async () => {
		const request: MCPElicitRequest = {
			message: "Extra regions?",
			requestedSchema: {
				type: "object",
				properties: { regions: { type: "array", items: { enum: ["us", "eu"] } } },
				required: ["regions"],
			},
		};
		const seen: { html?: string } = {};

		const result = await handlerFor(context({ formDialog: submitting({ regions: [] }, seen) }))(request, undefined);

		expect(result).toEqual({ action: "accept", content: { regions: [] } });
		// The form itself does not demand a pick either.
		expect(parseHtmlForm(seen.html ?? "").fields.find(field => field.name === "regions")?.required).toBe(false);
	});

	it("rejects dates that do not exist and date-times without a time or offset", async () => {
		const request: MCPElicitRequest = {
			message: "When?",
			requestedSchema: {
				type: "object",
				properties: { day: { type: "string", format: "date" }, at: { type: "string", format: "date-time" } },
			},
		};
		const problems = async (day: string, at: string) => {
			const forms: string[] = [];
			const formDialog: FormDialog = async html => {
				forms.push(html);
				// Fix both fields after the first submit so the loop ends.
				return { data: forms.length === 1 ? { day, at } : { day: "2026-02-10", at: "2026-02-10T09:30:00Z" } };
			};
			await handlerFor(context({ formDialog }))(request, undefined);
			return forms.length === 1 ? "accepted" : (forms[1] ?? "");
		};

		expect(await problems("2026-02-31", "2026-02-10T09:30:00Z")).toContain("day: Enter a real date");
		expect(await problems("2026-02-10", "2026-02-10")).toContain("at: Enter a date and time");
		expect(await problems("2024-02-29", "2026-02-10T09:30:00.5+02:00")).toBe("accepted");
	});

	it("closes the form as cancel when the user sends a message, without failing the call", async () => {
		const steering = new AbortController();
		const formDialog: FormDialog = (_html, options) => {
			queueMicrotask(() => steering.abort("user"));
			const { promise, reject } = Promise.withResolvers<ExtensionFormDialogResult | undefined>();
			options?.signal?.addEventListener("abort", () => reject(new DOMException("closed", "AbortError")));
			return promise;
		};
		const ctx = context({ formDialog }, {
			toolCall: { steeringSignal: steering.signal },
		} as Partial<AgentToolContext>);

		expect(await handlerFor(ctx)(APPROVAL, undefined)).toEqual({ action: "cancel" });
	});

	it("rejects when the tool call itself is aborted while the form is open", async () => {
		const call = new AbortController();
		const formDialog: FormDialog = () => {
			queueMicrotask(() => call.abort(new DOMException("stopped", "AbortError")));
			return Promise.withResolvers<ExtensionFormDialogResult | undefined>().promise;
		};

		const outcome = handlerFor(context({ formDialog }))(APPROVAL, call.signal);

		await expect(outcome).rejects.toThrow("stopped");
	});

	it("gives no handler to a context that cannot show a form, so the request declares no elicitation", () => {
		const formDialog = submitting({});

		expect(elicitHandler(context({ formDialog }, { hasUI: false }))).toBeUndefined();
		expect(elicitHandler(context({ select: async () => undefined }))).toBeUndefined();
	});
});
