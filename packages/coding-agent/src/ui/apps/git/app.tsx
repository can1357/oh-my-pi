/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * The `omp git` app (see {@link GitAppModel}): natively the diff pane under a
 * toolbar (file, `+a −d`, scope, change navigation, the view switch,
 * whitespace and wrap toggles, Stage file, help, close) beside the changes
 * sheet, which narrow terminals stack under the diff. The terminal draws the
 * whole screen (header, toolbar, diff, divider, sidebar) through the
 * `omp.app.git` look. Mount it full size (`<overlay size="full">`), with
 * {@link GitHelpOverlay} above it for the `?` sheet.
 */
import { type JSXNode, nativeRendering, type PasteEvent, type UiNode } from "@oh-my-pi/pi-tui";
import type { AssetFileContents, FileAssetSide, MediaRef } from "../../../cli/git-tui/model/state";
import type { TspSpan } from "@oh-my-pi/pi-wire";
import { formatTooltipKey } from "../../keys/hints";
import "../../styles/apps/git/app";
import { assetTitle } from "../../styles/apps/git/diff-pane";
import { type GitAppModel, NARROW_COLS } from "./app-model";
import { GitDiffPane } from "./diff-pane";
import { GitHelp, gitHelpSheet } from "./help";
import { GitSidebar } from "./sidebar";
import { ActionButton, IconButton, segmentedVariant } from "../../overlays/panels/common";

const VIEW_TABS = [
	{ id: "file", label: "File" },
	{ id: "split", label: "Split" },
	{ id: "inline", label: "Inline" },
	{ id: "hunk", label: "Hunks" },
];

function Bar(props: { readonly app: GitAppModel; readonly narrow: () => boolean }): JSXNode {
	const app = props.app;
	const where = (): JSXNode => {
		const file = app.currentFile();
		if (!file) {
			return <text spans={[{ s: "muted", t: app.model.branch ?? "detached" }]} role="omp.app.git.path" />;
		}
		const slash = file.path.lastIndexOf("/");
		const doc = app.pane.doc;
		const scope =
			file.area === "staged"
				? { text: "Staged", tone: "success" as const }
				: file.area === "unstaged"
					? { text: file.kind === "untracked" ? "Untracked" : "Unstaged", tone: "warning" as const }
					: { text: app.model.headCommit?.shortSha ?? "commit", tone: "accent" as const };
		return [
			<text
				spans={[
					{ s: "dim", t: file.path.slice(0, slash + 1) },
					{ s: "strong", t: file.path.slice(slash + 1) },
				]}
				truncate="start"
				role="omp.app.git.path"
				title={file.origPath ? `${file.origPath} → ${file.path}` : file.path}
			/>,
			doc ? (
				<text
					spans={[{ s: "ins num", t: `+${doc.additions}` }, { t: " " }, { s: "del num", t: `−${doc.deletions}` }]}
					role="omp.app.git.stat"
				/>
			) : null,
			<badge text={scope.text} tone={scope.tone} />,
		];
	};
	const tools = (): JSXNode => {
		const file = app.currentFile();
		const whitespace = app.whitespace();
		const out: JSXNode[] = [
			<row gap="none" align="center">
				<IconButton
					nodeKey="prev-hunk"
					name="chev-up"
					act="prev-hunk"
					title={`Previous change (${formatTooltipKey("alt+up")})`}
				/>
				<IconButton
					nodeKey="next-hunk"
					name="chev"
					act="next-hunk"
					title={`Next change (${formatTooltipKey("alt+down")})`}
				/>
			</row>,
			<tabs
				key="views"
				items={VIEW_TABS}
				active={() => app.pane.mode}
				role="omp.app.seg"
				variant={segmentedVariant}
				onSelect={item => void app.runAction(`view:${item}`)}
				onActivate={item => void app.runAction(`view:${item}`)}
			/>,
		];
		if (!props.narrow()) {
			out.push(
				<IconButton
					nodeKey="whitespace"
					name="type"
					act="whitespace"
					title={
						whitespace === "off"
							? `Ignore whitespace (${formatTooltipKey("b")})`
							: whitespace === "whitespace"
								? `Ignoring whitespace; also ignore formatting (${formatTooltipKey("b")})`
								: `Ignoring formatting and imports; show all (${formatTooltipKey("b")})`
					}
					on={whitespace !== "off"}
				/>,
				<IconButton
					nodeKey="wrap"
					name="corner-down-right"
					act="wrap"
					title={`Wrap lines (${formatTooltipKey("w")})`}
					on={app.pane.wrap}
				/>,
			);
		}
		if (file?.area === "unstaged" || file?.area === "staged") {
			const verb = file.area === "unstaged" ? "Stage" : "Unstage";
			out.push(<ActionButton id="stage-file" label={`${verb} file`} title={`${verb} ${file.path}`} keys={["s"]} />);
		}
		out.push(
			<IconButton
				nodeKey="help"
				name="keyboard"
				act="help"
				title={`Keyboard shortcuts (${formatTooltipKey("?")})`}
			/>,
			<IconButton nodeKey="close" name="x" act="close" title={`Close (${formatTooltipKey("q")})`} />,
		);
		return out;
	};
	return (
		<row key="bar" justify="between" align="center" role="omp.app.git.bar">
			<row gap="sm" align="center" role="omp.app.git.where">
				{where}
			</row>
			<row gap="sm" align="center" role="omp.app.git.tools">
				{tools}
			</row>
		</row>
	);
}

/** One side of a media/binary change as a short fact line. */
function assetText(asset: AssetFileContents["old"]): TspSpan[] {
	const size = (bytes: number | undefined): string =>
		bytes === undefined ? "" : bytes < 1024 ? ` · ${bytes} B` : ` · ${(bytes / 1024).toFixed(1)} KB`;
	switch (asset.kind) {
		case "empty":
			return [{ s: "dim", t: "none" }];
		case "text":
			return [{ t: `text${size(asset.byteLength)}` }];
		case "image":
			return [{ t: `image ${asset.image.widthPx}×${asset.image.heightPx}${size(asset.image.byteLength)}` }];
		case "binary":
			return [{ t: `binary${size(asset.byteLength)}` }];
		case "tooLarge":
			return [{ t: `too large to diff${size(asset.byteLength)}` }];
		case "lfsMissing":
			return [{ t: `LFS object ${asset.oid.slice(0, 12)} not fetched${size(asset.byteLength)}` }];
	}
}

/** `media` nodes of the before/after compare share this link, so they pan and zoom together. */
const MEDIA_COMPARE_LINK = "git-compare";

function MediaColumn(props: {
	side: "before" | "after";
	asset: FileAssetSide;
	mediaRef: MediaRef | undefined;
}): JSXNode {
	const { side, asset, mediaRef } = props;
	return (
		<col key={side} gap="xs" grow={1} basis={0} role="omp.app.git.media-side">
			<text
				key="head"
				spans={[{ s: "strong", t: assetTitle(side === "before" ? "Before" : "After", asset) }]}
				truncate="end"
				role="omp.app.git.media-head"
			/>
			{mediaRef ? (
				<media
					key={`media-${Bun.hash(mediaRef.path).toString(36)}`}
					{...mediaRef}
					link={MEDIA_COMPARE_LINK}
					grow={1}
					role="omp.app.git.media"
				/>
			) : (
				<text
					key="none"
					spans={
						asset.kind === "empty"
							? [{ s: "muted", t: side === "before" ? "Did not exist" : "Deleted" }]
							: assetText(asset).map(fact => ({ s: "muted", t: fact.t }))
					}
					role="omp.app.git.media-none"
				/>
			)}
		</col>
	);
}

/** The diff for the view mode, or the loading, empty and media states. */
function Body(props: { readonly app: GitAppModel; readonly media: () => boolean }): JSXNode {
	const app = props.app;
	return () => {
		const pane = app.pane;
		const state = pane.state;
		const file = app.currentFile();
		if (pane.doc && state === "ready") return <GitDiffPane model={pane} />;
		const contents = app.contents();
		if (state === "asset" && file && contents?.kind === "asset") {
			if (props.media()) {
				return (
					<row key="compare" gap="sm" align="stretch" grow={1} role="omp.app.git.compare">
						<MediaColumn side="before" asset={contents.old} mediaRef={contents.oldRef} />
						<MediaColumn side="after" asset={contents.new} mediaRef={contents.newRef} />
					</row>
				);
			}
			return (
				<col key="asset" gap="sm" role="omp.app.git.state">
					<text spans={[{ s: "strong", t: "Binary or media file" }]} />
					<kv
						items={[
							{ k: "before", v: assetText(contents.old) },
							{ k: "after", v: assetText(contents.new) },
						]}
						layout="grid"
					/>
				</col>
			);
		}
		if (state === "streaming" || state === "loading") {
			return (
				<row key="loading" gap="sm" align="center" role="omp.app.git.state">
					<spinner style="dots" />
					<text spans={[{ s: "muted", t: `Loading ${file?.path ?? "diff"}…` }]} />
				</row>
			);
		}
		return (
			<col key="empty" gap="xs" role="omp.app.git.empty">
				<text spans={[{ s: "strong", t: pane.emptyMessage }]} />
				<text
					spans={[
						{
							s: "muted",
							t: app.model.clean ? "The working tree is clean." : "Pick a file on the right to see its changes.",
						},
					]}
				/>
			</col>
		);
	};
}

/** Props of {@link GitApp}. */
export interface GitAppProps {
	readonly app: GitAppModel;
	/** Whether the terminal shows `media` nodes natively (the media compare). */
	readonly media?: () => boolean;
}

/** The app (see the module docs). */
export function GitApp(props: GitAppProps): JSXNode {
	const app = props.app;
	const narrow = (): boolean => app.columns() < NARROW_COLS;
	const media = props.media ?? (() => false);
	// Keep the panes (including the keyboard focus target) when the responsive wrapper switches kind.
	const children = [
		<col key="main" role="omp.app.git.main">
			<Bar app={app} narrow={narrow} />
			{() => {
				const status = app.visibleStatus();
				return status ? (
					<text
						key="status"
						spans={[{ s: status.tone === "dim" ? "muted" : status.tone, t: status.text }]}
						truncate="end"
						role="omp.app.status"
					/>
				) : null;
			}}
			<Body app={app} media={media} />
		</col>,
		<GitSidebar model={app.sidebar} nodeKey="side" onInteract={() => app.setFocus("sidebar")} />,
	];
	const handlers = {
		term: { app },
		onKey: (key: Parameters<GitAppModel["handleKey"]>[0]) => app.handleKey(key),
		onPaste: (paste: PasteEvent) => app.sidebar.paste(paste.text),
		onAction: (act: string) => {
			if (app.runAction(act)) return;
			if (app.sidebar.runAction(act)) app.setFocus("sidebar");
		},
	};
	return () =>
		narrow() ? (
			<col role="omp.app.git-narrow" {...handlers}>
				{children}
			</col>
		) : (
			<row role="omp.app.git" {...handlers}>
				{children}
			</row>
		);
}

/**
 * The `?` shortcuts sheet over the app while it is open; `onOpen` gets the
 * overlay node (the host gives it the keyboard: the sheet closes on `?`,
 * escape and `q`).
 */
export function GitHelpOverlay(props: {
	readonly app: GitAppModel;
	readonly onOpen?: (node: UiNode) => void;
}): JSXNode {
	const app = props.app;
	return () =>
		app.helpOpen() ? (
			<overlay key="git-help" {...gitHelpSheet(nativeRendering(), app.columns)} ref={props.onOpen}>
				<GitHelp onClose={() => app.toggleHelp()} />
			</overlay>
		) : null;
}
