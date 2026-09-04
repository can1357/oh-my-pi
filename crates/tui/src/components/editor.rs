use std::{
	cell::RefCell,
	fs, mem,
	ops::Range,
	path::Path,
	rc::Rc,
	sync::Arc,
	time,
	time::{Duration, Instant},
};

use omp_core::{IntoStr, Str, sf};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use smallvec::SmallVec;
use strum::{Display, EnumIter, EnumString};
use xutf::Text;

use super::{ContextGaugeMode, Img, StatusPlacement, hr::truncate_to_width};
use crate::{
	Completion, EditBuffer, EditOutcome, Editor, EditorOptions, Icon, PickerRow, SuggestionDisplay,
	anim,
	component::{
		Cached, Component, EventCtx, Flow, Hit, HitTag, IntoComponent, PaintCtx, Slot, next_slot,
	},
	context::{Charset, UiContext},
	editcore::{code_ranges, xml_ranges},
	frame::{Color, Frame, Rect, Style},
	imagefmt::dimensions,
	input::{Key, Mouse, UiEvent, byte_at_column, sanitize_paste},
	markup::Border,
	paste::{PastedPathKind, classify_attachment_path, dropped_paths},
	props::{Prop, PropValue, Props},
	rich::cell_width,
	spelling::{SpellingAssist, SpellingFeatures, TypoRange},
	syntax::{SyntaxRun, highlight_xml, xml_comment_state},
};
/// Built-in composer chrome selected by the `composer.shape` setting.
///
/// The enum is deliberately non-exhaustive: a future `Custom` variant can
/// carry an extension-owned style without changing call sites that already
/// dispatch through [`ComposerStyle::layout`].
#[non_exhaustive]
#[derive(
	Clone, Copy, Debug, Default, Display, EnumIter, EnumString, Eq, PartialEq, Serialize, Deserialize,
)]
#[serde(rename_all = "lowercase")]
#[strum(serialize_all = "lowercase")]
pub enum ComposerStyle {
	/// Rounded frame with the status embedded in its top edge.
	Box,
	/// Full-width rules, a prompt gutter, and a right-docked status chip.
	Claude,
	/// Rounded frame with a `> ` gutter and a scrollbar in the right edge.
	Pi,
	/// Unboxed prompt with a single curved left cue and a status strip above it.
	#[default]
	Borderless,
	/// One status-bearing rule above the input.
	Rule,
	/// Filled input surface with accented end caps.
	Field,
	/// Filled input surface anchored by an accented left rail.
	Rail,
}

/// How composer chrome consumes the status component.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ComposerStatusAttachment {
	/// Both status groups occupy the rounded top border.
	TopBorder,
	/// The right group occupies the top rule and the left group stands below.
	TopRuleChip,
	/// Both groups occupy a standalone row below the input.
	Standalone,
}

/// Cell geometry and status policy resolved for one composer style.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ComposerLayout {
	/// Rows above the editable content.
	pub top_rows:            u16,
	/// Rows below the editable content.
	pub bottom_rows:         u16,
	/// Horizontal padding between the gutter/text and side chrome.
	pub horizontal_pad:      u16,
	/// Chrome cells consumed on each side, excluding the prompt gutter.
	pub side_chrome:         u16,
	/// Visible cells consumed by the first-row prompt gutter.
	pub gutter_width:        u16,
	/// Status attachment used by the host scene.
	pub status_attachment:   ComposerStatusAttachment,
	/// Whether the primary status line owns a separate row.
	pub status_placement:    StatusPlacement,
	/// Context presentation appropriate for this status placement.
	pub context_gauge:       ContextGaugeMode,
	/// Whether a blank row separates the input from standalone status.
	pub status_gap:          bool,
	/// Whether a standalone status row precedes the editable content.
	pub status_before_input: bool,
}

impl ComposerStyle {
	/// Resolves row chrome and status placement for `charset`.
	pub const fn layout(self, _charset: Charset) -> ComposerLayout {
		let gutter_width = match self {
			Self::Claude | Self::Rule | Self::Pi => 2,
			Self::Borderless => 3,
			Self::Box | Self::Field | Self::Rail => 0,
		};
		let (top_rows, bottom_rows, horizontal_pad, side_chrome) = match self {
			Self::Box => (1, 1, 2, 3),
			Self::Claude => (1, 1, 0, 0),
			Self::Pi => (1, 1, 1, 2),
			Self::Borderless => (0, 0, 0, 0),
			Self::Rule => (1, 0, 0, 0),
			Self::Field | Self::Rail => (0, 0, 1, 2),
		};
		let status_attachment = match self {
			Self::Box => ComposerStatusAttachment::TopBorder,
			Self::Claude | Self::Rule => ComposerStatusAttachment::TopRuleChip,
			Self::Pi | Self::Borderless | Self::Field | Self::Rail => {
				ComposerStatusAttachment::Standalone
			},
		};
		let status_placement = if matches!(status_attachment, ComposerStatusAttachment::TopBorder) {
			StatusPlacement::Embedded
		} else {
			StatusPlacement::Standalone
		};
		let context_gauge = match status_attachment {
			ComposerStatusAttachment::TopBorder | ComposerStatusAttachment::Standalone => {
				ContextGaugeMode::Bar
			},
			ComposerStatusAttachment::TopRuleChip => ContextGaugeMode::Numeric,
		};
		let status_gap = matches!(self, Self::Rule | Self::Field | Self::Rail);
		let status_before_input = matches!(self, Self::Borderless);
		ComposerLayout {
			top_rows,
			bottom_rows,
			horizontal_pad,
			side_chrome,
			gutter_width,
			status_attachment,
			status_placement,
			context_gauge,
			status_gap,
			status_before_input,
		}
	}

	/// Prompt gutter for the first editable row.
	pub const fn prompt_gutter(self, charset: Charset) -> &'static str {
		match self {
			Self::Claude | Self::Rule => charset.cursor(),
			Self::Borderless => match charset {
				Charset::Ascii => "+- ",
				Charset::Unicode | Charset::NerdFont => "╰─ ",
			},
			Self::Pi => "> ",
			Self::Box | Self::Field | Self::Rail => "",
		}
	}

	/// Total rows reserved below the editor for standalone status.
	pub const fn standalone_status_rows(self) -> u16 {
		match self {
			Self::Box => 0,
			Self::Claude | Self::Pi | Self::Borderless => 1,
			Self::Rule | Self::Field | Self::Rail => 2,
		}
	}

	const fn text_width(self, width: u16, charset: Charset) -> u16 {
		let layout = self.layout(charset);
		let text = width
			.saturating_sub(layout.side_chrome.saturating_mul(2))
			.saturating_sub(layout.gutter_width);
		if text == 0 { 1 } else { text }
	}
}

fn paint_glyphs(frame: &mut Frame, x: u16, y: u16, width: u16, glyph: char, style: Style) {
	let mut bytes = [0_u8; 4];
	let glyph = glyph.encode_utf8(&mut bytes);
	for offset in 0..width {
		frame.put(x.saturating_add(offset), y, glyph, style);
	}
}

const fn field_caps(charset: Charset) -> (char, char) {
	match charset {
		Charset::Ascii => ('|', '|'),
		Charset::Unicode | Charset::NerdFont => ('▐', '▌'),
	}
}

const fn accent_rail(charset: Charset, focused: bool) -> char {
	match charset {
		Charset::Ascii => '|',
		Charset::Unicode | Charset::NerdFont => {
			if focused {
				'▎'
			} else {
				'▏'
			}
		},
	}
}

const fn scrollbar_thumb(charset: Charset) -> char {
	match charset {
		Charset::Ascii => '#',
		Charset::Unicode | Charset::NerdFont => '█',
	}
}

/// Semantic accent painted over host-declared inline spans.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum InlineAccent {
	/// Muted, dimmed host annotation.
	Dim,
	/// Theme-accented host annotation.
	Accent,
}

/// Pure host decoration from full editor text to accented byte spans.
pub type InlineDecorator = Box<dyn Fn(&str) -> SmallVec<(usize, usize, InlineAccent), 4>>;

/// Which leading sigil recolors the composer chrome for the whole draft.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PrefixAccent {
	/// `!` — the draft runs as a shell command (theme `warn`).
	Bash,
	/// `$` — the draft runs as an eval expression (theme `info`).
	Eval,
}

/// Host classification of a draft's leading sigil. The host owns the grammar
/// and pasted-shell-prompt guard; the editor only paints the verdict.
pub type PrefixClassifier = fn(&str) -> Option<PrefixAccent>;

/// Default classifier: a bare leading `!` or `$` byte.
fn leading_sigil(text: &str) -> Option<PrefixAccent> {
	match text.trim_start().as_bytes().first() {
		Some(b'!') => Some(PrefixAccent::Bash),
		Some(b'$') => Some(PrefixAccent::Eval),
		_ => None,
	}
}

/// HSL hue sweep painted across one magic keyword: stop `i` of
/// [`STOPS`](Self::STOPS) takes hue
/// `start + (i / STOPS) * span` at 90% saturation and 62% lightness.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct KeywordGradient {
	/// Hue in degrees at `t = 0`.
	pub hue_start: f32,
	/// Hue travelled across the sweep, in degrees.
	pub hue_span:  f32,
}

impl KeywordGradient {
	const LIGHTNESS: f32 = 0.62;
	/// Green through blue to violet, `150 + t * 130`.
	pub const ORCHESTRATE: Self = Self { hue_start: 150.0, hue_span: 130.0 };
	const SATURATION: f32 = 0.90;
	/// Repaint cadence while a keyword shimmers: ~14 frames/s reads as motion
	/// without flooding the renderer.
	pub const SHIMMER_FRAME: Duration = Duration::from_millis(70);
	/// Time for the gradient to sweep one full cycle across each keyword.
	pub const SHIMMER_PERIOD: Duration = Duration::from_millis(1800);
	/// Color stops swept across the gradient.
	pub const STOPS: usize = 14;
	/// The full rainbow, `t * 330`.
	pub const ULTRATHINK: Self = Self { hue_start: 0.0, hue_span: 330.0 };
	/// Orange through green, `30 + t * 120`.
	pub const WORKFLOWZ: Self = Self { hue_start: 30.0, hue_span: 120.0 };

	/// Compiles the stop palette once per color depth: truecolor keeps the
	/// HSL sample, 256-color terminals take the nearest indexed entry.
	fn palette(self, truecolor: bool) -> [Color; Self::STOPS] {
		let mut palette = [Color::Default; Self::STOPS];
		for (index, slot) in palette.iter_mut().enumerate() {
			let t = index as f32 / Self::STOPS as f32;
			let hue = self.hue_span.mul_add(t, self.hue_start).round();
			let color = anim::hsl(hue, Self::SATURATION, Self::LIGHTNESS);
			*slot = if truecolor {
				color
			} else {
				color.quantized_256()
			};
		}
		palette
	}

	/// Stop for character `index` of an `len`-character keyword at `phase`:
	/// `floor(((i / n + phase) mod 1) * stops) mod stops`.
	#[must_use]
	pub fn stop(index: usize, len: usize, phase: f32) -> usize {
		let t = anim::wrap_unit(index as f32 / len.max(1) as f32 + phase);
		((t * Self::STOPS as f32).floor() as usize) % Self::STOPS
	}
}

/// One accented keyword with its palettes compiled for both color depths.
#[derive(Clone, Debug)]
struct Keyword {
	text:     Str,
	/// `[256-color, truecolor]`.
	palettes: [[Color; KeywordGradient::STOPS]; 2],
}

/// Data-driven accent policy for editor keywords: each keyword shimmers
/// through its own [`KeywordGradient`] while the editor is focused.
#[derive(Clone, Debug, Default)]
pub struct KeywordAccent {
	keywords: Arc<[Keyword]>,
}

impl KeywordAccent {
	/// Creates an immutable keyword set. Empty values are ignored.
	pub fn new(keywords: impl IntoIterator<Item = (Str, KeywordGradient)>) -> Self {
		Self {
			keywords: keywords
				.into_iter()
				.filter(|(keyword, _)| !keyword.is_empty())
				.map(|(text, gradient)| Keyword {
					text,
					palettes: [gradient.palette(false), gradient.palette(true)],
				})
				.collect(),
		}
	}

	/// Built-in magic keywords: `ultrathink`, `orchestrate`, and `workflowz`,
	/// each with its own hue sweep.
	#[must_use]
	pub fn magic() -> Self {
		Self::new([
			(Str::new_static("ultrathink"), KeywordGradient::ULTRATHINK),
			(Str::new_static("orchestrate"), KeywordGradient::ORCHESTRATE),
			(Str::new_static("workflowz"), KeywordGradient::WORKFLOWZ),
		])
	}

	/// Palette of keyword `index` (as reported by
	/// [`matched_spans`](Self::matched_spans)) for the color depth.
	#[must_use]
	pub fn palette(&self, index: usize, truecolor: bool) -> &[Color; KeywordGradient::STOPS] {
		&self.keywords[index].palettes[usize::from(truecolor)]
	}

	/// Finds case-insensitive whole-word keyword spans in one immutable
	/// text, each with the index of the keyword it matched.
	pub fn matched_spans(&self, text: &str) -> SmallVec<(usize, usize, usize), 8> {
		let mut spans = SmallVec::new();
		for (at, _) in text.char_indices() {
			let boundary_before = text[..at]
				.chars()
				.next_back()
				.is_none_or(|character| !character.is_ascii_alphanumeric() && character != '_');
			if !boundary_before {
				continue;
			}
			for (index, keyword) in self.keywords.iter().enumerate() {
				let end = at.saturating_add(keyword.text.len());
				let Some(candidate) = text.get(at..end) else {
					continue;
				};
				let boundary_after = text[end..]
					.chars()
					.next()
					.is_none_or(|character| !character.is_ascii_alphanumeric() && character != '_');
				if boundary_after
					&& xutf::equals_ignore_ascii_case::<xutf::Utf8, xutf::Utf8>(
						candidate.as_bytes(),
						keyword.text.as_bytes(),
					) {
					spans.push((at, end, index));
					break;
				}
			}
		}
		spans
	}
}

const MAX_SPELLING_LINE_UTF16: usize = 1_000;

#[derive(Clone, Debug, Eq, PartialEq)]
struct AssistanceGuard {
	text:   Str,
	cursor: usize,
	range:  Range<usize>,
}

/// Focusable editable leaf used by [`EditorPane`].
pub struct EditInput {
	props:             Props,
	slot:              Slot,
	editor:            Editor,
	style:             ComposerStyle,
	attachments:       Option<Attachments>,
	dragging:          bool,
	last_click:        Option<((u16, u16), Instant)>,
	keyword_accent:    KeywordAccent,
	keyword_spans:     SmallVec<(usize, usize, usize), 8>,
	inline_decorator:  Option<InlineDecorator>,
	decoration_spans:  SmallVec<(usize, usize, InlineAccent), 4>,
	prefix_classifier: PrefixClassifier,
	spelling:          SpellingAssist,
	spelling_features: SpellingFeatures,
	spelling_mask:     SmallVec<Range<usize>, 8>,
	/// Cursor position an in-flight autocorrect request was made at; the
	/// correction only applies while the cursor still sits there.
	correction_guard:  Option<usize>,
	/// Exact source snapshot for an in-flight replacement request.
	guesses_guard:     Option<AssistanceGuard>,
	/// Leave the caret row empty to its right in side-bordered shapes so
	/// terminal-local IME preedit cannot shift the chrome onto the next row.
	ime_safe_cursor:   bool,
}

impl EditInput {
	/// Creates an empty editor.
	pub fn new() -> Self {
		Self {
			props:             Props::new(),
			slot:              next_slot(),
			editor:            Editor::new(EditorOptions::default()),
			style:             ComposerStyle::Borderless,
			attachments:       None,
			dragging:          false,
			last_click:        None,
			keyword_accent:    KeywordAccent::default(),
			keyword_spans:     SmallVec::new(),
			inline_decorator:  None,
			decoration_spans:  SmallVec::new(),
			prefix_classifier: leading_sigil,
			spelling:          SpellingAssist::new(),
			spelling_features: SpellingFeatures::default(),
			spelling_mask:     SmallVec::new(),
			correction_guard:  None,
			guesses_guard:     None,
			ime_safe_cursor:   false,
		}
	}

	/// Enables an IME-safe cursor layout: in side-bordered shapes (box, field,
	/// rail), the row whose caret sits at its end paints no right chrome, so
	/// marked text a terminal renders
	/// locally during IME composition never pushes the frame apart.
	pub const fn set_ime_safe_cursor(&mut self, enabled: bool) {
		self.ime_safe_cursor = enabled;
	}

	/// Binds the composer's shared attachment queue: image path drops stage
	/// automatically, large pastes collapse into atomic `<icon> #N` chips,
	/// and deleting a chip hides its card until an undo restores it.
	pub fn attachments(mut self, attachments: Attachments) -> Self {
		self.attachments = Some(attachments);
		self
	}

	/// Selects the built-in composer chrome.
	pub const fn composer_style(mut self, style: ComposerStyle) -> Self {
		self.style = style;
		self
	}

	/// Replaces the active composer chrome.
	pub const fn set_composer_style(&mut self, style: ComposerStyle) {
		self.style = style;
	}

	/// Replaces the data-driven keyword accent policy and refreshes cached
	/// spans.
	pub fn set_keyword_accent(&mut self, accent: KeywordAccent) {
		self.keyword_accent = accent;
		self.refresh_keyword_spans();
	}

	fn set_inline_decorator(&mut self, decorator: Option<InlineDecorator>) {
		self.inline_decorator = decorator;
		self.refresh_keyword_spans();
	}

	/// Replaces the leading-sigil classifier that recolors the chrome.
	pub const fn set_prefix_classifier(&mut self, classifier: PrefixClassifier) {
		self.prefix_classifier = classifier;
	}

	/// The chrome accent the current draft's leading sigil selects.
	#[must_use]
	pub fn prefix_accent(&self) -> Option<PrefixAccent> {
		(self.prefix_classifier)(self.editor.text())
	}

	fn refresh_keyword_spans(&mut self) {
		self.keyword_spans = self.keyword_accent.matched_spans(self.editor.text());
		self.decoration_spans = self
			.inline_decorator
			.as_ref()
			.map_or_else(SmallVec::new, |decorator| decorator(self.editor.text()));
		self.refresh_spelling();
	}

	fn refresh_spelling(&mut self) {
		let features = self.spelling_features;
		if !features.typo_detection && !features.autocomplete && !features.autocorrect {
			self.spelling.clear();
			self.correction_guard = None;
			self.guesses_guard = None;
			return;
		}
		self.spelling_mask.clear();
		self.spelling_mask.extend(
			self
				.editor
				.atom_ranges()
				.into_iter()
				.map(|(start, end)| start..end),
		);
		self.spelling_mask.extend(code_ranges(self.editor.text()));
		self.spelling_mask.extend(xml_ranges(self.editor.text()));
		let mut line_start = 0;
		for line in self.editor.text().split_inclusive('\n') {
			let line_end = line_start + line.len();
			let content = line.strip_suffix('\n').unwrap_or(line);
			if content.encode_utf16().count() > MAX_SPELLING_LINE_UTF16 {
				self.spelling_mask.push(line_start..line_end);
			}
			line_start = line_end;
		}
		if features.typo_detection {
			self.spelling.check(self.editor.text(), &self.spelling_mask);
		}
	}

	/// Applies an asynchronous platform correction while the buffer still
	/// matches the requesting state.
	fn apply_autocorrect(&mut self, range: &Range<usize>, replacement: &str) {
		let Some(guard) = self.correction_guard.take() else {
			return;
		};
		if !self.spelling_features.autocorrect || guard != self.editor.buffer().cursor() {
			return;
		}
		// Re-insert the boundary character so the cursor lands after it.
		let Some(boundary) = self.editor.text().get(range.end..guard) else {
			return;
		};
		let insert = sf!("{replacement}{boundary}");
		self.editor.apply_edit(range.start..guard, &insert);
		self.refresh_keyword_spans();
	}

	/// After a boundary character lands, asks the platform for a confident
	/// correction of the preceding word.
	fn request_autocorrect(&mut self, key: Key) {
		self.correction_guard = None;
		if !self.spelling_features.autocorrect {
			return;
		}
		let boundary = match key {
			Key::Space => ' ',
			Key::ShiftEnter => '\n',
			Key::Char(character) if is_word_boundary(character) => character,
			_ => return,
		};
		let text = self.editor.text();
		let cursor = self.editor.buffer().cursor();
		// Emoji/emoticon expansion may have rewritten the just-typed character.
		if !text[..cursor].ends_with(boundary) {
			return;
		}
		let Some(range) = word_suffix_range(text, cursor - boundary.len_utf8()) else {
			return;
		};
		if !is_prose_word(text, &self.spelling_mask, &range) {
			return;
		}
		self.correction_guard = Some(cursor);
		self.spelling.request_correction(text, range);
	}

	fn accept_word_completion(&mut self, key: Key) -> bool {
		if !self.spelling_features.autocomplete || self.editor.picker().is_some() {
			return false;
		}
		let cursor = self.editor.buffer().cursor();
		let text = self.editor.text();
		let at_line_end = cursor == text.len() || text[cursor..].starts_with('\n');
		if key != Key::Tab && !(key == Key::Right && at_line_end) {
			return false;
		}
		let Some(range) = completion_prefix_range(text, cursor, &self.spelling_mask) else {
			return false;
		};
		let Some(suffix) = self.spelling.completion(text, &range) else {
			return false;
		};
		// Logical lines exclude their newline, so a completion at line end
		// receives its separating space before `\n`.
		let needs_space = text[cursor..]
			.chars()
			.next()
			.is_none_or(|character| character == '\n' || !is_word_boundary(character));
		let insert = if needs_space {
			sf!("{suffix} ")
		} else {
			suffix
		};
		self.editor.apply_edit(cursor..cursor, &insert);
		self.refresh_keyword_spans();
		true
	}

	/// Applies native spelling feature gates.
	pub fn set_spelling_features(&mut self, features: SpellingFeatures) {
		if self.spelling_features == features {
			return;
		}
		self.spelling.clear();
		self.correction_guard = None;
		self.guesses_guard = None;
		self.spelling_features = features;
		self.refresh_spelling();
	}

	/// Replaces the editor feature switches at runtime (dropdown window,
	/// emoji expansion, history, XML affordances).
	pub fn set_editor_options(&mut self, options: EditorOptions) {
		self.editor.set_options(options);
	}

	/// Stages `text` as a text-attachment chip: a compact `<icon> #N` token
	/// in the buffer whose submitted form is
	/// `expansion` (default: the sanitized text itself), plus a band card.
	/// Returns whether a chip was inserted (needs staged attachments).
	pub fn stage_text_attachment(
		&mut self,
		text: &str,
		expansion: Option<&str>,
		charset: Charset,
	) -> bool {
		let Some(attachments) = &self.attachments else {
			return false;
		};
		let attachment = attachments.push_text(text);
		let expansion = expansion.map_or_else(|| sanitize_paste(text), str::to_owned);
		let references = [(chip_label(&attachment, charset).to_string(), expansion)];
		let _ = self.editor.insert_reference_group(&references, " ");
		self.refresh_keyword_spans();
		true
	}

	/// The editor feature switches currently in force.
	#[must_use]
	pub const fn editor_options(&self) -> EditorOptions {
		self.editor.options()
	}

	/// Native spelling feature gates currently applied.
	pub const fn active_spelling_features(&self) -> SpellingFeatures {
		self.spelling_features
	}

	/// Records a submitted prompt for Up/Down recall.
	pub fn add_to_history(&mut self, text: &str) {
		self.editor.add_to_history(text);
	}

	/// Replaces the Up/Down prompt history, newest first.
	pub fn seed_history(&mut self, prompts: impl IntoIterator<Item = Str>) {
		self.editor.seed_history(prompts);
	}

	/// Hides staged attachments whose chip left the buffer (an undo that
	/// restores the chip re-shows them), returning whether anything
	/// changed.
	fn reconcile(&self, ctx: &UiContext) -> bool {
		let Some(attachments) = &self.attachments else {
			return false;
		};
		let text = self.editor.text();
		let ranges = self.editor.atom_ranges();
		attachments.set_visible(|attachment| {
			let chip = chip_label(attachment, ctx.charset);
			ranges
				.iter()
				.any(|&(start, end)| text.get(start..end) == Some(chip.as_str()))
		})
	}

	#[allow(dead_code, reason = "acceptance-suite probe")]
	pub(crate) const fn buffer(&self) -> &EditBuffer {
		self.editor.buffer()
	}

	/// Returns the composer line containing the cursor, for host copy-line
	/// actions.
	pub fn current_line(&self) -> &str {
		self.editor.current_line()
	}

	/// Shows or replaces one volatile speech-recognition preview.
	pub fn set_volatile_text(&mut self, text: &str) {
		self.editor.set_volatile_text(text);
		self.refresh_keyword_spans();
	}

	/// Shows or replaces native-IME marked text and its byte-indexed
	/// selection inside the marked span.
	pub fn set_volatile_text_selection(&mut self, text: &str, selection: Option<Range<usize>>) {
		self.editor.set_volatile_text_selection(text, selection);
		self.refresh_keyword_spans();
	}

	/// Discards the active volatile speech-recognition preview.
	pub fn clear_volatile_text(&mut self) {
		self.editor.clear_volatile_text();
		self.refresh_keyword_spans();
	}

	/// Commits one finalized speech-recognition segment as an editor edit.
	pub fn commit_volatile_text(&mut self, text: &str) {
		self.editor.commit_volatile_text(text);
		self.refresh_keyword_spans();
	}

	/// Sets one editor property, updating its buffer for `value`.
	pub fn with(mut self, prop: Prop, value: impl Into<PropValue>) -> Self {
		let value = value.into();
		if prop == Prop::Value
			&& let PropValue::Str(text) = &value
		{
			self.editor.set_text(text);
			self.refresh_keyword_spans();
		}
		if prop == Prop::Rail
			&& let PropValue::Bool(enabled) = &value
		{
			self.style = if *enabled {
				ComposerStyle::Rail
			} else {
				ComposerStyle::default()
			};
		}
		self.props.set(prop, value);
		self
	}

	/// Sets one editor property from a string.
	pub fn with_str(self, prop: Prop, value: &str) -> Self {
		self.with(prop, value)
	}

	/// Registers the completion engine used by this editable leaf.
	pub fn set_completion(&mut self, completion: Box<dyn Completion>) {
		self.editor.set_completion(completion);
	}

	/// Moves the caret to the start or end of the whole draft.
	pub fn move_to_message_edge(&mut self, end: bool) {
		self.editor.move_to_message_edge(end);
	}

	/// Undoes the last edit made before the just-removed `transient`
	/// trigger text.
	pub fn undo_past_transient(&mut self, transient: &str) {
		if self.editor.undo_past_transient(transient) == EditOutcome::Changed {
			self.refresh_keyword_spans();
		}
	}

	/// Reports whether the cursor is on the first logical line.
	pub fn cursor_on_first_line(&self) -> bool {
		self.editor.buffer().cursor_line() == 0
	}

	/// Reports whether the cursor is on the last logical line.
	pub fn cursor_on_last_line(&self) -> bool {
		let buffer = self.editor.buffer();
		buffer.cursor_line().saturating_add(1) >= buffer.line_count()
	}

	fn max_rows(&self) -> u16 {
		match self.props.get(Prop::MaxRows) {
			Some(PropValue::U16(rows)) => rows.max(1),
			_ => 18,
		}
	}

	const fn text_width(&self, width: u16, charset: Charset) -> u16 {
		self.style.text_width(width, charset)
	}

	fn page_rows(&self, ec: &EventCtx<'_>) -> usize {
		let chrome = self.style.layout(ec.ctx.charset);
		usize::from(
			ec.view_rows
				.saturating_sub(chrome.top_rows)
				.saturating_sub(chrome.bottom_rows)
				.max(1),
		)
	}

	fn picker_icon_width(&self, ctx: &UiContext) -> u16 {
		self
			.editor
			.picker()
			.into_iter()
			.flat_map(|picker| picker.visible_suggestions().1)
			.filter_map(|suggestion| suggestion.icon())
			.map(|icon| cell_width(ctx.charset.icon(icon)))
			.max()
			.unwrap_or_default()
	}

	fn picker_height(&self, ctx: &UiContext, width: u16) -> u16 {
		let Some(picker) = self.editor.picker() else {
			return 0;
		};
		let max_rows = u16::try_from(picker.rows()).unwrap_or(u16::MAX);
		let icon_width = self.picker_icon_width(ctx);
		let mut rows = 0_u16;
		for picker_row in picker.visible_rows() {
			if rows >= max_rows {
				break;
			}
			let height = match picker_row {
				PickerRow::Header(_) => 1,
				PickerRow::Suggestion { suggestion, .. } => {
					let label_width = match suggestion.display() {
						SuggestionDisplay::Text(label) => cell_width(label),
						SuggestionDisplay::Emoji { emoji, shortcode } => cell_width(emoji)
							.saturating_add(cell_width(shortcode))
							.saturating_add(3),
					};
					let description_width = width
						.saturating_sub(cell_width(ctx.charset.cursor()))
						.saturating_sub(icon_width.saturating_add(u16::from(icon_width > 0)))
						.saturating_sub(label_width)
						.saturating_sub(2);
					if suggestion
						.description()
						.is_some_and(|description| cell_width(description) > description_width)
						&& description_width > 0
					{
						2
					} else {
						1
					}
				},
			};
			rows = rows.saturating_add(height.min(max_rows - rows));
		}
		rows
	}

	fn picker_hit_index(&self, ctx: &UiContext, width: u16, visual_row: u16) -> Option<usize> {
		let picker = self.editor.picker()?;
		let max_rows = u16::try_from(picker.rows()).unwrap_or(u16::MAX);
		let icon_width = self.picker_icon_width(ctx);
		let mut offset = 0_u16;
		for picker_row in picker.visible_rows() {
			if offset >= max_rows {
				break;
			}
			let (index, height) = match picker_row {
				PickerRow::Header(_) => (None, 1),
				PickerRow::Suggestion { index, suggestion } => {
					let label_width = match suggestion.display() {
						SuggestionDisplay::Text(label) => cell_width(label),
						SuggestionDisplay::Emoji { emoji, shortcode } => cell_width(emoji)
							.saturating_add(cell_width(shortcode))
							.saturating_add(3),
					};
					let description_width = width
						.saturating_sub(cell_width(ctx.charset.cursor()))
						.saturating_sub(icon_width.saturating_add(u16::from(icon_width > 0)))
						.saturating_sub(label_width)
						.saturating_sub(2);
					let height = if suggestion
						.description()
						.is_some_and(|description| cell_width(description) > description_width)
						&& description_width > 0
					{
						2
					} else {
						1
					};
					(Some(index), height)
				},
			};
			let height = height.min(max_rows - offset);
			if visual_row >= offset && visual_row < offset.saturating_add(height) {
				return index;
			}
			offset = offset.saturating_add(height);
		}
		None
	}

	fn paint_picker(&self, pc: &mut PaintCtx<'_>, rect: Rect, y: u16) {
		let Some(picker) = self.editor.picker() else {
			return;
		};
		let max_rows = u16::try_from(picker.rows()).unwrap_or(u16::MAX);
		let right = rect.x.saturating_add(rect.width);
		let icon_width = self.picker_icon_width(pc.ctx);
		let hovered = pc.pointer.and_then(|(x, pointer_y)| {
			(x >= rect.x && x < right && pointer_y >= y)
				.then(|| self.picker_hit_index(pc.ctx, rect.width, pointer_y - y))
				.flatten()
		});
		let mut offset = 0_u16;
		for picker_row in picker.visible_rows() {
			let row = y.saturating_add(offset);
			if offset >= max_rows || row >= pc.clip || row >= rect.y.saturating_add(rect.height) {
				break;
			}
			let PickerRow::Suggestion { index, suggestion } = picker_row else {
				let PickerRow::Header(category) = picker_row else {
					unreachable!()
				};
				let style = Style::new().fg(pc.ctx.theme.border).bold();
				pc.frame.put(rect.x.saturating_add(2), row, category, style);
				offset = offset.saturating_add(1);
				continue;
			};
			let selected = index == picker.selected();
			let highlighted = selected || hovered == Some(index);
			let style = Style::new().fg(if highlighted {
				pc.ctx.theme.accent
			} else {
				pc.ctx.theme.muted
			});
			let mut x = pc.frame.put(
				rect.x,
				row,
				if selected {
					pc.ctx.charset.cursor()
				} else {
					"  "
				},
				style,
			);
			if icon_width > 0 {
				let icon_start = x;
				if let Some(icon) = suggestion.icon() {
					pc.frame.put(x, row, pc.ctx.charset.icon(icon), style);
				}
				x = icon_start.saturating_add(icon_width).saturating_add(1);
			}
			x = match suggestion.display() {
				SuggestionDisplay::Text(name) => {
					Self::paint_match_text(pc, x, row, name, suggestion.match_spans(), style)
				},
				SuggestionDisplay::Emoji { emoji, shortcode } => {
					let x = pc.frame.put(x, row, emoji, style);
					let x = pc.frame.put(x, row, "  :", style);
					let x = pc.frame.put(x, row, shortcode.trim_matches(':'), style);
					pc.frame.put(x, row, ":", style)
				},
			};
			offset = offset.saturating_add(1);
			let Some(description) = suggestion.description() else {
				continue;
			};
			let description_x = x.saturating_add(2);
			let description_width = right.saturating_sub(description_x);
			if description_width == 0 {
				continue;
			}
			let first_end = prefix_byte_at_width(description, description_width);
			pc.frame
				.put(description_x, row, &description[..first_end], style);
			let rest = description[first_end..].trim_start();
			if rest.is_empty() {
				continue;
			}
			if offset >= max_rows || y.saturating_add(offset) >= pc.clip {
				let truncated = truncate_to_width(description, description_width);
				pc.frame.put(description_x, row, truncated.text, style);
				if truncated.ellipsis {
					pc.frame.put(
						description_x.saturating_add(truncated.width.saturating_sub(1)),
						row,
						"…",
						style,
					);
				}
				continue;
			}
			let continuation = truncate_to_width(rest, description_width);
			let continuation_row = y.saturating_add(offset);
			pc.frame
				.put(description_x, continuation_row, continuation.text, style);
			if continuation.ellipsis {
				pc.frame.put(
					description_x.saturating_add(continuation.width.saturating_sub(1)),
					continuation_row,
					"…",
					style,
				);
			}
			offset = offset.saturating_add(1);
		}
	}

	fn paint_match_text(
		pc: &mut PaintCtx<'_>,
		mut x: u16,
		row: u16,
		text: &str,
		spans: &[(u16, u16)],
		style: Style,
	) -> u16 {
		let mut at = 0;
		for &(start, end) in spans {
			let start = usize::from(start).min(text.len());
			let end = usize::from(end).min(text.len());
			if start < at
				|| start >= end
				|| !text.is_char_boundary(start)
				|| !text.is_char_boundary(end)
			{
				continue;
			}
			x = pc.frame.put(x, row, &text[at..start], style);
			x = pc.frame.put(x, row, &text[start..end], style.bold());
			at = end;
		}
		pc.frame.put(x, row, &text[at..], style)
	}
}
fn prefix_byte_at_width(text: &str, width: u16) -> usize {
	let mut used = 0_u16;
	for (offset, grapheme) in text.grapheme_indices() {
		let next = used.saturating_add(cell_width(grapheme));
		if next > width {
			return offset;
		}
		used = next;
	}
	text.len()
}
fn word_range_at_cursor(text: &str, cursor: usize) -> Option<Range<usize>> {
	if cursor > text.len() || !text.is_char_boundary(cursor) {
		return None;
	}
	let start = text[..cursor]
		.char_indices()
		.rev()
		.find_map(|(at, character)| {
			(!character.is_alphabetic() && character != '\'').then_some(at + character.len_utf8())
		})
		.unwrap_or(0);
	let end = text[cursor..]
		.char_indices()
		.find_map(|(offset, character)| {
			(!character.is_alphabetic() && character != '\'').then_some(cursor + offset)
		})
		.unwrap_or(text.len());
	(start < end).then_some(start..end)
}

fn assistance_word_at_cursor(text: &str, cursor: usize) -> Option<Range<usize>> {
	word_range_at_cursor(text, cursor).or_else(|| {
		let boundary = text[..cursor].chars().next_back()?;
		is_word_boundary(boundary)
			.then(|| word_suffix_range(text, cursor.saturating_sub(boundary.len_utf8())))
			.flatten()
	})
}

/// Prose word-boundary class: whitespace or clause punctuation.
const fn is_word_boundary(character: char) -> bool {
	character.is_whitespace()
		|| matches!(character, '.' | ',' | ';' | ':' | '!' | '?' | '"' | ']' | ')' | '}')
}

/// Byte range of the `[letter']+` word ending exactly at `end`.
fn word_suffix_range(text: &str, end: usize) -> Option<Range<usize>> {
	if end > text.len() || !text.is_char_boundary(end) {
		return None;
	}
	let start = text[..end]
		.char_indices()
		.rev()
		.find_map(|(at, character)| {
			(!character.is_alphabetic() && character != '\'').then_some(at + character.len_utf8())
		})
		.unwrap_or(0);
	(start < end).then_some(start..end)
}

/// Partial prose word ending at the cursor that platform autocomplete may
/// extend: at least two characters, no word
/// character immediately after the cursor, and prose by [`is_prose_word`].
fn completion_prefix_range(
	text: &str,
	cursor: usize,
	mask: &[Range<usize>],
) -> Option<Range<usize>> {
	if cursor > text.len() || !text.is_char_boundary(cursor) {
		return None;
	}
	if text[cursor..]
		.chars()
		.next()
		.is_some_and(|character| character.is_alphabetic() || character == '\'')
	{
		return None;
	}
	let range = word_suffix_range(text, cursor)?;
	if text[range.clone()].chars().take(2).count() < 2 {
		return None;
	}
	is_prose_word(text, mask, &range).then_some(range)
}

/// Whether `range` is user prose eligible for spelling assistance: unmasked,
/// with no codeish characters or digits in the whitespace-delimited token, no
/// camelCase, and not on a slash-command or arrow-prefixed line.
fn is_prose_word(text: &str, mask: &[Range<usize>], range: &Range<usize>) -> bool {
	if range.start >= range.end || range.end > text.len() {
		return false;
	}
	if mask
		.iter()
		.any(|masked| masked.start < range.end && range.start < masked.end)
	{
		return false;
	}
	let token_start = text[..range.start]
		.char_indices()
		.rev()
		.find_map(|(at, character)| {
			character
				.is_whitespace()
				.then_some(at + character.len_utf8())
		})
		.unwrap_or(0);
	let token_end = text[range.end..]
		.char_indices()
		.find_map(|(at, character)| character.is_whitespace().then_some(range.end + at))
		.unwrap_or(text.len());
	let mut previous_lowercase = false;
	for character in text[token_start..token_end].chars() {
		if matches!(character, '\\' | '/' | '@' | '_' | '=' | ':' | '{' | '}' | '[' | ']' | '<' | '>')
			|| character.is_ascii_digit()
			|| (previous_lowercase && character.is_uppercase())
		{
			return false;
		}
		previous_lowercase = character.is_lowercase();
	}
	let line_start = text[..range.start].rfind('\n').map_or(0, |at| at + 1);
	let line_end = text[range.end..]
		.find('\n')
		.map_or(text.len(), |at| range.end + at);
	let line = &text[line_start..line_end];
	!line.trim_start().starts_with('/') && !line.starts_with("->") && !line.starts_with("=>")
}

impl Default for EditInput {
	fn default() -> Self {
		Self::new()
	}
}

impl Component for EditInput {
	fn props(&self) -> &Props {
		&self.props
	}

	fn props_mut(&mut self) -> &mut Props {
		&mut self.props
	}

	fn slot(&self) -> Slot {
		self.slot
	}

	fn measure(&mut self, _ctx: &UiContext) -> (u16, u16) {
		(20, 40)
	}

	fn height(&mut self, ctx: &UiContext, width: u16) -> u16 {
		let chrome = self.style.layout(ctx.charset);
		let minimum = 1_u16
			.saturating_add(chrome.top_rows)
			.saturating_add(chrome.bottom_rows);
		let max_rows = self.max_rows().max(minimum);
		let input_width = self.text_width(width, ctx.charset);
		let composer = self
			.editor
			.input_height_for(input_width)
			.max(1)
			.saturating_add(chrome.top_rows)
			.saturating_add(chrome.bottom_rows)
			.min(max_rows);
		composer
			.saturating_add(self.picker_height(ctx, width))
			.min(max_rows)
	}

	fn paint(&mut self, pc: &mut PaintCtx<'_>, rect: Rect) {
		let spelling_changed = self.spelling.poll(self.editor.text());
		if let Some((range, items)) = self.spelling.take_guesses()
			&& self.spelling_features.typo_detection
			&& let Some(guard) = self.guesses_guard.take()
			&& guard.text == self.editor.text()
			&& guard.cursor == self.editor.buffer().cursor()
			&& guard.range == range
		{
			let _ = self.editor.show_replacements(range, items);
		}
		if let Some((range, replacement)) = self.spelling.take_correction() {
			self.apply_autocorrect(&range, &replacement);
		}
		pc.hits
			.push(Hit { rect, slot: self.slot, tag: HitTag::Press });
		let focused = pc.focus == Some(self.slot);
		let text = self.editor.text();
		let mut ghost = None;
		if focused
			&& self.spelling_features.autocomplete
			&& let Some(range) =
				completion_prefix_range(text, self.editor.buffer().cursor(), &self.spelling_mask)
		{
			self.spelling.request_completion(text, range.clone());
			ghost = self.spelling.completion(text, &range);
		}
		let hint = self.editor.inline_hint().or(ghost);
		if spelling_changed {
			pc.wake(self.slot, pc.now);
		} else if self.spelling.awaiting() {
			pc.wake(self.slot, pc.now.saturating_add(time::Duration::from_millis(16)));
		}
		let atoms = self.editor.atom_ranges();
		let layout = self.style.layout(pc.ctx.charset);
		let input_width = self.text_width(rect.width, pc.ctx.charset);
		let minimum_composer = 1_u16
			.saturating_add(layout.top_rows)
			.saturating_add(layout.bottom_rows);
		let picker_height = self
			.picker_height(pc.ctx, rect.width)
			.min(rect.height.saturating_sub(minimum_composer));
		let composer_height = rect.height.saturating_sub(picker_height);
		let content_height = composer_height
			.saturating_sub(layout.top_rows)
			.saturating_sub(layout.bottom_rows)
			.max(1);
		let (rows, (first, visible, total)) = self
			.editor
			.view_rows_with_metrics(input_width, usize::from(content_height));
		let thumb = if total > visible && visible > 0 {
			let track = usize::from(content_height);
			let size = (visible.saturating_mul(track).saturating_add(total - 1) / total).max(1);
			let start =
				first.saturating_mul(track.saturating_sub(size)) / total.saturating_sub(visible);
			Some((start, start.saturating_add(size)))
		} else {
			None
		};
		// A `!` or `$` prefix recolors the composer chrome (here the prompt
		// gutter) for the whole draft.
		let prefix_mode = (self.prefix_classifier)(text).map(|accent| match accent {
			PrefixAccent::Bash => pc.ctx.theme.warn,
			PrefixAccent::Eval => pc.ctx.theme.info,
		});
		let shell = prefix_mode.is_some();
		let keyword_accent = !self.keyword_spans.is_empty();
		// The keyword gradient shimmers only while the prompt is focused and a
		// magic keyword is on screen; the
		// next frame decides whether to schedule another, so the chain stops
		// by itself when focus leaves or the keyword is deleted.
		let shimmer = focused && keyword_accent;
		let phase = if shimmer {
			pc.wake(self.slot, pc.now.saturating_add(KeywordGradient::SHIMMER_FRAME));
			anim::phase(pc.now, KeywordGradient::SHIMMER_PERIOD)
		} else {
			0.0
		};
		let active_color = if let Some(color) = prefix_mode {
			color
		} else if shimmer && (pc.now.as_millis() / 180).is_multiple_of(2) {
			pc.ctx.theme.secondary
		} else {
			pc.ctx.theme.accent
		};
		// Terminals without truecolor run a quantized theme (every token
		// indexed); the accent is the tell.
		let truecolor = matches!(pc.ctx.theme.accent, Color::Rgb(..));
		let edge = Style::new().fg(if shell || keyword_accent {
			active_color
		} else {
			pc.ctx.theme.border
		});
		let accent = Style::new().fg(if focused {
			active_color
		} else {
			pc.ctx.theme.muted
		});
		let surface = Style::new()
			.fg(
				pc.ctx
					.theme
					.foreground_on(pc.ctx.theme.fg, pc.ctx.theme.panel),
			)
			.bg(pc.ctx.theme.panel);
		let (tl, tr, bl, br, horizontal, vertical) = pc.ctx.charset.border(Border::Round);
		let right = rect.x.saturating_add(rect.width.saturating_sub(1));
		if layout.top_rows > 0 && rect.y < pc.clip {
			match self.style {
				ComposerStyle::Box | ComposerStyle::Pi => {
					pc.frame
						.put(rect.x, rect.y, tl.encode_utf8(&mut [0; 4]), edge);
					paint_glyphs(
						pc.frame,
						rect.x.saturating_add(1),
						rect.y,
						rect.width.saturating_sub(2),
						horizontal,
						edge,
					);
					pc.frame
						.put(right, rect.y, tr.encode_utf8(&mut [0; 4]), edge);
				},
				ComposerStyle::Claude | ComposerStyle::Rule => {
					paint_glyphs(pc.frame, rect.x, rect.y, rect.width, horizontal, edge);
				},
				ComposerStyle::Borderless | ComposerStyle::Field | ComposerStyle::Rail => {},
			}
		}
		let content_y = rect.y.saturating_add(layout.top_rows);
		// The focused caret row whose text ends at the caret keeps no right
		// chrome (box border, field cap, surface fill).
		let ime_tail_row = (self.ime_safe_cursor && focused)
			.then(|| {
				rows
					.iter()
					.position(|content| content.cursor_column == Some(cell_width(content.text)))
			})
			.flatten()
			.and_then(|row| u16::try_from(row).ok());
		for row in 0..content_height {
			let y = content_y.saturating_add(row);
			if y >= pc.clip {
				break;
			}
			let ime_tail = ime_tail_row == Some(row);
			match self.style {
				ComposerStyle::Box => {
					pc.frame
						.put(rect.x, y, vertical.encode_utf8(&mut [0; 4]), edge);
					if !ime_tail {
						pc.frame
							.put(right, y, vertical.encode_utf8(&mut [0; 4]), edge);
					}
				},
				ComposerStyle::Pi => {
					pc.frame
						.put(rect.x, y, vertical.encode_utf8(&mut [0; 4]), edge);
					let glyph = if thumb
						.is_some_and(|(start, end)| usize::from(row) >= start && usize::from(row) < end)
					{
						scrollbar_thumb(pc.ctx.charset)
					} else {
						vertical
					};
					pc.frame.put(
						right,
						y,
						glyph.encode_utf8(&mut [0; 4]),
						if glyph == vertical { edge } else { accent },
					);
				},
				ComposerStyle::Field | ComposerStyle::Rail => {
					// The IME tail row fills only up to the caret: rows[row]
					// exists whenever a tail was found on it.
					let fill_width = if ime_tail {
						rows
							.get(usize::from(row))
							.and_then(|content| content.cursor_column)
							.map_or(rect.width, |column| {
								layout.side_chrome.saturating_add(column).min(rect.width)
							})
					} else {
						rect.width
					};
					pc.frame.fill(Rect::new(rect.x, y, fill_width, 1), surface);
					if self.style == ComposerStyle::Field {
						let (left, right_cap) = field_caps(pc.ctx.charset);
						pc.frame
							.put(rect.x, y, left.encode_utf8(&mut [0; 4]), accent);
						if !ime_tail {
							pc.frame
								.put(right, y, right_cap.encode_utf8(&mut [0; 4]), accent);
						}
					} else {
						let rail = accent_rail(pc.ctx.charset, focused);
						pc.frame
							.put(rect.x, y, rail.encode_utf8(&mut [0; 4]), accent);
					}
				},
				ComposerStyle::Claude | ComposerStyle::Borderless | ComposerStyle::Rule => {},
			}
		}
		let buffer_start = text.as_ptr() as usize;
		let xml = self.editor.options().xml;
		let mut scanned = 0;
		let mut in_comment = false;
		for (row, content) in rows.iter().enumerate() {
			let y = content_y.saturating_add(u16::try_from(row).unwrap_or(u16::MAX));
			if y >= pc.clip {
				break;
			}
			let start = (content.text.as_ptr() as usize)
				.saturating_sub(buffer_start)
				.min(text.len());
			let mut runs = if xml {
				in_comment = xml_comment_state(&text[scanned..start], in_comment);
				let (runs, next_comment) = highlight_xml(content.text, &pc.ctx.theme, in_comment);
				in_comment = next_comment;
				runs
			} else {
				let mut runs = SmallVec::new();
				if !content.text.is_empty() {
					runs.push(SyntaxRun {
						start: 0,
						end:   content.text.len(),
						style: Style::new().fg(pc.ctx.theme.fg),
					});
				}
				runs
			};
			scanned = start.saturating_add(content.text.len()).min(text.len());
			let mut chips: SmallVec<(usize, usize, Style), 4> = SmallVec::new();
			for &(atom_start, atom_end) in &atoms {
				let from = atom_start.max(start);
				let to = atom_end.min(scanned);
				if from < to
					&& let Some(style) = chip_style(&text[atom_start..atom_end])
				{
					chips.push((from - start, to - start, style));
				}
			}
			runs = overlay_chip_runs(&runs, &chips, content.text.len());
			let mut keyword_runs: SmallVec<(usize, usize, Style), 16> = SmallVec::new();
			for &(keyword_start, keyword_end, keyword) in &self.keyword_spans {
				let from = keyword_start.max(start);
				let to = keyword_end.min(scanned);
				if from >= to {
					continue;
				}
				let palette = self.keyword_accent.palette(keyword, truecolor);
				let keyword_len = text[keyword_start..keyword_end].chars().count().max(1);
				let mut position = text[keyword_start..from].chars().count();
				// Coalesce consecutive characters that resolve to the same stop.
				let mut run: Option<(usize, usize, usize)> = None;
				for (offset, character) in text[from..to].char_indices() {
					let run_start = from - start + offset;
					let run_end = run_start + character.len_utf8();
					let stop = KeywordGradient::stop(position, keyword_len, phase);
					position += 1;
					match &mut run {
						Some((_, end, current)) if *current == stop => *end = run_end,
						_ => {
							if let Some((start, end, stop)) = run.take() {
								keyword_runs.push((start, end, Style::new().fg(palette[stop])));
							}
							run = Some((run_start, run_end, stop));
						},
					}
				}
				if let Some((start, end, stop)) = run {
					keyword_runs.push((start, end, Style::new().fg(palette[stop])));
				}
			}
			runs = overlay_chip_runs(&runs, &keyword_runs, content.text.len());
			let mut decoration_runs: SmallVec<(usize, usize, Style), 8> = SmallVec::new();
			for &(decoration_start, decoration_end, decoration) in &self.decoration_spans {
				let from = decoration_start.max(start);
				let to = decoration_end.min(scanned);
				if from < to {
					let style = match decoration {
						InlineAccent::Dim => Style::new().fg(pc.ctx.theme.muted).dim(),
						InlineAccent::Accent => Style::new().fg(pc.ctx.theme.accent),
					};
					decoration_runs.push((from - start, to - start, style));
				}
			}
			runs = overlay_chip_runs(&runs, &decoration_runs, content.text.len());
			if matches!(self.style, ComposerStyle::Field | ComposerStyle::Rail) {
				for run in &mut runs {
					run.style = run
						.style
						.fg(
							pc.ctx
								.theme
								.foreground_on(run.style.foreground_color(), pc.ctx.theme.panel),
						)
						.bg(pc.ctx.theme.panel);
				}
			}
			// Typo decoration is the last text-style layer. It adds only the
			// semantic undercurl, preserving syntax/keyword foreground,
			// field background, emphasis, and links under the hardware caret.
			let typos: &[TypoRange] = if self.spelling_features.typo_detection {
				self.spelling.typo_ranges()
			} else {
				&[]
			};
			let mut typo_runs: SmallVec<(usize, usize, Style), 8> = SmallVec::new();
			let mut typo_cursor = 0;
			for typo in typos {
				let from = typo.start.max(start);
				let to = typo.end.min(scanned);
				if from >= to || from < typo_cursor {
					continue;
				}
				let local_from = from - start;
				let local_to = to - start;
				for run in &runs {
					let run_from = run.start.max(local_from);
					let run_to = run.end.min(local_to);
					if run_from < run_to {
						let style = typo_squiggle_style(run.style, pc.ctx.theme.err);
						typo_runs.push((run_from, run_to, style));
					}
				}
				typo_cursor = to;
			}
			runs = overlay_chip_runs(&runs, &typo_runs, content.text.len());
			let mut x = rect.x.saturating_add(layout.side_chrome);
			if layout.gutter_width > 0 {
				if row == 0 {
					x = pc
						.frame
						.put(x, y, self.style.prompt_gutter(pc.ctx.charset), accent);
				} else {
					x = x.saturating_add(layout.gutter_width);
				}
			}
			let selection = self.editor.selection_span(content);
			let selection_bytes = selection.map(|(start, end)| {
				(byte_at_column(content.text, start), byte_at_column(content.text, end))
			});
			let cursor = (focused
				&& self.editor.caret_visible()
				&& (selection.is_none() || self.editor.volatile_active()))
			.then_some(content.cursor_column)
			.flatten()
			.map(|column| byte_at_column(content.text, column));
			paint_xml_range(
				pc.frame,
				x,
				y,
				content.text,
				&runs,
				0,
				content.text.len(),
				selection_bytes,
				pc.ctx.theme.selection,
			);
			// The hardware cursor alone marks the insertion point — the caret
			// cell keeps its text styling, so no
			// painted block competes with the terminal's own cursor (and
			// IMEs, screen readers, and PTY drivers see the real caret).
			if let Some(cursor) = cursor {
				pc.frame
					.set_cursor(x.saturating_add(cell_width(&content.text[..cursor])), y);
			}
			// Dim ghost text after an end-of-row cursor: the completion
			// engine's usage hint or the platform word completion.
			if let Some(hint) = &hint
				&& cursor == Some(content.text.len())
			{
				let hint_x = x.saturating_add(cell_width(content.text)).saturating_add(1);
				let hint_width = rect
					.x
					.saturating_add(layout.side_chrome)
					.saturating_add(layout.gutter_width)
					.saturating_add(input_width)
					.saturating_sub(hint_x);
				if hint_width > 0 {
					let mut style = Style::new().fg(pc.ctx.theme.muted).dim();
					if matches!(self.style, ComposerStyle::Field | ComposerStyle::Rail) {
						style = style
							.fg(
								pc.ctx
									.theme
									.foreground_on(style.foreground_color(), pc.ctx.theme.panel),
							)
							.bg(pc.ctx.theme.panel);
					}
					pc.frame
						.put(hint_x, y, truncate_to_width(hint, hint_width).text, style);
				}
			}
			if row == 0
				&& text.is_empty()
				&& let Some(placeholder) = self.props.str_of(Prop::Placeholder)
			{
				let mut style = Style::new().fg(pc.ctx.theme.muted).dim().italic();
				if matches!(self.style, ComposerStyle::Field | ComposerStyle::Rail) {
					style = style
						.fg(
							pc.ctx
								.theme
								.foreground_on(style.foreground_color(), pc.ctx.theme.panel),
						)
						.bg(pc.ctx.theme.panel);
				}
				pc.frame.put(x, y, placeholder, style);
			}
		}
		if layout.bottom_rows > 0 {
			let y = rect.y.saturating_add(composer_height.saturating_sub(1));
			if y < pc.clip {
				match self.style {
					ComposerStyle::Box | ComposerStyle::Pi => {
						pc.frame.put(rect.x, y, bl.encode_utf8(&mut [0; 4]), edge);
						paint_glyphs(
							pc.frame,
							rect.x.saturating_add(1),
							y,
							rect.width.saturating_sub(2),
							horizontal,
							edge,
						);
						pc.frame.put(right, y, br.encode_utf8(&mut [0; 4]), edge);
					},
					ComposerStyle::Claude => {
						paint_glyphs(pc.frame, rect.x, y, rect.width, horizontal, edge);
					},
					ComposerStyle::Borderless
					| ComposerStyle::Rule
					| ComposerStyle::Field
					| ComposerStyle::Rail => {},
				}
			}
		}
		self.paint_picker(pc, rect, rect.y.saturating_add(composer_height));
	}

	fn focusable(&self) -> bool {
		true
	}

	fn key(&mut self, ec: &mut EventCtx<'_>, key: Key) -> Flow {
		if key == Key::Ctrl('.')
			&& self.spelling_features.typo_detection
			&& let Some(range) =
				assistance_word_at_cursor(self.editor.text(), self.editor.buffer().cursor())
			&& is_prose_word(self.editor.text(), &self.spelling_mask, &range)
		{
			self.guesses_guard = Some(AssistanceGuard {
				text:   Str::new(self.editor.text()),
				cursor: self.editor.buffer().cursor(),
				range:  range.clone(),
			});
			self.spelling.request_guesses(self.editor.text(), range);
			return Flow::Consumed;
		}
		if self.accept_word_completion(key) {
			return Flow::Consumed;
		}
		if key == Key::Enter && self.props.flag(Prop::Submit) {
			// Enter on a command row with nothing before its token applies the
			// completion and submits it in one keypress.
			if self.editor.picker_enter_submits() {
				self.editor.accept_for_submit();
				self.refresh_keyword_spans();
				if self.reconcile(ec.ctx) {
					ec.request_layout();
				}
				return Flow::Event(UiEvent::Submit);
			}
			if self.editor.picker().is_none() {
				if !self.editor.text().trim().is_empty() {
					return Flow::Event(UiEvent::Submit);
				}
				return Flow::Consumed;
			}
		}

		// Prompt history comes first; only a draft edge that history does not
		// claim is handed to the host.
		if self.editor.picker().is_none()
			&& !self.editor.history_navigates(key)
			&& (matches!(key, Key::Up) && self.editor.buffer().at_visual_start()
				|| matches!(key, Key::Down) && self.editor.buffer().at_visual_end())
		{
			return Flow::Skip;
		}
		let key =
			if key == Key::Enter && !self.props.flag(Prop::Submit) && self.editor.picker().is_none() {
				Key::ShiftEnter
			} else {
				key
			};
		match self.editor.handle(key) {
			EditOutcome::Changed => {
				self.refresh_keyword_spans();
				self.request_autocorrect(key);
				if self.reconcile(ec.ctx) {
					// The pane's attachment band changed height outside this
					// leaf's own box.
					ec.request_layout();
				}
				match self.editor.take_copied() {
					// The host owns the clipboard write (OSC 52 / native).
					Some(text) => Flow::Event(UiEvent::Copied(text)),
					None => Flow::Consumed,
				}
			},
			EditOutcome::Submitted(_) | EditOutcome::Ignored => Flow::Skip,
		}
	}

	fn mouse(
		&mut self,
		ec: &mut EventCtx<'_>,
		_tag: HitTag,
		at: (u16, u16),
		rect: Rect,
		mouse: Mouse,
	) -> Flow {
		let layout = self.style.layout(ec.ctx.charset);
		let minimum_composer = 1_u16
			.saturating_add(layout.top_rows)
			.saturating_add(layout.bottom_rows);
		let picker_height = self
			.picker_height(ec.ctx, rect.width)
			.min(rect.height.saturating_sub(minimum_composer));
		let composer_height = rect.height.saturating_sub(picker_height);
		let local_row = at.1.saturating_sub(rect.y);
		if picker_height > 0 && local_row >= composer_height {
			let index =
				self.picker_hit_index(ec.ctx, rect.width, local_row.saturating_sub(composer_height));
			return match mouse {
				Mouse::Click => {
					if let Some(index) = index
						&& self.editor.click_picker(index) == EditOutcome::Changed
					{
						self.refresh_keyword_spans();
						ec.request_layout();
					}
					Flow::Consumed
				},
				Mouse::Move => Flow::Consumed,
				Mouse::WheelUp | Mouse::WheelDown => {
					let _ = self.editor.wheel_picker(mouse == Mouse::WheelDown);
					Flow::Consumed
				},
				Mouse::Release | Mouse::Drag => Flow::Consumed,
				Mouse::RightClick | Mouse::MiddleClick | Mouse::WheelLeft | Mouse::WheelRight => {
					Flow::Skip
				},
			};
		}
		match mouse {
			Mouse::Click => {
				let now = Instant::now();
				let same_cell = self.last_click.is_some_and(|(cell, then)| {
					cell == at && now.duration_since(then) <= Duration::from_millis(400)
				});
				let layout = self.style.layout(ec.ctx.charset);
				let row = usize::from(at.1.saturating_sub(rect.y).saturating_sub(layout.top_rows));
				let text_x = rect
					.x
					.saturating_add(layout.side_chrome)
					.saturating_add(layout.gutter_width);
				let column = at.0.saturating_sub(text_x);
				let width = self.text_width(rect.width, ec.ctx.charset);
				if same_cell {
					self.editor.select_word_visual_row(row, column, width);
					self.last_click = None;
				} else {
					self.editor.set_cursor_visual_row(row, column, width);
					self.last_click = Some((at, now));
				}
				self.dragging = true;
				Flow::Consumed
			},
			Mouse::Drag if self.dragging => {
				let layout = self.style.layout(ec.ctx.charset);
				let text_x = rect
					.x
					.saturating_add(layout.side_chrome)
					.saturating_add(layout.gutter_width);
				self.editor.extend_selection_visual_row(
					usize::from(at.1.saturating_sub(rect.y).saturating_sub(layout.top_rows)),
					at.0.saturating_sub(text_x),
					self.text_width(rect.width, ec.ctx.charset),
				);
				Flow::Consumed
			},
			Mouse::Release if self.dragging => {
				self.dragging = false;
				Flow::Consumed
			},
			Mouse::WheelUp | Mouse::WheelDown => {
				let delta = if mouse == Mouse::WheelUp { -1 } else { 1 };
				if self.editor.scroll_rows(
					delta,
					self.text_width(ec.width, ec.ctx.charset),
					self.page_rows(ec),
				) {
					Flow::Consumed
				} else {
					Flow::Skip
				}
			},
			Mouse::RightClick
			| Mouse::MiddleClick
			| Mouse::Move
			| Mouse::Drag
			| Mouse::Release
			| Mouse::WheelLeft
			| Mouse::WheelRight => Flow::Skip,
		}
	}

	fn paste(&mut self, ec: &mut EventCtx<'_>, text: &str) -> Flow {
		if let Some(attachments) = &self.attachments {
			let paths = dropped_paths(text);
			// Classification is all-or-nothing: every path must be previewable and
			// exist locally. A mixed, missing, or ambiguous payload falls through as
			// literal text so no pasted path disappears.
			let classified = paths
				.iter()
				.map(|path| {
					let kind = classify_attachment_path(path)?;
					let source = attachment_source_path(path)?;
					Path::new(source.as_str())
						.exists()
						.then_some((source, kind))
				})
				.collect::<Option<Vec<_>>>();
			if let Some(classified) = classified.filter(|paths| !paths.is_empty()) {
				// One gesture is one undo group. Staging and reference insertion
				// both preserve the source order from the paste payload.
				let references: Vec<_> = classified
					.into_iter()
					.map(|(source, kind)| {
						let attachment = match kind {
							PastedPathKind::Image => attachments.push_image(source),
							PastedPathKind::Video => attachments.push_video(source),
						};
						let marker = attachment
							.wire_marker()
							.expect("media attachments always have a wire marker");
						(chip_label(&attachment, ec.ctx.charset).to_string(), marker.to_string())
					})
					.collect();
				let _ = self.editor.insert_reference_group(&references, " ");
				self.refresh_keyword_spans();
				ec.request_layout();
				return Flow::Consumed;
			}
		}
		if self.attachments.is_some() && marker_sized_paste(text) {
			self.stage_text_attachment(text, None, ec.ctx.charset);
			ec.request_layout();
			return Flow::Consumed;
		}
		let sanitized = sanitize_paste(text);
		let path_prefix = matches!(sanitized.as_bytes().first(), Some(b'/' | b'~' | b'.'));
		let before_is_word = self.editor.text()[..self.editor.buffer().cursor()]
			.chars()
			.next_back()
			.is_some_and(|ch| ch.is_alphanumeric() || ch == '_');
		if path_prefix && before_is_word {
			let _ = self.editor.insert_text(" ");
		}
		if matches!(self.editor.insert_text(&sanitized), EditOutcome::Changed) {
			self.refresh_keyword_spans();
			Flow::Consumed
		} else {
			Flow::Skip
		}
	}

	fn paste_raw(&mut self, _ec: &mut EventCtx<'_>, text: &str) -> Flow {
		// Verbatim insertion: the text stays inline
		// and editable — no attachment staging, no large-paste chip, no
		// auto-spacing. Sanitization still applies inside `insert_text`.
		if matches!(self.editor.insert_text(text), EditOutcome::Changed) {
			self.refresh_keyword_spans();
			Flow::Consumed
		} else {
			Flow::Skip
		}
	}

	fn value(&self, out: &mut serde_json::Map<String, Value>) {
		if let Some(id) = self.props.id() {
			out.insert(id.to_string(), Value::String(self.editor.buffer().expanded_text()));
		}
	}

	fn set_text(&mut self, _ctx: &UiContext, text: Str) -> bool {
		if self.editor.text() == text {
			return false;
		}
		self.editor.set_text(&text);
		self.refresh_keyword_spans();
		true
	}
}

/// Attachment preview thumbnail content, in cells.
const PREVIEW_COLS: u16 = 12;
const PREVIEW_ROWS: u16 = 4;
/// Blank columns between adjacent preview frames.
const PREVIEW_GAP: u16 = 2;
/// One preview frame: thumbnail content plus its colored border.
const PREVIEW_BOX_COLS: u16 = PREVIEW_COLS + 2;
const PREVIEW_BOX_ROWS: u16 = PREVIEW_ROWS + 2;
/// Identity palette cycled by marker number; see [`attachment_color`].
const ATTACHMENT_COLORS: [Color; 6] = [
	Color::Rgb(255, 179, 102),
	Color::Rgb(125, 207, 255),
	Color::Rgb(189, 147, 249),
	Color::Rgb(105, 220, 158),
	Color::Rgb(255, 141, 188),
	Color::Rgb(240, 223, 120),
];

/// Identity color for attachment marker `N` (1-based).
///
/// The preview frame and any host-rendered reference chip share it, so an
/// attachment stays recognizable from composer to transcript.
pub const fn attachment_color(marker: usize) -> Color {
	ATTACHMENT_COLORS[marker.saturating_sub(1) % ATTACHMENT_COLORS.len()]
}

/// The composer chip text for one attachment: `<icon> #N` with the tier's
/// image or text-file glyph.
///
/// Hosts insert it as an atomic reference (see
/// [`crate::EditBuffer::insert_reference`]); [`EditInput`] does so
/// automatically for staged media path drops and large paste cards.
pub fn chip_label(attachment: &Attachment, charset: Charset) -> Str {
	attachment.preview_names[charset_index(charset)].clone()
}

const fn charset_index(charset: Charset) -> usize {
	match charset {
		Charset::Unicode => 0,
		Charset::NerdFont => 1,
		Charset::Ascii => 2,
	}
}

/// Chip style for an atomic marker: a trailing `#N` selects the marker's
/// identity color. `None` leaves other atoms on their base styling.
fn chip_style(marker: &str) -> Option<Style> {
	let digits = &marker[marker.rfind('#')? + 1..];
	if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
		return None;
	}
	let marker: usize = digits.parse().ok()?;
	(marker > 0).then(|| Style::new().fg(attachment_color(marker)).bold())
}

/// Whether a paste is "marker-sized" (more than ten lines or more than 1000
/// characters) and so collapses into an attachment
/// chip instead of flooding the buffer.
#[must_use]
pub fn marker_sized_paste(text: &str) -> bool {
	text.len() > 1000 || text.bytes().filter(|byte| *byte == b'\n').count() >= 10
}

/// Adds a semantic typo squiggle without replacing any existing text style.
///
/// Background does not participate in [`Style::inherit`], so it is carried
/// explicitly alongside foreground, emphasis, and hyperlink state.
const fn typo_squiggle_style(base: Style, error: Color) -> Style {
	Style::new()
		.undercurl()
		.underline_color(error)
		.inherit(base)
		.bg(base.background_color())
}

/// Splices chip-styled runs over one row's syntax runs; chips win where
/// they overlap. `len` is the row's byte length.
fn overlay_chip_runs(
	runs: &[SyntaxRun],
	chips: &[(usize, usize, Style)],
	len: usize,
) -> SmallVec<SyntaxRun, 16> {
	let mut merged: SmallVec<SyntaxRun, 16> = SmallVec::new();
	if chips.is_empty() {
		merged.extend_from_slice(runs);
		return merged;
	}
	let base = |at: usize| {
		runs
			.iter()
			.find(|run| run.start <= at && at < run.end)
			.map_or_else(
				|| {
					let next = runs
						.iter()
						.map(|run| run.start)
						.filter(|start| *start > at)
						.min()
						.unwrap_or(len);
					(next, Style::new())
				},
				|run| (run.end, run.style),
			)
	};
	fn emit(
		base: &impl Fn(usize) -> (usize, Style),
		from: usize,
		to: usize,
		merged: &mut SmallVec<SyntaxRun, 16>,
	) {
		let mut at = from;
		while at < to {
			let (run_end, style) = base(at);
			let end = run_end.min(to);
			merged.push(SyntaxRun { start: at, end, style });
			at = end;
		}
	}
	let mut at = 0;
	for &(start, end, style) in chips {
		emit(&base, at, start, &mut merged);
		merged.push(SyntaxRun { start, end, style });
		at = end;
	}
	emit(&base, at, len, &mut merged);
	merged
}

fn attachment_source_path(path: &str) -> Option<Str> {
	let Some(rest) = path.strip_prefix("~/") else {
		return Some(Str::new(path));
	};
	#[allow(deprecated, reason = "the standard-library home lookup matches shell path expansion")]
	let home = std::env::home_dir()?;
	Some(sf!("{}/{}", home.display(), rest))
}

/// One staged composer attachment.
#[derive(Clone)]
pub struct Attachment {
	/// What the attachment holds and how its preview card renders.
	pub content:   AttachmentContent,
	/// 1-based marker number (`#N`), stable until the queue is drained.
	pub marker:    usize,
	/// Identity color shared by the preview frame and chip highlights.
	pub color:     Color,
	preview_names: [Str; 3],
	size_label:    Str,
}

impl Attachment {
	/// Builds a descriptor, deriving the per-charset preview names and the
	/// size caption from `content` once at staging time.
	pub fn new(content: AttachmentContent, marker: usize, color: Color) -> Self {
		let icon = match &content {
			AttachmentContent::Image { .. } => Icon::Image,
			AttachmentContent::Video { .. } => Icon::Video,
			AttachmentContent::Text { .. } => Icon::TextFile,
		};
		let preview_names = [
			sf!("{} #{marker}", Charset::Unicode.icon(icon)),
			sf!("{} #{marker}", Charset::NerdFont.icon(icon)),
			sf!("{} #{marker}", Charset::Ascii.icon(icon)),
		];
		let size_label = match &content {
			AttachmentContent::Image { dimensions, .. } => {
				dimensions.map_or_else(Str::default, |(width, height)| sf!("{width}x{height}"))
			},
			AttachmentContent::Video { .. } => Str::default(),
			AttachmentContent::Text { lines, .. } if *lines > 1 => sf!("+{lines} lines"),
			AttachmentContent::Text { chars, .. } => sf!("{chars} chars"),
		};
		Self { content, marker, color, preview_names, size_label }
	}

	/// The submitted form of a media chip: `[Image #N, WxH]`, `[Image #N]`, or
	/// `[Video #N]`. The marker is
	/// positional — `#N` names the N-th media source handed to the host on
	/// submit. `None` for a collapsed text paste, whose submitted form is the
	/// paste itself.
	#[must_use]
	pub fn wire_marker(&self) -> Option<Str> {
		match &self.content {
			AttachmentContent::Image { dimensions, .. } => {
				Some(image_wire_marker(self.marker, *dimensions))
			},
			AttachmentContent::Video { .. } => Some(sf!("[Video #{}]", self.marker)),
			AttachmentContent::Text { .. } => None,
		}
	}
}

/// Positional image marker: `[Image #N, WxH]` / `[Image #N]`.
fn image_wire_marker(marker: usize, dimensions: Option<(u32, u32)>) -> Str {
	match dimensions {
		Some((width, height)) => sf!("[Image #{marker}, {width}x{height}]"),
		None => sf!("[Image #{marker}]"),
	}
}
/// Content behind one [`Attachment`].
#[derive(Clone)]
pub enum AttachmentContent {
	/// An image staged from a file source.
	Image {
		/// Image source path.
		source:     Str,
		/// Pixel dimensions probed from the source header, when recognized.
		dimensions: Option<(u32, u32)>,
	},
	/// A video staged from a file source.
	Video {
		/// Video source path.
		source: Str,
	},
	/// Pasted text collapsed out of the composer.
	Text {
		/// Complete pasted text delivered to the composer host on submit.
		text:    Str,
		/// Leading rows previewed inside the card, pre-clipped to the frame.
		snippet: Str,
		/// Logical line count of the paste.
		lines:   usize,
		/// Character count of the paste.
		chars:   usize,
	},
}

/// Shared handle to the attachments staged on an [`EditorPane`] composer.
///
/// The composer's owner keeps a clone (see [`EditorPane::attachments`]),
/// stages media with [`Attachments::push_image`] or [`Attachments::push_video`]
/// and collapsed pastes with [`Attachments::push_text`], then drains the queue
/// on submit with [`Attachments::take`]. The pane renders one framed card per
/// visible attachment above the editable surface, tinted with the attachment's
/// identity color and captioned with its `#N` marker plus pixel resolution or
/// size.
///
/// [`Attachments::set_visible`] reconciles the band with the composer text:
/// an attachment whose inline reference was deleted hides — and returns on
/// undo — without losing its marker number.
///
/// Mutations change the pane's height out of band, so the owner triggers a
/// relayout afterwards (e.g. [`crate::Ui::resize`] at the current width).
#[derive(Clone, Default)]
pub struct Attachments {
	state: Rc<RefCell<AttachmentState>>,
}

#[derive(Default)]
struct AttachmentState {
	staged:  Vec<Staged>,
	/// Monotonic media marker source; survives hides so numbers stay stable.
	/// Images/videos and text pastes number
	/// separately so vision markers stay positional over media alone.
	media:   usize,
	/// Monotonic text-chip marker source.
	texts:   usize,
	version: u64,
}

struct Staged {
	attachment: Attachment,
	hidden:     bool,
}

impl Attachments {
	/// Creates an empty attachment queue.
	pub fn new() -> Self {
		Self::default()
	}

	/// Stages an image source, probing its pixel dimensions from the file
	/// header, and returns the staged descriptor.
	pub fn push_image(&self, source: impl IntoStr) -> Attachment {
		let source = source.into_str();
		let dimensions = probe_dimensions(source.as_str());
		self.stage(AttachmentContent::Image { source, dimensions })
	}

	/// Stages a video source and returns the staged descriptor.
	pub fn push_video(&self, source: impl IntoStr) -> Attachment {
		self.stage(AttachmentContent::Video { source: source.into_str() })
	}

	/// Stages pasted text collapsed out of the composer and returns the
	/// staged descriptor.
	pub fn push_text(&self, text: &str) -> Attachment {
		let lines = text.bytes().filter(|byte| *byte == b'\n').count() + 1;
		let chars = text.chars().count();
		let mut snippet = String::new();
		for (index, line) in text.split('\n').take(usize::from(PREVIEW_ROWS)).enumerate() {
			if index > 0 {
				snippet.push('\n');
			}
			snippet.push_str(&line[..byte_at_column(line, PREVIEW_COLS)]);
		}
		self.stage(AttachmentContent::Text {
			text: Str::new(text),
			snippet: Str::from(snippet),
			lines,
			chars,
		})
	}

	fn stage(&self, content: AttachmentContent) -> Attachment {
		let mut state = self.state.borrow_mut();
		let counter = match content {
			AttachmentContent::Image { .. } | AttachmentContent::Video { .. } => &mut state.media,
			AttachmentContent::Text { .. } => &mut state.texts,
		};
		*counter += 1;
		let marker = *counter;
		let attachment = Attachment::new(content, marker, attachment_color(marker));
		state
			.staged
			.push(Staged { attachment: attachment.clone(), hidden: false });
		state.version += 1;
		attachment
	}

	/// Clones visible attachment descriptors without mutating the staged queue.
	pub fn snapshot(&self) -> Vec<Attachment> {
		self
			.state
			.borrow()
			.staged
			.iter()
			.filter(|staged| !staged.hidden)
			.map(|staged| staged.attachment.clone())
			.collect()
	}

	/// Drains the whole queue, restarting marker numbering, and returns
	/// the visible attachments in marker order. Hidden descriptors — whose
	/// inline references the user deleted — are discarded, never handed to
	/// the host.
	pub fn take(&self) -> Vec<Attachment> {
		let mut state = self.state.borrow_mut();
		if !state.staged.is_empty() {
			state.version += 1;
		}
		state.media = 0;
		state.texts = 0;
		mem::take(&mut state.staged)
			.into_iter()
			.filter(|staged| !staged.hidden)
			.map(|staged| staged.attachment)
			.collect()
	}

	/// Restores descriptors previously drained by [`Attachments::take`].
	///
	/// Queue-dequeue uses this to make a submitted follow-up editable again
	/// without re-reading image files or rebuilding collapsed-paste previews.
	pub fn restore(&self, attachments: Vec<Attachment>) {
		if attachments.is_empty() {
			return;
		}
		let mut state = self.state.borrow_mut();
		for attachment in attachments {
			let counter = match attachment.content {
				AttachmentContent::Image { .. } | AttachmentContent::Video { .. } => &mut state.media,
				AttachmentContent::Text { .. } => &mut state.texts,
			};
			*counter = (*counter).max(attachment.marker);
			state.staged.push(Staged { attachment, hidden: false });
		}
		state.version += 1;
	}

	/// Shows exactly the attachments `visible` accepts and hides the rest
	/// (ones whose inline reference was deleted), returning whether
	/// anything changed. Hidden attachments stay staged, so an undo can
	/// bring them back.
	pub fn set_visible(&self, mut visible: impl FnMut(&Attachment) -> bool) -> bool {
		let mut state = self.state.borrow_mut();
		let mut changed = false;
		for staged in &mut state.staged {
			let hide = !visible(&staged.attachment);
			changed |= staged.hidden != hide;
			staged.hidden = hide;
		}
		if changed {
			state.version += 1;
		}
		changed
	}

	/// Number of visible attachments.
	pub fn len(&self) -> usize {
		self
			.state
			.borrow()
			.staged
			.iter()
			.filter(|staged| !staged.hidden)
			.count()
	}

	/// Whether no attachment is visible.
	pub fn is_empty(&self) -> bool {
		self.len() == 0
	}
}

/// Probes `source`'s pixel dimensions from its header bytes.
fn probe_dimensions(source: &str) -> Option<(u32, u32)> {
	let bytes = fs::read(source).ok()?;
	let probed = dimensions(&bytes)?;
	Some((probed.width, probed.height))
}

/// Editor shell with replaceable editable content, status chrome, and an
/// attachment preview band.
///
/// `placeholder` paints muted empty-state text, while `max-rows` caps the
/// viewport and leaves cursor-following scroll management to the edit buffer.
pub struct EditorPane {
	props:       Props,
	slot:        Slot,
	/// `[input, status?, previews..]`; previews start at
	/// [`EditorPane::preview_start`].
	children:    SmallVec<Cached, 2>,
	style:       ComposerStyle,
	has_status:  bool,
	attachments: Attachments,
	/// Attachment-state version the preview children were built from.
	synced:      u64,
	/// Preview band rectangle captured at place time; zero when empty.
	band:        Rect,
}

impl EditorPane {
	/// Creates an editor shell with a default [`EditInput`].
	pub fn new() -> Self {
		let attachments = Attachments::new();
		let mut children = SmallVec::new();
		children.push(Cached::new(Box::new(
			EditInput::new()
				.composer_style(ComposerStyle::default())
				.attachments(attachments.clone()),
		)));
		Self {
			props: Props::new(),
			slot: next_slot(),
			children,
			style: ComposerStyle::default(),
			has_status: false,
			attachments,
			synced: 0,
			band: Rect::new(0, 0, 0, 0),
		}
	}

	/// Replaces the editable leaf.
	pub fn input(mut self, input: impl IntoComponent) -> Self {
		self.children[0] = Cached::new(input.into_component());
		self
	}

	/// Selects built-in chrome for the editable surface and status placement.
	pub fn composer_style(mut self, style: ComposerStyle) -> Self {
		self.set_composer_style(style);
		self
	}

	/// Replaces built-in chrome for the editable surface and status placement.
	pub fn set_composer_style(&mut self, style: ComposerStyle) {
		self.style = style;
		if let Some(input) = self.children[0].comp_mut().downcast_mut::<EditInput>() {
			input.set_composer_style(style);
			self.children[0].invalidate();
		}
	}

	/// Enables an IME-safe cursor layout on the editable surface; see
	/// [`EditInput::set_ime_safe_cursor`].
	pub fn ime_safe_cursor(mut self, enabled: bool) -> Self {
		self.set_ime_safe_cursor(enabled);
		self
	}

	/// Toggles the IME-safe cursor layout at runtime.
	pub fn set_ime_safe_cursor(&mut self, enabled: bool) {
		if let Some(input) = self.children[0].comp_mut().downcast_mut::<EditInput>() {
			input.set_ime_safe_cursor(enabled);
			self.children[0].invalidate();
		}
	}

	/// Caps the editable surface at `rows` (`max-rows`), the terminal-size
	/// budget hosts recompute on resize.
	pub fn set_max_rows(&mut self, rows: u16) {
		let input = &mut self.children[0];
		if input.comp().props().max_rows() == Some(rows) {
			return;
		}
		input.comp_mut().props_mut().set(Prop::MaxRows, rows);
		input.invalidate();
	}

	/// Selects the data-driven composer keyword accent policy.
	pub fn keyword_accent(mut self, accent: KeywordAccent) -> Self {
		self.set_keyword_accent(accent);
		self
	}

	/// Replaces the data-driven composer keyword accent policy.
	pub fn set_keyword_accent(&mut self, accent: KeywordAccent) {
		if let Some(input) = self.children[0].comp_mut().downcast_mut::<EditInput>() {
			input.set_keyword_accent(accent);
			self.children[0].invalidate();
		}
	}

	/// Installs chat-host queue-shorthand decoration and refreshes its spans.
	pub fn set_inline_decorator(&mut self, decorator: Option<InlineDecorator>) {
		if let Some(input) = self.children[0].comp_mut().downcast_mut::<EditInput>() {
			input.set_inline_decorator(decorator);
			self.children[0].invalidate();
		}
	}

	/// Installs the host's leading-sigil grammar for chrome recoloring; see
	/// [`EditInput::set_prefix_classifier`].
	pub fn set_prefix_classifier(&mut self, classifier: PrefixClassifier) {
		if let Some(input) = self.children[0].comp_mut().downcast_mut::<EditInput>() {
			input.set_prefix_classifier(classifier);
			self.children[0].invalidate();
		}
	}

	/// The chrome accent the current draft's leading sigil selects.
	#[must_use]
	pub fn prefix_accent(&self) -> Option<PrefixAccent> {
		self.children[0]
			.comp()
			.downcast_ref::<EditInput>()
			.and_then(EditInput::prefix_accent)
	}

	/// Selects native editor spelling features.
	pub fn spelling_features(mut self, features: SpellingFeatures) -> Self {
		self.set_spelling_features(features);
		self
	}

	/// Applies native editor spelling feature gates immediately.
	pub fn set_spelling_features(&mut self, features: SpellingFeatures) {
		if let Some(input) = self.children[0].comp_mut().downcast_mut::<EditInput>() {
			input.set_spelling_features(features);
			self.children[0].invalidate();
		}
	}

	/// Native spelling feature gates the editable surface currently applies.
	pub fn active_spelling_features(&self) -> SpellingFeatures {
		self.children[0]
			.comp()
			.downcast_ref::<EditInput>()
			.map_or_else(SpellingFeatures::default, EditInput::active_spelling_features)
	}

	/// Replaces the editable surface's feature switches at runtime.
	pub fn set_editor_options(&mut self, options: EditorOptions) {
		if let Some(input) = self.children[0].comp_mut().downcast_mut::<EditInput>() {
			input.set_editor_options(options);
			self.children[0].invalidate();
		}
	}

	/// Stages a text-attachment chip on the editable surface; see
	/// [`EditInput::stage_text_attachment`]. The caller relayouts (the band
	/// grew).
	pub fn stage_text_attachment(
		&mut self,
		text: &str,
		expansion: Option<&str>,
		charset: Charset,
	) -> bool {
		let Some(input) = self.children[0].comp_mut().downcast_mut::<EditInput>() else {
			return false;
		};
		let staged = input.stage_text_attachment(text, expansion, charset);
		self.children[0].invalidate();
		staged
	}

	/// The editable surface's feature switches currently in force.
	pub fn editor_options(&self) -> EditorOptions {
		self.children[0]
			.comp()
			.downcast_ref::<EditInput>()
			.map_or_else(EditorOptions::default, EditInput::editor_options)
	}

	/// Returns the active composer chrome.
	pub const fn style(&self) -> ComposerStyle {
		self.style
	}

	/// Sets the composer's completion source (for example, slash commands).
	pub fn completion(mut self, completion: Box<dyn Completion>) -> Self {
		self.set_completion(completion);
		self
	}

	/// Replaces the composer's completion source.
	pub fn set_completion(&mut self, completion: Box<dyn Completion>) {
		self.input_mut().set_completion(completion);
	}

	/// Shows or replaces one volatile speech-recognition preview.
	pub fn set_volatile_text(&mut self, text: &str) {
		self.input_mut().set_volatile_text(text);
		self.children[0].invalidate();
	}

	/// Shows or replaces native-IME marked text and its byte-indexed
	/// selection inside the marked span.
	pub fn set_volatile_text_selection(&mut self, text: &str, selection: Option<Range<usize>>) {
		self
			.input_mut()
			.set_volatile_text_selection(text, selection);
		self.children[0].invalidate();
	}

	/// Discards the active volatile speech-recognition preview.
	pub fn clear_volatile_text(&mut self) {
		self.input_mut().clear_volatile_text();
		self.children[0].invalidate();
	}

	/// Commits one finalized speech-recognition segment as an editor edit.
	pub fn commit_volatile_text(&mut self, text: &str) {
		self.input_mut().commit_volatile_text(text);
		self.children[0].invalidate();
	}

	/// Moves the caret to the start or end of the whole draft.
	pub fn move_to_message_edge(&mut self, end: bool) {
		self.input_mut().move_to_message_edge(end);
		self.children[0].invalidate();
	}

	/// Undoes the last edit made before the just-removed `transient`
	/// trigger text.
	pub fn undo_past_transient(&mut self, transient: &str) {
		self.input_mut().undo_past_transient(transient);
		self.children[0].invalidate();
	}

	/// Records a submitted prompt for Up/Down recall.
	pub fn add_to_history(&mut self, text: &str) {
		self.input_mut().add_to_history(text);
	}

	/// Replaces the Up/Down prompt history, newest first.
	pub fn seed_history(&mut self, prompts: impl IntoIterator<Item = Str>) {
		self.input_mut().seed_history(prompts);
	}

	fn input_mut(&mut self) -> &mut EditInput {
		self.children[0]
			.comp_mut()
			.downcast_mut::<EditInput>()
			.expect("editor actions require the default editor input")
	}

	/// Adds or replaces the composer status component.
	pub fn status(mut self, status: impl IntoComponent) -> Self {
		let status = Cached::new(status.into_component());
		if self.has_status {
			self.children[1] = status;
		} else {
			self.children.insert(1, status);
			self.has_status = true;
		}
		self
	}

	/// Shared handle to this composer's staged attachments.
	pub fn attachments(&self) -> Attachments {
		self.attachments.clone()
	}

	/// Index of the first image-preview child: input, then the optional
	/// status.
	fn preview_start(&self) -> usize {
		1 + usize::from(self.has_status)
	}

	/// Rows of the preview band: framed cards plus a blank spacer row before
	/// the editable surface.
	fn band_rows(&self) -> u16 {
		if self.attachments.is_empty() {
			0
		} else {
			PREVIEW_BOX_ROWS + 1
		}
	}

	/// Rebuilds the image-preview children when the shared attachment
	/// queue changed.
	fn sync_attachments(&mut self) {
		let state = self.attachments.state.borrow();
		if state.version == self.synced {
			return;
		}
		self.synced = state.version;
		let keep = 1 + usize::from(self.has_status);
		self.children.truncate(keep);
		for staged in state.staged.iter().filter(|staged| !staged.hidden) {
			if let AttachmentContent::Image { source, .. } = &staged.attachment.content {
				self.children.push(Cached::new(Box::new(
					Img::new()
						.with(Prop::Src, source.clone())
						.with(Prop::W, PREVIEW_COLS)
						.with(Prop::H, PREVIEW_ROWS)
						.with(Prop::Trim, true),
				)));
			}
		}
	}

	/// Paints each attachment card: a rounded frame tinted with its
	/// identity color, captioned `<icon> #N` on the top edge and the pixel
	/// resolution or paste size on the bottom edge. Image cards hold a
	/// thumbnail; paste cards preview the leading text.
	fn paint_previews(&mut self, pc: &mut PaintCtx<'_>) {
		if self.band.height == 0 {
			return;
		}
		let (tl, tr, bl, br, horizontal, vertical) = pc.ctx.charset.border(Border::Round);
		let handle = self.attachments.clone();
		let state = handle.state.borrow();
		let right_limit = self.band.x.saturating_add(self.band.width);
		let top = self.band.y;
		let bottom = top.saturating_add(PREVIEW_BOX_ROWS.saturating_sub(1));
		let snippet_style = Style::new().fg(pc.ctx.theme.muted);
		let mut glyph = [0_u8; 4];
		let mut x = self.band.x;
		let mut image_child = self.preview_start();
		for staged in state.staged.iter().filter(|staged| !staged.hidden) {
			let attachment = &staged.attachment;
			if x.saturating_add(PREVIEW_BOX_COLS) > right_limit {
				break;
			}
			let line = Style::new().fg(attachment.color);
			let label = line.bold();
			let name = &attachment.preview_names[charset_index(pc.ctx.charset)];
			frame_caption_row(pc, x, top, PREVIEW_BOX_COLS, (tl, tr, horizontal), name, line, label);
			frame_caption_row(
				pc,
				x,
				bottom,
				PREVIEW_BOX_COLS,
				(bl, br, horizontal),
				attachment.size_label.as_str(),
				line,
				label,
			);
			let rail = vertical.encode_utf8(&mut glyph);
			let frame_right = x.saturating_add(PREVIEW_BOX_COLS.saturating_sub(1));
			for row in top.saturating_add(1)..bottom {
				if row >= pc.clip {
					break;
				}
				pc.frame.put(x, row, rail, line);
				pc.frame.put(frame_right, row, rail, line);
			}
			match &attachment.content {
				AttachmentContent::Image { .. } => {
					if let Some(child) = self.children.get_mut(image_child) {
						if child.visible {
							child.paint(pc);
						}
						image_child += 1;
					}
				},
				AttachmentContent::Video { source } => {
					let label = Path::new(source.as_str())
						.file_name()
						.and_then(|name| name.to_str())
						.unwrap_or(source.as_str());
					pc.frame.put(
						x.saturating_add(1),
						top.saturating_add(1),
						&label[..byte_at_column(label, PREVIEW_COLS)],
						snippet_style,
					);
				},
				AttachmentContent::Text { snippet, .. } => {
					for (offset, text) in snippet.as_str().split('\n').enumerate() {
						let y = top
							.saturating_add(1)
							.saturating_add(u16::try_from(offset).unwrap_or(u16::MAX));
						if y >= bottom || y >= pc.clip {
							break;
						}
						pc.frame.put(x.saturating_add(1), y, text, snippet_style);
					}
				},
			}
			x = x
				.saturating_add(PREVIEW_BOX_COLS)
				.saturating_add(PREVIEW_GAP);
		}
	}

	/// Sets one editor-shell property.
	pub fn with(mut self, prop: Prop, value: impl Into<PropValue>) -> Self {
		let value = value.into();
		if matches!(
			prop,
			Prop::Id | Prop::Value | Prop::Submit | Prop::Placeholder | Prop::MaxRows | Prop::Rail
		) {
			self.children[0]
				.comp_mut()
				.props_mut()
				.set(prop, value.clone());
			match prop {
				// The shell mirrors the input's id so id-based typed lookups
				// (`Ui::update_component::<EditorPane>`) resolve the pane;
				// the input keeps it for focus, value, and submit routing.
				Prop::Id => self.props.set(prop, value),
				Prop::Value => {
					if let PropValue::Str(text) = &value {
						self.children[0]
							.comp_mut()
							.set_text(&UiContext::default(), text.clone());
					}
				},
				Prop::Rail => {
					let style = if matches!(value, PropValue::Bool(true)) {
						ComposerStyle::Rail
					} else {
						ComposerStyle::default()
					};
					self.set_composer_style(style);
				},
				_ => {},
			}
		} else {
			self.props.set(prop, value);
		}
		self
	}

	/// Sets one editor-shell property from a string.
	pub fn with_str(self, prop: Prop, value: &str) -> Self {
		self.with(prop, value)
	}

	/// Reports whether the default editable leaf's cursor is on its first
	/// logical line.
	///
	/// Returns `false` when the pane's editable leaf was replaced by a custom
	/// component that cannot expose cursor state.
	pub fn cursor_on_first_line(&self) -> bool {
		self.children[0]
			.comp()
			.downcast_ref::<EditInput>()
			.is_some_and(EditInput::cursor_on_first_line)
	}

	/// Reports whether the default editable leaf's cursor is on its last
	/// logical line.
	///
	/// Returns `false` when the pane's editable leaf was replaced by a custom
	/// component that cannot expose cursor state.
	pub fn cursor_on_last_line(&self) -> bool {
		self.children[0]
			.comp()
			.downcast_ref::<EditInput>()
			.is_some_and(EditInput::cursor_on_last_line)
	}

	#[cfg(test)]
	pub(crate) fn buffer(&self) -> &EditBuffer {
		self.children[0]
			.comp()
			.downcast_ref::<EditInput>()
			.expect("default editor input was replaced")
			.buffer()
	}

	/// Returns the composer line containing the cursor, for host copy-line
	/// actions; empty when the editable leaf was replaced by a custom
	/// component.
	pub fn current_line(&self) -> &str {
		self.children[0]
			.comp()
			.downcast_ref::<EditInput>()
			.map_or("", EditInput::current_line)
	}

	/// Text as displayed, with attachment chips collapsed to their markers
	/// (the `value` expands them); empty when the editable leaf was replaced.
	pub fn displayed_text(&self) -> &str {
		self.children[0]
			.comp()
			.downcast_ref::<EditInput>()
			.map_or("", |input| input.editor.text())
	}

	/// Whether the completion dropdown is open under the editable surface.
	pub fn popup_open(&self) -> bool {
		self.children[0]
			.comp()
			.downcast_ref::<EditInput>()
			.is_some_and(|input| input.editor.picker().is_some())
	}

	#[cfg(test)]
	pub(crate) fn replace_external(&mut self, text: &str, cursor_at_start: bool) {
		self.children[0]
			.comp_mut()
			.downcast_mut::<EditInput>()
			.expect("default editor input was replaced")
			.editor
			.replace_external(text, cursor_at_start);
	}
}

impl Default for EditorPane {
	fn default() -> Self {
		Self::new()
	}
}

impl Component for EditorPane {
	fn props(&self) -> &Props {
		&self.props
	}

	fn props_mut(&mut self) -> &mut Props {
		&mut self.props
	}

	fn slot(&self) -> Slot {
		self.slot
	}

	fn children(&self) -> &[Cached] {
		&self.children
	}

	fn children_mut(&mut self) -> &mut [Cached] {
		&mut self.children
	}

	fn ring(&self, out: &mut Vec<Slot>) {
		self.children[0].comp().ring(out);
	}

	fn measure(&mut self, ctx: &UiContext) -> (u16, u16) {
		self.sync_attachments();
		self.children[0].measure(ctx)
	}

	fn height(&mut self, ctx: &UiContext, width: u16) -> u16 {
		self.sync_attachments();
		let input = self.children[0].height(ctx, width);
		let status = if self.has_status {
			self.style.standalone_status_rows()
		} else {
			0
		};
		input
			.saturating_add(status)
			.saturating_add(self.band_rows())
	}

	fn place(&mut self, ctx: &UiContext, rect: Rect) {
		self.sync_attachments();
		let band = self.band_rows();
		let layout = self.style.layout(ctx.charset);
		let status_height = if self.has_status {
			self.style.standalone_status_rows()
		} else {
			0
		};
		let editor_height = rect
			.height
			.saturating_sub(band)
			.saturating_sub(status_height);
		let editor_y = rect
			.y
			.saturating_add(band)
			.saturating_add(if layout.status_before_input {
				status_height
			} else {
				0
			});
		self.children[0].place(ctx, Rect::new(rect.x, editor_y, rect.width, editor_height));
		if self.has_status {
			let status = &mut self.children[1];
			let _ = status.measure(ctx);
			let _ = status.height(ctx, rect.width);
			// Standalone status sits on the last reserved row below the input
			// (a `status_gap` layout leaves the row before it blank); a rule
			// chip paints over the input's own top rule and gets the whole
			// surface.
			let status_rect = if layout.status_before_input {
				Rect::new(rect.x, rect.y.saturating_add(band), rect.width, status_height)
			} else if layout.status_attachment == ComposerStatusAttachment::Standalone {
				let status_y = editor_y
					.saturating_add(editor_height)
					.saturating_add(status_height.saturating_sub(1));
				Rect::new(rect.x, status_y, rect.width, status_height.min(1))
			} else {
				Rect::new(rect.x, editor_y, rect.width, editor_height.saturating_add(status_height))
			};
			status.place(ctx, status_rect);
		}
		self.band =
			Rect::new(rect.x, rect.y, rect.width, if band > 0 { PREVIEW_BOX_ROWS } else { 0 });
		let right = rect.x.saturating_add(rect.width);
		let handle = self.attachments.clone();
		let state = handle.state.borrow();
		let mut x = rect.x;
		let mut image_child = self.preview_start();
		for staged in state.staged.iter().filter(|staged| !staged.hidden) {
			let fits = x.saturating_add(PREVIEW_BOX_COLS) <= right;
			if matches!(staged.attachment.content, AttachmentContent::Image { .. })
				&& let Some(child) = self.children.get_mut(image_child)
			{
				image_child += 1;
				child.visible = fits;
				if fits {
					let _ = child.measure(ctx);
					let _ = child.height(ctx, PREVIEW_COLS);
					child.place(
						ctx,
						Rect::new(
							x.saturating_add(1),
							rect.y.saturating_add(1),
							PREVIEW_COLS,
							PREVIEW_ROWS,
						),
					);
				}
			}
			if fits {
				x = x
					.saturating_add(PREVIEW_BOX_COLS)
					.saturating_add(PREVIEW_GAP);
			}
		}
	}

	fn paint(&mut self, pc: &mut PaintCtx<'_>, rect: Rect) {
		if self.children[0].rect.width == 0 {
			self.place(pc.ctx, rect);
		}
		self.children[0].paint(pc);
		if self.has_status {
			self.children[1].paint(pc);
		}
		self.paint_previews(pc);
	}

	fn paints_border(&self) -> bool {
		false
	}

	fn value(&self, out: &mut serde_json::Map<String, Value>) {
		self.children[0].comp().value(out);
	}

	fn set_text(&mut self, ctx: &UiContext, text: Str) -> bool {
		let input = &mut self.children[0];
		let changed = input.comp_mut().set_text(ctx, text);
		if changed {
			input.invalidate();
		}
		changed
	}
}

/// Paints one preview-frame edge: corners, rule fill, and an optional
/// centered caption set off by single spaces.
fn frame_caption_row(
	pc: &mut PaintCtx<'_>,
	x: u16,
	y: u16,
	width: u16,
	(left, right, horizontal): (char, char, char),
	caption: &str,
	line: Style,
	label: Style,
) {
	if y >= pc.clip || width < 2 {
		return;
	}
	let mut glyph = [0_u8; 4];
	let right_x = x.saturating_add(width.saturating_sub(1));
	let mut at = pc.frame.put(x, y, left.encode_utf8(&mut glyph), line);
	let caption_width = u16::try_from(xutf::width_str(caption)).unwrap_or(u16::MAX);
	if !caption.is_empty() && caption_width.saturating_add(2) <= width.saturating_sub(2) {
		let lead = (width.saturating_sub(2) - caption_width.saturating_add(2)) / 2;
		let caption_x = at.saturating_add(lead);
		for column in at..caption_x {
			pc.frame
				.put(column, y, horizontal.encode_utf8(&mut glyph), line);
		}
		at = pc.frame.put(caption_x, y, " ", line);
		at = pc.frame.put(at, y, caption, label);
		at = pc.frame.put(at, y, " ", line);
	}
	for column in at..right_x {
		pc.frame
			.put(column, y, horizontal.encode_utf8(&mut glyph), line);
	}
	pc.frame
		.put(right_x, y, right.encode_utf8(&mut glyph), line);
}

fn paint_xml_range(
	frame: &mut Frame,
	mut x: u16,
	y: u16,
	text: &str,
	runs: &[SyntaxRun],
	start: usize,
	end: usize,
	selection: Option<(usize, usize)>,
	selection_color: Color,
) -> u16 {
	for run in runs {
		let from = run.start.max(start);
		let to = run.end.min(end);
		if from >= to {
			continue;
		}
		let Some((selection_start, selection_end)) = selection else {
			x = frame.put(x, y, &text[from..to], run.style);
			continue;
		};
		let selected_from = from.max(selection_start);
		let selected_to = to.min(selection_end);
		if selected_from >= selected_to {
			x = frame.put(x, y, &text[from..to], run.style);
			continue;
		}
		if from < selected_from {
			x = frame.put(x, y, &text[from..selected_from], run.style);
		}
		x = frame.put(x, y, &text[selected_from..selected_to], run.style.bg(selection_color));
		if selected_to < to {
			x = frame.put(x, y, &text[selected_to..to], run.style);
		}
	}
	x
}

#[cfg(test)]
mod tests {
	use std::{env, fs, path::PathBuf};

	use super::*;
	use crate::{
		Color, Icon, Renderer, SlashCommands, Ui,
		components::{ContextGaugeMode, Input, Segment, Status, StatusPlacement},
		context::{Charset, UiContext},
		editcore::Command,
		frame::{Frame, Size, Underline},
		test_support::frame_row_text,
	};
	fn temp_drop_file(test: &str, name: &str, bytes: &[u8]) -> PathBuf {
		let dir = env::temp_dir().join(format!("omp-editor-drop-{test}-{}", std::process::id()));
		fs::create_dir_all(&dir).unwrap();
		let path = dir.join(name);
		fs::write(&path, bytes).unwrap();
		path
	}

	fn editor_pane(ui: &Ui) -> &EditorPane {
		ui.root()
			.comp()
			.downcast_ref::<EditorPane>()
			.expect("UI root is an editor pane")
	}
	fn edit_input(ui: &Ui) -> &EditInput {
		ui.root()
			.comp()
			.downcast_ref::<EditInput>()
			.expect("UI root is an editor input")
	}

	fn assist_features(autocomplete: bool, autocorrect: bool) -> SpellingFeatures {
		SpellingFeatures { typo_detection: false, autocomplete, autocorrect }
	}

	#[test]
	fn completion_prefix_gating_mirrors_pi_prose_rules() {
		// Eligible: cursor at the end of a two-plus character prose word.
		assert_eq!(completion_prefix_range("say recei", 9, &[]), Some(4..9));
		// A word character after the cursor means mid-word: ineligible.
		assert_eq!(completion_prefix_range("say recei", 6, &[]), None);
		// Single-character prefixes never complete.
		assert_eq!(completion_prefix_range("say a", 5, &[]), None);
		// Codeish tokens, camelCase, and digits are not prose.
		assert_eq!(completion_prefix_range("src/recei", 9, &[]), None);
		assert_eq!(completion_prefix_range("getFoo", 6, &[]), None);
		assert_eq!(completion_prefix_range("x2recei", 7, &[]), None);
		// Slash-command and arrow-prefixed lines are ineligible.
		assert_eq!(completion_prefix_range("/model recei", 12, &[]), None);
		assert_eq!(completion_prefix_range("-> recei", 8, &[]), None);
		// Masked spans (code ranges, atomic chips) are ineligible.
		assert_eq!(completion_prefix_range("say recei", 9, &[4..9]), None);
	}

	#[test]
	fn tab_accepts_word_completion_with_trailing_space() {
		let mut input = EditInput::new().with(Prop::Value, "recei");
		input.set_spelling_features(assist_features(true, false));
		input.spelling.seed_completion("recei", 0..5, "ved");
		let mut ui = Ui::from_root(input, 40, UiContext::default());
		ui.focus_first();
		ui.handle_key(Key::Tab);
		assert_eq!(edit_input(&ui).buffer().text(), "received ");
	}

	#[test]
	fn right_arrow_accepts_word_completion_only_at_logical_line_end() {
		let mut input = EditInput::new().with(Prop::Value, "recei");
		input.set_spelling_features(assist_features(true, false));
		input.spelling.seed_completion("recei", 0..5, "ved");
		let mut ui = Ui::from_root(input, 40, UiContext::default());
		ui.focus_first();
		ui.handle_key(Key::Right);
		assert_eq!(edit_input(&ui).buffer().text(), "received ");

		let mut input = EditInput::new().with(Prop::Value, "recei rest");
		input.set_spelling_features(assist_features(true, false));
		input.spelling.seed_completion("recei rest", 0..5, "ved");
		let mut ui = Ui::from_root(input, 40, UiContext::default());
		ui.focus_first();
		ui.handle_key(Key::Home);
		for _ in 0..5 {
			ui.handle_key(Key::Right);
		}
		assert_eq!(edit_input(&ui).buffer().cursor(), 5);
		ui.handle_key(Key::Right);
		assert_eq!(edit_input(&ui).buffer().text(), "recei rest");
		assert_eq!(edit_input(&ui).buffer().cursor(), 6);

		let mut input = EditInput::new().with(Prop::Value, "recei\nnext");
		input.set_spelling_features(assist_features(true, false));
		input.spelling.seed_completion("recei\nnext", 0..5, "ved");
		let _ = input.editor.move_to_message_edge(false);
		let mut ui = Ui::from_root(input, 40, UiContext::default());
		ui.focus_first();
		for _ in 0..5 {
			ui.handle_key(Key::Right);
		}
		ui.handle_key(Key::Right);
		assert_eq!(edit_input(&ui).buffer().text(), "received \nnext");
		assert_eq!(edit_input(&ui).buffer().cursor(), 9);
	}

	#[test]
	fn tab_word_completion_skips_space_before_boundary() {
		let mut input = EditInput::new().with(Prop::Value, "recei.");
		input.set_spelling_features(assist_features(true, false));
		input.spelling.seed_completion("recei.", 0..5, "ved");
		let mut ui = Ui::from_root(input, 40, UiContext::default());
		ui.focus_first();
		ui.handle_key(Key::Left);
		ui.handle_key(Key::Tab);
		assert_eq!(edit_input(&ui).buffer().text(), "received.");
	}

	#[test]
	fn ghost_word_completion_paints_dim_after_cursor() {
		let mut input = EditInput::new().with(Prop::Value, "recei");
		input.set_spelling_features(assist_features(true, false));
		input.spelling.seed_completion("recei", 0..5, "ved");
		let mut ui = Ui::from_root(input, 40, UiContext::default());
		let mut renderer = Renderer::new(Vec::new());
		ui.present(&mut renderer, 10).unwrap();
		let row = frame_row_text(ui.frame(), 0);
		assert!(row.contains("recei ved"), "{row:?}");
	}

	#[test]
	fn autocorrect_applies_only_while_cursor_is_stable() {
		let corrected = |guard: Option<usize>| {
			let mut input = EditInput::new().with(Prop::Value, "teh ");
			input.set_spelling_features(assist_features(false, true));
			input.correction_guard = guard;
			input.spelling.seed_correction(0..3, "the");
			let mut ui = Ui::from_root(input, 40, UiContext::default());
			let mut renderer = Renderer::new(Vec::new());
			ui.present(&mut renderer, 10).unwrap();
			edit_input(&ui).buffer().text().to_owned()
		};
		// The cursor sits at byte 4 (after the boundary space) when stable.
		assert_eq!(corrected(Some(4)), "the ");
		// A moved cursor or missing request leaves the text alone.
		assert_eq!(corrected(Some(2)), "teh ");
		assert_eq!(corrected(None), "teh ");
	}

	#[test]
	fn autocorrect_preserves_a_newline_boundary() {
		let mut input = EditInput::new().with(Prop::Value, "teh\n");
		input.set_spelling_features(assist_features(false, true));
		input.correction_guard = Some(4);
		input.spelling.seed_correction(0..3, "the");
		let mut ui = Ui::from_root(input, 40, UiContext::default());
		let mut renderer = Renderer::new(Vec::new());
		ui.present(&mut renderer, 10).unwrap();
		assert_eq!(edit_input(&ui).buffer().text(), "the\n");
		assert_eq!(edit_input(&ui).buffer().cursor(), 4);
	}

	#[test]
	fn spelling_replacements_preserve_boundary_and_caret_offset() {
		let text = "recieved ";
		let mut input = EditInput::new().with(Prop::Value, text);
		input.set_spelling_features(SpellingFeatures {
			typo_detection: true,
			autocomplete:   false,
			autocorrect:    false,
		});
		input.guesses_guard =
			Some(AssistanceGuard { text: Str::new(text), cursor: text.len(), range: 0..8 });
		input
			.spelling
			.seed_guesses(text, 0..8, ["received", "relieved"]);
		let mut ui = Ui::from_root(input, 40, UiContext::default());
		ui.focus_first();
		assert!(edit_input(&ui).editor.picker().is_some());
		ui.handle_key(Key::Tab);
		assert_eq!(edit_input(&ui).buffer().text(), "received ");
		assert_eq!(edit_input(&ui).buffer().cursor(), 9);
	}

	#[test]
	fn spelling_replacements_drop_stale_cursor_results() {
		let text = "recieved";
		let mut input = EditInput::new().with(Prop::Value, text);
		input.set_spelling_features(SpellingFeatures {
			typo_detection: true,
			autocomplete:   false,
			autocorrect:    false,
		});
		input.guesses_guard = Some(AssistanceGuard {
			text:   Str::new(text),
			cursor: text.len(),
			range:  0..text.len(),
		});
		input
			.spelling
			.seed_guesses(text, 0..text.len(), ["received"]);
		let _ = input.editor.handle(Key::Left);
		let ui = Ui::from_root(input, 40, UiContext::default());
		assert!(edit_input(&ui).editor.picker().is_none());
		assert_eq!(edit_input(&ui).buffer().text(), text);
	}

	#[test]
	fn spelling_replacements_drop_stale_source_results() {
		let requested = "recieved";
		let mut input = EditInput::new().with(Prop::Value, "recieved!");
		input.set_spelling_features(SpellingFeatures {
			typo_detection: true,
			autocomplete:   false,
			autocorrect:    false,
		});
		input.guesses_guard = Some(AssistanceGuard {
			text:   Str::new(requested),
			cursor: requested.len(),
			range:  0..requested.len(),
		});
		input
			.spelling
			.seed_guesses("recieved!", 0..requested.len(), ["received"]);
		let ui = Ui::from_root(input, 40, UiContext::default());
		assert!(edit_input(&ui).editor.picker().is_none());
		assert_eq!(edit_input(&ui).buffer().text(), "recieved!");
	}

	#[test]
	fn typo_squiggle_preserves_text_and_field_surface_styles() {
		let text = "recieved";
		let mut input = EditInput::new()
			.composer_style(ComposerStyle::Field)
			.with(Prop::Value, text);
		input.spelling.seed_typos(text, [0..text.len()]);
		let mut context = UiContext::default();
		context.theme.fg = Color::Rgb(0x11, 0x22, 0x33);
		context.theme.panel = Color::Rgb(0x44, 0x55, 0x66);
		context.theme.err = Color::Rgb(0xff, 0x5f, 0x5f);
		let expected_foreground = context
			.theme
			.foreground_on(context.theme.fg, context.theme.panel);
		let ui = Ui::from_root(input, 40, context);
		let text_x = ComposerStyle::Field.layout(Charset::Unicode).side_chrome;
		assert!(frame_row_text(ui.frame(), 0).contains(text));
		let style = ui.frame().cell(text_x, 0).style().spec();
		assert_eq!(style.foreground, expected_foreground);
		assert_eq!(style.background, Color::Rgb(0x44, 0x55, 0x66));
		assert_eq!(style.underline, Underline::Curly);
		assert_eq!(style.underline_color, Color::Rgb(0xff, 0x5f, 0x5f));
	}

	#[test]
	fn typo_squiggle_preserves_emphasis_and_link() {
		let foreground = Color::Rgb(0x11, 0x22, 0x33);
		let background = Color::Rgb(0x44, 0x55, 0x66);
		let error = Color::Rgb(0xff, 0x5f, 0x5f);
		let base = Style::new()
			.fg(foreground)
			.bg(background)
			.bold()
			.italic()
			.link("https://example.test/typo");
		let style = typo_squiggle_style(base, error).spec();

		assert_eq!(style.foreground, foreground);
		assert_eq!(style.background, background);
		assert!(style.bold);
		assert!(style.italic);
		assert_eq!(style.link, base.spec().link);
		assert_eq!(style.underline, Underline::Curly);
		assert_eq!(style.underline_color, error);
	}

	#[test]
	fn composer_layouts_define_row_chrome_and_gutter_widths() {
		let cases = [
			(ComposerStyle::Box, (1, 1, 2, 3, 0, ComposerStatusAttachment::TopBorder)),
			(ComposerStyle::Claude, (1, 1, 0, 0, 2, ComposerStatusAttachment::TopRuleChip)),
			(ComposerStyle::Pi, (1, 1, 1, 2, 2, ComposerStatusAttachment::Standalone)),
			(ComposerStyle::Borderless, (0, 0, 0, 0, 3, ComposerStatusAttachment::Standalone)),
			(ComposerStyle::Rule, (1, 0, 0, 0, 2, ComposerStatusAttachment::TopRuleChip)),
			(ComposerStyle::Field, (0, 0, 1, 2, 0, ComposerStatusAttachment::Standalone)),
			(ComposerStyle::Rail, (0, 0, 1, 2, 0, ComposerStatusAttachment::Standalone)),
		];
		for (style, expected) in cases {
			let layout = style.layout(Charset::Unicode);
			assert_eq!(
				(
					layout.top_rows,
					layout.bottom_rows,
					layout.horizontal_pad,
					layout.side_chrome,
					layout.gutter_width,
					layout.status_attachment,
				),
				expected,
				"{style}",
			);
			if style == ComposerStyle::Box {
				assert_eq!(layout.status_placement, StatusPlacement::Embedded);
			} else {
				assert_eq!(layout.status_placement, StatusPlacement::Standalone);
			}
			let expected_gauge = if layout.status_attachment == ComposerStatusAttachment::TopRuleChip {
				ContextGaugeMode::Numeric
			} else {
				ContextGaugeMode::Bar
			};
			assert_eq!(layout.context_gauge, expected_gauge, "{style}");
			assert_eq!(layout.status_before_input, style == ComposerStyle::Borderless);
		}
		assert_eq!(ComposerStyle::default(), ComposerStyle::Borderless);
	}

	#[test]
	fn every_composer_style_renders_its_declared_chrome() {
		let render = |style| {
			Ui::from_root(
				EditorPane::new()
					.composer_style(style)
					.with(Prop::Value, "hello"),
				20,
				UiContext::default(),
			)
		};

		let box_ui = render(ComposerStyle::Box);
		assert!(frame_row_text(box_ui.frame(), 0).starts_with('╭'));
		assert!(frame_row_text(box_ui.frame(), 1).contains("hello"));
		assert_eq!(
			frame_row_text(box_ui.frame(), box_ui.frame().size().height - 1),
			format!("╰{}╯", "─".repeat(18)),
		);

		let claude = render(ComposerStyle::Claude);
		assert_eq!(frame_row_text(claude.frame(), 0), "─".repeat(20));
		assert!(frame_row_text(claude.frame(), 1).starts_with("❯ hello"));
		assert_eq!(frame_row_text(claude.frame(), claude.frame().size().height - 1), "─".repeat(20),);

		let pi = render(ComposerStyle::Pi);
		assert!(frame_row_text(pi.frame(), 0).starts_with('╭'));
		assert!(frame_row_text(pi.frame(), 1).contains("> hello"));
		assert_eq!(
			frame_row_text(pi.frame(), pi.frame().size().height - 1),
			format!("╰{}╯", "─".repeat(18)),
		);

		let borderless = render(ComposerStyle::Borderless);
		assert!(frame_row_text(borderless.frame(), 0).starts_with("╰─ hello"));

		let rule = render(ComposerStyle::Rule);
		assert_eq!(frame_row_text(rule.frame(), 0), "─".repeat(20));
		assert!(frame_row_text(rule.frame(), 1).starts_with("❯ hello"));

		let field = render(ComposerStyle::Field);
		assert!(frame_row_text(field.frame(), 0).starts_with("▐ hello"));
		assert!(frame_row_text(field.frame(), 0).ends_with('▌'));
		assert_eq!(
			field.frame().cell(1, 0).style().background_color(),
			UiContext::default().theme.panel,
		);

		let rail = render(ComposerStyle::Rail);
		assert!(frame_row_text(rail.frame(), 0).starts_with("▎ hello"));
		assert!(!frame_row_text(rail.frame(), 0).ends_with('▌'));
		assert_eq!(
			rail.frame().cell(1, 0).style().background_color(),
			UiContext::default().theme.panel,
		);
	}
	#[test]
	fn unset_editor_foreground_falls_back_only_on_painted_fields() {
		let mut painted = UiContext::default();
		painted.theme.fg = Color::Default;
		painted.theme.panel = Color::Rgb(0xee, 0xee, 0xee);
		let painted = Ui::from_root(
			EditorPane::new()
				.composer_style(ComposerStyle::Field)
				.with(Prop::Value, "hello"),
			20,
			painted,
		);
		let painted_style = painted.frame().cell(2, 0).style();
		assert_ne!(painted_style.foreground_color(), Color::Default);
		assert_eq!(painted_style.background_color(), Color::Rgb(0xee, 0xee, 0xee));

		let mut terminal_default = UiContext::default();
		terminal_default.theme.fg = Color::Default;
		terminal_default.theme.panel = Color::Default;
		let terminal_default = Ui::from_root(
			EditorPane::new()
				.composer_style(ComposerStyle::Field)
				.with(Prop::Value, "hello"),
			20,
			terminal_default,
		);
		let default_style = terminal_default.frame().cell(2, 0).style();
		assert_eq!(default_style.foreground_color(), Color::Default);
		assert_eq!(default_style.background_color(), Color::Default);
	}

	#[test]
	fn editor_rail_prop_selects_focus_sensitive_rail_chrome() {
		let pane = EditorPane::new()
			.with(Prop::Rail, true)
			.with(Prop::Placeholder, "Description")
			.with(Prop::MaxRows, 3_u16);
		assert!(pane.children[0].comp().props().flag(Prop::Rail));
		assert_eq!(pane.children[0].comp().props().max_rows(), Some(3));

		let ctx = UiContext::default();
		let mut editor = Cached::new(Box::new(pane));
		let height = editor.height(&ctx, 20);
		editor.place(&ctx, Rect::new(0, 0, 20, height));
		let mut frame = Frame::new(Size::new(20, height));
		let mut hits = Vec::new();
		editor.paint(&mut PaintCtx::new(&mut frame, &ctx, &mut hits, &mut Vec::new()));
		let blurred = frame_row_text(&frame, 0);
		assert!(blurred.starts_with("▏ Description"), "{blurred:?}");
		assert!(!blurred.contains("╰─"), "{blurred:?}");

		let mut ui = Ui::from_root(
			EditorPane::new()
				.with(Prop::Rail, true)
				.with(Prop::Placeholder, "Description"),
			20,
			UiContext::default(),
		);
		let mut renderer = Renderer::new(Vec::new());
		ui.present(&mut renderer, 10).unwrap();
		let focused = frame_row_text(ui.frame(), 0);
		assert!(focused.starts_with("▎ Description"), "{focused:?}");
		assert!(!focused.contains("╰─"), "{focused:?}");
	}

	#[test]
	fn composer_chrome_degrades_to_ascii_glyphs() {
		let ctx = UiContext { charset: Charset::Ascii, ..UiContext::default() };
		let box_ui = Ui::from_root(
			EditorPane::new()
				.composer_style(ComposerStyle::Box)
				.with(Prop::Value, "x"),
			12,
			ctx.clone(),
		);
		assert!(frame_row_text(box_ui.frame(), 0).starts_with('+'));
		let field = Ui::from_root(
			EditorPane::new()
				.composer_style(ComposerStyle::Field)
				.with(Prop::Value, "x"),
			12,
			ctx,
		);
		assert!(frame_row_text(field.frame(), 0).starts_with("| x"));
	}
	#[test]
	fn pi_composer_uses_right_border_as_scrollbar_track() {
		let ui = Ui::from_root(
			EditorPane::new().composer_style(ComposerStyle::Pi).with(
				Prop::Value,
				"one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\neleven\ntwelve\nthirteen\\
				 nfourteen\nfifteen\nsixteen\nseventeen\neighteen\nnineteen\ntwenty",
			),
			20,
			UiContext::default(),
		);
		// The composer correctly grows for six lines; overflow (and therefore
		// a thumb) starts only once content exceeds its 18-row height cap.
		assert!(
			(1..5).any(|row| frame_row_text(ui.frame(), row).ends_with('█')),
			"overflowing input should paint a thumb in its right border",
		);
	}

	#[test]
	fn selection_paint_replaces_only_the_glyph_background() {
		let mut frame = Frame::new(Size::new(3, 1));
		let foreground = Color::Rgb(0x11, 0x22, 0x33);
		let selection = Color::Rgb(0x44, 0x55, 0x66);
		let style = Style::new().fg(foreground).bold();
		let runs = [SyntaxRun { start: 0, end: 3, style }];
		paint_xml_range(&mut frame, 0, 0, "abc", &runs, 0, 3, Some((1, 2)), selection);

		assert_eq!(frame.cell(0, 0).style(), style);
		assert_eq!(frame.cell(1, 0).style(), style.bg(selection));
		assert_eq!(frame.cell(2, 0).style(), style);
	}

	/// Only the hardware cursor marks the caret; the cell under it and the
	/// cell after the text stay unstyled.
	#[test]
	fn caret_is_hardware_only_and_never_paints_a_styled_cell() {
		let mut ui = Ui::from_root(
			EditInput::new()
				.composer_style(ComposerStyle::Borderless)
				.with(Prop::Id, "composer"),
			40,
			UiContext::default(),
		);
		ui.focus_first();
		for character in "hi".chars() {
			ui.handle_key(Key::Char(character));
		}
		let frame = ui.frame();
		let (column, row) = frame.cursor().expect("hardware caret placed");
		assert_eq!((column, row), (5, 0));
		let accent = ui.context().theme.accent;
		for x in 0..frame.size().width {
			let style = frame.cell(x, row).style();
			assert_ne!(style.background_color(), accent, "column {x} paints a caret block");
		}
		assert_ne!(frame.cell(column, row).style().foreground_color(), accent);
		ui.handle_key(Key::Left);
		let frame = ui.frame();
		assert_eq!(frame.cursor(), Some((4, 0)));
		assert_ne!(frame.cell(4, 0).style().background_color(), accent);
		assert_ne!(frame.cell(4, 0).style().foreground_color(), accent);
	}

	/// Wide graphemes occupy two cells: the caret lands after the whole
	/// glyph, never between its halves, and walking left steps a full glyph.
	#[test]
	fn caret_skips_wide_graphemes_as_whole_cells() {
		let mut ui = Ui::from_root(
			EditInput::new()
				.composer_style(ComposerStyle::Borderless)
				.with(Prop::Id, "composer"),
			40,
			UiContext::default(),
		);
		ui.focus_first();
		for character in "日本🙂x".chars() {
			ui.handle_key(Key::Char(character));
		}
		// `╰─ ` gutter (3) + 2 + 2 + 2 + 1.
		assert_eq!(ui.frame().cursor(), Some((10, 0)), "end of buffer after wide text");
		ui.handle_key(Key::Left);
		assert_eq!(ui.frame().cursor(), Some((9, 0)));
		ui.handle_key(Key::Left);
		assert_eq!(ui.frame().cursor(), Some((7, 0)), "the emoji is one two-cell step");
		ui.handle_key(Key::Left);
		assert_eq!(ui.frame().cursor(), Some((5, 0)));
		ui.handle_key(Key::Home);
		ui.handle_key(Key::Right);
		assert_eq!(ui.frame().cursor(), Some((5, 0)), "never between the halves of 日");
	}

	/// With the IME-safe layout on, the focused caret row of a side-bordered
	/// shape keeps no right chrome, so terminal-local preedit cannot push the
	/// border onto the next row. Off and unfocused, the border stays.
	#[test]
	fn ime_safe_layout_drops_right_chrome_on_the_caret_row() {
		let mut ui = Ui::from_root(
			EditorPane::new()
				.composer_style(ComposerStyle::Box)
				.ime_safe_cursor(true)
				.with(Prop::Id, "composer")
				.with(Prop::Value, "ast\nsecond"),
			20,
			UiContext::default(),
		);
		ui.focus_first();
		// Caret at the end of the last line: that row is open to the right,
		// the first content row and the bottom border keep their chrome.
		let rows: Vec<String> = (0..4).map(|row| frame_row_text(ui.frame(), row)).collect();
		assert!(rows[0].starts_with('╭') && rows[0].ends_with('╮'), "{rows:?}");
		assert!(rows[1].ends_with('│'), "{rows:?}");
		assert_eq!(rows[2].trim_end(), "│  second", "{rows:?}");
		assert!(rows[3].starts_with('╰') && rows[3].ends_with('╯'), "{rows:?}");
		assert_eq!(ui.frame().cursor(), Some((3 + 6, 2)));
		// Caret mid-line: nothing to protect, the right border returns.
		ui.handle_key(Key::Left);
		assert!(frame_row_text(ui.frame(), 2).ends_with('│'));
		// Unfocused: no caret, so no open row.
		ui.handle_key(Key::End);
		ui.blur();
		assert!(frame_row_text(ui.frame(), 2).ends_with('│'));

		let mut plain = Ui::from_root(
			EditorPane::new()
				.composer_style(ComposerStyle::Box)
				.with(Prop::Id, "composer")
				.with(Prop::Value, "ast"),
			20,
			UiContext::default(),
		);
		plain.focus_first();
		assert!(frame_row_text(plain.frame(), 1).ends_with('│'), "the default keeps the compact box");

		let mut rail = Ui::from_root(
			EditorPane::new()
				.composer_style(ComposerStyle::Rail)
				.ime_safe_cursor(true)
				.with(Prop::Id, "composer")
				.with(Prop::Value, "ast"),
			20,
			UiContext::default(),
		);
		rail.focus_first();
		let (column, row) = rail.frame().cursor().expect("caret");
		let panel = rail.context().theme.panel;
		assert_ne!(rail.frame().cell(column, row).style().background_color(), panel);
		assert_eq!(
			rail
				.frame()
				.cell(column - 1, row)
				.style()
				.background_color(),
			panel
		);
	}

	/// Magic keywords shimmer on the paint clock (1800ms sweep, 70ms frames)
	/// only while focused; unfocused, the gradient rests at phase 0 and
	/// schedules nothing.
	#[test]
	fn magic_keywords_shimmer_only_while_focused() {
		fn row_colors(ui: &Ui, row: u16, from: u16, len: u16) -> Vec<Color> {
			(from..from + len)
				.map(|x| ui.frame().cell(x, row).style().foreground_color())
				.collect()
		}
		// Platform spelling would add its own 16 ms polls; only the shimmer
		// clock is under test.
		let mut ui = Ui::from_root(
			EditorPane::new()
				.keyword_accent(KeywordAccent::magic())
				.spelling_features(assist_features(false, false))
				.with(Prop::Id, "composer")
				.with(Prop::Value, "ultrathink now"),
			40,
			UiContext::default(),
		);
		ui.focus_first();
		let resting = row_colors(&ui, 0, 3, 10);
		let magic = KeywordAccent::magic();
		let palette = magic.palette(0, true);
		let expected: Vec<Color> = (0..10)
			.map(|i| palette[KeywordGradient::stop(i, 10, 0.0)])
			.collect();
		assert_eq!(resting, expected, "phase 0 paints the static palette");
		assert_eq!(resting[0], anim::hsl(0.0, 0.90, 0.62));
		assert_eq!(
			ui.next_wake(),
			Some(KeywordGradient::SHIMMER_FRAME),
			"a focused keyword schedules the next shimmer frame"
		);
		assert!(ui.tick(KeywordGradient::SHIMMER_FRAME), "the frame repaints");
		let moved = row_colors(&ui, 0, 3, 10);
		assert_ne!(moved, resting, "70 ms later the gradient has rotated");
		assert_eq!(
			ui.next_wake(),
			Some(KeywordGradient::SHIMMER_FRAME * 2),
			"the chain continues while focused"
		);
		// Plain text after the keyword is never painted from the palette.
		let plain = ui.frame().cell(3 + 11, 0).style().foreground_color();
		assert!(!palette.contains(&plain), "{plain:?}");

		ui.blur();
		ui.tick(KeywordGradient::SHIMMER_FRAME * 3);
		assert_eq!(row_colors(&ui, 0, 3, 10), expected, "unfocused: phase 0");
		assert_eq!(ui.next_wake(), None, "unfocused: no shimmer wake");

		// 256-color terminals take the nearest indexed stop.
		let indexed = magic.palette(0, false);
		assert!(
			indexed
				.iter()
				.all(|color| matches!(color, Color::Indexed(_))),
			"{indexed:?}"
		);
		assert_eq!(indexed[0], anim::hsl(0.0, 0.90, 0.62).quantized_256());
	}

	#[test]
	fn editor_mouse_drag_and_double_click_select_text() {
		let mut ui = Ui::from_root(
			EditInput::new()
				.with(Prop::Id, "composer")
				.with(Prop::Value, "hello world"),
			40,
			UiContext::default(),
		);
		ui.focus_first();
		let hit = ui
			.hits()
			.iter()
			.find(|hit| hit.tag == HitTag::Press)
			.copied()
			.expect("editor press target");

		ui.handle_mouse(hit.rect.x + 3, hit.rect.y, Mouse::Click);
		ui.handle_mouse(hit.rect.x + 8, hit.rect.y, Mouse::Drag);
		ui.handle_mouse(hit.rect.x + 8, hit.rect.y, Mouse::Release);
		let selected = ui
			.root()
			.comp()
			.downcast_ref::<EditInput>()
			.expect("editor input")
			.buffer()
			.selected_text();
		assert_eq!(selected, Some("hello"));

		ui.handle_mouse(hit.rect.x + 9, hit.rect.y, Mouse::Click);
		ui.handle_mouse(hit.rect.x + 9, hit.rect.y, Mouse::Click);
		let selected = ui
			.root()
			.comp()
			.downcast_ref::<EditInput>()
			.expect("editor input")
			.buffer()
			.selected_text();
		assert_eq!(selected, Some("world"));
	}

	struct GrowingInput {
		props: Props,
		slot:  Slot,
		rows:  u16,
	}

	impl GrowingInput {
		fn new() -> Self {
			Self { props: Props::new(), slot: next_slot(), rows: 1 }
		}
	}

	impl Component for GrowingInput {
		fn props(&self) -> &Props {
			&self.props
		}

		fn props_mut(&mut self) -> &mut Props {
			&mut self.props
		}

		fn slot(&self) -> Slot {
			self.slot
		}

		fn measure(&mut self, _ctx: &UiContext) -> (u16, u16) {
			(1, 8)
		}

		fn height(&mut self, _ctx: &UiContext, _width: u16) -> u16 {
			self.rows
		}

		fn paint(&mut self, pc: &mut PaintCtx<'_>, rect: Rect) {
			pc.frame
				.set_cursor(rect.x, rect.y.saturating_add(self.rows.saturating_sub(1)));
		}

		fn focusable(&self) -> bool {
			true
		}

		fn key(&mut self, _ec: &mut EventCtx<'_>, key: Key) -> Flow {
			if key == Key::ShiftEnter {
				self.rows = self.rows.saturating_add(1);
				Flow::Consumed
			} else {
				Flow::Skip
			}
		}
	}

	#[test]
	fn ui_routes_multiline_growth_to_the_editor_input_cache() {
		let mut ui =
			Ui::from_root(EditorPane::new().input(GrowingInput::new()), 14, UiContext::default());
		let initial_height = ui.height();
		ui.handle_key(Key::ShiftEnter);
		ui.handle_key(Key::ShiftEnter);

		assert_eq!(ui.height(), initial_height.saturating_add(2));
		assert_eq!(ui.frame().size().height, ui.height());
		let (cursor_x, cursor_y) = ui.frame().cursor().expect("focused editor cursor");
		assert!(cursor_x < ui.frame().size().width);
		assert!(cursor_y < ui.frame().size().height);
	}

	#[test]
	fn editor_pane_forwards_submit_and_handles_enter() {
		let pane = EditorPane::new().with(Prop::Submit, true);
		assert!(pane.children[0].comp().props().flag(Prop::Submit));

		let mut ui = Ui::from_root(pane, 40, UiContext::default());
		assert_eq!(ui.handle_key(Key::Enter), UiEvent::None, "empty enter should not submit");

		ui.handle_key(Key::Char(' '));
		assert_eq!(ui.handle_key(Key::Enter), UiEvent::None, "whitespace enter should not submit");

		ui.handle_key(Key::ShiftEnter);
		let text = ui
			.root
			.comp()
			.downcast_ref::<EditorPane>()
			.unwrap()
			.buffer()
			.text();
		assert_eq!(text, " \n");

		ui.handle_key(Key::Char('a'));
		assert_eq!(ui.handle_key(Key::Enter), UiEvent::Submit, "non-empty enter should submit");
		let text = ui
			.root
			.comp()
			.downcast_ref::<EditorPane>()
			.unwrap()
			.buffer()
			.text();
		assert_eq!(text, " \na", "buffer should not be cleared on submit");
	}

	#[test]
	fn editor_pane_id_resolves_typed_pane_lookup() {
		let pane = EditorPane::new()
			.with(Prop::Id, "input")
			.with(Prop::Submit, true);
		assert_eq!(pane.props().id().map(Str::as_str), Some("input"));
		assert_eq!(pane.children[0].comp().props().id().map(Str::as_str), Some("input"));

		let mut ui = Ui::from_root(pane, 40, UiContext::default());
		let mut attachments = None;
		ui.update_component::<EditorPane>("input", |pane| {
			attachments = Some(pane.attachments());
			false
		});
		assert!(attachments.is_some(), "id lookup must resolve the pane, not its input");

		ui.focus_first();
		ui.handle_key(Key::Char('a'));
		assert!(ui.set_text("input", "hi"), "set_text still routes through the pane to the input");
		assert_eq!(ui.values()["input"], "hi");
	}

	#[test]
	fn inline_decorator_paints_host_spans() {
		let ctx = UiContext::default();
		let mut pane = EditorPane::new();
		pane.set_inline_decorator(Some(Box::new(|text| {
			let mut spans = SmallVec::new();
			if text.starts_with("->") {
				spans.push((0, 2, InlineAccent::Dim));
			}
			if let Some(start) = text.find("hello") {
				spans.push((start, start + "hello".len(), InlineAccent::Accent));
			}
			spans
		})));
		let ui = Ui::from_root(pane.with(Prop::Value, "-> hello"), 20, ctx.clone());
		let row = frame_row_text(ui.frame(), 0);
		let arrow = row.find("->").expect("decorated arrow is painted");
		let arrow_x = u16::try_from(xutf::width_str(&row[..arrow])).expect("narrow editor row");
		for x in arrow_x..arrow_x + 2 {
			let style = ui.frame().cell(x, 0).style();
			assert_eq!(style.foreground_color(), ctx.theme.muted);
			assert!(style.spec().dim);
		}
		let space = ui.frame().cell(arrow_x + 2, 0).style();
		assert_eq!(space.foreground_color(), ctx.theme.fg);
		assert!(!space.spec().dim);
		for x in arrow_x + 3..arrow_x + 8 {
			let style = ui.frame().cell(x, 0).style();
			assert_eq!(style.foreground_color(), ctx.theme.accent);
			assert!(!style.spec().dim);
		}
	}

	/// The host owns the sigil grammar: the chrome recolors only on the
	/// installed classifier's verdict, never on a bare leading `$` byte.
	#[test]
	fn prefix_classifier_decides_the_chrome_accent() {
		let ctx = UiContext::default();
		let boxed = || EditorPane::new().composer_style(ComposerStyle::Box);
		let naive = Ui::from_root(boxed().with(Prop::Value, "$HOME is set"), 20, ctx.clone());
		assert_eq!(naive.frame().cell(0, 0).style().foreground_color(), ctx.theme.info);

		let mut pane = boxed();
		pane.set_prefix_classifier(|text| {
			(text.starts_with("$ ") && !text.starts_with("$ git")).then_some(PrefixAccent::Eval)
		});
		assert_eq!(pane.prefix_accent(), None);
		let prose = Ui::from_root(pane.with(Prop::Value, "$HOME is set"), 20, ctx.clone());
		assert_eq!(prose.frame().cell(0, 0).style().foreground_color(), ctx.theme.border);

		let mut pane = boxed();
		pane.set_prefix_classifier(|text| {
			(text.starts_with("$ ") && !text.starts_with("$ git")).then_some(PrefixAccent::Eval)
		});
		let pasted = Ui::from_root(pane.with(Prop::Value, "$ git status"), 20, ctx.clone());
		assert_eq!(pasted.frame().cell(0, 0).style().foreground_color(), ctx.theme.border);

		let mut pane = boxed();
		pane.set_prefix_classifier(|text| {
			(text.starts_with("$ ") && !text.starts_with("$ git")).then_some(PrefixAccent::Eval)
		});
		let eval = Ui::from_root(pane.with(Prop::Value, "$ 1+1"), 20, ctx.clone());
		assert_eq!(eval.frame().cell(0, 0).style().foreground_color(), ctx.theme.info);
	}

	/// `picker_rows` bounds the open dropdown live and is clamped to `[3, 20]`.
	#[test]
	fn editor_options_resize_the_open_dropdown() {
		let commands = (0..30)
			.map(|index| Command::new(&format!("cmd{index:02}"), "", &[]))
			.collect::<Vec<_>>();
		let pane = EditorPane::new()
			.with(Prop::Id, "input")
			.completion(Box::new(SlashCommands::new(commands.into_boxed_slice())));
		let mut ui = Ui::from_root(pane, 40, UiContext::default());
		ui.focus_first();
		ui.handle_key(Key::Char('/'));
		let rows = |ui: &Ui| {
			ui.root()
				.comp()
				.downcast_ref::<EditorPane>()
				.expect("pane")
				.children[0]
				.comp()
				.downcast_ref::<EditInput>()
				.expect("input")
				.editor
				.picker()
				.expect("dropdown open")
				.visible_suggestions()
				.1
				.len()
		};
		assert_eq!(rows(&ui), 10, "default window");
		for (requested, shown) in [(4, 4), (1, 3), (99, 20)] {
			ui.with_component_mut::<EditorPane, _>("input", |pane| {
				pane.set_editor_options(EditorOptions {
					picker_rows: requested,
					..EditorOptions::default()
				});
			});
			assert_eq!(rows(&ui), shown, "picker_rows {requested}");
		}
	}

	/// Turning `emoji` off at runtime closes the built-in `:shortcode:`
	/// dropdown and stops shortcode expansion.
	#[test]
	fn editor_options_toggle_emoji_live() {
		let mut ui =
			Ui::from_root(EditorPane::new().with(Prop::Id, "input"), 40, UiContext::default());
		ui.focus_first();
		for character in ":joy".chars() {
			ui.handle_key(Key::Char(character));
		}
		let open = |ui: &Ui| {
			ui.root()
				.comp()
				.downcast_ref::<EditorPane>()
				.expect("pane")
				.popup_open()
		};
		assert!(open(&ui), "emoji dropdown opens by default");
		ui.with_component_mut::<EditorPane, _>("input", |pane| {
			pane.set_editor_options(EditorOptions { emoji: false, ..EditorOptions::default() });
		});
		assert!(!open(&ui), "the switch closes the built-in dropdown");
		ui.handle_key(Key::Char(':'));
		assert_eq!(ui.values()["input"], ":joy:", "no shortcode expansion while emoji is off");
	}

	/// `stage_text_attachment` inserts a chip whose submitted form is the
	/// caller's expansion.
	#[test]
	fn staged_text_attachment_expands_to_the_given_text() {
		let mut pane = EditorPane::new().with(Prop::Id, "input");
		assert!(pane.stage_text_attachment(
			"raw body",
			Some("<attachment>\nraw body\n</attachment>"),
			Charset::Unicode
		));
		let ui = Ui::from_root(pane, 40, UiContext::default());
		assert_eq!(ui.values()["input"], "<attachment>\nraw body\n</attachment> ");
	}

	#[test]
	fn editor_pane_placeholder_disappears_after_input() {
		let pane = EditorPane::new().with(Prop::Placeholder, "Ask anything");
		let mut ui = Ui::from_root(pane, 40, UiContext::default());
		ui.focus_first();

		let mut renderer = Renderer::new(Vec::new());
		ui.present(&mut renderer, 10).unwrap();
		let frame_text = (0..ui.height())
			.map(|y| frame_row_text(ui.frame(), y))
			.collect::<Vec<_>>();
		assert!(
			frame_text.iter().any(|r| r.contains("Ask anything")),
			"empty focused editor should paint its placeholder, got: {frame_text:?}"
		);

		ui.handle_key(Key::Char('x'));
		ui.present(&mut renderer, 10).unwrap();
		let painted = (0..ui.height())
			.map(|y| frame_row_text(ui.frame(), y))
			.collect::<Vec<_>>();
		assert!(painted.iter().any(|r| r.contains('x')));
		assert!(!painted.iter().any(|r| r.contains("Ask anything")));
	}

	#[test]
	fn editor_pane_max_rows_caps_and_scrolls_the_viewport() {
		let pane = EditorPane::new()
			.with(Prop::Id, "input")
			.with(Prop::Value, "one\ntwo\nthree\nfour\nfive\nsix")
			.with(Prop::MaxRows, 3_u16);
		let mut ui = Ui::from_root(pane, 20, UiContext::default());
		ui.focus_first();
		assert_eq!(ui.height(), 3);

		let mut renderer = Renderer::new(Vec::new());
		ui.present(&mut renderer, 10).unwrap();
		let painted = (0..ui.height())
			.map(|y| frame_row_text(ui.frame(), y))
			.collect::<Vec<_>>();
		assert!(painted.iter().any(|row| row.contains("six")));
		assert!(!painted.iter().any(|row| row.contains("one")));
	}

	#[test]
	fn editor_pane_reports_logical_cursor_boundaries() {
		let mut pane = EditorPane::new().with(Prop::Value, "first\nmiddle\nlast");
		assert!(!pane.cursor_on_first_line());
		assert!(pane.cursor_on_last_line());

		pane.replace_external("first\nmiddle\nlast", true);
		assert!(pane.cursor_on_first_line());
		assert!(!pane.cursor_on_last_line());

		pane.replace_external("only", true);
		assert!(pane.cursor_on_first_line());
		assert!(pane.cursor_on_last_line());
	}

	#[test]
	fn editor_pane_opens_slash_completion_popup() {
		let commands = vec![
			crate::Command::new("help", "Show available commands", &[]),
			crate::Command::new("models", "Choose a model", &[]),
		];
		let pane =
			EditorPane::new().completion(Box::new(SlashCommands::new(commands.into_boxed_slice())));
		let mut ui = Ui::from_root(pane, 40, UiContext::default());
		let collapsed_height = ui.height();

		ui.focus_first();
		assert_eq!(ui.handle_key(Key::Char('/')), UiEvent::None);

		let input = ui
			.root()
			.comp()
			.downcast_ref::<EditorPane>()
			.expect("UI root is an editor pane")
			.children[0]
			.comp()
			.downcast_ref::<EditInput>()
			.expect("pane has its default editor input");
		assert_eq!(input.editor.picker().expect("slash popup").len(), 2);
		assert!(ui.height() > collapsed_height);
	}

	#[test]
	fn completion_popup_click_accepts_the_hit_row_without_moving_the_caret_first() {
		let commands = vec![
			crate::Command::new("help", "Show available commands", &[]),
			crate::Command::new("models", "Choose a model", &[]),
		];
		let pane = EditorPane::new()
			.with(Prop::Id, "input")
			.completion(Box::new(SlashCommands::new(commands.into_boxed_slice())));
		let mut ui = Ui::from_root(pane, 40, UiContext::default());
		ui.focus_first();
		ui.handle_key(Key::Char('/'));
		let row = (0..ui.height())
			.find(|row| frame_row_text(ui.frame(), *row).contains("models"))
			.expect("models completion row");
		ui.handle_mouse(1, row, Mouse::Click);
		assert_eq!(ui.values()["input"], "/models ");
		let pane = ui
			.root()
			.comp()
			.downcast_ref::<EditorPane>()
			.expect("editor pane");
		assert!(!pane.popup_open());
	}

	#[test]
	fn slash_completion_icons_resolve_per_charset_and_align_labels() {
		let cases = [
			(Charset::Ascii, ["/", "PR", "MCP", "SK", "EX", "id"]),
			(Charset::Unicode, ["⌘", "✎", "🔌", "✦", "🧩", "🆔"]),
			(Charset::NerdFont, ["", "", "", "", "", "󰁑"]),
		];
		for (charset, glyphs) in cases {
			let commands = [
				("action", Icon::SlashCommand),
				("prompt", Icon::Prompt),
				("mcp", Icon::McpExtension),
				("skill", Icon::Skill),
				("extension", Icon::ExtensionCommand),
				("session", Icon::Session),
			]
			.into_iter()
			.map(|(name, icon)| Command::new(name, "type", &[]).with_icon(icon))
			.collect::<Vec<_>>();
			let pane =
				EditorPane::new().completion(Box::new(SlashCommands::new(commands.into_boxed_slice())));
			let mut ui = Ui::from_root(pane, 80, UiContext { charset, ..UiContext::default() });
			ui.focus_first();
			ui.handle_key(Key::Char('/'));
			let mut renderer = Renderer::new(Vec::new());
			ui.present(&mut renderer, 24).unwrap();
			let rows = (0..ui.height())
				.map(|row| frame_row_text(ui.frame(), row))
				.collect::<Vec<_>>();
			let mut columns = Vec::new();
			for ((name, _), glyph) in [
				("action", Icon::SlashCommand),
				("prompt", Icon::Prompt),
				("mcp", Icon::McpExtension),
				("skill", Icon::Skill),
				("extension", Icon::ExtensionCommand),
				("session", Icon::Session),
			]
			.into_iter()
			.zip(glyphs)
			{
				let row = rows
					.iter()
					.find(|row| row.contains(name))
					.expect("command row");
				assert!(row.contains(glyph), "{charset:?} row did not use catalog glyph: {row}");
				let at = row.find(name).expect("label offset");
				columns.push(cell_width(&row[..at]));
			}
			assert!(columns.windows(2).all(|pair| pair[0] == pair[1]), "{charset:?}: {rows:?}");
		}
	}

	#[test]
	fn slash_completion_description_is_capped_at_two_rows_with_ellipsis() {
		let description = "Plan and execute non-trivial architectural improvements to the codebase \
		                   while preserving behavior, validating invariants, and documenting every \
		                   important tradeoff long past the available popup space.";
		let command = Command::new("improve-architecture", description, &[]);
		let pane = EditorPane::new()
			.completion(Box::new(SlashCommands::new(vec![command].into_boxed_slice())));
		let mut ui = Ui::from_root(pane, 64, UiContext::default());
		ui.focus_first();
		ui.handle_key(Key::Char('/'));
		let mut renderer = Renderer::new(Vec::new());
		ui.present(&mut renderer, 24).unwrap();
		let rows = (0..ui.height())
			.map(|row| frame_row_text(ui.frame(), row))
			.collect::<Vec<_>>();
		let command_row = rows
			.iter()
			.position(|row| row.contains("improve-architecture"))
			.expect("command row");
		assert!(
			rows
				.get(command_row + 1)
				.is_some_and(|row| row.contains('…')),
			"{rows:?}"
		);
		assert!(!rows.iter().any(|row| row.contains("available popup space")));
	}

	#[test]
	fn editor_status_embeds_in_rounded_top_border() {
		let ctx = UiContext { charset: Charset::NerdFont, ..UiContext::default() };
		let mut editor = Cached::new(Box::new(
			EditorPane::new().composer_style(ComposerStyle::Box).status(
				Status::new()
					.with(Prop::Bg, "yellow")
					.segment(Segment::new().label("ready")),
			),
		));
		let height = editor.height(&ctx, 20);
		editor.place(&ctx, Rect::new(0, 0, 20, height));
		let mut frame = Frame::new(Size::new(20, height));
		let mut hits = Vec::new();
		editor.paint(&mut PaintCtx::new(&mut frame, &ctx, &mut hits, &mut Vec::new()));

		let row = frame_row_text(&frame, 0);
		assert!(row.starts_with("\u{e0b6} ready \u{e0b0}"));
		assert!(row.ends_with('╮'));
		assert_eq!(frame.cell(0, 0).style.foreground_color(), Color::Rgb(255, 255, 0));
		assert_eq!(frame.cell(0, 0).style.background_color(), Color::Default);
		assert_eq!(frame.cell(9, 0).style.background_color(), Color::Default);
	}

	#[test]
	fn borderless_composer_places_status_above_one_curved_prompt() {
		let ctx = UiContext { charset: Charset::NerdFont, ..UiContext::default() };
		let mut editor = Cached::new(Box::new(
			EditorPane::new()
				.composer_style(ComposerStyle::Borderless)
				.with(Prop::Value, "body")
				.status(Status::new().segment(Segment::new().label("ready"))),
		));
		let height = editor.height(&ctx, 20);
		assert_eq!(height, 2);
		editor.place(&ctx, Rect::new(0, 0, 20, height));
		let mut frame = Frame::new(Size::new(20, height));
		let mut hits = Vec::new();
		editor.paint(&mut PaintCtx::new(&mut frame, &ctx, &mut hits, &mut Vec::new()));

		assert!(frame_row_text(&frame, 0).contains("ready"));
		assert!(frame_row_text(&frame, 1).starts_with("╰─ body"));
		for row in 0..height {
			let text = frame_row_text(&frame, row);
			assert!(
				!text
					.chars()
					.any(|glyph| matches!(glyph, '╭' | '╮' | '╯' | '│')),
				"unexpected enclosing editor border on row {row}: {text}",
			);
		}
	}

	#[test]
	fn editor_status_is_excluded_from_the_focus_ring() {
		let editor = EditorPane::new().status(Input::new());
		let mut ring = Vec::new();
		editor.ring(&mut ring);
		assert_eq!(ring, vec![editor.children[0].comp().slot()]);
	}

	#[test]
	fn attachments_render_framed_previews_with_markers_and_resolution() {
		let dir = env::temp_dir().join(format!("omp-editor-attach-{}", std::process::id()));
		fs::create_dir_all(&dir).unwrap();
		let probed = dir.join("shot.png");
		let mut png = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
		png.extend(528_u32.to_be_bytes());
		png.extend(200_u32.to_be_bytes());
		fs::write(&probed, png).unwrap();

		let ctx = UiContext::default();
		let pane = EditorPane::new()
			.with(Prop::Value, "body")
			.status(Status::new().segment(Segment::new().label("ready")));
		let attachments = pane.attachments();
		let mut editor = Cached::new(Box::new(pane));
		let base = editor.height(&ctx, 40);

		let first = attachments.push_image(probed.to_str().expect("temp path is UTF-8"));
		assert_eq!(first.marker, 1);
		assert!(
			matches!(first.content, AttachmentContent::Image { dimensions: Some((528, 200)), .. }),
			"PNG header probes its resolution"
		);
		assert_eq!(first.color, attachment_color(1));
		assert_eq!(attachments.push_image("/nope/b.png").marker, 2);
		editor.invalidate();
		let height = editor.height(&ctx, 40);
		assert_eq!(
			height,
			base + PREVIEW_BOX_ROWS + 1,
			"band adds the framed previews plus the spacer row"
		);
		editor.place(&ctx, Rect::new(0, 0, 40, height));
		let mut frame = Frame::new(Size::new(40, height));
		let mut hits = Vec::new();
		editor.paint(&mut PaintCtx::new(&mut frame, &ctx, &mut hits, &mut Vec::new()));

		let top = frame_row_text(&frame, 0);
		assert!(top.contains("#1"), "first frame caption missing: {top}");
		assert!(top.contains("#2"), "second frame caption missing: {top}");
		let bottom = frame_row_text(&frame, PREVIEW_BOX_ROWS - 1);
		assert!(bottom.contains("528x200"), "resolution caption missing: {bottom}");
		assert_eq!(frame.cell(0, 0).style.foreground_color(), attachment_color(1));
		assert_eq!(
			frame
				.cell(PREVIEW_BOX_COLS + PREVIEW_GAP, 0)
				.style
				.foreground_color(),
			attachment_color(2),
			"each frame is tinted with its own identity color"
		);
		assert_eq!(
			frame_row_text(&frame, PREVIEW_BOX_ROWS).trim(),
			"",
			"a spacer row separates the band from the status line"
		);
		assert!(frame_row_text(&frame, PREVIEW_BOX_ROWS + 1).contains("ready"));
		assert!(frame_row_text(&frame, PREVIEW_BOX_ROWS + 2).contains("body"));

		assert_eq!(attachments.take().len(), 2);
		editor.invalidate();
		assert_eq!(editor.height(&ctx, 40), base, "taking attachments collapses the band");
		fs::remove_dir_all(&dir).ok();
	}

	#[test]
	fn attachment_previews_hide_when_the_composer_is_too_narrow() {
		let ctx = UiContext::default();
		let pane = EditorPane::new();
		let attachments = pane.attachments();
		attachments.push_image("/nope/a.png");
		attachments.push_image("/nope/b.png");
		let mut editor = Cached::new(Box::new(pane));
		let height = editor.height(&ctx, 20);
		editor.place(&ctx, Rect::new(0, 0, 20, height));
		let mut frame = Frame::new(Size::new(20, height));
		let mut hits = Vec::new();
		editor.paint(&mut PaintCtx::new(&mut frame, &ctx, &mut hits, &mut Vec::new()));

		let captions = frame_row_text(&frame, 0);
		assert!(captions.contains("#1"), "caption row: {captions}");
		assert!(!captions.contains("#2"), "overflowing preview must stay hidden: {captions}");
	}

	#[test]
	fn paste_cards_preview_leading_text_with_size_caption() {
		let ctx = UiContext::default();
		let pane = EditorPane::new();
		let attachments = pane.attachments();
		let paste = (0..12)
			.map(|n| format!("line{n}"))
			.collect::<Vec<_>>()
			.join("\n");
		let card = attachments.push_text(&paste);
		assert_eq!(card.marker, 1);
		let AttachmentContent::Text { text, lines, .. } = &card.content else {
			panic!("paste attachment must carry text");
		};
		assert_eq!(text.as_str(), paste);
		assert_eq!(*lines, 12);

		let mut editor = Cached::new(Box::new(pane));
		let height = editor.height(&ctx, 40);
		editor.place(&ctx, Rect::new(0, 0, 40, height));
		let mut frame = Frame::new(Size::new(40, height));
		let mut hits = Vec::new();
		editor.paint(&mut PaintCtx::new(&mut frame, &ctx, &mut hits, &mut Vec::new()));

		assert!(frame_row_text(&frame, 0).contains("#1"));
		assert!(frame_row_text(&frame, 1).contains("line0"), "card previews the paste text");
		assert!(
			frame_row_text(&frame, PREVIEW_BOX_ROWS - 1).contains("+12 lines"),
			"bottom edge captions the paste size"
		);
	}

	#[test]
	fn quoted_image_path_drop_stages_a_reference_chip() {
		let path = temp_drop_file("quoted", "drop test.png", b"\x89PNG\r\n\x1a\n");
		let normalized = path.to_str().expect("temp path is UTF-8");
		let pasted = format!("'{normalized}'");
		let pane = EditorPane::new().with(Prop::Id, "composer");
		let attachments = pane.attachments();
		let mut ui = Ui::from_root(pane, 60, UiContext::default());
		ui.focus_first();

		ui.handle_paste(&pasted);

		assert_eq!(attachments.len(), 1);
		let visible = editor_pane(&ui).buffer().text();
		assert!(visible.contains("#1"));
		assert!(!visible.contains(&pasted));
		assert!(visible.ends_with(' '));
		// A header without IHDR gives no dimensions.
		assert_eq!(editor_pane(&ui).buffer().expanded_text(), "[Image #1] ");
		assert!(matches!(
			&attachments.snapshot()[0].content,
			AttachmentContent::Image { source, .. } if source.as_str() == normalized
		));
		fs::remove_dir_all(path.parent().unwrap()).ok();
	}

	#[test]
	fn probed_image_drop_expands_to_a_dimensioned_marker() {
		let png = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR\0\0\0\x04\0\0\0\x03";
		let path = temp_drop_file("probed-marker", "probed.png", png);
		let pane = EditorPane::new().with(Prop::Id, "composer");
		let attachments = pane.attachments();
		let mut ui = Ui::from_root(pane, 60, UiContext::default());
		ui.focus_first();

		ui.handle_paste(path.to_str().expect("temp path is UTF-8"));

		assert_eq!(editor_pane(&ui).buffer().expanded_text(), "[Image #1, 4x3] ");
		assert_eq!(attachments.snapshot()[0].wire_marker().as_deref(), Some("[Image #1, 4x3]"));
		fs::remove_dir_all(path.parent().unwrap()).ok();
	}

	#[test]
	fn file_url_image_drop_stages_its_normalized_path() {
		let path = temp_drop_file("file-url", "url drop.png", b"\x89PNG\r\n\x1a\n");
		let normalized = path.to_str().expect("temp path is UTF-8");
		let pasted = format!("file://{}", normalized.replace(' ', "%20"));
		let pane = EditorPane::new().with(Prop::Id, "composer");
		let attachments = pane.attachments();
		let mut ui = Ui::from_root(pane, 60, UiContext::default());
		ui.focus_first();

		ui.handle_paste(&pasted);

		assert_eq!(attachments.len(), 1);
		assert_eq!(editor_pane(&ui).buffer().expanded_text(), "[Image #1] ");
		assert!(matches!(
			&attachments.snapshot()[0].content,
			AttachmentContent::Image { source, .. } if source.as_str() == normalized
		));
		fs::remove_dir_all(path.parent().unwrap()).ok();
	}

	#[test]
	fn escaped_image_path_drop_stages_chips_in_order() {
		let first = temp_drop_file("escaped", "drop one.png", b"\x89PNG\r\n\x1a\n");
		let second = temp_drop_file("escaped", "drop two.gif", b"GIF89a");
		let first_text = first.to_str().expect("temp path is UTF-8");
		let second_text = second.to_str().expect("temp path is UTF-8");
		let pasted =
			format!("{} {}", first_text.replace(' ', "\\ "), second_text.replace(' ', "\\ "));
		let pane = EditorPane::new().with(Prop::Id, "composer");
		let attachments = pane.attachments();
		let mut ui = Ui::from_root(pane, 60, UiContext::default());
		ui.focus_first();

		ui.handle_paste(&pasted);

		assert_eq!(attachments.len(), 2);
		let visible = editor_pane(&ui).buffer().text();
		assert!(visible.find("#1").unwrap() < visible.find("#2").unwrap());
		assert_eq!(editor_pane(&ui).buffer().expanded_text(), "[Image #1] [Image #2] ");
		let sources = attachments
			.snapshot()
			.iter()
			.map(|attachment| match &attachment.content {
				AttachmentContent::Image { source, .. } => source.to_string(),
				AttachmentContent::Video { .. } | AttachmentContent::Text { .. } => {
					unreachable!("image drop")
				},
			})
			.collect::<Vec<_>>();
		assert_eq!(sources, [first_text, second_text]);
		ui.handle_key(Key::Ctrl('_'));
		assert_eq!(
			editor_pane(&ui).buffer().text(),
			"",
			"one undo removes every chip and suffix from one drop"
		);
		fs::remove_dir_all(first.parent().unwrap()).ok();
	}

	#[test]
	fn mixed_image_video_drop_stages_classified_chips_in_source_order() {
		let image = temp_drop_file("mixed-media", "first image.png", b"\x89PNG\r\n\x1a\n");
		let video = temp_drop_file("mixed-media", "second video.mp4", b"video");
		let pasted = format!("'{}' '{}'", image.display(), video.display());
		let pane = EditorPane::new().with(Prop::Id, "composer");
		let attachments = pane.attachments();
		let mut ui = Ui::from_root(pane, 80, UiContext::default());
		ui.focus_first();

		ui.handle_paste(&pasted);

		assert_eq!(editor_pane(&ui).buffer().expanded_text(), "[Image #1] [Video #2] ");
		let staged = attachments.snapshot();
		assert!(matches!(
			&staged[0].content,
			AttachmentContent::Image { source, .. } if source.as_str() == image.to_string_lossy().as_ref()
		));
		assert!(matches!(
			&staged[1].content,
			AttachmentContent::Video { source } if source.as_str() == video.to_string_lossy().as_ref()
		));
		fs::remove_dir_all(image.parent().unwrap()).ok();
	}

	#[test]
	fn missing_image_path_drop_remains_plain_text() {
		let path = env::temp_dir()
			.join(format!("omp-editor-drop-missing-{}", std::process::id()))
			.join("missing image.png");
		fs::remove_file(&path).ok();
		let pasted = format!("'{}'", path.to_str().expect("temp path is UTF-8"));
		let pane = EditorPane::new().with(Prop::Id, "composer");
		let attachments = pane.attachments();
		let mut ui = Ui::from_root(pane, 60, UiContext::default());
		ui.focus_first();

		ui.handle_paste(&pasted);

		assert!(attachments.is_empty());
		assert_eq!(editor_pane(&ui).buffer().text(), pasted);
	}

	#[test]
	fn existing_non_image_path_drop_remains_plain_text() {
		let path = temp_drop_file("non-image", "notes.txt", b"not an image");
		let pasted = path.to_str().expect("temp path is UTF-8");
		let pane = EditorPane::new().with(Prop::Id, "composer");
		let attachments = pane.attachments();
		let mut ui = Ui::from_root(pane, 60, UiContext::default());
		ui.focus_first();

		ui.handle_paste(pasted);

		assert!(attachments.is_empty());
		assert_eq!(editor_pane(&ui).buffer().text(), pasted);
		fs::remove_dir_all(path.parent().unwrap()).ok();
	}

	#[test]
	fn image_path_drop_without_attachment_binding_remains_plain_text() {
		let path = temp_drop_file("unbound", "drop test.png", b"\x89PNG\r\n\x1a\n");
		let pasted = format!("'{}'", path.to_str().expect("temp path is UTF-8"));
		let mut ui =
			Ui::from_root(EditInput::new().with(Prop::Id, "composer"), 60, UiContext::default());
		ui.focus_first();

		ui.handle_paste(&pasted);

		let input = ui
			.root()
			.comp()
			.downcast_ref::<EditInput>()
			.expect("UI root is an editor input");
		assert_eq!(input.buffer().text(), pasted);
		fs::remove_dir_all(path.parent().unwrap()).ok();
	}

	#[test]
	fn plain_path_paste_separates_from_a_preceding_word_only() {
		let mut after_word = Ui::from_root(
			EditInput::new()
				.with(Prop::Id, "composer")
				.with(Prop::Value, "word"),
			40,
			UiContext::default(),
		);
		after_word.focus_first();
		after_word.handle_paste("/tmp");
		assert_eq!(after_word.values()["composer"], Value::String("word /tmp".to_owned()));

		let mut after_space = Ui::from_root(
			EditInput::new()
				.with(Prop::Id, "composer")
				.with(Prop::Value, "word "),
			40,
			UiContext::default(),
		);
		after_space.focus_first();
		after_space.handle_paste("/tmp");
		assert_eq!(after_space.values()["composer"], Value::String("word /tmp".to_owned()));
	}

	#[test]
	fn hidden_attachments_keep_markers_but_never_reach_take() {
		let attachments = Attachments::new();
		attachments.push_image("/nope/a.png");
		attachments.push_image("/nope/b.png");
		assert!(attachments.set_visible(|attachment| attachment.marker != 1));
		assert_eq!(attachments.len(), 1, "hiding drops the visible count");
		assert_eq!(attachments.push_image("/nope/c.png").marker, 3, "markers stay stable");

		// Undo made the first reference reappear.
		assert!(attachments.set_visible(|_| true));
		assert_eq!(attachments.len(), 3);

		// Deleted again; the drain must never hand it to the host.
		assert!(attachments.set_visible(|attachment| attachment.marker != 1));
		let taken = attachments.take();
		assert_eq!(
			taken.iter().map(|a| a.marker).collect::<Vec<_>>(),
			vec![2, 3],
			"take returns only visible attachments"
		);
		assert!(attachments.is_empty());
		assert_eq!(attachments.push_image("/nope/d.png").marker, 1, "numbering restarts");
	}

	#[test]
	fn collapsed_paste_chip_and_suffix_undo_together() {
		let mut ui =
			Ui::from_root(EditorPane::new().with(Prop::Id, "composer"), 40, UiContext::default());
		ui.focus_first();
		let paste = (0..12)
			.map(|n| format!("line{n}"))
			.collect::<Vec<_>>()
			.join("\n");
		ui.handle_paste(&paste);
		assert!(editor_pane(&ui).buffer().text().ends_with(' '));
		ui.handle_key(Key::Ctrl('_'));
		assert_eq!(editor_pane(&ui).buffer().text(), "");
	}

	#[test]
	fn default_editor_collapses_large_pastes_into_atomic_chip_cards() {
		let mut ui = Ui::from_root(
			EditorPane::new()
				.with(Prop::Id, "composer")
				.status(Status::new().segment(Segment::new().label("ready"))),
			40,
			UiContext::default(),
		);
		ui.focus_first();
		let base = ui.height();
		let paste = (0..12)
			.map(|n| format!("line{n}"))
			.collect::<Vec<_>>()
			.join("\n");
		ui.handle_paste(&paste);
		assert_eq!(
			ui.height(),
			base + PREVIEW_BOX_ROWS + 1,
			"a routed paste grows the pane's band without a manual relayout"
		);
		assert!(frame_row_text(ui.frame(), 0).contains("#1"));
		assert!(frame_row_text(ui.frame(), PREVIEW_BOX_ROWS - 1).contains("+12 lines"));

		// The chip paints in its identity color inside the input row.
		let input_row = PREVIEW_BOX_ROWS + 2;
		let text = frame_row_text(ui.frame(), input_row);
		let hash = text.find('#').expect("chip in the input row");
		let column = u16::try_from(xutf::width_str(&text[..hash])).expect("narrow row");
		assert_eq!(ui.frame().cell(column, input_row).style.foreground_color(), attachment_color(1));

		// Backspace over the trailing space, then the chip: one atomic unit
		// whose removal collapses the band through the same event path.
		ui.handle_key(Key::Backspace);
		ui.handle_key(Key::Backspace);
		assert_eq!(ui.height(), base, "deleting the chip collapses the band");
		assert_eq!(
			ui.values().get("composer").and_then(Value::as_str),
			Some(""),
			"a deleted paste never reaches the submitted value"
		);

		// Undo restores the chip, its card, and the expanded payload.
		ui.handle_key(Key::Ctrl('_'));
		assert_eq!(ui.height(), base + PREVIEW_BOX_ROWS + 1, "undo restores the band");
		let values = ui.values();
		assert_eq!(
			values
				.get("composer")
				.and_then(Value::as_str)
				.map(|value| value.trim_end().to_owned()),
			Some(paste),
			"the restored chip expands back to the pasted text"
		);
	}

	/// The nerd-font chip label is a private-use glyph (two cells, three
	/// bytes) plus `#N`: every delete key removes the whole chip from either
	/// side, and the caret never rests inside it.
	#[test]
	fn wide_glyph_chips_delete_atomically_from_both_sides() {
		let paste = (0..12)
			.map(|n| format!("line{n}"))
			.collect::<Vec<_>>()
			.join("\n");
		let ctx = UiContext { charset: Charset::NerdFont, ..UiContext::default() };
		for (key, from_left) in [
			(Key::Backspace, false),
			(Key::Ctrl('w'), false),
			(Key::Delete, true),
			(Key::WordDelete, true),
		] {
			let mut ui = Ui::from_root(
				EditorPane::new()
					.with(Prop::Id, "composer")
					.status(Status::new().segment(Segment::new().label("ready"))),
				40,
				ctx.clone(),
			);
			ui.focus_first();
			let base = ui.height();
			ui.handle_paste(&paste);
			let chip = chip_label(&editor_pane(&ui).attachments.snapshot()[0], Charset::NerdFont);
			assert!(chip.starts_with(Charset::NerdFont.icon(Icon::TextFile)), "{chip}");
			assert_eq!(editor_pane(&ui).buffer().text(), format!("{chip} "));
			// Walking left over the chip lands before it, never inside.
			ui.handle_key(Key::Left);
			ui.handle_key(Key::Left);
			assert_eq!(editor_pane(&ui).buffer().cursor(), 0, "{key:?}");
			if from_left {
				ui.handle_key(key);
				assert_eq!(editor_pane(&ui).buffer().text(), " ", "{key:?}");
			} else {
				ui.handle_key(Key::End);
				ui.handle_key(Key::Backspace);
				ui.handle_key(key);
				assert_eq!(editor_pane(&ui).buffer().text(), "", "{key:?}");
			}
			assert_eq!(ui.height(), base, "{key:?}: deleting the chip collapses the band");
		}
	}

	#[test]
	fn raw_paste_bypasses_chips_and_drop_classification() {
		let dir = env::temp_dir().join(format!("omp-tui-raw-paste-{}", std::process::id()));
		fs::create_dir_all(&dir).unwrap();
		let path = dir.join("raw.png");
		fs::write(&path, b"\x89PNG\r\n\x1a\n\0\0\0\0").unwrap();

		let mut ui = Ui::from_root(
			EditorPane::new()
				.with(Prop::Id, "composer")
				.status(Status::new().segment(Segment::new().label("ready"))),
			40,
			UiContext::default(),
		);
		ui.focus_first();

		// An existing image path inserts as text instead of staging an
		// attachment (Ctrl+Shift+V contract: verbatim insertion).
		let path_text = path.to_str().expect("temp path is UTF-8").to_owned();
		ui.handle_paste_raw(&path_text);
		assert!(
			editor_pane(&ui).attachments.is_empty(),
			"raw paste must not stage an attachment card"
		);
		assert_eq!(
			ui.values().get("composer").and_then(Value::as_str),
			Some(path_text.as_str()),
			"the path stays inline text"
		);

		// Large text stays inline and editable instead of collapsing.
		let mut ui = Ui::from_root(
			EditorPane::new()
				.with(Prop::Id, "composer")
				.status(Status::new().segment(Segment::new().label("ready"))),
			40,
			UiContext::default(),
		);
		ui.focus_first();
		let big = (0..12)
			.map(|n| format!("line{n}"))
			.collect::<Vec<_>>()
			.join("\n");
		ui.handle_paste_raw(&big);
		// The old base-height expectation confused “no chip band” with
		// “single-line”; inline multiline content must still grow the editor.
		assert_eq!(
			ui.height(),
			13,
			"verbatim multiline text grows the inline editor without adding the seven-row chip band"
		);
		assert!(
			editor_pane(&ui).attachments.is_empty(),
			"raw paste must not stage chip-card content"
		);
		assert_eq!(
			ui.values().get("composer").and_then(Value::as_str),
			Some(big.as_str()),
			"the full text stays inline"
		);
		fs::remove_dir_all(&dir).ok();
	}
}
