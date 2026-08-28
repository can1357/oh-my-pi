import {
	type Dispatch,
	type RefObject,
	type SetStateAction,
	useCallback,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import type { RpcBridge } from "../../rpc/bridge";
import type { AvailableSlashCommand } from "../../rpc/protocol";
import { readDroppedImage } from "../../rpc/transport";
import { composeMessage } from "./keymap";

export interface Attachment {
	id: string;
	name: string;
	mimeType: string;
	/** Base64 payload, as `prompt(message, images)` expects. */
	data: string;
	previewUrl: string;
}

/**
 * `file.name + size` collided for the same file dropped twice, which gave two
 * chips one id: React warned about the duplicate key, and removing either chip
 * removed both. A counter cannot collide.
 */
let attachmentSeq = 0;

/** What the composer hands `prompt(message, images)` for each attachment. */
export interface ComposerImage {
	type: "image";
	data: string;
	mimeType: string;
}

/** The draft exactly as it stood when Send was pressed. */
export interface DraftContents {
	draft: string;
	attachments: readonly Attachment[];
	references: readonly string[];
}

/** Everything `sendDraft` is allowed to touch, so the order can be tested. */
export interface DraftSink {
	/**
	 * Put the message on the wire.
	 *
	 * `refused` is the second answer a prompt can get. The server acknowledges
	 * the frame and only then starts the turn — it has to, a turn runs for
	 * minutes — so a refusal raised during turn setup (no model selected, no API
	 * key for the provider) arrives after this promise has already resolved.
	 */
	send(message: string, images: ComposerImage[] | undefined, refused: (cause: Error) => void): Promise<boolean>;
	/**
	 * Draw the message in the transcript before the wire has confirmed it.
	 *
	 * Returns the handle `retract` takes it back out with. Called before `send`,
	 * because the whole point is that the message is on screen while the send is
	 * still in flight — measured at ~3.7s for the first prompt of a session.
	 */
	echo(message: string): string;
	/**
	 * Take the optimistic copy back out: this message was never sent.
	 *
	 * Unconditional, unlike `restore` — which declines to overwrite a draft the
	 * user has started typing since. The two agree on the thing that matters: a
	 * message the server refused is never left standing in the transcript, even
	 * when its text does not go back into the composer.
	 */
	retract(token: string): void;
	/** Drop exactly what went out, and revoke its previews. */
	clear(sent: DraftContents): void;
	/** Put back what `clear` took, for a send that was refused after it. */
	restore(sent: DraftContents): void;
	/** Somewhere the user will actually see it — the session's error banner. */
	reportError(cause: unknown): void;
}

/**
 * Send the draft, and give it up only once the send has landed.
 *
 * The order is the whole point. Everything used to be cleared — and every
 * object URL revoked — before the await, with the rejection swallowed by an
 * empty catch. A send refused because the sidecar was still coming up, or
 * evicted mid-flight to free a pool slot, took the message with it and left no
 * trace that anything had happened.
 *
 * Module-level and injected rather than written inline in the hook, because
 * this ordering is the part that keeps going wrong and inside a hook it is only
 * reachable through a real React tree — which this package has no test
 * environment for. Same reason `keymap.ts` exists.
 */
export async function sendDraft(message: string, contents: DraftContents, sink: DraftSink): Promise<void> {
	const images = contents.attachments.map(attachment => ({
		type: "image" as const,
		data: attachment.data,
		mimeType: attachment.mimeType,
	}));
	/*
	 * Which of the two answers got here first. The refusal can arrive in the
	 * same batch of frames as the acknowledgement — the relay hands the webview
	 * a batch and it is read synchronously, a microtask before the `await` below
	 * resumes — so without this the failed send would still empty the composer,
	 * and the restore would have found a full box and rightly left it alone.
	 */
	let outcome: "sending" | "cleared" | "failed" = "sending";
	/*
	 * Before the send, not after it. The server does not echo the message back
	 * until it opens the turn, and for the first prompt of a session that is
	 * ~3.7s of MCP mounting later — during which the transcript showed nothing at
	 * all and the app looked like it had eaten the message.
	 */
	const echo = sink.echo(message);
	const refused = (cause: Error) => {
		if (outcome === "failed") return;
		const cleared = outcome === "cleared";
		outcome = "failed";
		// Unconditionally, and before the restore: a message that did not go must
		// not be left on screen even when the box is too full to take it back.
		sink.retract(echo);
		// Only if it was actually given up. Beat the clear here and the message
		// is still in the box, previews and all, with nothing to put back.
		if (cleared) sink.restore({ ...contents, attachments: revivePreviews(contents.attachments) });
		sink.reportError(refusal(cause));
	};
	let took = true;
	try {
		took = await sink.send(message, images.length ? images : undefined, refused);
	} catch (cause) {
		outcome = "failed";
		sink.retract(echo);
		sink.reportError(refusal(cause));
		return;
	}
	if (outcome !== "sending") return;
	outcome = "cleared";
	sink.clear(contents);
	// Nothing will ever echo a command the server answered on its own: an ACP
	// builtin is handled before the prompt reaches the session, so no user
	// message is recorded and no frame ever arrives to claim this echo.
	if (!took) sink.retract(echo);
}

/** One sentence for both answers: the message did not go, and it is still here. */
function refusal(cause: unknown): Error {
	const reason = cause instanceof Error ? cause.message : String(cause);
	return new Error(`Could not send that message, so it is still in the composer: ${reason}`);
}

/**
 * The same attachments, with previews that survived the clear.
 *
 * `clear` revoked the object URLs and the `File` they were made from is gone,
 * so a restored chip would show a broken thumbnail. The base64 the send itself
 * carried is enough to draw it again as a data URL — which is how the
 * dropped-path attachments have always made their previews, and needs no
 * revoking at all.
 */
function revivePreviews(attachments: readonly Attachment[]): Attachment[] {
	return attachments.map(attachment =>
		attachment.previewUrl.startsWith("data:")
			? attachment
			: { ...attachment, previewUrl: `data:${attachment.mimeType};base64,${attachment.data}` },
	);
}

/**
 * Everything the composer's two surfaces share.
 *
 * Written out rather than inferred from the hook: the draft is owned in one
 * place and read by the inline row, the expanded dialog and the chips, so what
 * passes between them is a contract worth being able to read.
 */
export interface ComposerDraft {
	draft: string;
	changeDraft(value: string): void;
	attachments: Attachment[];
	references: string[];
	notice: string | null;
	dismissNotice(): void;
	dropping: boolean;
	setDropping: Dispatch<SetStateAction<boolean>>;
	expanded: boolean;
	setExpanded: Dispatch<SetStateAction<boolean>>;
	/** Slash commands matching the draft, or empty when the menu is closed. */
	matches: AvailableSlashCommand[];
	slashListId: string;
	highlight: number;
	setHighlight: Dispatch<SetStateAction<number>>;
	dismissSlash(): void;
	applyCompletion(command: AvailableSlashCommand): void;
	addImages(files: readonly File[]): Promise<void>;
	addDroppedPaths(paths: readonly string[]): Promise<void>;
	addReferences(paths: readonly string[]): void;
	removeAttachment(id: string): void;
	removeReference(path: string): void;
	submit(): Promise<void>;
	/** A send is on the wire and the draft has not been given up yet. */
	sending: boolean;
	streaming: boolean;
	editorRef: RefObject<HTMLTextAreaElement | null>;
	/** Where the caret was, so it survives the move between surfaces. */
	selection: RefObject<{ start: number; end: number }>;
	pendingCaret: RefObject<number | null>;
}

/**
 * Everything the composer knows, owned in one place.
 *
 * It lives here rather than inside `Composer` because the draft is now edited
 * from two places — the inline row and the expanded modal — and two components
 * each holding their own copy of the text is the bug this shape exists to make
 * impossible. Only one `<textarea>` is ever mounted; this is what it reads and
 * writes.
 *
 * Called once per session in `SessionView`, so each tab keeps its own draft the
 * way it always has.
 */
export function useComposerDraft({
	bridge,
	commands,
	streaming,
}: {
	bridge: RpcBridge;
	commands: readonly AvailableSlashCommand[];
	streaming: boolean;
}): ComposerDraft {
	const [draft, setDraft] = useState("");
	const [attachments, setAttachments] = useState<Attachment[]>([]);
	/**
	 * Files the agent should read, held apart from the draft.
	 *
	 * They used to be written into the text as `@"/very/long/path"`, which is
	 * what the agent needs but not what anyone wants to look at — two absolute
	 * iCloud paths filled the editor before a word had been typed. The mention is
	 * assembled at send time instead, so the editor stays prose and these show as
	 * tags.
	 */
	const [references, setReferences] = useState<string[]>([]);
	const [dropping, setDropping] = useState(false);
	const [highlight, setHighlight] = useState(0);
	const [expanded, setExpanded] = useState(false);
	const [slashDismissed, setSlashDismissed] = useState(false);
	const [notice, setNotice] = useState<string | null>(null);
	const [sending, setSending] = useState(false);

	/** The one mounted textarea, whichever surface is rendering it. */
	const editorRef = useRef<HTMLTextAreaElement>(null);
	/** Survives the editor unmounting when it moves between surfaces. */
	const selection = useRef({ start: 0, end: 0 });
	/** Where to put the caret after a programmatic insert, applied on next paint. */
	const pendingCaret = useRef<number | null>(null);
	/**
	 * Bumped whenever the current draft stops being the one on screen. Reads of
	 * dropped files are async, so a paste that is still being decoded when the
	 * message goes out would otherwise reappear attached to the *next* message.
	 */
	const generation = useRef(0);
	/**
	 * The same fact as `sending`, kept where it can be read without a render.
	 * The draft now survives the round trip, so a submit reaching this from a
	 * control the `disabled` attribute does not cover would send it a second
	 * time — and `submit` reads a render-stale `sending` from its own closure.
	 */
	const sendingRef = useRef(false);
	/** Unique per composer, so N open sessions do not share element ids. */
	const slashListId = useId();

	/**
	 * The slash menu opens only when `/` starts the draft — mid-sentence slashes
	 * are just text. `getAvailableCommands` returned 79 commands on a stock
	 * install, so the list is filtered, not dumped.
	 *
	 * It also closes as soon as the draft has a newline, which means it is
	 * effectively single-line-only: in the expanded modal it shows while you are
	 * still on the first line and then gets out of the way. That is the right
	 * trade — a command and a multi-paragraph prompt are different things.
	 */
	const slashQuery = !slashDismissed && draft.startsWith("/") && !draft.includes("\n") ? draft.slice(1) : null;

	const matches = useMemo(() => {
		if (slashQuery === null) return [];
		const query = slashQuery.toLowerCase().split(" ")[0];
		return commands
			.filter(
				command =>
					command.name.toLowerCase().startsWith(query) ||
					command.aliases?.some(alias => alias.toLowerCase().startsWith(query)),
			)
			.slice(0, 12);
	}, [commands, slashQuery]);

	/**
	 * The command list is replaced whenever an `available_commands_update` frame
	 * arrives, which can happen mid-keystroke. Without this, `highlight` outlives
	 * a shrinking list and accepting the completion reads `undefined.name`.
	 */
	useEffect(() => {
		setHighlight(current => (current < matches.length ? current : 0));
	}, [matches.length]);

	/**
	 * Object URLs are revoked on send and on removing a chip, but nothing covered
	 * unmount — every preview leaked for the life of the window. Navigating to
	 * Settings unmounts every session, so this was not a rare path.
	 */
	const attachmentsRef = useRef(attachments);
	attachmentsRef.current = attachments;
	useEffect(() => {
		return () => {
			generation.current++; // anything still decoding must not attach itself
			for (const attachment of attachmentsRef.current) URL.revokeObjectURL(attachment.previewUrl);
		};
	}, []);

	const addImages = useCallback(async (files: readonly File[]) => {
		const mine = generation.current;
		const images = files.filter(file => file.type.startsWith("image/"));

		// Silence was the old behaviour: drop a PDF and nothing happened at all.
		// Only images can be sent as content — see `addFileReferences`.
		if (images.length === 0) {
			if (files.length > 0) setNotice("Only images can be attached. Use “Reference a file” for anything else.");
			return;
		}
		if (images.length < files.length) setNotice("Skipped the non-image files. Use “Reference a file” for those.");
		else setNotice(null);

		// `allSettled`, not `all`: a file that becomes unreadable between the drop
		// and the read — moved, or on a volume that went away — would reject the
		// whole batch and strand the object URLs already created for its siblings.
		const settled = await Promise.allSettled(
			images.map(async file => {
				const buffer = await file.arrayBuffer();
				const bytes = new Uint8Array(buffer);
				let binary = "";
				for (const byte of bytes) binary += String.fromCharCode(byte);
				return {
					id: `attachment-${++attachmentSeq}`,
					name: file.name || "pasted image",
					mimeType: file.type,
					data: btoa(binary),
					previewUrl: URL.createObjectURL(file),
				} satisfies Attachment;
			}),
		);
		const next = settled.flatMap(result => (result.status === "fulfilled" ? [result.value] : []));
		if (next.length < images.length) setNotice("Could not read every image.");

		// The message these belong to was sent, or the session went away, while we
		// were decoding. Attaching them now would put them on the wrong message.
		if (generation.current !== mine) {
			for (const attachment of next) URL.revokeObjectURL(attachment.previewUrl);
			return;
		}
		setAttachments(current => [...current, ...next]);
	}, []);

	const removeAttachment = useCallback((id: string) => {
		setAttachments(current => {
			for (const attachment of current) if (attachment.id === id) URL.revokeObjectURL(attachment.previewUrl);
			return current.filter(attachment => attachment.id !== id);
		});
	}, []);

	/**
	 * Non-image files cannot be sent as content — the RPC prompt carries
	 * `images?: ImageContent[]` and nothing else. What omp *does* support is
	 * reading `@path` out of the message text, so a "file attachment" here is a
	 * mention the agent resolves on its side.
	 */
	const addReferences = useCallback((paths: readonly string[]) => {
		const wanted = paths.filter(Boolean);
		if (wanted.length === 0) return;
		setNotice(null);
		setReferences(current => [...current, ...wanted.filter(path => !current.includes(path))]);
	}, []);

	const removeReference = useCallback((path: string) => {
		setReferences(current => current.filter(entry => entry !== path));
	}, []);

	/**
	 * Files dropped on the window, which arrive as paths rather than `File`s.
	 *
	 * Images are read through Rust so they can be sent as content and shown with
	 * a thumbnail — the same result as picking them, so a drop and a pick are not
	 * two different features. Everything else becomes a reference.
	 */
	const addDroppedPaths = useCallback(
		async (paths: readonly string[]) => {
			const mine = generation.current;
			const images: Attachment[] = [];
			const others: string[] = [];
			let failed = 0;

			for (const path of paths) {
				if (!/\.(?:png|jpe?g|gif|webp)$/i.test(path)) {
					others.push(path);
					continue;
				}
				try {
					const image = await readDroppedImage(path);
					images.push({
						id: `attachment-${++attachmentSeq}`,
						name: image.name,
						mimeType: image.mimeType,
						data: image.data,
						// A data URL, because there is no `File` to make an object URL
						// from — and nothing to revoke later, which is one less leak.
						previewUrl: `data:${image.mimeType};base64,${image.data}`,
					});
				} catch {
					failed++;
				}
			}

			if (generation.current !== mine) return;
			if (failed > 0) setNotice("Could not read every image.");
			else if (images.length > 0 || others.length > 0) setNotice(null);
			if (images.length > 0) setAttachments(current => [...current, ...images]);
			if (others.length > 0) addReferences(others);
		},
		[addReferences],
	);

	const submit = useCallback(async () => {
		if (sendingRef.current) return;
		const message = composeMessage(draft, references);
		if (!message && attachments.length === 0) return;

		/*
		 * Bumped here, not on the clear. This message has already taken its images;
		 * a paste or a drop still decoding belongs to it and to nothing else, and
		 * letting it land would attach it to the *next* message — which is the very
		 * thing this counter was added to stop.
		 */
		generation.current++;
		sendingRef.current = true;
		setSending(true);
		try {
			await sendDraft(
				message,
				{ draft, attachments, references },
				{
					echo: text => bridge.echoUserMessage(text),
					retract: token => bridge.retractUserEcho(token),
					// While a turn is running, `steer` injects into it; `prompt` queues.
					// Only `prompt` answers twice: the server awaits `steer` before
					// replying, so its failures reject this send outright.
					send: async (text, images, refused) => {
						if (!streaming) return await bridge.prompt(text, images, refused);
						await bridge.steer(text, images);
						return true;
					},
					clear: sent => {
						for (const attachment of sent.attachments) URL.revokeObjectURL(attachment.previewUrl);
						/*
						 * Remove exactly what went out rather than blanking. A file
						 * dropped on the window during the round trip belongs to the next
						 * message, and blanking would discard it and leak its preview.
						 */
						const sentIds = new Set(sent.attachments.map(attachment => attachment.id));
						const sentPaths = new Set(sent.references);
						setDraft(current => (current === sent.draft ? "" : current));
						setAttachments(current => current.filter(attachment => !sentIds.has(attachment.id)));
						setReferences(current => current.filter(path => !sentPaths.has(path)));
						setNotice(null);
						setExpanded(false);
					},
					restore: sent => {
						/*
						 * Into an empty box only. Anything typed since the send is the
						 * user's own and outranks a message they have already watched
						 * leave — the terminal draws the same line when it hands back a
						 * prompt the session dropped (`#restoreDroppedPrompt`).
						 */
						setDraft(current => (current === "" ? sent.draft : current));
						// Additive, mirroring `clear`: what was dropped on the window
						// since belongs to the next message and stays with it.
						setAttachments(current => [...sent.attachments, ...current]);
						setReferences(current => [...sent.references, ...current]);
					},
					reportError: cause => {
						/*
						 * Both surfaces. The banner lives in the session view and the
						 * expanded dialog's backdrop covers it, so a send that failed out
						 * of the modal left the draft sitting there with no reason given.
						 */
						bridge.reportError(cause);
						setNotice(cause instanceof Error ? cause.message : String(cause));
					},
				},
			);
		} finally {
			sendingRef.current = false;
			setSending(false);
		}
	}, [attachments, bridge, draft, references, streaming]);

	/**
	 * Swap the command token for the chosen one and keep whatever came after it.
	 *
	 * It used to replace the entire draft, which was survivable while Tab was the
	 * only way to trigger it and the draft was one line. It is not survivable in
	 * an editor people write paragraphs in — `/plan` plus three sentences became
	 * `/plan ` and the sentences were gone.
	 */
	const applyCompletion = useCallback((command: AvailableSlashCommand) => {
		const node = editorRef.current;
		const rest = (node?.value ?? "").replace(/^\/\S*\s?/, "");
		const head = `/${command.name} `;
		pendingCaret.current = head.length;
		setDraft(head + rest);
		setHighlight(0);
		node?.focus();
	}, []);

	const changeDraft = useCallback((value: string) => {
		setDraft(value);
		setHighlight(0);
		setSlashDismissed(false);
	}, []);

	return {
		draft,
		changeDraft,
		attachments,
		references,
		notice,
		dismissNotice: useCallback(() => setNotice(null), []),
		dropping,
		setDropping,
		expanded,
		setExpanded,
		matches,
		slashListId,
		highlight,
		setHighlight,
		dismissSlash: useCallback(() => setSlashDismissed(true), []),
		applyCompletion,
		addImages,
		addDroppedPaths,
		addReferences,
		removeAttachment,
		removeReference,
		submit,
		sending,
		streaming,
		editorRef,
		selection,
		pendingCaret,
	};
}
