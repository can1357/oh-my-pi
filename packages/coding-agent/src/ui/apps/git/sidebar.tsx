/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * The git app's sidebar (the changes sheet): a head with the change count,
 * the branch and a Path/Tree switch; one file `list` per section under a
 * quiet head (fold chevron, name, count, `Stage all`/`Unstage all`, the AI
 * staging wand); the commit composer docked below. A clean tree shows the
 * HEAD commit and its files instead. Text fields are live `input`/`editor`
 * nodes only while they own the keys. The terminal draws the whole sheet
 * through the `omp.app.git.side` look from the {@link SidebarModel}.
 */
import type { JSXNode } from "@oh-my-pi/pi-tui";
import type { TspSpan } from "@oh-my-pi/pi-wire";
import type { ChangedFile, HeadCommit } from "../../../cli/git-tui/model/state";
import "../../styles/apps/git/sidebar";
import { KIND_LETTER, KIND_TONE } from "../../styles/apps/git/sidebar";
import { entryKey, itemKey, type SectionArea, SUMMARY_LIMIT, type SidebarModel } from "./sidebar-model";
import type { FileEntry } from "./tree";
import { ActionButton, IconButton, QuietButton, segmentedVariant } from "../../overlays/panels/common";

/** A text field at rest: its value (or the dim placeholder); a click starts editing it. */
function FieldText(props: {
	readonly nodeKey: string;
	readonly value: string;
	readonly placeholder: string;
	readonly act: string;
	readonly role: string;
	readonly on: boolean;
}): JSXNode {
	return (
		<text
			key={props.nodeKey}
			{...(props.value ? { text: props.value } : { spans: [{ s: "dim", t: props.placeholder }] })}
			truncate="end"
			role={props.on ? `${props.role}.on` : props.role}
			actions={{ click: props.act }}
		/>
	);
}

/** Runs after the sidebar handled a native event (the app moves the keyboard to it). */
type Interact = (() => void) | undefined;

function StyleToggle(props: { readonly model: SidebarModel; readonly onInteract?: Interact }): JSXNode {
	return (
		<tabs
			key="style"
			items={[
				{ id: "path", label: "Path" },
				{ id: "tree", label: "Tree" },
			]}
			active={props.model.viewStyle}
			role="omp.app.seg"
			variant={segmentedVariant}
			onSelect={item => {
				if (props.model.pickItem(item, false)) props.onInteract?.();
			}}
		/>
	);
}

function entryItem(entry: FileEntry, tree: boolean): JSXNode {
	const key = itemKey(entryKey(entry));
	if (entry.kind === "dir") {
		return (
			<item
				key={key}
				label={[{ t: entry.name }]}
				icon="folder"
				role={`omp.app.git.dir-d${Math.min(entry.depth, 8)}`}
				tone={entry.collapsed ? "muted" : undefined}
			/>
		);
	}
	const file = entry.file;
	const slash = file.path.lastIndexOf("/");
	const label: TspSpan[] =
		tree || slash < 0
			? [{ t: file.path.slice(slash + 1) }]
			: [{ s: "dim", t: file.path.slice(0, slash + 1) }, { t: file.path.slice(slash + 1) }];
	const stats: TspSpan[] = [];
	if (file.additions) stats.push({ s: "ins num", t: `+${file.additions}` });
	if (file.deletions) stats.push({ s: "del num", t: `${stats.length > 0 ? " " : ""}−${file.deletions}` });
	return (
		<item
			key={key}
			label={label}
			detail={file.origPath ? [{ s: "dim", t: `from ${file.origPath}` }] : undefined}
			value={stats.length > 0 ? stats : undefined}
			hint={[KIND_LETTER[file.kind]]}
			tone={KIND_TONE[file.kind]}
			role={`omp.app.git.file-d${tree ? Math.min(entry.depth ?? 0, 8) : 0}`}
			title={`${file.kind}: ${file.path}`}
		/>
	);
}

function FileList(props: {
	readonly model: SidebarModel;
	readonly listKey: string;
	readonly files: () => readonly ChangedFile[];
	readonly section: string;
	readonly empty?: string;
	readonly onInteract?: Interact;
}): JSXNode {
	const model = props.model;
	const entries = (): FileEntry[] => model.entries(props.files(), props.section);
	return (
		<list
			key={props.listKey}
			selected={() => {
				const key = model.selected()?.key;
				const entry = entries().find(candidate => entryKey(candidate) === key);
				return entry ? itemKey(entryKey(entry)) : null;
			}}
			empty={props.empty}
			role="omp.app.git.files"
			actions={{ click: "select", dblclick: "activate" }}
			onSelect={item => {
				if (model.pickItem(item, false)) props.onInteract?.();
			}}
			onActivate={item => {
				if (model.pickItem(item, true)) props.onInteract?.();
			}}
		>
			{() => {
				const tree = model.viewStyle() === "tree";
				return entries().map(entry => entryItem(entry, tree));
			}}
		</list>
	);
}

function Section(props: {
	readonly model: SidebarModel;
	readonly area: SectionArea;
	readonly onInteract?: Interact;
}): JSXNode {
	const model = props.model;
	const area = props.area;
	const files = (): readonly ChangedFile[] => (area === "unstaged" ? model.state.unstaged : model.state.staged);
	const folded = (): boolean => model.isSectionFolded(area);
	const on = (): boolean => model.focused() && model.selected()?.key === `section:${area}`;
	return [
		<row
			key={`${area}-head`}
			justify="between"
			align="center"
			role={() => (on() ? "omp.app.git.sechead.on" : "omp.app.git.sechead")}
		>
			<row gap="xs" align="center" actions={{ click: `fold-${area}` }} title={() => (folded() ? "Show" : "Hide")}>
				<icon name={() => (folded() ? "chev-r" : "chev")} />
				<text text={area === "unstaged" ? "Unstaged" : "Staged"} />
				<text role="omp.app.git.count" spans={() => [{ s: "num", t: String(files().length) }]} />
			</row>
			<row gap="xs" align="center" role="omp.app.git.acts">
				{() =>
					files().length === 0
						? null
						: area === "unstaged"
							? [
									<QuietButton
										label="Stage all"
										act="stage-all"
										title="Stage every change (space on the head)"
									/>,
									<IconButton
										nodeKey="ai"
										name="wand"
										act="stage-ai"
										title="Stage by description…"
										aria="Stage by description"
									/>,
								]
							: [
									<QuietButton
										label="Unstage all"
										act="unstage-all"
										title="Unstage every change (space on the head)"
									/>,
								]
				}
			</row>
		</row>,
		() => {
			if (area !== "unstaged" || !model.aiOpen()) return null;
			if (model.editing() === "stage-ai-input") {
				const line = model.aiPrompt();
				return (
					<input
						key="ai"
						text={line.text}
						cursor={line.cursor}
						sendable={false}
						placeholder="What should we stage?"
						role="omp.app.git.field.on"
					/>
				);
			}
			return (
				<FieldText
					nodeKey="ai"
					value={model.aiPrompt().text}
					placeholder="What should we stage?"
					act="edit-ai"
					role="omp.app.git.field"
					on={model.focused() && model.selected()?.key === "stage-ai-input"}
				/>
			);
		},
		() =>
			folded() ? null : (
				<FileList
					model={model}
					listKey={area}
					files={files}
					section={area}
					empty={area === "unstaged" ? "Nothing to stage" : "Nothing staged yet"}
					onInteract={props.onInteract}
				/>
			),
	];
}

function CommitForm(props: { readonly model: SidebarModel }): JSXNode {
	const model = props.model;
	const on = (key: string): boolean => model.focused() && model.selected()?.key === key;
	return (
		<col gap="sm" role="omp.app.git.commit">
			{() => {
				const summary = model.summary();
				if (model.editing() !== "summary") {
					return (
						<FieldText
							nodeKey="summary"
							value={summary.text}
							placeholder="Summary"
							act="edit-summary"
							role="omp.app.git.summary"
							on={on("summary")}
						/>
					);
				}
				const left = SUMMARY_LIMIT - summary.text.length;
				return (
					<row key="summary" gap="sm" align="center" role="omp.app.git.summary.on">
						<input text={summary.text} cursor={summary.cursor} sendable={false} placeholder="Summary" grow={1} />
						<text role="omp.app.git.count" spans={[{ s: left < 0 ? "warning num" : "num", t: String(left) }]} />
					</row>
				);
			}}
			{() => {
				const description = model.description();
				if (model.editing() === "description") {
					return (
						<editor
							key="body"
							text={description.text}
							cursor={description.cursor}
							sendable={false}
							placeholder="Description"
							maxLines={5}
							role="omp.app.git.body.on"
						/>
					);
				}
				const text = description.text;
				return (
					<FieldText
						nodeKey="body"
						value={text.split("\n", 1)[0]! + (text.includes("\n") ? " …" : "")}
						placeholder="Description"
						act="edit-description"
						role="omp.app.git.body"
						on={on("description")}
					/>
				);
			}}
			<row key="foot" justify="between" align="center" role="omp.app.git.foot">
				<row
					gap="xs"
					align="center"
					role={() => `omp.app.git.toggle${model.amend() ? ".set" : ""}${on("amend") ? ".on" : ""}`}
					actions={{ click: "amend" }}
					title="Amend the previous commit"
				>
					<icon name={() => (model.amend() ? "check" : "commit")} />
					<text text="Amend" />
				</row>
				{() => commitButton(model, on("commit-button"))}
			</row>
		</col>
	);
}

/** The commit button's look and action for the form's state. */
function commitButton(model: SidebarModel, on: boolean): JSXNode {
	const state = model.state;
	const summary = model.summary().text;
	const description = model.description().text;
	const generating = model.generating();
	const hasChanges = state.staged.length > 0 || state.unstaged.length > 0 || model.amend();
	const blocked = !hasChanges
		? "Nothing to commit"
		: generating
			? "Generating the commit message…"
			: summary.trim().length === 0 && description.trim().length > 0
				? "Write a summary line first"
				: undefined;
	const label = generating
		? "Generating message…"
		: summary.trim().length === 0 && description.trim().length === 0
			? "Generate message"
			: state.staged.length > 0
				? "Commit"
				: "Stage all & commit";
	return (
		<ActionButton
			id="commit"
			label={label}
			title={state.staged.length > 0 ? "Commit the staged changes" : "Stage everything, then commit"}
			tone={on ? "accent" : undefined}
			busy={generating}
			disabled={blocked}
		/>
	);
}

function plural(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function HeadView(props: {
	readonly model: SidebarModel;
	readonly head: HeadCommit | null;
	readonly onInteract?: Interact;
}): JSXNode {
	const head = props.head;
	if (!head) return <text key="empty" spans={[{ s: "muted", t: "No commits yet" }]} role="omp.app.git.empty" />;
	const when = head.authorDate ? new Date(head.authorDate) : null;
	const initials = head.authorName
		.split(/\s+/)
		.filter(Boolean)
		.slice(0, 2)
		.map(word => word[0]!.toUpperCase())
		.join("");
	const facts: { k: string; v: string | TspSpan[] }[] = [];
	if (when && !Number.isNaN(when.getTime())) facts.push({ k: "authored", v: when.toLocaleString() });
	if (head.parents.length > 0) {
		facts.push({
			k: head.parents.length === 1 ? "parent" : "parents",
			v: [{ s: "mono accent", t: head.parents.map(sha => sha.slice(0, 8)).join(" ") }],
		});
	}
	const out: JSXNode[] = [
		<col key="head" gap="sm" role="omp.app.git.commit-info">
			<text spans={[{ s: "strong", t: head.subject }]} wrap="word" role="omp.app.git.subject" />
			{head.body.trim() !== "" ? (
				<text text={head.body.trim()} wrap="word" lines={8} role="omp.app.git.message" />
			) : null}
			<row gap="sm" align="center" role="omp.app.git.author">
				<text text={initials || "?"} role="omp.app.git.avatar" title={head.authorEmail} />
				<col gap="none">
					<text spans={[{ s: "strong", t: head.authorName }]} truncate="end" />
					<text spans={[{ s: "dim", t: head.authorEmail }]} truncate="end" />
				</col>
			</row>
			<kv items={facts} layout="grid" />
		</col>,
	];
	if (!head.filesLoaded) {
		out.push(<text key="loading" spans={[{ s: "muted", t: "Loading changed files…" }]} />);
		return out;
	}
	const additions = head.files.reduce((sum, file) => sum + (file.additions ?? 0), 0);
	const deletions = head.files.reduce((sum, file) => sum + (file.deletions ?? 0), 0);
	out.push(
		<row key="files-head" justify="between" align="center" role="omp.app.git.head">
			<text
				spans={[
					{ s: "strong", t: plural(head.files.length, "file") },
					{ t: "  " },
					{ s: "ins num", t: `+${additions}` },
					{ t: " " },
					{ s: "del num", t: `−${deletions}` },
					{ s: "dim mono", t: `  ${head.shortSha}` },
				]}
			/>
			<StyleToggle model={props.model} onInteract={props.onInteract} />
		</row>,
		<FileList
			model={props.model}
			listKey="commit-files"
			files={() => head.files}
			section="commit"
			onInteract={props.onInteract}
		/>,
	);
	return out;
}

function ChangesHead(props: { readonly model: SidebarModel; readonly onInteract?: Interact }): JSXNode {
	const model = props.model;
	return (
		<row key="head" justify="between" align="center" role="omp.app.git.head">
			<row gap="xs" align="center" role="omp.app.git.title">
				<text
					spans={() => [
						{ s: "strong", t: plural(model.state.unstaged.length + model.state.staged.length, "change") },
					]}
				/>
				{() =>
					model.state.branch === null
						? null
						: [
								<text spans={[{ s: "muted", t: "on" }]} />,
								<text
									role="omp.app.git.branch"
									spans={[{ s: "mono", t: model.state.branch }]}
									truncate="middle"
								/>,
							]
				}
			</row>
			<StyleToggle model={model} onInteract={props.onInteract} />
		</row>
	);
}

/** Props of {@link GitSidebar}. */
export interface GitSidebarProps {
	readonly model: SidebarModel;
	/** JSX key of the sheet (the app keys it `side`). */
	readonly nodeKey?: string;
	/** A native event reached the sidebar (the app gives it the keyboard). */
	readonly onInteract?: () => void;
}

/** The sidebar (see the module docs). */
export function GitSidebar(props: GitSidebarProps): JSXNode {
	const model = props.model;
	const interact = props.onInteract;
	return (
		<col
			key={props.nodeKey}
			role="omp.app.git.side"
			term={{ sidebar: model }}
			onAction={act => {
				if (model.runAction(act)) interact?.();
			}}
			onEdit={event => {
				if (model.applyEdit(event)) interact?.();
			}}
			onKey={key => model.handleKey(key)}
		>
			{() =>
				model.state.clean ? (
					<HeadView model={model} head={model.state.headCommit} onInteract={interact} />
				) : (
					[
						<ChangesHead model={model} onInteract={interact} />,
						<col key="changes" gap="sm" role="omp.app.git.changes">
							<Section model={model} area="unstaged" onInteract={interact} />
							<Section model={model} area="staged" onInteract={interact} />
						</col>,
						<CommitForm model={model} />,
					]
				)
			}
		</col>
	);
}
