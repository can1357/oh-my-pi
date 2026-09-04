//! Observer-local composer: a retained editor tree whose draft never enters
//! the session DOM until submission.

use std::{cell::Cell, fmt::Write as _, ops::Range, path::Path, rc::Rc, time::Duration};

use omp_core::Str;
use omp_tui::{
	Command, EditorOptions, Frame, Key, MouseReport, SpellingFeatures, Ui, UiContext, UiEvent,
	components::{
		AttachmentContent, ComposerStyle, EditorPane, InlineAccent, PrefixAccent, marker_sized_paste,
	},
};

use crate::{
	autocomplete::{PromptAction, PromptActions, UrlCompleter, composer_chain},
	chrome::{
		COMPOSER_ID, GAP_ID, STATUS_ID, StatusAppearance, StatusBand, StatusFacts, composer_ui,
		top_gap_shown,
	},
};

/// Editor row budget for a terminal of `rows` rows (
/// `computeEditorMaxHeight`): roomy terminals get the comfortable `[6, 18]`
/// band below twelve reserved rows; small terminals shrink the cap so the
/// editor leaves at least four rows for the transcript and status, never
/// dropping under the three-row bordered floor.
#[must_use]
pub fn editor_max_rows(rows: u16) -> u16 {
	const MIN: u16 = 6;
	const MAX: u16 = 18;
	const RESERVED: u16 = 12;
	const FALLBACK_ROWS: u16 = 24;
	const MIN_CHROME_ROWS: u16 = 4;
	const MIN_RENDERED_ROWS: u16 = 3;
	let rows = if rows == 0 { FALLBACK_ROWS } else { rows };
	let comfortable = rows.saturating_sub(RESERVED).clamp(MIN, MAX);
	comfortable
		.min(rows.saturating_sub(MIN_CHROME_ROWS))
		.max(MIN_RENDERED_ROWS)
}

/// Kind of a composer-staged media source.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ComposerMediaKind {
	/// A directly supported image container.
	Image,
	/// A supported video container.
	Video,
}

/// One ordered media source drained from the composer's attachment band.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ComposerMediaSource {
	/// Producer-side classification used by the host materializer.
	pub kind:   ComposerMediaKind,
	/// Local source path and retry link, resolved relative to the chat process.
	///
	/// Normalization may replace the encoded bytes handed to the model but
	/// never this source, so a refused or restored draft keeps its image link.
	pub source: Str,
}

/// Result of applying a composer key.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ComposerAction {
	/// Composer changed and needs repainting.
	Changed,
	/// Submit the current draft as a prompt.
	Submit(Str),
	/// Submit the draft with the media chips it references (
	/// `pendingImages`): `[Image #N]` / `[Video #N]` in `text` is positional
	/// against `media[N-1]`, each a local source the host reads once.
	SubmitWithMedia {
		/// The draft with chips expanded to their wire markers.
		text:  Str,
		/// Staged media sources in marker order.
		media: Vec<ComposerMediaSource>,
	},
	/// Run a submitted `/…` line as the console statement after the slash.
	Command {
		/// Console statement after the leading slash.
		statement: Str,
		/// Media still referenced by the command draft. Commands that do not
		/// accept media refuse before commit instead of silently dropping it.
		media:     Vec<ComposerMediaSource>,
	},
	/// Queue the draft behind the active turn ( `->` / `=>` yield-queue
	/// shorthand): the body runs when the agent yields, or at once when it
	/// is idle with an empty queue. Media chips travel with it exactly as
	/// they do for [`ComposerAction::SubmitWithMedia`].
	Queue {
		/// The body behind the sigil, chips expanded to their wire markers.
		text:  Str,
		/// Staged media sources in marker order.
		media: Vec<ComposerMediaSource>,
	},
	/// Write text to the clipboard (the host owns OSC 52 / native access).
	Copy(Str),
	/// No composer action.
	Ignored,
}

/// `compactImageMarkers`: submitted media are the visible chips in marker
/// order, so `[Image #M…]` or `[Video #M…]` for the K-th surviving marker M
/// is rewritten to K. A matching legacy `attachment://M` link moves with the
/// marker. The positional marker-to-source contract therefore survives chip
/// deletion without disturbing image/video classification or source links.
fn compact_media_markers(text: &str, markers: &[usize]) -> String {
	if markers
		.iter()
		.enumerate()
		.all(|(index, marker)| *marker == index + 1)
	{
		return text.to_owned();
	}
	rewrite_media_markers(text, |old| {
		markers
			.iter()
			.position(|marker| *marker == old)
			.map(|index| index + 1)
	})
}

fn rewrite_media_markers(text: &str, mut mapped: impl FnMut(usize) -> Option<usize>) -> String {
	const PREFIXES: [&str; 2] = ["[Image #", "[Video #"];
	const LEGACY: &str = " attachment://";
	let mut out = String::with_capacity(text.len());
	let mut rest = text;
	loop {
		let next = PREFIXES
			.into_iter()
			.filter_map(|prefix| rest.find(prefix).map(|at| (at, prefix)))
			.min_by_key(|(at, _)| *at);
		let Some((at, prefix)) = next else {
			break;
		};
		out.push_str(&rest[..at]);
		let marker = &rest[at..];
		let digits_start = prefix.len();
		let digits_len = marker[digits_start..]
			.bytes()
			.take_while(u8::is_ascii_digit)
			.count();
		let digits_end = digits_start + digits_len;
		let valid = digits_len > 0
			&& marker.as_bytes().get(digits_start) != Some(&b'0')
			&& marker[digits_end..]
				.find(['\n', ']'])
				.is_some_and(|end| marker.as_bytes().get(digits_end + end) == Some(&b']'));
		if !valid {
			out.push_str(prefix);
			rest = &marker[prefix.len()..];
			continue;
		}
		let close = digits_end
			+ marker[digits_end..]
				.find(']')
				.expect("validated marker has a closing bracket");
		let Some(old) = marker[digits_start..digits_end].parse::<usize>().ok() else {
			out.push_str(&marker[..=close]);
			rest = &marker[close + 1..];
			continue;
		};
		let Some(new) = mapped(old) else {
			out.push_str(&marker[..=close]);
			rest = &marker[close + 1..];
			continue;
		};
		out.push_str(prefix);
		let _ = write!(out, "{new}");
		out.push_str(&marker[digits_end..=close]);
		rest = &marker[close + 1..];
		if let Some(link) = rest.strip_prefix(LEGACY) {
			let link_digits = link.bytes().take_while(u8::is_ascii_digit).count();
			let link_is_exact = link_digits > 0
				&& link[..link_digits].parse::<usize>().ok() == Some(old)
				&& !link
					.as_bytes()
					.get(link_digits)
					.is_some_and(u8::is_ascii_digit);
			if link_is_exact {
				out.push_str(LEGACY);
				let _ = write!(out, "{new}");
				rest = &link[link_digits..];
			}
		}
	}
	out.push_str(rest);
	out
}

/// `QUEUE_PREFIXES`: the yield-queue shorthand sigils.
const QUEUE_PREFIXES: [&str; 2] = ["->", "=>"];

/// `parseQueueShorthand`: the message body behind a leading `->` / `=>`
/// on the trimmed draft, `None` when the draft carries no shorthand.
#[must_use]
pub fn parse_queue_shorthand(text: &str) -> Option<&str> {
	let text = text.trim();
	QUEUE_PREFIXES
		.iter()
		.find_map(|prefix| text.strip_prefix(prefix))
		.map(str::trim)
}

/// Context carried by the terminal input batch that produced a paste.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct PasteOptions {
	/// A submit key followed the bracketed paste in the same terminal read.
	///
	/// The paste must land synchronously instead of opening a modal that
	/// would consume that key ( `PasteOptions.submitAfterPaste`).
	pub submit_after_paste: bool,
}

/// What [`Composer::paste`] did with the text.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PasteOutcome {
	/// The editor took the paste (inline, or collapsed to a chip).
	Inserted,
	/// A marker-sized paste of `lines` lines reached
	/// `cl_paste_large_menu_threshold`: nothing was inserted and the host
	/// presents the large-paste menu ( `handleLargePaste`).
	Menu {
		/// Line count of the paste, for the menu title.
		lines: usize,
	},
}

/// Composer knobs mirrored from convars ( editor preferences).
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ComposerSettings {
	/// `autocompleteMaxVisible`: dropdown window rows.
	pub autocomplete_max_visible: i64,
	/// `emojiAutocomplete`: `:shortcode:` dropdown and emoticon expansion.
	pub emoji_autocomplete:       bool,
	/// `paste.largeMenuThreshold`: line count at which a marker-sized
	/// paste opens the large-paste menu; `<= 0` disables the menu.
	pub paste_large_menu_lines:   i64,
}

impl Default for ComposerSettings {
	fn default() -> Self {
		Self {
			autocomplete_max_visible: 10,
			emoji_autocomplete:       true,
			paste_large_menu_lines:   100,
		}
	}
}

/// `shouldSkipHistory`: whether a submitted line is kept out of Up/Down
/// recall.
///
/// A `/login`, `/join`, or `/mcp add --token` line carries a secret (OAuth
/// callback, room key, bearer token). The command name is split exactly
/// like  `parseSlashCommand`: at the earliest whitespace or colon.
#[must_use]
pub fn should_skip_history(text: &str) -> bool {
	let Some(body) = text.strip_prefix('/') else {
		return false;
	};
	let separator = body
		.char_indices()
		.find(|(_, character)| character.is_whitespace() || *character == ':');
	let (name, args) = match separator {
		Some((at, character)) => (&body[..at], Some(body[at + character.len_utf8()..].trim())),
		None => (body, None),
	};
	match name {
		"login" | "join" => args.is_some(),
		"mcp" => args.is_some_and(|args| {
			args.starts_with("add")
				&& args.split_once("--token").is_some_and(|(_, rest)| {
					rest.starts_with(char::is_whitespace) || rest.starts_with('=')
				})
		}),
		_ => false,
	}
}

/// Composer prefix mode: the leading sigil recolors the chrome and Esc
/// clears the draft instead of interrupting ( rung 8).
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PrefixMode {
	/// `!` — shell command.
	Bash,
	/// `$` — eval expression.
	Eval,
}

/// One submitted prefix-mode line: what to run locally and whether the
/// model may see it ( `!!` / `$$` `excludeFromContext`).
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LocalInput {
	/// Which executor the sigil selects.
	pub mode:    PrefixMode,
	/// The command or code after the sigil, trimmed.
	pub code:    Str,
	/// Keep the run out of the model's context.
	pub exclude: bool,
}

/// Selector opened by a completed empty-composer double-Esc gesture.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DoubleEscapeTarget {
	/// The transcript rewind selector ( `doubleEscapeAction=rewind`).
	Rewind,
	/// The session tree selector ( `doubleEscapeAction=tree`).
	Tree,
}

/// Composer-local outcome of one rung in  Esc ladder.
///
/// Host-owned rungs (maintenance, speech, loop mode, collaboration, and
/// running work) stay outside the composer. The host executes them in order,
/// then uses this result to perform only the requested global transition.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ComposerEscape {
	/// The autocomplete popup consumed Esc and was dismissed.
	DismissedCompletion,
	/// A focused-session draft was cleared.
	ClearedFocusedDraft,
	/// The focused session has an empty composer and should be unfocused.
	UnfocusSession,
	/// An idle `!` / `$` prefix draft was cleared.
	ClearedPrefix,
	/// A non-empty prose draft was preserved.
	PreservedDraft,
	/// The first empty-composer Esc armed the timing window.
	Armed,
	/// The second empty-composer Esc completed the gesture.
	Open(DoubleEscapeTarget),
	/// This local rung did not consume Esc.
	NotHandled,
}

const DOUBLE_ESCAPE_WINDOW: Duration = Duration::from_millis(500);

/// `pythonCommandPrefixLength`: `$` / `$$` starts eval mode only when
/// followed by whitespace or the end of input, so `$HOME is set` and `${x}`
/// stay prose.
fn eval_prefix_len(trimmed: &str) -> usize {
	let bytes = trimmed.as_bytes();
	if bytes.first() != Some(&b'$') || bytes.get(1) == Some(&b'{') {
		return 0;
	}
	let prefix = if bytes.get(1) == Some(&b'$') { 2 } else { 1 };
	match bytes.get(prefix) {
		None => prefix,
		Some(b' ' | b'\t' | b'\n' | b'\r') => prefix,
		Some(_) => 0,
	}
}

/// Commands a pasted shell prompt typically starts with (
/// `SHELL_PROMPT_COMMAND_RE`, minus the path forms handled inline).
const SHELL_PROMPT_COMMANDS: &[&str] = &[
	"cd", "sudo", "git", "bun", "npm", "pnpm", "yarn", "node", "cargo", "go", "make", "docker",
	"kubectl",
];

/// Whether `word` is a shell-prompt command: one of [`SHELL_PROMPT_COMMANDS`]
/// or `python` with an optional version suffix (`python`, `python3`,
/// `python3.12` is not:  `python\d*` stops at the digits).
fn is_shell_prompt_command(word: &str) -> bool {
	SHELL_PROMPT_COMMANDS.contains(&word)
		|| word
			.strip_prefix("python")
			.is_some_and(|rest| rest.bytes().all(|byte| byte.is_ascii_digit()))
}

/// Whether `token` is a shell operator standing alone between whitespace
/// ( `SHELL_PROMPT_OPERATOR_RE`: `&&`, `||`, `|`, `2>&1`, and one or two
/// redirection chevrons).
fn is_shell_operator(token: &str) -> bool {
	matches!(token, "&&" | "||" | "|" | "2>&1")
		|| ((1..=2).contains(&token.len()) && token.bytes().all(|byte| matches!(byte, b'<' | b'>')))
}

/// Whether `line` is omp's own status line (`in: 12 out: 34 [cache …] t: …
/// tok/s: …`), the tell of a pasted transcript.
fn is_status_line(line: &str) -> bool {
	fn number(word: &str) -> bool {
		!word.is_empty() && word.bytes().all(|byte| byte.is_ascii_digit())
	}
	let mut words = line.split_ascii_whitespace();
	if words.next() != Some("in:") || !words.next().is_some_and(number) {
		return false;
	}
	if words.next() != Some("out:") || !words.next().is_some_and(number) {
		return false;
	}
	let mut next = words.next();
	if next == Some("cache") {
		if words.next().is_none() {
			return false;
		}
		next = words.next();
	}
	next == Some("t:")
		&& words.next().is_some()
		&& words.next() == Some("tok/s:")
		&& words.next().is_some()
}

/// `looksLikePastedShellPrompt`: a single-`$` body shaped like a copied
/// terminal line (`$ cd ~/project && cargo test`, `$ git status`) stays an
/// ordinary prompt instead of being run as Python.
#[must_use]
pub fn looks_like_pasted_shell_prompt(code: &str) -> bool {
	let first = code.split('\n').next().unwrap_or_default().trim_start();
	let starts_like_path = first.starts_with('/')
		|| first.starts_with("./")
		|| first.starts_with("../")
		|| first.starts_with("~/");
	let head = first
		.split(|c: char| c.is_whitespace())
		.next()
		.unwrap_or_default();
	starts_like_path
		|| is_shell_prompt_command(head)
		|| first.split_whitespace().any(is_shell_operator)
		|| code.lines().any(is_status_line)
}

/// Splits a draft into its sigil and body ( `parsePythonCommandInput`
/// plus the `!` branch of `handleSubmit`): the mode, the prefix length, and
/// the trimmed code. `None` is prose.
fn split_local(text: &str) -> Option<(PrefixMode, usize, &str)> {
	let trimmed = text.trim_start();
	let (mode, prefix) = if trimmed.starts_with('!') {
		(PrefixMode::Bash, if trimmed.starts_with("!!") { 2 } else { 1 })
	} else {
		match eval_prefix_len(trimmed) {
			0 => return None,
			len => (PrefixMode::Eval, len),
		}
	};
	let code = trimmed[prefix..].trim();
	if mode == PrefixMode::Eval && prefix == 1 && looks_like_pasted_shell_prompt(code) {
		return None;
	}
	Some((mode, prefix, code))
}

/// Classifies a draft's leading sigil ( `isBashMode` / `isPythonMode`);
/// a pasted shell prompt behind a single `$` is prose.
#[must_use]
pub fn prefix_mode_of(text: &str) -> Option<PrefixMode> {
	split_local(text).map(|(mode, ..)| mode)
}

/// The editor chrome accent for a draft: the same grammar as
/// [`prefix_mode_of`], so `$HOME is set`, `${x}`, and a pasted `$ git
/// status` never paint eval mode.
fn prefix_accent_of(text: &str) -> Option<PrefixAccent> {
	prefix_mode_of(text).map(|mode| match mode {
		PrefixMode::Bash => PrefixAccent::Bash,
		PrefixMode::Eval => PrefixAccent::Eval,
	})
}

/// Dims the leading `->` / `=>` of a yield-queue shorthand draft (
/// `QUEUE_LIST_MARKER_RE` editor highlighting).
fn queue_shorthand_spans(text: &str) -> smallvec::SmallVec<(usize, usize, InlineAccent), 4> {
	let mut spans = smallvec::SmallVec::new();
	let start = text.len() - text.trim_start().len();
	if let Some(prefix) = QUEUE_PREFIXES
		.iter()
		.find(|prefix| text[start..].starts_with(*prefix))
	{
		spans.push((start, start + prefix.len(), InlineAccent::Dim));
	}
	spans
}

/// Parses a submitted line into a local run ( `input-controller.ts`
/// `handleSubmit`: `!cmd`, `!!cmd`, `$ code`, `$$ code`). `None` is an
/// ordinary prompt, including a bare sigil with nothing to run and a
/// single-`$` line that [`looks_like_pasted_shell_prompt`].
#[must_use]
pub fn parse_local_input(text: &str) -> Option<LocalInput> {
	let (mode, prefix, code) = split_local(text)?;
	if code.is_empty() {
		return None;
	}
	Some(LocalInput { mode, code: Str::new(code), exclude: prefix == 2 })
}

/// Max gap between two spaces for the later one to count as OS auto-repeat
/// ( `SPACE_REPEAT_MAX_GAP_MS`).
pub const SPACE_REPEAT_MAX_GAP: Duration = Duration::from_millis(120);
/// Absolute jitter floor between two mechanical gaps (
/// `SPACE_REPEAT_JITTER_MS`).
pub const SPACE_REPEAT_JITTER: Duration = Duration::from_millis(18);
/// Proportional jitter tolerance for slower repeat rates (
/// `SPACE_REPEAT_JITTER_RATIO`).
pub const SPACE_REPEAT_JITTER_RATIO: f64 = 0.35;
/// Consecutive mechanical gaps that confirm a held bar (
/// `SPACE_HOLD_MECHANICAL_RUN`).
pub const SPACE_HOLD_MECHANICAL_RUN: u8 = 2;
/// Idle gap after the last repeated space that counts as release (
/// `SPACE_HOLD_RELEASE_MS`).
pub const SPACE_HOLD_RELEASE: Duration = Duration::from_millis(250);

/// What the space-hold detector decided about one key.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SpaceHoldEvent {
	/// Not part of a hold: the key reaches the editor as usual.
	Pass,
	/// A repeat inside a recognized hold (or a pre-burst space already
	/// typed): swallowed.
	Swallow,
	/// The bar is held: delete `track_back` pre-burst spaces and start
	/// recording.
	Begin {
		/// Spaces already inserted before the cadence was recognized.
		track_back: usize,
	},
	/// A non-space key arrived during a hold: stop recording, then let the
	/// key through.
	EndThenPass,
}

/// `#handleSpaceHold`: recognizes a held space bar from the metronomic
/// OS auto-repeat cadence, never from taps or smashing.
#[derive(Clone, Copy, Debug, Default)]
pub struct SpaceHold {
	active:         bool,
	last_space:     Option<Duration>,
	prev_gap:       Option<Duration>,
	mechanical_run: u8,
	inserted:       usize,
}

/// Whether two consecutive inter-space gaps look machine-driven.
fn gaps_are_mechanical(gap: Duration, prev: Duration) -> bool {
	if gap > SPACE_REPEAT_MAX_GAP || prev > SPACE_REPEAT_MAX_GAP {
		return false;
	}
	let smaller = gap.min(prev).as_secs_f64() * SPACE_REPEAT_JITTER_RATIO;
	let tolerance = SPACE_REPEAT_JITTER.as_secs_f64().max(smaller);
	(gap.as_secs_f64() - prev.as_secs_f64()).abs() <= tolerance
}

impl SpaceHold {
	/// Whether a recording is in progress.
	#[must_use]
	pub const fn active(&self) -> bool {
		self.active
	}

	/// Observes one key at `now`. `enabled` gates recognition (the setting
	/// and the autocomplete popup); a hold already in progress still ends.
	pub fn observe(&mut self, key: Key, now: Duration, enabled: bool) -> SpaceHoldEvent {
		let is_space = matches!(key, Key::Space | Key::Char(' '));
		if self.active {
			if is_space {
				self.last_space = Some(now);
				return SpaceHoldEvent::Swallow;
			}
			self.end();
			return SpaceHoldEvent::EndThenPass;
		}
		if !is_space {
			self.reset_run();
			return SpaceHoldEvent::Pass;
		}
		if !enabled {
			return SpaceHoldEvent::Pass;
		}
		let gap = self.last_space.map(|last| now.saturating_sub(last));
		let prev = self.prev_gap;
		self.last_space = Some(now);
		self.prev_gap = gap;
		let mechanical = match (gap, prev) {
			(Some(gap), Some(prev)) => gaps_are_mechanical(gap, prev),
			_ => false,
		};
		if !mechanical {
			// First space, a deliberate tap, or jittery smashing: a real space.
			self.mechanical_run = 0;
			self.inserted += 1;
			return SpaceHoldEvent::Pass;
		}
		self.mechanical_run += 1;
		if self.mechanical_run >= SPACE_HOLD_MECHANICAL_RUN {
			let track_back = self.inserted;
			self.reset_run();
			self.active = true;
			self.last_space = Some(now);
			return SpaceHoldEvent::Begin { track_back };
		}
		SpaceHoldEvent::Swallow
	}

	/// Whether the release idle gap elapsed at `now`; ends the hold when so.
	pub fn release_due(&mut self, now: Duration) -> bool {
		let due = self.active
			&& self
				.last_space
				.is_some_and(|last| now.saturating_sub(last) >= SPACE_HOLD_RELEASE);
		if due {
			self.end();
		}
		due
	}

	/// Host-clock deadline for the release check.
	#[must_use]
	pub fn next_wake(&self) -> Option<Duration> {
		self.active.then_some(self.last_space? + SPACE_HOLD_RELEASE)
	}

	/// Ends a hold unconditionally (toggle, interrupt).
	pub fn end(&mut self) {
		self.active = false;
		self.reset_run();
	}

	fn reset_run(&mut self) {
		self.inserted = 0;
		self.mechanical_run = 0;
		self.prev_gap = None;
		self.last_space = None;
	}
}

/// Retained composer chrome: status band plus the borderless editor.
///
/// The hardware caret is the editor's insertion point; the host places the
/// terminal cursor from [`Composer::frame`].
pub struct Composer {
	ui:          Ui,
	width:       u16,
	/// Active chrome shape: the band at rest, the rail while the plan
	/// Director is engaged.
	shape:       ComposerStyle,
	/// Whether the host paints a status/notice row directly above the
	/// composer (drives  `EditorTopGap`).
	occupied:    bool,
	/// IME-safe caret-row layout (`cl_ime_safe_cursor`).
	ime_safe:    bool,
	/// Native spelling gates applied to the editor (`cl_spelling_*`).
	spelling:    SpellingFeatures,
	/// Dropdown, emoji, and large-paste knobs (`cl_autocomplete_max_visible`,
	/// `cl_emoji_autocomplete`, `cl_paste_large_menu_threshold`).
	settings:    ComposerSettings,
	/// Prompt action accepted from the `#` menu, applied after the key.
	pending:     Rc<Cell<Option<PromptAction>>>,
	/// First empty-composer Esc, measured on the host's monotonic clock.
	last_escape: Option<Duration>,
}

impl Composer {
	/// Creates a focused composer at `width` for the launch facts, with the
	/// slash `roster`, `scheme://` completion from `urls`, and `@` file
	/// completion under `project_root`.
	#[must_use]
	pub fn new(
		width: u16,
		ctx: UiContext,
		facts: StatusFacts,
		roster: Vec<Command>,
		urls: UrlCompleter,
		project_root: Option<&Path>,
	) -> Self {
		let actions = PromptActions::new();
		let pending = actions.slot();
		let chain = composer_chain(roster, actions, urls, project_root);
		let shape = ComposerStyle::Borderless;
		let mut ui = composer_ui(facts, shape, width, ctx);
		ui.with_component_mut::<EditorPane, _>(COMPOSER_ID, |pane| {
			pane.set_completion(Box::new(chain));
			// The chrome recolors on the composer's own sigil grammar, not
			// on a bare leading byte ( `isPythonMode` after
			// `pythonCommandPrefixLength` + the pasted-shell-prompt guard).
			pane.set_prefix_classifier(prefix_accent_of);
			pane.set_inline_decorator(Some(Box::new(queue_shorthand_spans)));
		});
		ui.focus_first();
		Self {
			ui,
			width,
			shape,
			occupied: false,
			ime_safe: false,
			spelling: SpellingFeatures::default(),
			settings: ComposerSettings::default(),
			pending,
			last_escape: None,
		}
	}

	/// Applies the dropdown/emoji/large-paste knobs; returns whether they
	/// changed.
	pub fn set_settings(&mut self, settings: ComposerSettings) -> bool {
		if self.settings == settings {
			return false;
		}
		self.settings = settings;
		self.ui.update_component::<EditorPane>(COMPOSER_ID, |pane| {
			let options = pane.editor_options();
			pane.set_editor_options(EditorOptions {
				emoji: settings.emoji_autocomplete,
				picker_rows: usize::try_from(settings.autocomplete_max_visible).unwrap_or(0),
				..options
			});
			true
		});
		true
	}

	/// The dropdown/emoji/large-paste knobs currently applied.
	#[must_use]
	pub const fn settings(&self) -> ComposerSettings {
		self.settings
	}

	/// The editor's chrome accent for the current draft (`None` is prose).
	#[must_use]
	pub fn prefix_accent(&self) -> Option<PrefixAccent> {
		self
			.ui
			.with_component::<EditorPane, _>(COMPOSER_ID, EditorPane::prefix_accent)
			.flatten()
	}

	/// Tells the composer whether a status/notice row is painted directly
	/// above it ( `statusRowOccupied`); the band then sits flush under it.
	/// Returns whether the top gap changed.
	pub fn set_status_row_occupied(&mut self, occupied: bool) -> bool {
		if self.occupied == occupied {
			return false;
		}
		self.occupied = occupied;
		self.sync_gap()
	}

	/// Applies the native spelling gates (`cl_spelling_*`); returns whether
	/// they changed.
	pub fn set_spelling_features(&mut self, features: SpellingFeatures) -> bool {
		if self.spelling == features {
			return false;
		}
		self.spelling = features;
		self.ui.update_component::<EditorPane>(COMPOSER_ID, |pane| {
			pane.set_spelling_features(features);
			true
		});
		true
	}

	/// Native spelling gates currently applied to the editor.
	#[must_use]
	pub const fn spelling_features(&self) -> SpellingFeatures {
		self.spelling
	}

	/// Seeds Up/Down prompt recall with `prompts`, newest first (
	/// `setHistoryStorage` on a resumed session).
	pub fn seed_history(&mut self, prompts: impl IntoIterator<Item = Str>) {
		self
			.ui
			.with_component_mut::<EditorPane, _>(COMPOSER_ID, |pane| pane.seed_history(prompts));
	}

	/// Toggles  IME-safe cursor layout (`cl_ime_safe_cursor`); returns
	/// whether it changed.
	pub fn set_ime_safe_cursor(&mut self, enabled: bool) -> bool {
		if self.ime_safe == enabled {
			return false;
		}
		self.ime_safe = enabled;
		self.ui.update_component::<EditorPane>(COMPOSER_ID, |pane| {
			pane.set_ime_safe_cursor(enabled);
			true
		});
		true
	}

	/// Active chrome shape.
	#[must_use]
	pub const fn shape(&self) -> ComposerStyle {
		self.shape
	}

	/// Switches the chrome shape, re-evaluating the top gap (
	/// `syncComposerShape` + `EditorTopGap`); returns whether it changed.
	pub fn set_shape(&mut self, shape: ComposerStyle) -> bool {
		if self.shape == shape {
			return false;
		}
		self.shape = shape;
		self.ui.update_component::<EditorPane>(COMPOSER_ID, |pane| {
			pane.set_composer_style(shape);
			true
		});
		self.sync_gap();
		true
	}

	/// The plan Director engaged (or exited): the composer wears the rail
	/// shape while planning and the band otherwise.
	pub fn set_plan_mode(&mut self, engaged: bool) -> bool {
		self.set_shape(if engaged {
			ComposerStyle::Rail
		} else {
			ComposerStyle::Borderless
		})
	}

	fn sync_gap(&mut self) -> bool {
		let shown = top_gap_shown(self.shape, self.occupied);
		let before = self.ui.height();
		self.ui.set_visible(GAP_ID, shown);
		self.ui.height() != before
	}

	/// Whether the completion dropdown is open ( routes `Esc` to it before
	/// any global interrupt).
	#[must_use]
	pub fn popup_open(&self) -> bool {
		self
			.ui
			.with_component::<EditorPane, _>(COMPOSER_ID, EditorPane::popup_open)
			.unwrap_or(false)
	}

	/// Gives Esc to autocomplete before the host starts the global ladder.
	///
	/// The editor's base handler dismisses autocomplete:
	/// the same Esc must never also cancel maintenance or a streaming turn.
	pub fn dismiss_completion_on_escape(&mut self) -> ComposerEscape {
		if !self.popup_open() {
			return ComposerEscape::NotHandled;
		}
		let _ = self.ui.handle_key_claimed(Key::Esc);
		ComposerEscape::DismissedCompletion
	}

	/// Applies the focused-session composer rung.
	///
	/// A focused subagent is never interrupted by Esc. Typed text is cleared;
	/// an already-empty composer asks the host to return to the main session.
	pub fn escape_focused(&mut self) -> ComposerEscape {
		if self.draft_blank() {
			ComposerEscape::UnfocusSession
		} else {
			self.clear();
			ComposerEscape::ClearedFocusedDraft
		}
	}

	/// Clears an idle local-command prefix draft.
	///
	/// The caller must check a running local command first and interrupt that
	/// execution through its typed cancellation path. Only  real prefix
	/// grammar is cleared here: prose such as `$HOME` remains a draft.
	pub fn clear_prefix_on_escape(&mut self) -> ComposerEscape {
		if self.prefix_mode().is_none() {
			return ComposerEscape::NotHandled;
		}
		self.clear();
		ComposerEscape::ClearedPrefix
	}

	/// Applies the final draft/double-Esc rungs after every host-owned rung.
	///
	/// `now` comes from the host's monotonic clock. A draft is never erased;
	/// pressing Esc over one only disarms a prior empty-composer tap.
	pub fn escape_draft(
		&mut self,
		now: Duration,
		target: Option<DoubleEscapeTarget>,
	) -> ComposerEscape {
		if !self.draft_blank() {
			self.last_escape = None;
			return ComposerEscape::PreservedDraft;
		}
		let Some(target) = target else {
			return ComposerEscape::NotHandled;
		};
		let doubled = self
			.last_escape
			.and_then(|prior| now.checked_sub(prior))
			.is_some_and(|elapsed| elapsed < DOUBLE_ESCAPE_WINDOW);
		if doubled {
			self.last_escape = None;
			ComposerEscape::Open(target)
		} else {
			self.last_escape = Some(now);
			ComposerEscape::Armed
		}
	}

	/// Disarms a pending empty-composer double-Esc gesture.
	///
	/// Speech cancellation and focus changes reset the
	/// gesture at those transitions.
	pub fn reset_escape_sequence(&mut self) {
		self.last_escape = None;
	}

	/// Whether the visible draft is blank, without materializing the
	/// attachment-expanded submission value.
	#[must_use]
	pub fn draft_blank(&self) -> bool {
		self
			.ui
			.with_component::<EditorPane, _>(COMPOSER_ID, |pane| {
				pane.displayed_text().trim().is_empty()
			})
			.unwrap_or(true)
	}

	/// Replaces the draft, leaving the caret at its end.
	pub fn set_text(&mut self, text: &str) {
		self.ui.set_text(COMPOSER_ID, text);
		self.ui.resize(self.width);
	}

	/// Clears the draft.
	pub fn clear(&mut self) {
		self.set_text("");
	}

	/// Current unsent draft in its submitted form: every collapsed paste or
	/// attachment chip is expanded to its full text ( expands `[Paste #N]`
	/// markers before handing the draft to `$EDITOR` or the model).
	#[must_use]
	pub fn text(&self) -> String {
		self
			.ui
			.values()
			.get(COMPOSER_ID)
			.and_then(serde_json::Value::as_str)
			.map(str::to_owned)
			.unwrap_or_default()
	}

	/// Draft as displayed: chips stay collapsed to their `<icon> #N` markers.
	#[must_use]
	pub fn text_displayed(&self) -> String {
		self
			.ui
			.with_component::<EditorPane, _>(COMPOSER_ID, |pane| pane.displayed_text().to_owned())
			.unwrap_or_default()
	}

	/// Replaces the draft with text edited outside the composer (
	/// `handleExternalEditor`): the chips were expanded into `text`, so the
	/// staged attachment cards are dropped rather than re-collapsed, and the
	/// edited text lands verbatim with the caret at its end.
	pub fn replace_edited(&mut self, text: &str) {
		self
			.ui
			.with_component_mut::<EditorPane, _>(COMPOSER_ID, |pane| pane.attachments().take());
		self.set_text(text);
	}

	/// Rendered chrome, including the caret.
	#[must_use]
	pub const fn frame(&self) -> &Frame {
		self.ui.frame()
	}

	/// Chrome height in rows at the current width.
	#[must_use]
	pub const fn height(&self) -> u16 {
		self.ui.height()
	}

	/// Inserts sanitized pasted text at the caret, unless the paste is
	/// marker-sized and reaches `cl_paste_large_menu_threshold` lines: then
	/// nothing is inserted and the host shows the large-paste menu (
	/// `handleLargePaste`), which lands the text through
	/// [`Composer::paste_chip`] once the user chooses.
	pub fn paste(&mut self, text: &str) -> PasteOutcome {
		self.paste_with_options(text, PasteOptions::default())
	}

	/// Applies a paste with terminal-batch context.
	///
	/// When the same read already carries Submit, the normal collapsed chip
	/// lands synchronously. Opening the menu would hand that Submit to the
	/// selector and leave the composer idle.
	pub fn paste_with_options(&mut self, text: &str, options: PasteOptions) -> PasteOutcome {
		let threshold = usize::try_from(self.settings.paste_large_menu_lines).unwrap_or(0);
		if !options.submit_after_paste && threshold > 0 && marker_sized_paste(text) {
			let lines = text.split('\n').count();
			if lines >= threshold {
				return PasteOutcome::Menu { lines };
			}
		}
		let _ = self.ui.handle_paste(text);
		PasteOutcome::Inserted
	}

	/// Stages pasted text as an attachment chip ( `insertTextAttachment`):
	/// the buffer holds a compact token and the submitted form is
	/// `expansion` (default: the text itself). The large-paste menu's
	/// "wrapped block" choice passes the `<attachment>`-wrapped text.
	pub fn paste_chip(&mut self, text: &str, expansion: Option<&str>) {
		let charset = self.ui.context().charset;
		self
			.ui
			.with_component_mut::<EditorPane, _>(COMPOSER_ID, |pane| {
				pane.stage_text_attachment(text, expansion, charset)
			});
		self.ui.resize(self.width);
	}

	/// Inserts `text` at the caret verbatim as ordinary draft text (a
	/// `local://paste-N.md` reference from the large-paste menu).
	pub fn insert_text(&mut self, text: &str) {
		let _ = self.ui.handle_paste_raw(text);
	}

	/// Shows or replaces the streaming recognizer's volatile preview at the
	/// current caret without adding undo entries.
	pub fn set_volatile_text(&mut self, text: &str) {
		self
			.ui
			.with_component_mut::<EditorPane, _>(COMPOSER_ID, |pane| pane.set_volatile_text(text));
		self.ui.resize(self.width);
	}

	/// Shows or replaces native-IME marked text and its byte-indexed
	/// selection without adding an undo entry.
	pub fn set_volatile_text_selection(&mut self, text: &str, selection: Option<Range<usize>>) {
		self
			.ui
			.with_component_mut::<EditorPane, _>(COMPOSER_ID, |pane| {
				pane.set_volatile_text_selection(text, selection)
			});
		self.ui.resize(self.width);
	}

	/// Discards the streaming recognizer's current volatile preview.
	pub fn clear_volatile_text(&mut self) {
		self
			.ui
			.with_component_mut::<EditorPane, _>(COMPOSER_ID, EditorPane::clear_volatile_text);
		self.ui.resize(self.width);
	}

	/// Commits one finalized recognition segment exactly once at the caret.
	pub fn commit_volatile_text(&mut self, text: &str) {
		self
			.ui
			.with_component_mut::<EditorPane, _>(COMPOSER_ID, |pane| pane.commit_volatile_text(text));
		self.ui.resize(self.width);
	}

	/// Inserts pasted text verbatim ( `app.clipboard.pasteTextRaw`): no
	/// chip collapse, no drop classification, newlines kept.
	pub fn paste_raw(&mut self, text: &str) {
		let _ = self.ui.handle_paste_raw(text);
	}

	/// Whether the draft is in a `!` (bash) or `$` (eval) prefix mode (
	/// `isBashMode` / `isPythonMode`).
	#[must_use]
	pub fn prefix_mode(&self) -> Option<PrefixMode> {
		self
			.ui
			.with_component::<EditorPane, _>(COMPOSER_ID, |pane| prefix_mode_of(pane.displayed_text()))
			.flatten()
	}

	/// Current composer line, for `cl_copy_line`.
	#[must_use]
	pub fn current_line(&self) -> Str {
		self
			.ui
			.with_component::<EditorPane, _>(COMPOSER_ID, |pane| Str::new(pane.current_line()))
			.unwrap_or_default()
	}

	/// Deletes `count` graphemes before the caret (space-hold track-back).
	pub fn delete_before_caret(&mut self, count: usize) {
		for _ in 0..count {
			let _ = self.ui.handle_key(Key::Backspace);
		}
	}

	/// Applies one terminal key, committing a submitted draft immediately.
	///
	/// Hosts that can refuse a submission use [`Composer::preview_key`]
	/// instead and call [`Composer::commit_submission`] only after accepting
	/// the returned action.
	pub fn key(&mut self, key: Key) -> ComposerAction {
		let action = self.preview_key(key);
		if matches!(
			&action,
			ComposerAction::Submit(_)
				| ComposerAction::SubmitWithMedia { .. }
				| ComposerAction::Command { .. }
				| ComposerAction::Queue { .. }
		) {
			let _ = self.commit_submission();
		}
		action
	}

	/// Applies one terminal key without clearing a submitted draft.
	///
	/// This is the refusal-safe host path: validation and dispatch happen
	/// against the returned action while the exact editor buffer, attachment
	/// atoms, caret, and media order remain intact.
	pub fn preview_key(&mut self, key: Key) -> ComposerAction {
		let (event, claimed) = self.ui.handle_key_claimed(key);
		if let Some(action) = self.pending.take() {
			return self.apply_prompt_action(action);
		}
		match event {
			UiEvent::Submit => self.preview_submission(),
			UiEvent::Copied(text) => ComposerAction::Copy(text),
			_ if claimed => ComposerAction::Changed,
			_ => ComposerAction::Ignored,
		}
	}

	/// Routes a pointer report in composer-frame coordinates. Completion
	/// rows accept on click, hover without moving keyboard selection, and
	/// wheel without wrapping; prompt actions run through the same slot as
	/// keyboard acceptance.
	pub fn mouse(&mut self, report: MouseReport) -> ComposerAction {
		let event = self
			.ui
			.handle_mouse_with_mods(report.col, report.row, report.kind, report.mods);
		if let Some(action) = self.pending.take() {
			return self.apply_prompt_action(action);
		}
		match event {
			UiEvent::Submit => self.preview_submission(),
			UiEvent::Copied(text) => ComposerAction::Copy(text),
			_ => ComposerAction::Changed,
		}
	}

	/// Reports whether text or attachment atoms currently form a submittable
	/// user draft. Interactive Goal continuation uses this observer-local fact
	/// to let typing win the idle boundary.
	#[must_use]
	pub fn has_pending_submission(&self) -> bool {
		self.prepared_submission().is_some()
	}

	/// Classifies the current draft without mutating it.
	///
	/// Collapsed text attachments are expanded, surviving media markers are
	/// compacted, and media sources retain composer order. The host may
	/// validate or refuse the action with no rollback work.
	#[must_use]
	pub fn preview_submission(&self) -> ComposerAction {
		self
			.prepared_submission()
			.map_or(ComposerAction::Ignored, |(_, action)| action)
	}

	/// Commits the current previewed submission.
	///
	/// Clears the editor and attachment band and records history. Returns
	/// `false` when there is no non-blank draft to commit.
	pub fn commit_submission(&mut self) -> bool {
		let Some((history, _)) = self.prepared_submission() else {
			return false;
		};
		self.commit_prepared_submission(&history);
		true
	}

	/// Submits the draft immediately.
	///
	/// This compatibility path is equivalent to
	/// [`Composer::preview_submission`] followed by
	/// [`Composer::commit_submission`]. Refusal-capable hosts use those two
	/// phases separately so cancellation restores the exact draft for free.
	pub fn take_submission(&mut self) -> ComposerAction {
		let Some((history, action)) = self.prepared_submission() else {
			return ComposerAction::Ignored;
		};
		self.commit_prepared_submission(&history);
		action
	}

	fn prepared_submission(&self) -> Option<(Str, ComposerAction)> {
		let text = self.text();
		if text.trim().is_empty() {
			return None;
		}
		let staged = self
			.ui
			.with_component::<EditorPane, _>(COMPOSER_ID, |pane| pane.attachments().snapshot())
			.unwrap_or_default();
		let (markers, media): (Vec<usize>, Vec<ComposerMediaSource>) = staged
			.into_iter()
			.filter_map(|attachment| {
				let kind_and_source = match attachment.content {
					AttachmentContent::Image { source, .. } => Some((ComposerMediaKind::Image, source)),
					AttachmentContent::Video { source } => Some((ComposerMediaKind::Video, source)),
					AttachmentContent::Text { .. } => None,
				};
				kind_and_source
					.map(|(kind, source)| (attachment.marker, ComposerMediaSource { kind, source }))
			})
			.unzip();
		let text = Str::from(compact_media_markers(&text, &markers));
		// `parseQueueShorthand` runs before slash commands: `-> body`
		// queues `body` for the next yield.
		let action = if let Some(body) = parse_queue_shorthand(&text) {
			ComposerAction::Queue { text: Str::new(body), media }
		} else {
			// A leading `/` line is a command, never a prompt.
			match text.trim_start().strip_prefix("/") {
				Some(command) if !command.starts_with('/') => {
					ComposerAction::Command { statement: Str::new(command.trim()), media }
				},
				_ if !media.is_empty() => ComposerAction::SubmitWithMedia { text: text.clone(), media },
				_ => ComposerAction::Submit(text.clone()),
			}
		};
		Some((text, action))
	}

	fn commit_prepared_submission(&mut self, history: &str) {
		self.ui.set_text(COMPOSER_ID, "");
		// Chips leave the band only after the host accepts the action.
		let staged = self
			.ui
			.with_component_mut::<EditorPane, _>(COMPOSER_ID, |pane| pane.attachments().take())
			.unwrap_or_default();
		if !staged.is_empty() {
			self.ui.resize(self.width);
		}
		if !should_skip_history(history.trim_start()) {
			self
				.ui
				.with_component_mut::<EditorPane, _>(COMPOSER_ID, |pane| pane.add_to_history(history));
		}
	}

	/// Runs an accepted `#` prompt action against the editor.
	fn apply_prompt_action(&mut self, action: PromptAction) -> ComposerAction {
		match action {
			PromptAction::CopyLine => {
				let line = self
					.ui
					.with_component::<EditorPane, _>(COMPOSER_ID, |pane| Str::new(pane.current_line()))
					.unwrap_or_default();
				ComposerAction::Copy(line)
			},
			PromptAction::CopyPrompt => ComposerAction::Copy(Str::new(self.text())),
			PromptAction::Undo { transient } => {
				self
					.ui
					.with_component_mut::<EditorPane, _>(COMPOSER_ID, |pane| {
						pane.undo_past_transient(&transient);
					});
				ComposerAction::Changed
			},
			PromptAction::MessageEnd | PromptAction::MessageStart => {
				let end = action == PromptAction::MessageEnd;
				self
					.ui
					.with_component_mut::<EditorPane, _>(COMPOSER_ID, |pane| {
						pane.move_to_message_edge(end);
					});
				ComposerAction::Changed
			},
			PromptAction::LineStart => {
				self.ui.handle_key(Key::Home);
				ComposerAction::Changed
			},
			PromptAction::LineEnd => {
				self.ui.handle_key(Key::End);
				ComposerAction::Changed
			},
		}
	}

	/// Reflows the chrome for a new terminal size: the editor grows with its
	/// content up to [`editor_max_rows`] of `height`.
	pub fn resize(&mut self, width: u16, height: u16) {
		self.width = width;
		let rows = editor_max_rows(height);
		self.ui.update_component::<EditorPane>(COMPOSER_ID, |pane| {
			pane.set_max_rows(rows);
			true
		});
		self.ui.resize(width);
	}

	/// Restores keyboard focus after the terminal or native surface is
	/// reconstructed. The retained editor buffer is not rebuilt, so its
	/// caret, selection, undo history, and attachment atoms survive.
	pub fn restore_focus(&mut self) {
		if self.ui.focused_id().as_deref() != Some(COMPOSER_ID) {
			let _ = self.ui.focus_id(COMPOSER_ID);
		}
	}

	/// Replaces the presentation context (theme, charset, terminal caps).
	pub fn set_context(&mut self, ctx: UiContext) {
		self.ui.set_context(ctx);
	}

	/// Updates the status band; returns whether it repainted.
	pub fn set_status(&mut self, facts: StatusFacts) -> bool {
		self
			.ui
			.update_component::<StatusBand>(STATUS_ID, |band| band.set_facts(facts))
	}

	/// Applies a retained status appearance, including settings previews.
	pub fn set_status_appearance(&mut self, appearance: StatusAppearance) -> bool {
		self
			.ui
			.update_component::<StatusBand>(STATUS_ID, |band| band.set_appearance(appearance))
	}

	/// Advances chrome animations (the working spinner).
	pub fn tick(&mut self, now: Duration) -> bool {
		self.ui.tick(now)
	}

	/// Next animation deadline, if any component asked to be woken.
	#[must_use]
	pub fn next_wake(&self) -> Option<Duration> {
		self.ui.next_wake()
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn facts() -> StatusFacts {
		StatusFacts {
			model: Str::new_static("Sonnet 4.5"),
			thinking: None,
			cwd: Str::new_static("~/proj"),
			scratch: false,
			branch: None,
			tokens: 0,
			context_window: Some(200_000),
			compact_percent: 80,
			working: None,
			..StatusFacts::default()
		}
	}

	fn no_urls() -> UrlCompleter {
		std::sync::Arc::new(|_scheme: &str, _query: &str| None)
	}

	fn composer() -> Composer {
		Composer::new(
			60,
			UiContext::default(),
			facts(),
			vec![Command::new("help", "Shows a name's description", &[])],
			no_urls(),
			None,
		)
	}

	fn type_text(composer: &mut Composer, text: &str) {
		for character in text.chars() {
			composer.key(Key::Char(character));
		}
	}

	fn rows(composer: &Composer) -> Vec<String> {
		omp_tui::frame_text(composer.frame())
			.lines()
			.map(|line| line.trim_end().to_owned())
			.collect()
	}

	#[test]
	fn typing_moves_the_caret_and_enter_submits_then_clears() {
		let mut composer = composer();
		let (column, row) = composer.frame().cursor().expect("caret placed at boot");
		assert_eq!((column, row), (3, 2));
		for character in "hi".chars() {
			assert_eq!(composer.key(Key::Char(character)), ComposerAction::Changed);
		}
		assert_eq!(composer.text(), "hi");
		assert_eq!(composer.frame().cursor(), Some((5, 2)));
		// `band` shape: `╰─ ` gutter at column 0, paddingX 0, no frame.
		assert_eq!(rows(&composer)[2], "╰─ hi");
		assert_eq!(composer.key(Key::Enter), ComposerAction::Submit(Str::new_static("hi")));
		assert_eq!(composer.text(), "");
		assert_eq!(composer.frame().cursor(), Some((3, 2)));
	}

	#[test]
	fn streaming_stt_replaces_volatile_text_and_commits_segments_at_the_caret() {
		let mut composer = composer();
		type_text(&mut composer, "note: tail");
		for _ in 0..4 {
			composer.key(Key::Left);
		}
		composer.set_volatile_text("hel");
		assert_eq!(composer.text(), "note: heltail");
		assert_eq!(composer.frame().cursor(), Some((12, 2)));

		composer.set_volatile_text("hello");
		assert_eq!(composer.text(), "note: hellotail");
		assert_eq!(composer.frame().cursor(), Some((14, 2)));

		composer.commit_volatile_text("hello");
		composer.set_volatile_text(" wor");
		assert_eq!(composer.text(), "note: hello wortail");
		composer.clear_volatile_text();
		assert_eq!(composer.text(), "note: hellotail");
		assert_eq!(composer.frame().cursor(), Some((14, 2)));
	}

	#[test]
	fn native_ime_preedit_tracks_its_byte_cursor_and_commits_once() {
		let mut composer = composer();
		composer.set_volatile_text_selection("a界b", Some(1..1));
		assert_eq!(composer.text(), "a界b");
		assert_eq!(
			composer.frame().cursor(),
			Some((4, 2)),
			"candidate area follows the IME's byte cursor inside marked text",
		);

		composer.set_volatile_text_selection("a界b", Some(1..4));
		assert_eq!(
			composer.frame().cursor(),
			Some((6, 2)),
			"a marked selection still anchors candidates at its trailing caret",
		);

		composer.set_volatile_text_selection("啊不", None);
		assert_eq!(composer.frame().cursor(), None, "None hides the marked-text caret");
		composer.commit_volatile_text("啊不");
		assert_eq!(composer.text(), "啊不", "commit replaces rather than duplicates preedit");
		assert_eq!(composer.frame().cursor(), Some((7, 2)));

		composer.clear();
		composer.set_volatile_text_selection("e\u{301}", Some(3..3));
		assert_eq!(composer.text(), "é", "native marked text follows the shared NFC input policy");
		assert_eq!(
			composer.frame().cursor(),
			Some((4, 2)),
			"pre-normalization byte offsets remain bounded by the retained span",
		);
	}

	#[test]
	fn volatile_stt_preserves_the_caret_and_adjacent_attachment_atom() {
		const PAYLOAD: &str = "line one\nline two";
		let mut composer = composer();
		composer.paste_chip(PAYLOAD, None);
		type_text(&mut composer, " tail");
		let displayed = composer.text_displayed();
		let expanded = composer.text();

		composer.key(Key::Home);
		let caret = composer.frame().cursor();
		composer.set_volatile_text("heard");
		assert!(composer.text_displayed().contains("#1"), "the preview must not tear the chip");
		composer.clear_volatile_text();
		assert_eq!(composer.text_displayed(), displayed);
		assert_eq!(composer.text(), expanded, "cancelling restores the atom-backed draft exactly");
		assert_eq!(composer.frame().cursor(), caret, "cancelling restores the insertion caret");

		composer.key(Key::End);
		for _ in 0..5 {
			composer.key(Key::Left);
		}
		composer.set_volatile_text("heard");
		composer.commit_volatile_text("heard");
		assert!(composer.text_displayed().contains("#1"), "committing must not flatten the chip");
		assert_eq!(composer.text().matches(PAYLOAD).count(), 1);
		assert!(composer.text().contains("heard tail"));
	}

	/// `addToHistory` + `navigateHistory`: every submission (prompt,
	/// `/command`, `!shell`) is recalled by Up on an empty draft; Down walks
	/// back to the draft the user was writing.
	#[test]
	fn submissions_are_recalled_by_up_and_down_on_the_draft_edges() {
		let mut composer = composer();
		composer.key(Key::Up);
		assert_eq!(composer.text(), "", "nothing to recall");
		type_text(&mut composer, "first prompt");
		assert!(matches!(composer.key(Key::Enter), ComposerAction::Submit(_)));
		type_text(&mut composer, "/help");
		assert!(matches!(composer.key(Key::Enter), ComposerAction::Command { .. }));
		type_text(&mut composer, "!ls");
		assert!(matches!(composer.key(Key::Enter), ComposerAction::Submit(_)));
		assert_eq!(composer.text(), "");
		assert_eq!(composer.key(Key::Up), ComposerAction::Changed);
		assert_eq!(composer.text(), "!ls");
		assert_eq!(composer.key(Key::Up), ComposerAction::Changed);
		assert_eq!(composer.text(), "/help");
		assert_eq!(composer.key(Key::Up), ComposerAction::Changed);
		assert_eq!(composer.text(), "first prompt");
		composer.key(Key::Up);
		assert_eq!(composer.text(), "first prompt", "oldest entry");
		composer.key(Key::End);
		composer.key(Key::Down);
		composer.key(Key::Down);
		assert_eq!(composer.key(Key::Down), ComposerAction::Changed);
		assert_eq!(composer.text(), "", "back to the empty draft");
		// A non-empty draft keeps Up for the host (transcript scrolling).
		type_text(&mut composer, "draft");
		composer.key(Key::Up);
		assert_eq!(composer.text(), "draft");
		// Recalling then submitting re-records without duplicates.
		composer.clear();
		composer.key(Key::Up);
		assert!(matches!(composer.key(Key::Enter), ComposerAction::Submit(_)));
		composer.key(Key::Up);
		assert_eq!(composer.text(), "!ls");
		composer.key(Key::Up);
		assert_eq!(composer.text(), "/help");
	}

	/// `shouldSkipHistory`: secret-bearing commands never enter recall.
	#[test]
	fn secret_bearing_commands_are_kept_out_of_history() {
		assert!(should_skip_history("/login https://x?code=abc&state=1"));
		assert!(should_skip_history("/login:?code=abc"));
		assert!(should_skip_history("/login\u{a0}secret"));
		assert!(should_skip_history("/join room-link"));
		assert!(should_skip_history("/mcp add --token abc srv"));
		assert!(should_skip_history("/mcp add srv --token=abc"));
		assert!(!should_skip_history("/login"));
		assert!(!should_skip_history("/mcp add srv"));
		assert!(!should_skip_history("/mcp list --tokens"));
		assert!(!should_skip_history("login secret"));
		let mut composer = composer();
		type_text(&mut composer, "/login secret-code");
		assert!(matches!(composer.key(Key::Enter), ComposerAction::Command { .. }));
		type_text(&mut composer, "safe");
		assert!(matches!(composer.key(Key::Enter), ComposerAction::Submit(_)));
		composer.key(Key::Up);
		assert_eq!(composer.text(), "safe");
		composer.key(Key::Up);
		assert_eq!(composer.text(), "safe", "the login line is absent");
	}

	/// `setHistoryStorage`: a resumed session seeds recall newest first.
	#[test]
	fn seeded_history_is_recalled_newest_first() {
		let mut composer = composer();
		composer.seed_history([Str::new_static("newest"), Str::new_static("older")]);
		assert_eq!(composer.key(Key::Up), ComposerAction::Changed);
		assert_eq!(composer.text(), "newest");
		assert_eq!(composer.key(Key::Up), ComposerAction::Changed);
		assert_eq!(composer.text(), "older");
	}

	/// A recalled multiline prompt remains focused and keeps its caret visible
	/// while terminal resize recomputes the editor's row budget.
	#[test]
	fn recalled_history_reflows_without_losing_navigation_or_caret() {
		let mut composer = composer();
		let recalled = (1..=20)
			.map(|line| format!("history line {line}"))
			.collect::<Vec<_>>()
			.join("\n");
		composer.seed_history([Str::new(recalled.clone())]);
		assert_eq!(composer.key(Key::Up), ComposerAction::Changed);
		assert_eq!(composer.text(), recalled);

		for (width, height) in [(32, 8), (80, 30), (24, 10)] {
			composer.resize(width, height);
			composer.restore_focus();
			let (x, y) = composer
				.frame()
				.cursor()
				.expect("recalled history keeps the caret");
			assert!(x < composer.frame().size().width);
			assert!(y < composer.frame().size().height);
			assert_eq!(composer.ui.focused_id().as_deref(), Some(COMPOSER_ID));
		}

		assert_eq!(composer.apply_prompt_action(PromptAction::MessageEnd), ComposerAction::Changed);
		assert_eq!(composer.key(Key::Down), ComposerAction::Changed);
		assert_eq!(composer.text(), "", "history navigation survives every reflow");
	}

	/// The `cl_spelling_*` convars reach the live editor.
	#[test]
	fn spelling_features_apply_to_the_editor_and_report_change() {
		let mut composer = composer();
		assert_eq!(composer.spelling_features(), SpellingFeatures::default());
		let off =
			SpellingFeatures { typo_detection: false, autocomplete: false, autocorrect: false };
		assert!(composer.set_spelling_features(off));
		assert!(!composer.set_spelling_features(off), "unchanged");
		assert_eq!(composer.spelling_features(), off);
		let pane = composer
			.ui
			.with_component::<EditorPane, _>(COMPOSER_ID, EditorPane::active_spelling_features)
			.expect("composer pane");
		assert_eq!(pane, off);
	}

	/// `useTerminalCursor`: the caret cell is never painted as a block;
	/// only the frame's hardware cursor moves.
	#[test]
	fn caret_cell_stays_unstyled_while_typing() {
		let mut composer = composer();
		for character in "hi".chars() {
			composer.key(Key::Char(character));
		}
		let frame = composer.frame();
		let (column, row) = frame.cursor().expect("caret placed");
		let theme = UiContext::default().theme;
		for x in 0..frame.size().width {
			assert_ne!(
				frame.cell(x, row).style().background_color(),
				theme.accent,
				"column {x} paints a software caret; hardware caret is at {column}"
			);
		}
	}

	#[test]
	fn slash_opens_the_command_popup_below_the_prompt_and_enter_runs_it() {
		let mut composer = composer();
		assert!(!composer.popup_open());
		assert_eq!(composer.key(Key::Char('/')), ComposerAction::Changed);
		assert!(composer.popup_open(), "slash opens the roster");
		let rows = rows(&composer);
		let prompt = rows
			.iter()
			.position(|row| row.starts_with("╰─ /"))
			.expect("prompt row");
		assert!(rows[prompt + 1].contains("help"), "{rows:?}");
		assert!(rows[prompt + 1].contains("Shows a name's description"), "{rows:?}");
		assert_eq!(composer.key(Key::Esc), ComposerAction::Changed);
		assert!(!composer.popup_open(), "esc closes the popup");
		for character in "help".chars() {
			composer.key(Key::Char(character));
		}
		assert_eq!(composer.key(Key::Enter), ComposerAction::Command {
			statement: Str::new_static("help"),
			media:     Vec::new(),
		});
		assert_eq!(composer.text(), "");
	}

	#[test]
	fn hash_menu_runs_prompt_actions_and_removes_the_trigger() {
		let mut composer = composer();
		for character in "hello world".chars() {
			composer.key(Key::Char(character));
		}
		composer.key(Key::Home);
		composer.key(Key::Char('#'));
		assert!(composer.popup_open(), "# opens prompt actions");
		let rows = rows(&composer);
		assert!(rows.iter().any(|row| row.contains("Copy current line")), "{rows:?}");
		// A space ends the `#query` token, so the query is one word.
		for character in "msgend".chars() {
			composer.key(Key::Char(character));
		}
		assert_eq!(composer.key(Key::Tab), ComposerAction::Changed);
		assert_eq!(composer.text(), "hello world", "the #query token is removed");
		assert_eq!(composer.frame().cursor(), Some((3 + 11, 2)), "caret moved to the message end");
		for character in " #copywhole".chars() {
			composer.key(Key::Char(character));
		}
		assert_eq!(
			composer.key(Key::Tab),
			ComposerAction::Copy(Str::new_static("hello world ")),
			"copy prompt reports the draft without the trigger"
		);
		assert_eq!(composer.text(), "hello world ");
	}

	#[test]
	fn at_lists_project_files_and_accepts_with_a_trailing_space() {
		let root = tempfile::tempdir().expect("scratch project");
		std::fs::write(root.path().join("note.txt"), "hi").expect("fixture");
		std::fs::create_dir(root.path().join("src")).expect("fixture dir");
		let mut composer =
			Composer::new(60, UiContext::default(), facts(), Vec::new(), no_urls(), Some(root.path()));
		composer.key(Key::Char('@'));
		let deadline = std::time::Instant::now() + Duration::from_secs(5);
		while !composer.popup_open() && std::time::Instant::now() < deadline {
			std::thread::sleep(Duration::from_millis(10));
			// The index lands asynchronously; a caret motion re-queries it.
			composer.key(Key::Left);
			composer.key(Key::Right);
		}
		assert!(composer.popup_open(), "@ lists the indexed project");
		for character in "no".chars() {
			composer.key(Key::Char(character));
		}
		assert_eq!(composer.key(Key::Tab), ComposerAction::Changed);
		assert_eq!(composer.text(), "@note.txt ");
	}

	#[test]
	fn colon_opens_the_builtin_emoji_popup() {
		let mut composer = composer();
		for character in ":joy".chars() {
			composer.key(Key::Char(character));
		}
		assert!(composer.popup_open(), "emoji dropdown");
		assert!(rows(&composer).iter().any(|row| row.contains("joy")));
	}

	#[test]
	fn set_text_and_clear_replace_the_draft_with_the_caret_at_the_end() {
		let mut composer = composer();
		composer.set_text("draft");
		assert_eq!(composer.text(), "draft");
		assert_eq!(composer.frame().cursor(), Some((8, 2)));
		composer.clear();
		assert_eq!(composer.text(), "");
		assert_eq!(composer.frame().cursor(), Some((3, 2)));
	}

	#[test]
	fn empty_enter_is_ignored_and_status_updates_repaint() {
		let mut composer = composer();
		assert!(!matches!(composer.key(Key::Enter), ComposerAction::Submit(_)));
		let working = Some(Duration::ZERO);
		assert!(composer.set_status(StatusFacts { working, ..facts() }));
		assert!(!composer.set_status(StatusFacts { working, ..facts() }));
		assert!(composer.next_wake().is_some(), "spinner schedules a wake");
	}

	/// Plan mode swaps the band for the rail and back; `EditorTopGap`
	/// keeps the one-row gap for the rail and collapses it for the band
	/// only while a status row is painted directly above.
	#[test]
	fn plan_mode_switches_the_shape_and_the_top_gap() {
		let mut composer = composer();
		for character in "hi".chars() {
			composer.key(Key::Char(character));
		}
		assert_eq!(composer.shape(), ComposerStyle::Borderless);
		assert_eq!(rows(&composer)[0], "", "band at rest keeps the gap row");
		assert_eq!(rows(&composer)[2], "╰─ hi");
		assert!(composer.set_status_row_occupied(true), "band under a notice: gap collapses");
		assert_eq!(rows(&composer)[1], "╰─ hi");
		assert!(!composer.set_status_row_occupied(true));

		assert!(composer.set_plan_mode(true));
		assert!(!composer.set_plan_mode(true), "already engaged");
		assert_eq!(composer.shape(), ComposerStyle::Rail);
		let railed = rows(&composer);
		assert_eq!(railed[0], "", "rail keeps the top gap even under a notice");
		assert!(
			railed
				.iter()
				.any(|row| row.starts_with('▎') && row.contains("hi")),
			"{railed:?}"
		);
		assert_eq!(composer.text(), "hi", "the draft survives the reshape");

		assert!(composer.set_plan_mode(false));
		assert_eq!(rows(&composer)[1], "╰─ hi", "band again, notice still up: flush");
		assert!(composer.set_status_row_occupied(false));
		assert_eq!(rows(&composer)[2], "╰─ hi", "notice gone: the gap returns");
	}

	/// `computeEditorMaxHeight`, then the composer grows with content up
	/// to that budget.
	#[test]
	fn editor_height_budget_follows_pi_and_caps_growth() {
		assert_eq!(editor_max_rows(40), 18);
		assert_eq!(editor_max_rows(30), 18);
		assert_eq!(editor_max_rows(24), 12);
		assert_eq!(editor_max_rows(18), 6);
		assert_eq!(editor_max_rows(10), 6);
		assert_eq!(editor_max_rows(8), 4);
		assert_eq!(editor_max_rows(6), 3);
		assert_eq!(editor_max_rows(5), 3);
		assert_eq!(editor_max_rows(1), 3);
		assert_eq!(editor_max_rows(0), 12, "unknown size falls back to 24 rows");

		for rows in 7..=18 {
			assert!(
				rows - editor_max_rows(rows) >= 4,
				"{rows} terminal rows do not preserve four chrome rows"
			);
		}

		let mut composer = composer();
		let base = composer.height();
		composer.paste_raw("a\nb\nc\nd");
		assert_eq!(composer.height(), base + 3, "four lines grow the editor by three rows");
		composer.resize(60, 10);
		// Budget 6 rows: the status band, the four content rows, and picker
		// room all fit; a 20-line draft is clamped instead.
		composer.paste_raw(&"\nx".repeat(20));
		assert!(
			composer.height() <= base + 6,
			"height {} exceeds the small-terminal budget",
			composer.height()
		);
		composer.resize(60, 40);
		assert!(composer.height() > base + 6, "a roomy terminal lets the draft grow again");
	}

	/// Terminal leave/re-enter and resize retain the live editor object rather
	/// than rebuilding it: focus, selection, and collapsed atoms all survive.
	#[test]
	fn lifecycle_reentry_preserves_focus_selection_and_atoms() {
		let mut composer = composer();
		composer.paste_chip("line one\nline two", None);
		for character in " tail".chars() {
			composer.key(Key::Char(character));
		}
		composer.key(Key::SelectLeft);
		composer.key(Key::SelectLeft);
		let displayed = composer.text_displayed();
		let expanded = composer.text();

		composer.resize(47, 8);
		composer.restore_focus();

		assert_eq!(composer.ui.focused_id().as_deref(), Some(COMPOSER_ID));
		assert_eq!(composer.text_displayed(), displayed);
		assert_eq!(composer.text(), expanded, "the collapsed atom keeps its submitted expansion");
		composer.key(Key::Char('X'));
		assert_eq!(composer.text_displayed(), displayed.replace("il", "X"));
		assert_eq!(
			composer.text().matches("line one\nline two").count(),
			1,
			"editing the retained selection must not flatten or duplicate the atom"
		);
	}

	/// `handleExternalEditor`: the draft handed to `$EDITOR` expands every
	/// chip; the edited text comes back verbatim with the cards dropped.
	#[test]
	fn external_editor_round_trip_expands_chips_and_lands_verbatim() {
		let mut composer = composer();
		let paste = (0..12)
			.map(|n| format!("line{n}"))
			.collect::<Vec<_>>()
			.join("\n");
		composer.paste(&paste);
		for character in "tail".chars() {
			composer.key(Key::Char(character));
		}
		let displayed = composer.text_displayed();
		assert!(displayed.contains("#1 tail"), "{displayed}");
		assert!(!displayed.contains("line0"), "the chip stays collapsed on screen");
		let expanded = composer.text();
		assert_eq!(expanded, format!("{paste} tail"), "the editor draft carries the paste");
		assert!(rows(&composer).iter().any(|row| row.contains("#1 ───")), "card band shown");

		let edited = format!("{expanded}\nedited");
		composer.replace_edited(&edited);
		assert_eq!(composer.text(), edited, "verbatim replacement, nothing re-collapsed");
		assert_eq!(composer.text_displayed(), edited);
		let after = rows(&composer);
		assert!(!after.iter().any(|row| row.contains("#1 ───")), "the attachment card band is gone");
		assert!(after.iter().any(|row| row.contains("line0")), "the expanded lines are editable");
	}

	#[test]
	fn prefix_lines_parse_like_pi_and_prose_stays_prose() {
		let bash = parse_local_input("  !echo hi").expect("bash");
		assert_eq!(bash, LocalInput {
			mode:    PrefixMode::Bash,
			code:    "echo hi".into(),
			exclude: false,
		});
		let hidden = parse_local_input("!! ls -la ").expect("excluded bash");
		assert_eq!(hidden.code, "ls -la");
		assert!(hidden.exclude);
		let eval = parse_local_input("$ 1+1").expect("eval");
		assert_eq!(eval, LocalInput {
			mode:    PrefixMode::Eval,
			code:    "1+1".into(),
			exclude: false,
		});
		let hidden_eval = parse_local_input("$$\tprint(2)").expect("excluded eval");
		assert!(hidden_eval.exclude && hidden_eval.mode == PrefixMode::Eval);
		// A bare sigil runs nothing; shell-style variables and `${…}` are prose.
		assert_eq!(parse_local_input("!"), None);
		assert_eq!(parse_local_input("$ "), None);
		assert_eq!(parse_local_input("$HOME is set"), None);
		assert_eq!(parse_local_input("${x} costs $5"), None);
		assert_eq!(prefix_mode_of("$HOME"), None);
		assert_eq!(prefix_mode_of("$"), Some(PrefixMode::Eval));
		assert_eq!(prefix_mode_of("!"), Some(PrefixMode::Bash));
	}

	/// `looksLikePastedShellPrompt`: every branch of the three regexes.
	#[test]
	fn pasted_shell_prompts_behind_a_single_dollar_stay_prose() {
		// SHELL_PROMPT_COMMAND_RE: path forms and the command roster.
		for line in [
			"$ cd ~/project && cargo test",
			"$ git status",
			"$ ./run.sh",
			"$ ../scripts/build",
			"$ /usr/bin/env",
			"$ ~/bin/tool --flag",
			"$ sudo make install",
			"$ python3 -m venv .venv",
			"$ python",
			"$ kubectl get pods",
			"$ cd",
			// SHELL_PROMPT_OPERATOR_RE: standalone operators anywhere on the first line.
			"$ cat a | sort",
			"$ a || b",
			"$ run 2>&1",
			"$ echo hi > out.txt",
			"$ prog << EOF",
			"$ cmd < input",
			// OMP_STATUS_LINE_RE: a pasted omp status line on any line.
			"$ first\nin: 12 out: 34 t: 1.2s tok/s: 40",
			"$ first\n  in: 12 out: 34 cache 5% t: 1.2s tok/s: 40",
		] {
			assert_eq!(parse_local_input(line), None, "{line:?} must stay a prompt");
			assert_eq!(prefix_mode_of(line), None, "{line:?} must not paint eval mode");
		}
		// The guard is about shell shapes, not tokens inside Python.
		for line in ["$ print('cd')", "$ gitlab = 1", "$ python_version()", "$ x|y", "$ 1<2"] {
			let parsed = parse_local_input(line).unwrap_or_else(|| panic!("{line:?} is Python"));
			assert_eq!(parsed.mode, PrefixMode::Eval);
			assert_eq!(prefix_mode_of(line), Some(PrefixMode::Eval));
		}
		// `$$` is explicit: the excluded form skips the guard.
		let forced = parse_local_input("$$ git status").expect("explicit eval");
		assert!(forced.exclude);
		assert_eq!(forced.code, "git status");
		assert_eq!(prefix_mode_of("$$ git status"), Some(PrefixMode::Eval));
		// Only the first line decides the command/operator shape.
		assert!(parse_local_input("$ x = 1\ncd home").is_some());
		assert!(looks_like_pasted_shell_prompt("cd home\nx = 1"));
	}

	/// The editor chrome recolors on the composer's grammar, not on a bare
	/// leading `$`: shell variables and pasted shell prompts stay prose
	/// ( `isPythonMode` after `pythonCommandPrefixLength` + the guard).
	#[test]
	fn editor_chrome_follows_the_composer_sigil_grammar() {
		let info = UiContext::default().theme.info;
		let warn = UiContext::default().theme.warn;
		let gutter = |composer: &Composer| composer.frame().cell(0, 2).style().foreground_color();
		for (draft, accent) in [
			("$HOME is set", None),
			("${x} costs $5", None),
			("$ git status", None),
			("$ cd ~/project && cargo test", None),
			("$ 1+1", Some(PrefixAccent::Eval)),
			("$$ git status", Some(PrefixAccent::Eval)),
			("!ls", Some(PrefixAccent::Bash)),
			("plain prose", None),
		] {
			let mut composer = composer();
			composer.set_text(draft);
			assert_eq!(composer.prefix_accent(), accent, "{draft:?}");
			let painted = gutter(&composer);
			match accent {
				Some(PrefixAccent::Eval) => assert_eq!(painted, info, "{draft:?}"),
				Some(PrefixAccent::Bash) => assert_eq!(painted, warn, "{draft:?}"),
				None => {
					assert_ne!(painted, info, "{draft:?} must not paint eval mode");
					assert_ne!(painted, warn, "{draft:?} must not paint bash mode");
				},
			}
		}
	}

	/// `parseQueueShorthand`: `->` / `=>` on the trimmed draft queues the
	/// body for the next yield; it wins over `/` classification and the
	/// draft is still recalled by Up.
	#[test]
	fn queue_shorthand_submits_a_queue_action() {
		assert_eq!(parse_queue_shorthand("-> run tests"), Some("run tests"));
		assert_eq!(parse_queue_shorthand("  =>check logs  "), Some("check logs"));
		assert_eq!(parse_queue_shorthand("->"), Some(""));
		assert_eq!(parse_queue_shorthand("- > nope"), None);
		assert_eq!(parse_queue_shorthand("a -> b"), None);

		let mut composer = composer();
		type_text(&mut composer, "-> /help later");
		assert_eq!(composer.key(Key::Enter), ComposerAction::Queue {
			text:  Str::new_static("/help later"),
			media: Vec::new(),
		});
		assert_eq!(composer.text(), "");
		assert_eq!(composer.key(Key::Up), ComposerAction::Changed);
		assert_eq!(composer.text(), "-> /help later", "history keeps the shorthand");
		composer.clear();
		type_text(&mut composer, "=> second");
		assert_eq!(composer.key(Key::Enter), ComposerAction::Queue {
			text:  Str::new_static("second"),
			media: Vec::new(),
		});
		type_text(&mut composer, "plain -> not shorthand");
		assert!(matches!(composer.key(Key::Enter), ComposerAction::Submit(_)));
	}

	/// `#queueForYield(text, { images })`: the yield-queue shorthand
	/// carries staged media chips with the body, positional against the
	/// markers that survive the stripped sigil.
	#[test]
	fn queue_shorthand_keeps_image_chips() {
		let dir = tempfile::tempdir().expect("tempdir");
		let image = dir.path().join("shot.png");
		std::fs::write(&image, b"\x89PNG\r\n\x1a\n").expect("png");
		let mut composer = composer();
		type_text(&mut composer, "-> ");
		composer.paste(&format!("'{}'", image.display()));
		type_text(&mut composer, "later");
		assert_eq!(composer.key(Key::Enter), ComposerAction::Queue {
			text:  Str::new_static("[Image #1] later"),
			media: vec![ComposerMediaSource {
				kind:   ComposerMediaKind::Image,
				source: Str::new(image.to_string_lossy()),
			}],
		});
	}

	/// `cl_autocomplete_max_visible`, `cl_emoji_autocomplete`, and
	/// `cl_paste_large_menu_threshold` reach the live editor through
	/// [`Composer::set_settings`].
	#[test]
	fn settings_reach_the_editor_and_gate_the_paste_menu() {
		let mut composer = composer();
		assert!(!composer.set_settings(ComposerSettings::default()), "defaults are a no-op");
		// Emoji dropdown follows the switch.
		type_text(&mut composer, ":joy");
		assert!(composer.popup_open(), "emoji dropdown opens by default");
		assert!(composer.set_settings(ComposerSettings {
			emoji_autocomplete: false,
			..ComposerSettings::default()
		}));
		assert!(!composer.popup_open(), "the switch closes the built-in dropdown");
		composer.clear();

		// A marker-sized paste at or above the line threshold is held for the
		// menu; below it, or with the menu disabled, it collapses to a chip.
		let twelve = (0..12)
			.map(|n| format!("l{n}"))
			.collect::<Vec<_>>()
			.join("\n");
		composer.set_settings(ComposerSettings {
			paste_large_menu_lines: 12,
			..ComposerSettings::default()
		});
		assert_eq!(composer.paste(&twelve), PasteOutcome::Menu { lines: 12 });
		assert_eq!(composer.text(), "", "the menu holds the text; nothing landed");
		assert_eq!(
			composer.paste_with_options(&twelve, PasteOptions { submit_after_paste: true }),
			PasteOutcome::Inserted,
			"a Submit in the same input batch bypasses the menu"
		);
		assert!(composer.text_displayed().contains("#1"), "same-batch Submit gets the default chip");
		composer.replace_edited("");
		composer.set_settings(ComposerSettings {
			paste_large_menu_lines: 13,
			..ComposerSettings::default()
		});
		assert_eq!(composer.paste(&twelve), PasteOutcome::Inserted);
		assert!(composer.text_displayed().contains("#1"), "below the threshold: chip");
		composer.replace_edited("");
		composer.set_settings(ComposerSettings {
			paste_large_menu_lines: 0,
			..ComposerSettings::default()
		});
		assert_eq!(composer.paste(&twelve), PasteOutcome::Inserted, "0 disables the menu");
		composer.replace_edited("");
		composer.set_settings(ComposerSettings {
			paste_large_menu_lines: 2,
			..ComposerSettings::default()
		});
		assert_eq!(
			composer.paste("a\nb\nc"),
			PasteOutcome::Inserted,
			"a small paste is never marker-sized, whatever the threshold"
		);
		assert_eq!(composer.text(), "a\nb\nc");

		// Menu choices land through `paste_chip` / `insert_text`.
		composer.replace_edited("");
		composer.paste_chip(&twelve, Some(&format!("<attachment>\n{twelve}\n</attachment>")));
		assert!(composer.text_displayed().contains("#1"), "{}", composer.text_displayed());
		assert_eq!(composer.text().trim_end(), format!("<attachment>\n{twelve}\n</attachment>"));
		composer.replace_edited("");
		composer.insert_text("local://paste-1.md");
		assert_eq!(composer.text(), "local://paste-1.md");
	}

	/// `compactImageMarkers`: surviving media markers renumber densely
	/// against the sources actually submitted without changing their kind.
	#[test]
	fn media_markers_compact_to_the_submitted_source_order() {
		assert_eq!(
			compact_media_markers(
				"[Image #2, 4x3] attachment://2 then [Video #3] attachment://3 x",
				&[2, 3],
			),
			"[Image #1, 4x3] attachment://1 then [Video #2] attachment://2 x"
		);
		assert_eq!(compact_media_markers("[Image #1] [Video #2]", &[1, 2]), "[Image #1] [Video #2]");
		assert_eq!(
			compact_media_markers("[Image #9] [Video #] [x]", &[3]),
			"[Image #9] [Video #] [x]"
		);
		assert_eq!(compact_media_markers("no markers", &[]), "no markers");
	}

	/// Raw paste bypasses both the large-paste selector and attachment-chip
	/// collapse while retaining every newline in the submitted draft.
	#[test]
	fn raw_paste_stays_inline_above_the_large_paste_threshold() {
		let mut composer = composer();
		composer.set_settings(ComposerSettings {
			paste_large_menu_lines: 2,
			..ComposerSettings::default()
		});
		let text = "one\ntwo\nthree\nfour";
		composer.paste_raw(text);
		assert_eq!(composer.text_displayed(), text);
		assert_eq!(composer.text(), text);
	}

	/// The follow-up path reads expanded composer text, not the visible
	/// `[Paste]` chip label (issue #3737).
	#[test]
	fn follow_up_queue_expands_collapsed_paste_text() {
		let mut composer = composer();
		type_text(&mut composer, "-> before ");
		composer.paste_chip("line one\nline two", None);
		type_text(&mut composer, "after");
		assert_eq!(composer.key(Key::Enter), ComposerAction::Queue {
			text:  Str::new_static("before line one\nline two after"),
			media: Vec::new(),
		});
	}

	/// A host may preview and refuse an action without reconstructing the
	/// draft: text chips, their atom expansions, and the caret stay live
	/// until the host explicitly commits.
	#[test]
	fn refused_preview_preserves_the_exact_collapsed_draft() {
		let mut composer = composer();
		type_text(&mut composer, "before ");
		composer.paste_chip("line one\nline two", None);
		type_text(&mut composer, "after");
		let displayed = composer.text_displayed();
		let expanded = composer.text();

		assert_eq!(composer.preview_submission(), ComposerAction::Submit(Str::new(expanded.clone())));
		assert_eq!(composer.text_displayed(), displayed);
		assert_eq!(composer.text(), expanded, "the chip atom still expands after refusal");
		assert!(composer.commit_submission());
		assert_eq!(composer.text(), "");
		assert!(!composer.commit_submission(), "the accepted draft commits once");
	}

	/// Slash/local commands carry their referenced media through validation.
	/// A host that cannot consume command attachments can refuse without
	/// committing, rather than silently dropping the image and its link.
	#[test]
	fn local_command_preview_retains_media_and_atoms() {
		let dir = tempfile::tempdir().expect("tempdir");
		let image = dir.path().join("command.png");
		std::fs::write(&image, b"\x89PNG\r\n\x1a\n").expect("fixture");
		let mut composer = composer();
		type_text(&mut composer, "/goal inspect ");
		composer.paste(&format!("'{}'", image.display()));
		let displayed = composer.text_displayed();
		assert_eq!(composer.preview_submission(), ComposerAction::Command {
			statement: Str::new_static("goal inspect [Image #1]"),
			media:     vec![ComposerMediaSource {
				kind:   ComposerMediaKind::Image,
				source: Str::new(image.to_string_lossy()),
			}],
		});
		assert_eq!(composer.text_displayed(), displayed, "preview/refusal keeps the media atom");
	}

	/// Media materialization is a typed pre-commit gate: an invalid source
	/// refuses the whole action while the exact media chip atom, link, and
	/// expanded marker remain staged for retry.
	#[test]
	fn typed_media_refusal_keeps_the_atom_backed_draft() {
		let dir = tempfile::tempdir().expect("tempdir");
		let image = dir.path().join("broken.png");
		std::fs::write(&image, b"not an image").expect("fixture");
		let mut composer = composer();
		composer.paste(&format!("'{}'", image.display()));
		type_text(&mut composer, " inspect");
		let displayed = composer.text_displayed();
		let expanded = composer.text();
		let ComposerAction::SubmitWithMedia { media, .. } = composer.preview_submission() else {
			panic!("media action");
		};

		let error = crate::media::prepare_media_sources(&media).expect_err("typed refusal");
		assert!(matches!(error, crate::media::MediaInputError::UnsupportedImage { .. }));
		assert_eq!(composer.text_displayed(), displayed);
		assert_eq!(composer.text(), expanded);
		assert_eq!(composer.preview_submission(), ComposerAction::SubmitWithMedia {
			text: Str::new(expanded),
			media,
		});
	}

	/// Dropping media stages chips whose submission carries classified sources
	/// in pasted order; a text-only draft still submits plainly.
	#[test]
	fn media_chips_submit_classified_sources_in_paste_order() {
		let dir = tempfile::tempdir().expect("tempdir");
		let first = dir.path().join("one.png");
		let second = dir.path().join("two.mp4");
		std::fs::write(&first, b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR\0\0\0\x04\0\0\0\x03").expect("png");
		std::fs::write(&second, b"video").expect("video");
		let mut composer = composer();
		composer.paste(&format!("'{}' '{}'", first.display(), second.display()));
		assert!(composer.text_displayed().contains("#1") && composer.text_displayed().contains("#2"));
		type_text(&mut composer, "compare");
		assert_eq!(composer.key(Key::Enter), ComposerAction::SubmitWithMedia {
			text:  Str::new("[Image #1, 4x3] [Video #2] compare"),
			media: vec![
				ComposerMediaSource {
					kind:   ComposerMediaKind::Image,
					source: Str::new(first.to_string_lossy()),
				},
				ComposerMediaSource {
					kind:   ComposerMediaKind::Video,
					source: Str::new(second.to_string_lossy()),
				},
			],
		});
		assert_eq!(composer.text(), "");
		type_text(&mut composer, "plain");
		assert_eq!(composer.key(Key::Enter), ComposerAction::Submit(Str::new_static("plain")));
	}

	/// Text attachments expand in their exact draft position while the
	/// out-of-band media vector retains image/video source order.
	#[test]
	fn submission_preserves_interleaved_text_and_media_order() {
		let dir = tempfile::tempdir().expect("tempdir");
		let image = dir.path().join("first.png");
		let video = dir.path().join("second.mp4");
		std::fs::write(&image, b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR\0\0\0\x02\0\0\0\x01").expect("png");
		std::fs::write(&video, b"video").expect("video");
		let mut composer = composer();
		type_text(&mut composer, "lead ");
		composer.paste(&format!("'{}'", image.display()));
		type_text(&mut composer, " middle ");
		composer.paste_chip("pasted\ntext", None);
		type_text(&mut composer, " then ");
		composer.paste(&format!("'{}'", video.display()));
		type_text(&mut composer, " tail");

		let displayed = composer.text_displayed();
		assert_eq!(composer.preview_submission(), ComposerAction::SubmitWithMedia {
			text:  Str::new_static("lead [Image #1, 2x1]  middle pasted\ntext  then [Video #2]  tail"),
			media: vec![
				ComposerMediaSource {
					kind:   ComposerMediaKind::Image,
					source: Str::new(image.to_string_lossy()),
				},
				ComposerMediaSource {
					kind:   ComposerMediaKind::Video,
					source: Str::new(video.to_string_lossy()),
				},
			],
		});
		assert_eq!(
			composer.text_displayed(),
			displayed,
			"validation/refusal leaves every interleaved chip in place"
		);
		assert!(composer.commit_submission());
		assert_eq!(composer.text(), "");
	}
}
