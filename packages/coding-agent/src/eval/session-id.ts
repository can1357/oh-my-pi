import type { ToolSession } from "../tools";

export type EvalSessionSource = Pick<ToolSession, "cwd" | "getSessionFile">;

export function defaultEvalSessionId(session: EvalSessionSource): string {
	const sessionFile = session.getSessionFile?.() ?? undefined;
	return sessionFile ? `session:${sessionFile}:cwd:${session.cwd}` : `cwd:${session.cwd}`;
}
