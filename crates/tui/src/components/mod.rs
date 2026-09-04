mod boxed;
mod brand;
mod button;
mod callout;
mod checkbox;
mod choice;
mod col;
mod countdown;
mod custom;
mod diff;
mod diff_doc;
mod diff_pane;
pub mod diffstat;
/// Editable composer and external-editor lifecycle primitives.
pub mod editor;
mod fact;
mod files;
mod form;
pub mod hr;
mod icon;
mod img;
mod input;
mod json;
mod latex;
mod layout;
mod loader;
mod logo;
mod markdown;
mod number;
mod progress;
mod pulse;
mod qr;
mod quote;
mod radio;
mod row;
mod scene;
mod scroll;
mod segmented;
mod select;
mod shader;
mod spinner;
pub mod state;
mod status;
mod strike;
mod table;
mod tabs;
mod text;
mod text_limit;
mod time;
mod todo;
mod tool_card;
mod tree;
mod wizard;

use std::fmt::{self, Write as _};

use crate::{
	component::PaintCtx,
	context::Charset,
	frame::{Rect, Style},
	props::Props,
};

#[derive(Clone, Copy)]
pub(super) struct OverflowPlan<'a> {
	pub content_rows: u16,
	pub omitted:      u16,
	pub noun:         &'a str,
}

struct FooterText {
	bytes: [u8; 256],
	len:   usize,
}

impl FooterText {
	const fn new() -> Self {
		Self { bytes: [0; 256], len: 0 }
	}

	fn as_str(&self) -> &str {
		// SAFETY: `fmt::Write` only copies complete UTF-8 prefixes.
		unsafe { std::str::from_utf8_unchecked(&self.bytes[..self.len]) }
	}
}

impl fmt::Write for FooterText {
	fn write_str(&mut self, value: &str) -> fmt::Result {
		let mut take = value.len().min(self.bytes.len().saturating_sub(self.len));
		while !value.is_char_boundary(take) {
			take -= 1;
		}
		self.bytes[self.len..self.len + take].copy_from_slice(&value.as_bytes()[..take]);
		self.len += take;
		if take == value.len() {
			Ok(())
		} else {
			Err(fmt::Error)
		}
	}
}

/// Plans a container-local clamp, reserving its last row for shared chrome.
pub(super) fn overflow_plan(
	props: &Props,
	natural_rows: u16,
	available_rows: u16,
) -> Option<OverflowPlan<'_>> {
	let cap = props.max_rows()?.min(available_rows);
	if natural_rows <= cap {
		return None;
	}
	let noun = props.overflow().map_or("", |noun| noun.as_str());
	let footer_rows = u16::from(!noun.is_empty() && cap > 0);
	let content_rows = cap.saturating_sub(footer_rows);
	Some(OverflowPlan { content_rows, omitted: natural_rows.saturating_sub(content_rows), noun })
}

/// Paints the canonical overflow summary reserved by [`overflow_plan`].
pub(super) fn paint_overflow_footer(pc: &mut PaintCtx<'_>, rect: Rect, plan: OverflowPlan<'_>) {
	if plan.noun.is_empty() || rect.height <= plan.content_rows {
		return;
	}
	let marker = if matches!(pc.ctx.charset, Charset::Ascii) {
		"..."
	} else {
		"…"
	};
	let mut summary = FooterText::new();
	let _ = write!(summary, "{marker} {} more {}", plan.omitted, plan.noun);
	pc.frame.put_clipped(
		rect.x,
		rect.y.saturating_add(plan.content_rows),
		rect.width,
		summary.as_str(),
		Style::new().fg(pc.ctx.theme.muted),
	);
}

#[cfg(test)]
mod tests;

pub use boxed::Boxed;
pub use brand::Brand;
pub use button::{Button, ButtonVariant};
pub use callout::Callout;
pub use checkbox::Checkbox;
pub use choice::Choice;
pub use col::Col;
pub use countdown::Countdown;
pub use custom::CustomElement;
pub use diff::{DiffKind, DiffLine, DiffView};
pub use diff_doc::{
	DiffBuildOptions, DiffDocument, DiffFileLine, DiffHunk, DiffMark, DiffRow, DiffRowKind,
	DiffSide, DiffStyleRun, DiffWhitespaceMode,
};
pub use diff_pane::{
	DiffActionKind, DiffPane, DiffPaneState, DiffPatchTarget, DiffSelection, DiffTarget, ViewMode,
};
pub use diffstat::DiffStat;
pub use editor::{
	Attachment, AttachmentContent, Attachments, ComposerLayout, ComposerStatusAttachment,
	ComposerStyle, EditInput, EditorPane, InlineAccent, InlineDecorator, KeywordAccent,
	KeywordGradient, PrefixAccent, PrefixClassifier, attachment_color, chip_label,
	marker_sized_paste,
};
pub use fact::Fact;
pub use files::Files;
pub use form::{Field, Form};
pub use hr::{Hr, Spacer};
pub use icon::Icon;
pub use img::{Img, RowBound, draw_image_inline, image_cell_box};
pub(crate) use img::{ImgState, decode_source};
pub use input::Input;
pub use json::JsonPreview;
pub use latex::Latex;
pub use loader::Loader;
pub use logo::Logo;
pub use markdown::Markdown;
pub use number::{NumberLeaf, write_compact_count};
pub use progress::Progress;
pub use pulse::{Pulse, SPEED_MAX, SPEED_WINDOW, SpeedGauge, write_compact};
pub use qr::Qr;
pub use quote::Quote;
pub use radio::Radio;
pub use row::Row;
pub use scene::Scene;
pub use scroll::Scroll;
pub use segmented::Segmented;
pub use select::{Select, SelectOption};
pub use shader::Shader;
pub use spinner::Spinner;
pub use state::State;
pub use status::{
	BoundaryLayout, CompactionBoundaries, ContextGauge, ContextGaugeMode, GaugeCell, Segment,
	Status, StatusPlacement, advisor_spend_label, boundary_layout, compaction_boundary_color,
	compaction_threshold_color, spend_label,
};
pub use strike::{STRIKE_HOLD_FRAMES, STRIKE_REVEAL_FRAMES, STRIKE_TOTAL_FRAMES, Strike};
pub use table::{Table, TableCell, TableRow};
pub use tabs::Tabs;
pub use text::{Pre, TextLeaf};
pub use time::{Time, relative_age};
pub use todo::{TaskStatus, Todo, TodoTask, collapse_hud_line};
pub use tool_card::{ToolCard, ToolState};
pub use tree::{Tree, TreeAnnotation, TreeNode};
pub use wizard::Wizard;
