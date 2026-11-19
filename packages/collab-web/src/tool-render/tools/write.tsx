/** `write` — file create/overwrite: content preview plus write confirmation. */
import type { ReactNode } from "react";
import { Badge, Badges, CodeBlock, InvalidArg, Note, Output, PathText, ResultText } from "../parts";
import type { ToolRenderer, ToolRenderProps } from "../types";
import { detailsRecord, isRecord, languageFromPath, str } from "../util";

/** Subset of the write tool's `details` payload the web renderer surfaces. */
interface WriteDiagnostics {
	server?: string;
	messages: string[];
	summary: string | null;
	errored: boolean;
}

function diagnosticsOf(details: Record<string, unknown> | null): WriteDiagnostics | null {
	if (!details || !isRecord(details.diagnostics)) return null;
	const d = details.diagnostics;
	const messages: string[] = [];
	if (Array.isArray(d.messages)) {
		for (const m of d.messages) if (typeof m === "string") messages.push(m);
	}
	const summary = str(d.summary);
	if (messages.length === 0 && !summary) return null;
	return { server: str(d.server) ?? undefined, messages, summary, errored: d.errored === true };
}

function Summary({ args }: ToolRenderProps): ReactNode {
	const path = str(args.file_path ?? args.path);
	const content = str(args.content);
	const lines = content ? content.split("\n").length : 0;
	return (
		<>
			{path === null ? <InvalidArg what="path" /> : <PathText path={path} />}
			{lines > 1 && (
				<>
					{" "}
					<Badge>{lines} lines</Badge>
				</>
			)}
		</>
	);
}

function Body({ args, result }: ToolRenderProps): ReactNode {
	const path = str(args.file_path ?? args.path);
	const content = str(args.content);
	const details = detailsRecord(result);
	const diagnostics = diagnosticsOf(details);
	return (
		<>
			<Badges
				items={[
					details?.madeExecutable === true && <Badge tone="ok">made executable</Badge>,
					diagnostics?.summary && (
						<Badge tone={diagnostics.errored ? "err" : "warn"}>
							{diagnostics.server ? `${diagnostics.server}: ` : ""}
							{diagnostics.summary}
						</Badge>
					),
				]}
			/>
			{content === null ? (
				<Note tone="err">
					<InvalidArg what="content" /> — expected string
				</Note>
			) : (
				content && <CodeBlock code={content} lang={path ? languageFromPath(path) : null} maxLines={12} />
			)}
			<ResultText result={result} maxLines={4} />
			{diagnostics && diagnostics.messages.length > 0 && (
				<Output
					text={diagnostics.messages.join("\n")}
					title="diagnostics"
					error={diagnostics.errored}
					maxLines={8}
				/>
			)}
		</>
	);
}

export const writeRenderer: ToolRenderer = { Summary, Body };
