//! Welcome banner: a two-column box with the brand mark,
//! startup tip, LSP and recent-session slots.
//!
//! The mark plays a 3000ms gradient intro on the block's paint clock
//! (`welcome.ts` `playIntro` / `introLogoFrame`) through
//! [`Brand`]; the host keeps the block mutable until the intro settles
//! (ADR 0034) and remounts it on the resting frame.

use std::{
	sync::LazyLock,
	time::{Duration, SystemTime, UNIX_EPOCH},
};

use omp_core::Str;
use omp_tui::{
	Border, Charset, Component, Icon, PaintCtx, Props, Rect, Slot, Style, UiContext,
	anim::Rainbow,
	cell_width,
	components::{Brand, hr::truncate_to_width},
	next_slot,
};

use crate::chrome::ModelBadge;

/// Widest welcome box, in cells.
const BOX_MAX_WIDTH: u16 = 100;
const PREFERRED_LEFT: u16 = 26;
const MIN_LEFT: u16 = 12;
const MIN_RIGHT: u16 = 20;
/// Fixed slot counts so the box height never depends on live data (
/// `WELCOME_SESSION_SLOTS` / `WELCOME_LSP_SLOTS`).
const SESSION_SLOTS: usize = 4;
const LSP_SLOTS: usize = 4;
/// Startup tips embedded at build time, one per line.
const TIPS_TEXT: &str = include_str!("tips.txt");
/// Trailing marker flagging a "what's new" tip.
const NEW_TIP_MARKER: &str = "[NEW]";
/// Visible text painted in place of the marker.
const NEW_TAG_TEXT: &str = "NEW!";
/// Selection weight of `[NEW]` tips.
const NEW_TIP_WEIGHT: u32 = 4;
/// Shown instead of a tip on a plain-unicode terminal one launch in ten.
const NERDFONT_NAG: &str = "Please use nerdfont 😭.";
const NAG_CHANCE: f32 = 0.1;
const TIP_LABEL: &str = "Tip: ";

/// A recently used session for the welcome box.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RecentSession {
	/// Display name: the session title or its first prompt line.
	pub name:     Str,
	/// Relative age label (`5m ago`).
	pub time_ago: Str,
}

/// Language-server state for one welcome slot.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LspStatus {
	/// Running and initialized.
	Ready,
	/// Configured and resolvable, not started.
	Available,
	/// Starting or indexing.
	Connecting,
	/// Failed to start or missing binary.
	Error,
}

/// A language server for the welcome box.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LspServer {
	/// Server name.
	pub name:       Str,
	/// Current state.
	pub status:     LspStatus,
	/// File types it serves; the box shows the first three.
	pub file_types: Vec<Str>,
}

/// Observer-local facts the welcome box paints in its right column.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct WelcomeFacts {
	/// Recent sessions, newest first.
	pub recent: Vec<RecentSession>,
	/// Language servers for the project.
	pub lsp:    Vec<LspServer>,
}

/// The embedded tip list with blanks dropped.
fn tips() -> impl Iterator<Item = &'static str> {
	TIPS_TEXT
		.lines()
		.map(str::trim)
		.filter(|line| !line.is_empty())
}

fn is_new_tip(tip: &str) -> bool {
	tip.trim_end().ends_with(NEW_TIP_MARKER)
}

/// Strips a trailing `[NEW]` marker and any whitespace before it.
fn strip_new_marker(tip: &str) -> (&str, bool) {
	let trimmed = tip.trim_end();
	match trimmed.strip_suffix(NEW_TIP_MARKER) {
		Some(body) => (body.trim_end(), true),
		None => (tip, false),
	}
}

/// Picks a tip biased toward `[NEW]` tips by [`NEW_TIP_WEIGHT`]; `r` is a
/// uniform sample in `[0, 1)`. Empty
/// `tips` yield `""`.
#[must_use]
pub fn pick_weighted_tip<'a>(tips: &[&'a str], r: f32) -> &'a str {
	let Some(last) = tips.last() else {
		return "";
	};
	let weight = |tip: &str| if is_new_tip(tip) { NEW_TIP_WEIGHT } else { 1 };
	let total: u32 = tips.iter().map(|tip| weight(tip)).sum();
	let mut acc = r * total as f32;
	for &tip in tips {
		acc -= weight(tip) as f32;
		if acc < 0.0 {
			return tip;
		}
	}
	*last
}

/// Two uniform rolls in `[0, 1)` from one seed (splitmix64), latched for
/// the session so the tip is stable across repaints.
fn rolls(seed: u64) -> (f32, f32) {
	let mut state = seed;
	let mut next = || {
		state = state.wrapping_add(0x9e37_79b9_7f4a_7c15);
		let mut z = state;
		z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
		z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
		z ^= z >> 31;
		(z >> 40) as f32 / (1u64 << 24) as f32
	};
	(next(), next())
}

/// Process-wide launch entropy, latched on first use.
static LAUNCH_SEED: LazyLock<u64> = LazyLock::new(|| {
	SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.map_or(0, |since| since.as_nanos() as u64)
});

/// Deterministic seed for `cwd` (FNV-1a), the headless golden's tip source.
#[must_use]
pub fn welcome_seed(cwd: &str) -> u64 {
	cwd.bytes().fold(0xcbf2_9ce4_8422_2325_u64, |acc, byte| {
		(acc ^ u64::from(byte)).wrapping_mul(0x100_0000_01b3)
	})
}

/// Picks the session's startup tip from `seed`: the
/// nerdfont nag one launch in ten on a plain-unicode terminal, otherwise a
/// `[NEW]`-weighted pick. Deterministic for a fixed seed.
#[must_use]
pub fn tip_seeded(seed: u64, charset: Charset) -> Str {
	let (nag_roll, tip_roll) = rolls(seed);
	if charset == Charset::Unicode && nag_roll < NAG_CHANCE {
		return Str::new_static(NERDFONT_NAG);
	}
	let tips: Vec<&str> = tips().collect();
	Str::new_static(pick_weighted_tip(&tips, tip_roll))
}

/// Picks the session's startup tip for one launch: the working directory
/// mixed with launch entropy, latched once per process so every repaint
/// shows the same line.
#[must_use]
pub fn tip_for(cwd: &str, charset: Charset) -> Str {
	tip_seeded(welcome_seed(cwd) ^ *LAUNCH_SEED, charset)
}

/// Welcome banner: two-column box with the brand mark, model, tips, LSP and
/// recent-session slots, followed by the startup tip.
pub struct Welcome {
	props:    Props,
	slot:     Slot,
	/// Top-border title ` omp v<version> `, built once.
	title:    Str,
	model:    Str,
	provider: Str,
	/// Tip body with any `[NEW]` marker stripped.
	tip:      Str,
	/// Whether the tip carries the rainbow `NEW!` tag.
	new_tag:  bool,
	facts:    WelcomeFacts,
	brand:    Brand,
	/// Wrapped tip lines for the last box width (ADR 0030: the cache owns
	/// the memory; the intro repaints every frame at one width).
	tip_wrap: TipWrap,
}

/// Width-keyed wrap of the startup tip: rebuilt only when the box width
/// changes.
struct TipWrap {
	box_width: u16,
	lines:     Vec<Str>,
	/// Whether the `NEW!` tag rides the last line (`false` puts it on its
	/// own indented line).
	inline:    bool,
}

impl TipWrap {
	const fn empty() -> Self {
		Self { box_width: 0, lines: Vec::new(), inline: false }
	}
}

struct WelcomeGeometry {
	box_width:  u16,
	left_col:   u16,
	right_col:  u16,
	show_right: bool,
}

impl Welcome {
	/// Creates the banner for one launch. `intro` is how far into the
	/// 3000ms brand intro the block already is when its paint clock starts
	/// (`Duration::ZERO` = fresh start); `None` paints the resting frame.
	#[must_use]
	pub fn new(
		version: Str,
		badge: &ModelBadge,
		tip: Str,
		facts: WelcomeFacts,
		intro: Option<Duration>,
	) -> Self {
		let (body, new_tag) = strip_new_marker(tip.as_str());
		let tip = if new_tag { Str::new(body) } else { tip };
		let brand = intro.map_or_else(Brand::new, |elapsed| Brand::new().intro(elapsed));
		Self {
			props: Props::new(),
			slot: next_slot(),
			title: Str::new(format!(" omp v{version} ")),
			model: badge.name.clone(),
			provider: badge.provider.clone(),
			tip,
			new_tag,
			facts,
			brand,
			tip_wrap: TipWrap::empty(),
		}
	}

	/// Computes responsive breakpoint arithmetic.
	fn geometry(width: u16) -> Option<WelcomeGeometry> {
		let box_width = BOX_MAX_WIDTH.min(width.saturating_sub(2));
		if box_width < 4 {
			return None;
		}
		let dual_content = box_width - 3;
		let left_min_content = MIN_LEFT.max(cell_width("Welcome back!"));
		let scaled = (f64::from(dual_content) * 0.35).floor() as u16;
		let desired_left = PREFERRED_LEFT
			.min(MIN_LEFT.max(scaled))
			.max(left_min_content);
		let dual_left = if dual_content > MIN_RIGHT {
			desired_left.min(dual_content - MIN_RIGHT)
		} else {
			dual_content.saturating_sub(1).max(1)
		};
		let dual_right = dual_content.saturating_sub(dual_left).max(1);
		let show_right = dual_left >= left_min_content && dual_right >= MIN_RIGHT;
		let left_col = if show_right { dual_left } else { box_width - 2 };
		let right_col = if show_right { dual_right } else { 0 };
		Some(WelcomeGeometry { box_width, left_col, right_col, show_right })
	}

	fn content_rows(show_right: bool) -> u16 {
		let left = 3 + usize::from(Brand::size().1) + 1 + 2;
		let right = 1 + 4 + 1 + 1 + LSP_SLOTS + 1 + 1 + SESSION_SLOTS + 1;
		let rows = if show_right { left.max(right) } else { left };
		u16::try_from(rows).unwrap_or(u16::MAX)
	}

	/// Wrapped tip body lines for `box_width`, rewrapped only when the width
	/// differs from the cached one; the returned lines are owned by the
	/// component.
	fn tip_lines(&mut self, box_width: u16) -> &TipWrap {
		if self.tip_wrap.box_width != box_width || self.tip_wrap.box_width == 0 {
			let indent = cell_width(TIP_LABEL);
			let budget = box_width.saturating_sub(1 + indent);
			self.tip_wrap.box_width = box_width;
			self.tip_wrap.lines.clear();
			self.tip_wrap.inline = false;
			if budget >= 8 {
				wrap_words(self.tip.as_str(), budget, &mut self.tip_wrap.lines);
				if let Some(last) = self.tip_wrap.lines.last() {
					let tag_width = 1 + cell_width(NEW_TAG_TEXT);
					self.tip_wrap.inline = 1 + indent + cell_width(last) + tag_width <= box_width;
				}
			}
		}
		&self.tip_wrap
	}

	/// Rows the tip occupies under the box.
	fn tip_rows(&mut self, box_width: u16) -> u16 {
		let new_tag = self.new_tag;
		let wrap = self.tip_lines(box_width);
		let extra = u16::from(new_tag && !wrap.inline && !wrap.lines.is_empty());
		u16::try_from(wrap.lines.len())
			.unwrap_or(u16::MAX)
			.saturating_add(extra)
	}

	fn paint_new_tag(pc: &mut PaintCtx<'_>, x: u16, y: u16) {
		let rainbow = Rainbow::at(pc.now);
		let count = NEW_TAG_TEXT.chars().count();
		let mut column = x;
		let mut utf8 = [0; 4];
		for (index, glyph) in NEW_TAG_TEXT.chars().enumerate() {
			column =
				pc.frame
					.put(column, y, glyph.encode_utf8(&mut utf8), rainbow.style(index, count));
		}
	}

	fn paint_session(&self, pc: &mut PaintCtx<'_>, x: u16, y: u16, width: u16, index: usize) {
		let theme = pc.ctx.theme;
		let dim = Style::new().fg(theme.dim);
		let muted = Style::new().fg(theme.muted);
		if self.facts.recent.is_empty() {
			if index == 0 {
				pc.frame
					.put(x.saturating_add(1), y, "No recent sessions", dim);
			}
			return;
		}
		let Some(session) = self.facts.recent.get(index) else {
			return;
		};
		// Reserve the bullet prefix and the trailing time so the relative
		// time is never the part that gets truncated.
		let bullet = pc.ctx.charset.icon(Icon::Bullet);
		let prefix_width = 1 + cell_width(bullet) + 1;
		let time_width = 2 + cell_width(&session.time_ago) + 1;
		let budget = width
			.saturating_sub(prefix_width)
			.saturating_sub(time_width)
			.max(1);
		let name = truncate_to_width(&session.name, budget);
		let mut column = pc.frame.put(x, y, " ", dim);
		column = pc.frame.put(column, y, bullet, dim);
		column = pc.frame.put(column, y, " ", dim);
		column = pc.frame.put(column, y, name.text, muted);
		if name.ellipsis {
			column = pc.frame.put(column, y, "…", muted);
		}
		column = pc.frame.put(column, y, " (", dim);
		column = pc.frame.put(column, y, &session.time_ago, dim);
		pc.frame.put(column, y, ")", dim);
	}

	fn paint_lsp(&self, pc: &mut PaintCtx<'_>, x: u16, y: u16, index: usize) {
		let theme = pc.ctx.theme;
		let dim = Style::new().fg(theme.dim);
		let muted = Style::new().fg(theme.muted);
		if self.facts.lsp.is_empty() {
			if index == 0 {
				pc.frame.put(x.saturating_add(1), y, "No LSP servers", dim);
			}
			return;
		}
		let Some(server) = self.facts.lsp.get(index) else {
			return;
		};
		let (icon, icon_style) = match server.status {
			LspStatus::Ready => (Icon::Enabled, Style::new().fg(theme.ok)),
			LspStatus::Available => (Icon::Enabled, dim),
			LspStatus::Connecting => (Icon::Pending, muted),
			LspStatus::Error => (Icon::Error, Style::new().fg(theme.err)),
		};
		let mut column = pc.frame.put(x, y, " ", dim);
		column = pc
			.frame
			.put(column, y, pc.ctx.charset.icon(icon), icon_style);
		column = pc.frame.put(column, y, " ", dim);
		column = pc.frame.put(column, y, &server.name, muted);
		for file_type in server.file_types.iter().take(3) {
			column = pc.frame.put(column, y, " ", dim);
			column = pc.frame.put(column, y, file_type, dim);
		}
	}
}

/// Greedy word wrap on cell width into `lines`; words wider than the
/// budget are broken at grapheme boundaries so wide and emoji text never
/// overflows the box.
fn wrap_words(text: &str, budget: u16, lines: &mut Vec<Str>) {
	let mut current = String::new();
	for word in text.split_whitespace() {
		let word_width = cell_width(word);
		let candidate_width = cell_width(&current)
			.saturating_add(u16::from(!current.is_empty()))
			.saturating_add(word_width);
		if !current.is_empty() && candidate_width > budget {
			lines.push(Str::new(std::mem::take(&mut current)));
		}
		if word_width > budget {
			let mut rest = word;
			while !rest.is_empty() {
				let piece = clip_to_width(rest, budget.max(1));
				if piece.is_empty() {
					break;
				}
				lines.push(Str::new(piece));
				rest = &rest[piece.len()..];
			}
			continue;
		}
		if !current.is_empty() {
			current.push(' ');
		}
		current.push_str(word);
	}
	if !current.is_empty() {
		lines.push(Str::new(current));
	}
}

/// Paints `glyph` `count` times from `(x, y)` without building a string;
/// returns the column after the run.
fn put_repeat(pc: &mut PaintCtx<'_>, x: u16, y: u16, glyph: char, count: u16, style: Style) -> u16 {
	let mut utf8 = [0; 4];
	let text = glyph.encode_utf8(&mut utf8);
	let mut column = x;
	for _ in 0..count {
		column = pc.frame.put(column, y, text, style);
	}
	column
}

/// Paints `text` centered inside `width` cells starting at `x`.
fn put_centered(pc: &mut PaintCtx<'_>, x: u16, y: u16, width: u16, text: &str, style: Style) {
	let text_width = cell_width(text);
	if text_width >= width {
		let clipped = clip_to_width(text, width);
		pc.frame.put(x, y, clipped, style);
		return;
	}
	let left_pad = (width - text_width) / 2;
	pc.frame.put(x.saturating_add(left_pad), y, text, style);
}

fn clip_to_width(text: &str, width: u16) -> &str {
	let mut end = 0;
	let mut used = 0;
	for (index, grapheme) in text.char_indices() {
		let glyph = cell_width(&text[index..index + grapheme.len_utf8()]);
		if used + glyph > width {
			break;
		}
		used += glyph;
		end = index + grapheme.len_utf8();
	}
	&text[..end]
}

impl Component for Welcome {
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
		(MIN_LEFT + 4, BOX_MAX_WIDTH + 2)
	}

	fn height(&mut self, _ctx: &UiContext, width: u16) -> u16 {
		let Some(geometry) = Self::geometry(width) else {
			return 0;
		};
		1_u16
			.saturating_add(1)
			.saturating_add(Self::content_rows(geometry.show_right))
			.saturating_add(1)
			.saturating_add(self.tip_rows(geometry.box_width))
	}

	fn paint(&mut self, pc: &mut PaintCtx<'_>, rect: Rect) {
		let Some(geometry) = Self::geometry(rect.width) else {
			return;
		};
		let theme = pc.ctx.theme;
		let (tl, tr, bl, br, horizontal, vertical) = pc.ctx.charset.border(Border::Round);
		let dim = Style::new().fg(theme.dim);
		let muted = Style::new().fg(theme.muted);
		let border_muted = Style::new().fg(theme.border_muted);
		let accent = Style::new().fg(theme.accent).bold();
		let x = rect.x;
		let mut y = rect.y.saturating_add(1);
		let WelcomeGeometry { box_width, left_col, right_col, show_right } = geometry;

		// Top border with the embedded title after three rule cells.
		let mut column = pc.frame.put(x, y, tl.encode_utf8(&mut [0; 4]), dim);
		let title_space = box_width - 2;
		let title_width = 3 + cell_width(&self.title);
		column = put_repeat(pc, column, y, horizontal, 3, dim);
		if title_width >= title_space {
			let clipped = clip_to_width(&self.title, title_space.saturating_sub(3));
			column = pc.frame.put(column, y, clipped, muted);
		} else {
			column = pc.frame.put(column, y, &self.title, muted);
			column = put_repeat(pc, column, y, horizontal, title_space - title_width, dim);
		}
		pc.frame.put(column, y, tr.encode_utf8(&mut [0; 4]), dim);
		y = y.saturating_add(1);

		// Content rows.
		let rows = Self::content_rows(show_right);
		let left_x = x.saturating_add(1);
		let right_x = left_x.saturating_add(left_col).saturating_add(1);
		let mut vertical_utf8 = [0; 4];
		let vertical_glyph: &str = vertical.encode_utf8(&mut vertical_utf8);
		let logo_top = 3_u16;
		let (logo_cols, logo_rows) = Brand::size();
		let model_row = logo_top + logo_rows + 1;
		// The right-column rule: one pad cell then the horizontal run.
		let separator_run = right_col.saturating_sub(2);
		let lsp_top = 7_u16;
		let sessions_top = lsp_top + 1 + u16::try_from(LSP_SLOTS).unwrap_or(u16::MAX) + 1;

		// The brand mark, centered in the left column; it clips itself.
		let logo_x = left_x.saturating_add(left_col.saturating_sub(logo_cols) / 2);
		self.brand.paint_at(pc, logo_x, y.saturating_add(logo_top));
		if let Some(at) = self.brand.next_wake(pc.now) {
			pc.wake(self.slot, at);
		}

		for row in 0..rows {
			if y >= pc.clip {
				return;
			}
			pc.frame.put(x, y, vertical_glyph, dim);
			match row {
				1 => put_centered(pc, left_x, y, left_col, "Welcome back!", Style::new().bold()),
				row if row == model_row => put_centered(pc, left_x, y, left_col, &self.model, muted),
				row if row == model_row + 1 => {
					put_centered(pc, left_x, y, left_col, &self.provider, border_muted);
				},
				_ => {},
			}
			if show_right {
				pc.frame
					.put(right_x.saturating_sub(1), y, vertical_glyph, dim);
				let content_x = right_x.saturating_add(1);
				match row {
					0 => {
						pc.frame.put(content_x, y, "Tips", accent);
					},
					1..=4 => {
						let (key, text) = [
							("#", "for prompt actions"),
							("/", "for commands"),
							("!", "to run bash"),
							("$", "to run python"),
						][usize::from(row - 1)];
						let column = pc.frame.put(content_x, y, key, dim);
						let column = pc.frame.put(column, y, " ", muted);
						pc.frame.put(column, y, text, muted);
					},
					5 => {
						let column = pc.frame.put(right_x, y, " ", dim);
						put_repeat(pc, column, y, horizontal, separator_run, dim);
					},
					row if row == lsp_top - 1 => {
						pc.frame.put(content_x, y, "LSP Servers", accent);
					},
					row if row >= lsp_top && row < sessions_top - 2 => {
						self.paint_lsp(pc, right_x, y, usize::from(row - lsp_top));
					},
					row if row == sessions_top - 2 => {
						let column = pc.frame.put(right_x, y, " ", dim);
						put_repeat(pc, column, y, horizontal, separator_run, dim);
					},
					row if row == sessions_top - 1 => {
						pc.frame.put(content_x, y, "Recent sessions", accent);
					},
					row if row >= sessions_top && usize::from(row - sessions_top) < SESSION_SLOTS => {
						self.paint_session(pc, right_x, y, right_col, usize::from(row - sessions_top));
					},
					_ => {},
				}
				pc.frame
					.put(right_x.saturating_add(right_col), y, vertical_glyph, dim);
			} else {
				pc.frame
					.put(left_x.saturating_add(left_col), y, vertical_glyph, dim);
			}
			y = y.saturating_add(1);
		}

		// Bottom border, with a tee where the column divider meets it.
		if y < pc.clip {
			let mut column = pc.frame.put(x, y, bl.encode_utf8(&mut [0; 4]), dim);
			column = put_repeat(pc, column, y, horizontal, left_col, dim);
			if show_right {
				let tee = if pc.ctx.charset == Charset::Ascii {
					"+"
				} else {
					"┴"
				};
				column = pc.frame.put(column, y, tee, dim);
				column = put_repeat(pc, column, y, horizontal, right_col, dim);
			}
			pc.frame.put(column, y, br.encode_utf8(&mut [0; 4]), dim);
			y = y.saturating_add(1);
		}

		// Startup tip, with the rainbow `NEW!` tag on the last line when it
		// fits, else on its own indented line.
		let label = Style::new().fg(theme.secondary).italic();
		let body = Style::new().fg(theme.muted).italic();
		let indent = cell_width(TIP_LABEL);
		let new_tag = self.new_tag;
		let wrap = self.tip_lines(box_width);
		let inline = wrap.inline;
		let count = wrap.lines.len();
		for (index, line) in wrap.lines.iter().enumerate() {
			if y >= pc.clip {
				return;
			}
			let column = if index == 0 {
				pc.frame.put(x.saturating_add(1), y, TIP_LABEL, label)
			} else {
				x.saturating_add(1).saturating_add(indent)
			};
			let column = pc.frame.put(column, y, line, body);
			if new_tag && inline && index + 1 == count {
				let column = pc.frame.put(column, y, " ", body);
				Self::paint_new_tag(pc, column, y);
			}
			y = y.saturating_add(1);
		}
		if new_tag && !inline && count > 0 && y < pc.clip {
			Self::paint_new_tag(pc, x.saturating_add(1).saturating_add(indent), y);
		}
	}
}

#[cfg(test)]
mod tests {
	use omp_tui::{Color, Ui, anim::FRAME, frame_text};

	use super::*;

	fn badge() -> ModelBadge {
		ModelBadge {
			identifier:     Str::new_static("anthropic/claude-fable-5"),
			name:           Str::new_static("Claude Fable 5"),
			provider:       Str::new_static("anthropic"),
			context_window: Some(1_000_000),
			reasoning:      true,
		}
	}

	fn welcome(tip: &str, facts: WelcomeFacts) -> Welcome {
		Welcome::new(Str::new_static("18.0.11"), &badge(), Str::new(tip), facts, None)
	}

	fn rows_of(ui: &Ui) -> Vec<String> {
		frame_text(ui.frame())
			.lines()
			.map(|line| line.trim_end().to_owned())
			.collect()
	}

	fn rows(component: impl omp_tui::IntoComponent, width: u16) -> Vec<String> {
		rows_of(&Ui::from_root(component, width, UiContext::default()))
	}

	#[test]
	fn welcome_matches_pi_geometry_at_120_columns() {
		let tip = "Press shift+tab to cycle through reasoning effort levels";
		let rows = rows(welcome(tip, WelcomeFacts::default()), 120);
		assert_eq!(rows[0], "");
		assert!(rows[1].starts_with("╭─── omp v18.0.11 ─"), "{}", rows[1]);
		assert_eq!(cell_width(&rows[1]), 100);
		assert_eq!(rows[3], "│      Welcome back!       │ # for prompt actions                                                  │");
		assert_eq!(rows[5], "│       ████████████       │ ! to run bash                                                         │");
		assert_eq!(rows[8], "│          ▒▒  ██          │ LSP Servers                                                           │");
		assert!(rows[9].contains("No LSP servers"), "{}", rows[9]);
		assert!(rows[15].contains("No recent sessions"), "{}", rows[15]);
		assert_eq!(rows[20], format!("╰{}┴{}╯", "─".repeat(26), "─".repeat(71)));
		assert_eq!(rows[21], format!(" Tip: {tip}"));
		assert_eq!(rows.len(), 22);
	}

	#[test]
	fn welcome_drops_the_right_column_on_narrow_terminals() {
		let badge = ModelBadge::from_identifier("anthropic/claude-sonnet-4-5");
		let welcome = Welcome::new(
			Str::new_static("0.1.0"),
			&badge,
			Str::new_static("tip"),
			WelcomeFacts::default(),
			None,
		);
		let rows = rows(welcome, 30);
		assert!(rows.iter().any(|row| row.contains("Welcome back!")));
		assert!(!rows.iter().any(|row| row.contains("Tips")));
	}

	#[test]
	fn recent_sessions_keep_the_time_suffix_and_pad_to_four_slots() {
		let facts = WelcomeFacts {
			recent: vec![
				RecentSession {
					name:     Str::new_static("fix the parser"),
					time_ago: Str::new_static("2h ago"),
				},
				RecentSession {
					name:     Str::new_static(
						"a very long session name that certainly does not fit inside the column",
					),
					time_ago: Str::new_static("3d ago"),
				},
			],
			lsp:    Vec::new(),
		};
		let rows = rows(welcome("tip", facts), 120);
		assert_eq!(rows[15], format!("│{}│{:<71}│", " ".repeat(26), " • fix the parser (2h ago)"));
		assert!(rows[16].contains("… (3d ago)│"), "{}", rows[16]);
		assert_eq!(cell_width(&rows[16]), 100, "truncated name never widens the box");
		assert_eq!(rows[17], format!("│{}│{}│", " ".repeat(26), " ".repeat(71)));
		assert_eq!(rows.len(), 22, "slot count is fixed");
	}

	#[test]
	fn lsp_slots_paint_status_glyphs_and_three_file_types() {
		let server = |name: Str, status| LspServer {
			name,
			status,
			file_types: vec![
				Str::new_static("rs"),
				Str::new_static("toml"),
				Str::new_static("md"),
				Str::new_static("txt"),
			],
		};
		let facts = WelcomeFacts {
			recent: Vec::new(),
			lsp:    vec![
				server(Str::new_static("rust-analyzer"), LspStatus::Ready),
				server(Str::new_static("taplo"), LspStatus::Available),
				server(Str::new_static("marksman"), LspStatus::Connecting),
				server(Str::new_static("broken"), LspStatus::Error),
				server(Str::new_static("overflow"), LspStatus::Ready),
			],
		};
		let ui = Ui::from_root(welcome("tip", facts), 120, UiContext::default());
		let rows = rows_of(&ui);
		assert!(rows[9].contains("● rust-analyzer rs toml md"), "{}", rows[9]);
		assert!(!rows[9].contains("txt"), "only three file types");
		assert!(rows[10].contains("● taplo"), "{}", rows[10]);
		assert!(rows[11].contains("⏳ marksman"), "{}", rows[11]);
		assert!(rows[12].contains("✘ broken"), "{}", rows[12]);
		assert!(!rows[13].contains("overflow"), "slot overflow is sliced");
		let theme = UiContext::default().theme;
		let fg = |x: u16, y: u16| ui.frame().cell(x, y).style().foreground_color();
		assert_eq!(fg(29, 9), theme.ok);
		assert_eq!(fg(29, 10), theme.dim);
		assert_eq!(fg(29, 11), theme.muted);
		assert_eq!(fg(29, 12), theme.err);
	}

	#[test]
	fn pick_weighted_tip_matches_pi() {
		let tips = ["a", "b [NEW]", "c"];
		// Weights 1, 4, 1 → total 6: r*6 in [0,1) → a, [1,5) → b, [5,6) → c.
		assert_eq!(pick_weighted_tip(&tips, 0.0), "a");
		assert_eq!(pick_weighted_tip(&tips, 0.16), "a");
		assert_eq!(pick_weighted_tip(&tips, 0.17), "b [NEW]");
		assert_eq!(pick_weighted_tip(&tips, 0.8), "b [NEW]");
		assert_eq!(pick_weighted_tip(&tips, 0.84), "c");
		assert_eq!(pick_weighted_tip(&tips, 0.999), "c");
		assert_eq!(pick_weighted_tip(&[], 0.5), "");
		assert!(tips_list_has_no_blanks());
	}

	fn tips_list_has_no_blanks() -> bool {
		tips().count() == 27 && tips().all(|tip| !tip.is_empty())
	}

	#[test]
	fn tip_rolls_are_stable_per_seed_and_nag_only_on_plain_unicode() {
		let nag_seed = (0..10_000u64)
			.find(|seed| rolls(*seed).0 < NAG_CHANCE)
			.expect("some seed nags");
		assert_eq!(tip_seeded(nag_seed, Charset::Unicode).as_str(), NERDFONT_NAG);
		assert_ne!(tip_seeded(nag_seed, Charset::NerdFont).as_str(), NERDFONT_NAG);
		assert_eq!(tip_seeded(7, Charset::NerdFont), tip_seeded(7, Charset::NerdFont));
		assert_eq!(tip_for("/tmp", Charset::Ascii), tip_for("/tmp", Charset::Ascii));
	}

	#[test]
	fn new_tag_rides_the_last_tip_line_or_its_own_line() {
		let ui = Ui::from_root(
			welcome("Try /omfg [NEW]", WelcomeFacts::default()),
			120,
			UiContext::default(),
		);
		let rows = rows_of(&ui);
		assert_eq!(rows[21], " Tip: Try /omfg NEW!");
		assert_eq!(rows.len(), 22);
		// Rainbow at phase 0: N=0°, E=90°, W=180°, !=270°, bold.
		let style = ui.frame().cell(16, 21).style();
		assert_eq!(style, Rainbow::default().style(0, 4));
		assert_eq!(
			ui.frame().cell(17, 21).style().foreground_color(),
			omp_tui::anim::hsl(90.0, 0.95, 0.6)
		);
		assert_eq!(ui.next_wake(), None, "a resting welcome never animates the tag");

		// A body filling the budget pushes the tag to its own indented line.
		let long = format!("{} [NEW]", "x".repeat(94));
		let rows = self::rows(welcome(&long, WelcomeFacts::default()), 120);
		assert_eq!(rows.len(), 23);
		assert_eq!(rows[22], "      NEW!");
		assert!(cell_width(&rows[21]) <= 100);
	}

	#[test]
	fn wide_tips_never_overflow_the_box() {
		let long = "😭".repeat(70);
		let rows = self::rows(welcome(&long, WelcomeFacts::default()), 40);
		assert!(rows.iter().all(|row| cell_width(row) <= 38), "{rows:?}");
		assert!(rows.len() > 22);
	}

	#[test]
	fn tip_wrap_is_retained_across_frames_and_rebuilt_only_on_width_change() {
		let mut component = welcome(
			"Press shift+tab to cycle through reasoning effort levels of the current model",
			WelcomeFacts::default(),
		);
		let ctx = UiContext::default();
		let first = component.height(&ctx, 60);
		let count = component.tip_wrap.lines.len();
		assert!(count > 1, "the tip wraps at 60 columns");
		// Every intro frame measures and paints at the same width: the
		// wrapped lines are retained untouched (a sentinel survives).
		component.tip_wrap.lines[0] = Str::new_static("sentinel");
		for _ in 0..3 {
			assert_eq!(component.height(&ctx, 60), first);
			assert_eq!(component.tip_wrap.lines[0].as_str(), "sentinel");
			assert_eq!(component.tip_wrap.lines.len(), count);
		}
		let wide = component.height(&ctx, 120);
		assert!(wide < first, "a wider box needs fewer tip rows");
		assert_eq!(component.tip_wrap.box_width, 100, "rewrapped for the new box width");
		assert_ne!(component.tip_wrap.lines[0].as_str(), "sentinel");
		assert!(component.tip_wrap.lines.len() < count);
	}

	#[test]
	fn intro_wakes_every_frame_and_settles_after_three_seconds() {
		let component = Welcome::new(
			Str::new_static("1"),
			&badge(),
			Str::new_static("Try /omfg [NEW]"),
			WelcomeFacts::default(),
			Some(Duration::ZERO),
		);
		let mut ui = Ui::from_root(component, 120, UiContext::default());
		let corner = |ui: &Ui| ui.frame().cell(8, 5).style().foreground_color();
		let tag = |ui: &Ui| ui.frame().cell(16, 21).style().foreground_color();
		assert_eq!(ui.next_wake(), Some(FRAME));
		let (first_logo, first_tag) = (corner(&ui), tag(&ui));
		assert!(ui.tick(Duration::from_millis(1_000)));
		assert_ne!(corner(&ui), first_logo, "the sweep recolors the mark");
		assert_ne!(tag(&ui), first_tag, "the tag hue rotates during the intro");
		assert_eq!(ui.next_wake(), Some(Duration::from_millis(1_033)));
		assert!(ui.tick(Duration::from_millis(3_000)));
		assert_eq!(corner(&ui), Color::Rgb(248, 79, 204), "resting frame");
		assert_eq!(ui.next_wake(), None, "settled welcome stops waking");
	}
}
