export interface V8ErrorPayload {
	name?: string;
	message: string;
	stack?: string;
	isAbort?: boolean;
	isToolError?: boolean;
}

export interface V8ReadOptions {
	offset?: number;
	limit?: number;
}

export type V8WriteEncoding = "utf8" | "base64";

export type V8Inbound =
	| { type: "init" }
	| {
			type: "run";
			runId: string;
			code: string;
			filename: string;
			finalExprSuppressed?: boolean;
			asyncWrapped?: boolean;
			finalExprReturned?: boolean | null;
	  }
	| {
			type: "tool-reply";
			id: string;
			ok: true;
			value?: unknown;
	  }
	| {
			type: "tool-reply";
			id: string;
			ok: false;
			error: V8ErrorPayload;
	  }
	| { type: "cancel"; runId: string }
	| { type: "close" };

export type V8Outbound =
	| { type: "ready" }
	| { type: "text"; runId: string; chunk: string }
	| { type: "display"; runId: string; output: unknown }
	| { type: "tool-call"; id: string; runId: string; name: string; args: unknown }
	| { type: "url-read"; id: string; runId: string; path: string; options?: V8ReadOptions }
	| { type: "url-write"; id: string; runId: string; path: string; data: string; encoding: V8WriteEncoding }
	| { type: "result"; runId: string; ok: true }
	| { type: "result"; runId: string; ok: false; error: V8ErrorPayload }
	| { type: "closed" };
