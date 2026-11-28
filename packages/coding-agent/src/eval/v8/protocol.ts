export interface V8ErrorPayload {
	name?: string;
	message: string;
	stack?: string;
}

export interface V8ReadOptions {
	offset?: number;
	limit?: number;
}

export type V8WriteEncoding = "utf8" | "base64";

export type V8Inbound =
	| {
			type: "run";
			runId: string;
			code: string;
			filename: string;
			suppressFinalExpr?: boolean;
			emitCompletionValue?: boolean;
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
	| { type: "bridge-call"; id: string; runId: string; op: "tool"; name: string; args: unknown }
	| { type: "bridge-call"; id: string; runId: string; op: "read"; path: string; options?: V8ReadOptions }
	| {
			type: "bridge-call";
			id: string;
			runId: string;
			op: "write";
			path: string;
			data: string;
			encoding: V8WriteEncoding;
	  }
	| { type: "result"; runId: string; ok: true }
	| { type: "result"; runId: string; ok: false; error: V8ErrorPayload }
	| { type: "closed" };
