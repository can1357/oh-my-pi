//! History-collapse dividers: compaction, branch summary, and handoff.
//!
//! Every collapse point renders
//! as one slim centered banner framed by rules —
//! `──── 📷 remote-compacted · 256K→20K · ctrl+o ────` — and `ctrl+o`
//! reveals the summary Markdown in a tinted box below it.

use std::{fmt::Write as _, iter};

use omp_core::{Str, StrMut, Ulid, sf};
use omp_dom::{Dom, Handle, KnownTag, Node, PropId, Tag};
use omp_journal::data::Attachment;
use omp_tui::{
	IntoComponent as _, PaintCtx, Props, Rect, Slot, UiContext, cell_width, dom, next_slot,
};

use super::{format_number, prop_text, prop_u64};
use crate::cards::Component;

/// Maintenance method recorded on a `<compaction>` element. The `method`
/// prop parses through [`FromStr`](std::str::FromStr) (`auto`, `remote`,
/// `soft`, `handoff`, `snapcompact`, `shake`, `branch`); an unknown name is
/// a parse error the caller lowers to [`Method::Other`].
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, strum::EnumString)]
#[strum(serialize_all = "lowercase")]
pub enum Method {
	/// Automatic threshold compaction (`/compact` without a strategy).
	#[default]
	Auto,
	/// Provider-side remote compaction.
	Remote,
	/// Soft (in-context) compaction.
	Soft,
	/// Handoff document replacing the context.
	Handoff,
	/// Screenshot-based snap compaction.
	SnapCompact,
	/// Context shake.
	Shake,
	/// Side branch folded back into the main line.
	Branch,
	/// Legacy or extension-provided method; never spelled by the journal.
	#[strum(disabled)]
	Other,
}

impl Method {
	/// Divider label; unknown methods fall back to `compacted`, branches read
	/// `branch`.
	#[must_use]
	pub const fn label(self) -> &'static str {
		match self {
			Self::Remote => "remote-compacted",
			Self::Soft => "soft-compacted",
			Self::Handoff => "handed-off",
			Self::SnapCompact => "snap-compacted",
			Self::Shake => "shaken",
			Self::Branch => "branch",
			Self::Auto | Self::Other => "compacted",
		}
	}

	/// Divider icon: the camera for every compaction flavor
	/// (`compaction-summary-message.ts:118`), the branch glyph for branch
	/// summaries (`:216`), and the handoff glyph for handoffs.
	const fn icon(self) -> &'static str {
		match self {
			Self::Branch => "branch",
			Self::Handoff => "handoff",
			_ => "camera",
		}
	}
}

/// One history-collapse banner and its `ctrl+o` detail.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SummaryDivider {
	/// Theme icon name painted before the label.
	pub icon:     &'static str,
	/// Banner text after the icon (`remote-compacted · 256K→20K`).
	pub label:    Str,
	/// Whether a dead-end warning badges the banner.
	pub warning:  bool,
	/// Markdown revealed below the banner when expanded.
	pub detail:   Str,
	/// Whether the detail box is shown.
	pub expanded: bool,
	/// Oldest-to-newest snapcompact frame references rendered with the detail.
	pub frames:   Vec<Attachment>,
}

impl SummaryDivider {
	/// Builds the divider for a `<compaction>` element from its `method`,
	/// `tokens-before`, `tokens-after`, `warning`, and `summary` props.
	#[must_use]
	pub fn compaction(node: &Node, expanded: bool) -> Self {
		let method = prop_text(node, PropId::Method)
			.map_or(Method::Auto, |name| name.parse().unwrap_or(Method::Other));
		let before = prop_u64(node, PropId::TokensBefore);
		let after = prop_u64(node, PropId::TokensAfter);
		let warning = prop_text(node, PropId::Warning);
		let summary = prop_text(node, PropId::Summary).unwrap_or_default();
		let frames = omp_session::compaction_frames(node);
		let frame_count = omp_session::compaction_frame_count(node);
		let mut label = StrMut::new(method.label());
		let detail = match method {
			// Branch and handoff banners carry no amount badge
			// (`compaction-summary-message.ts:175,216`).
			Method::Branch => {
				let mut detail = StrMut::new("**Branch summary**\n\n");
				detail.push_str(&summary);
				detail.freeze()
			},
			Method::Handoff => {
				let document = omp_session::custom_message::extract_handoff_document(summary.as_str());
				let mut detail = StrMut::new("**Handoff context**\n\n");
				detail.push_str(if document.is_empty() {
					"_No handoff content._"
				} else {
					document
				});
				detail.freeze()
			},
			_ => {
				// `compactionAmount` (`:16-19`): only when both amounts exist.
				if before > 0 && after > 0 {
					let _ = write!(label, " · {}→{}", format_number(before), format_number(after));
				}
				compaction_detail(before, after, warning.as_deref(), &summary, frame_count)
			},
		};
		Self {
			icon: method.icon(),
			label: label.freeze(),
			warning: warning.is_some(),
			detail,
			expanded,
			frames,
		}
	}

	/// Renders the banner, plus the tinted detail box and retained
	/// snapcompact frames when expanded (`SummaryDividerComponent.render`,
	/// `:50-52`; `#detailBox`, `:79-91`).
	#[must_use]
	pub fn into_component(self) -> Component {
		let Self { icon, label, warning, detail, expanded, frames } = self;
		let divider = Divider::new(icon, label, warning);
		if expanded {
			let frames = snapcompact_frame_components(frames);
			dom! {
				<col gap=1>
					{divider}
					<md bg=surface pad="1 1">{detail}</md>
					for frame in frames { {frame} }
				</col>
			}
			.into_component()
		} else {
			divider.into_component()
		}
	}
}

/// A bold token line, the optional warning paragraph, then the summary. The
/// warning glyph lives on the banner as `<icon name="warning">` instead;
/// Markdown bodies built from props cannot host icon markup.
fn compaction_detail(
	before: u64,
	after: u64,
	warning: Option<&str>,
	summary: &str,
	frame_count: usize,
) -> Str {
	let mut detail = StrMut::new("**");
	match (before > 0, after > 0) {
		(true, true) => {
			let _ = write!(
				detail,
				"Compacted from {} to {} tokens",
				group_thousands(before),
				group_thousands(after)
			);
		},
		(true, false) => {
			let _ = write!(detail, "Compacted from {} tokens", group_thousands(before));
		},
		(false, true) => {
			let _ = write!(detail, "Compacted to {} tokens", group_thousands(after));
		},
		(false, false) => detail.push_str("Compacted context"),
	}
	detail.push_str("**");
	if let Some(warning) = warning {
		detail.push_str("\n\n**Warning:** ");
		detail.push_str(warning);
	}
	detail.push_str("\n\n");
	detail.push_str(summary);
	if frame_count > 0 {
		let suffix = if frame_count == 1 { "" } else { "s" };
		let _ = write!(detail, "\n\n_{frame_count} snapcompact frame{suffix} attached_");
	}
	detail.freeze()
}

fn snapcompact_frame_components(frames: Vec<Attachment>) -> Vec<Component> {
	frames
		.into_iter()
		.map(|frame| {
			let source = sf!("artifact://sha256/{}", frame.blob);
			dom! {
				<img
					src={source}
					w={crate::cards::INLINE_IMAGE_MAX_COLS}
					max-rows={crate::cards::INLINE_IMAGE_MAX_ROWS}
				/>
			}
			.into_component()
		})
		.collect()
}

/// `toLocaleString()` for token counts: `256,000`.
fn group_thousands(value: u64) -> String {
	let digits = value.to_string();
	let mut text = String::with_capacity(digits.len() + digits.len() / 3);
	for (index, digit) in digits.bytes().enumerate() {
		if index > 0 && (digits.len() - index) % 3 == 0 {
			text.push(',');
		}
		text.push(char::from(digit));
	}
	text
}

/// Every `<compaction>` under `<meta>` whose `boundary` entry was journaled
/// inside `turn`, in meta order, paired with its handle for block keys.
///
/// A turn owns the entries journaled from its own turn-start entry up to the
/// next turn's start, so the boundary lands in `turn` when its ULID is at or
/// after `turn`'s id and before the following turn's id.
#[must_use]
pub fn compaction_dividers(dom: &Dom, turn: Handle, expanded: bool) -> Vec<(Handle, Component)> {
	turn_compactions(dom, turn)
		.into_iter()
		.filter_map(|handle| {
			let node = dom.get(handle)?;
			Some((handle, SummaryDivider::compaction(node, expanded).into_component()))
		})
		.collect()
}

/// Handles of every `<compaction>` under `<meta>` whose boundary entry was
/// journaled inside `turn` (the attribution rule of
/// [`compaction_dividers`]), in meta order.
#[must_use]
pub fn turn_compactions(dom: &Dom, turn: Handle) -> Vec<Handle> {
	let turns = dom.children(dom.body());
	let Some(index) = turns.iter().position(|handle| *handle == turn) else {
		return Vec::new();
	};
	let Some(start) = dom.get(turn).and_then(entry_ulid) else {
		return Vec::new();
	};
	let end = turns
		.get(index + 1)
		.and_then(|next| dom.get(*next))
		.and_then(entry_ulid);
	dom.children(dom.meta())
		.iter()
		.copied()
		.filter(|handle| {
			let Some(node) = dom.get(*handle) else {
				return false;
			};
			if node.tag != Tag::Known(KnownTag::Compaction) {
				return false;
			}
			let Some(boundary) = prop_text(node, PropId::Boundary)
				.and_then(|boundary| Ulid::from_string(&boundary).ok())
			else {
				return false;
			};
			boundary >= start && end.is_none_or(|end| boundary < end)
		})
		.collect()
}

fn entry_ulid(node: &Node) -> Option<Ulid> {
	prop_text(node, PropId::Id).and_then(|id| Ulid::from_string(&id).ok())
}

/// Retained one-row banner: dim rules framing ` <icon> <label> · ctrl+o `
/// centered (`SummaryDividerComponent.#divider`,
/// `compaction-summary-message.ts:57-77`). Narrow widths paint the bare
/// muted label.
struct Divider {
	props:   Props,
	slot:    Slot,
	icon:    &'static str,
	label:   Str,
	warning: bool,
	bar:     String,
}

impl Divider {
	const HINT: &'static str = "ctrl+o";

	fn new(icon: &'static str, label: Str, warning: bool) -> Self {
		Self { props: Props::new(), slot: next_slot(), icon, label, warning, bar: String::new() }
	}

	fn glyph<'a>(&self, ctx: &'a UiContext) -> &'a str {
		ctx.charset.icon_named(self.icon).unwrap_or(self.icon)
	}

	fn warning_glyph(ctx: &UiContext) -> &'static str {
		ctx.charset.icon_named("warning").unwrap_or("!")
	}

	/// The trimmed separator dot.
	fn dot(ctx: &UiContext) -> &'static str {
		ctx.charset.icon_named("dot").unwrap_or("·").trim()
	}

	/// Cells taken by `<icon> <label>[ <warning>]`.
	fn label_width(&self, ctx: &UiContext) -> u16 {
		let mut width = cell_width(self.glyph(ctx))
			.saturating_add(1)
			.saturating_add(cell_width(&self.label));
		if self.warning {
			width = width
				.saturating_add(1)
				.saturating_add(cell_width(Self::warning_glyph(ctx)));
		}
		width
	}

	/// Cells taken by `<label> <dot> ctrl+o`.
	fn plain_width(&self, ctx: &UiContext) -> u16 {
		self
			.label_width(ctx)
			.saturating_add(1)
			.saturating_add(cell_width(Self::dot(ctx)))
			.saturating_add(1)
			.saturating_add(cell_width(Self::HINT))
	}

	fn rule(&mut self, ctx: &UiContext, count: u16) -> &str {
		self.bar.clear();
		self
			.bar
			.extend(iter::repeat_n(ctx.charset.rule(), usize::from(count)));
		&self.bar
	}
}

impl omp_tui::Component for Divider {
	fn props(&self) -> &Props {
		&self.props
	}

	fn props_mut(&mut self) -> &mut Props {
		&mut self.props
	}

	fn slot(&self) -> Slot {
		self.slot
	}

	fn measure(&mut self, ctx: &UiContext) -> (u16, u16) {
		// Bare label at the narrowest; a framed banner with four rule cells
		// per side is the natural width.
		(self.label_width(ctx), self.plain_width(ctx).saturating_add(10))
	}

	fn height(&mut self, _ctx: &UiContext, _width: u16) -> u16 {
		1
	}

	fn paint(&mut self, pc: &mut PaintCtx<'_>, rect: Rect) {
		if rect.y >= pc.clip || rect.width == 0 {
			return;
		}
		let theme = &pc.ctx.theme;
		let base = self.props.style(theme);
		let muted = base.fg(theme.muted);
		let dim = muted.dim();
		let warn = base.fg(theme.warn);
		let glyph = self.glyph(pc.ctx);
		let y = rect.y;
		// ` label hint ` framed by rules on both sides.
		let remaining = i32::from(rect.width) - i32::from(self.plain_width(pc.ctx)) - 2;
		let mut x = rect.x;
		if remaining < 4 {
			x = pc.frame.put(x, y, glyph, muted);
			x = pc.frame.put(x, y, " ", muted);
			x = pc.frame.put(x, y, &self.label, muted);
			if self.warning {
				x = pc.frame.put(x, y, " ", muted);
				pc.frame.put(x, y, Self::warning_glyph(pc.ctx), warn);
			}
			return;
		}
		let left = u16::try_from(remaining / 2).unwrap_or(u16::MAX);
		let right = u16::try_from(remaining)
			.unwrap_or(u16::MAX)
			.saturating_sub(left);
		let rule = self.rule(pc.ctx, left);
		x = pc.frame.put(x, y, rule, dim);
		x = pc.frame.put(x, y, " ", base);
		x = pc.frame.put(x, y, glyph, muted);
		x = pc.frame.put(x, y, " ", muted);
		x = pc.frame.put(x, y, &self.label, muted);
		if self.warning {
			x = pc.frame.put(x, y, " ", muted);
			x = pc.frame.put(x, y, Self::warning_glyph(pc.ctx), warn);
		}
		x = pc.frame.put(x, y, " ", base);
		x = pc.frame.put(x, y, Self::dot(pc.ctx), dim);
		x = pc.frame.put(x, y, " ", dim);
		x = pc.frame.put(x, y, Self::HINT, dim);
		x = pc.frame.put(x, y, " ", base);
		let rule = self.rule(pc.ctx, right);
		pc.frame.put(x, y, rule, dim);
	}
}

#[cfg(test)]
mod tests {
	use omp_core::Hash32;
	use omp_dom::{PropKey, Value};
	use omp_journal::{
		blob::{BlobRef, BlobStore},
		data::{Attachment, Compaction},
	};
	use omp_session::{ComponentRegistry, Session};
	use omp_tui::{Ui, frame_text};
	use smallvec::smallvec;

	use super::*;

	fn compaction_node(
		method: Option<&str>,
		before: u64,
		after: u64,
		warning: Option<&str>,
	) -> Node {
		let mut props: smallvec::SmallVec<(PropKey, Value), 4> = smallvec![(
			PropId::Summary.into(),
			Value::Str(Str::new_static("Earlier work: wired the parser."))
		),];
		if let Some(method) = method {
			props.push((PropId::Method.into(), Value::Str(Str::new(method))));
		}
		if before > 0 {
			props.push((PropId::TokensBefore.into(), Value::Int(i64::try_from(before).unwrap())));
		}
		if after > 0 {
			props.push((PropId::TokensAfter.into(), Value::Int(i64::try_from(after).unwrap())));
		}
		if let Some(warning) = warning {
			props.push((PropId::Warning.into(), Value::Str(Str::new(warning))));
		}
		Node { tag: Tag::Known(KnownTag::Compaction), props, kids: Vec::new(), content: None }
	}

	fn render(divider: SummaryDivider, width: u16) -> String {
		let ui = Ui::from_root(divider.into_component(), width, UiContext::default());
		frame_text(ui.frame())
	}

	fn with_frames(mut node: Node, count: usize) -> Node {
		let frames = (0..count)
			.map(|index| Attachment {
				blob: BlobRef { hash: Hash32::sum(&index.to_le_bytes()), size: 1_024 },
				mime: Str::new_static("image/png"),
			})
			.collect::<Vec<_>>();
		node.props.push((
			PropId::Frames.into(),
			Value::Json(serde_json::value::to_raw_value(&frames).expect("frame json")),
		));
		node.props.push((
			PropId::FrameCount.into(),
			Value::Int(i64::try_from(frames.len()).expect("fixture count")),
		));
		node
	}

	#[test]
	fn method_labels_match_pi() {
		let cases = [
			("remote", "remote-compacted"),
			("soft", "soft-compacted"),
			("handoff", "handed-off"),
			("snapcompact", "snap-compacted"),
			("shake", "shaken"),
			("branch", "branch"),
			("auto", "compacted"),
		];
		for (name, label) in cases {
			let method: Method = name.parse().unwrap();
			assert_eq!(method.label(), label, "{name}");
		}
		assert!("bogus".parse::<Method>().is_err(), "unknown methods are not spelled by the journal");
		assert!("other".parse::<Method>().is_err(), "`Other` is never parsed by name");
		assert_eq!(
			SummaryDivider::compaction(
				&compaction_node(Some("extension-provided"), 0, 0, None),
				false
			)
			.label,
			"compacted",
			"an unknown method reads `compacted`"
		);
		assert_eq!(
			SummaryDivider::compaction(&compaction_node(None, 0, 0, None), false).label,
			"compacted"
		);
	}

	#[test]
	fn compaction_label_carries_amount_and_warning() {
		let node = compaction_node(
			Some("remote"),
			256_000,
			20_000,
			Some("No progress since last compaction"),
		);
		let divider = SummaryDivider::compaction(&node, false);
		assert_eq!(divider.icon, "camera");
		assert!(divider.warning);
		let text = render(divider, 60);
		assert!(text.contains("📷 remote-compacted · 256K→20K ⚠ · ctrl+o"), "{text:?}");
		assert!(text.starts_with("──────── 📷"), "left rule is floor(remaining / 2): {text:?}");
		assert!(text.ends_with("· ctrl+o ─────────"), "right rule takes the odd cell: {text:?}");
		assert_eq!(text.lines().count(), 1);

		let plain = SummaryDivider::compaction(&compaction_node(Some("soft"), 4_000, 0, None), false);
		assert!(!plain.warning);
		assert_eq!(plain.label, "soft-compacted", "no badge without tokens-after");
	}

	#[test]
	fn narrow_width_paints_bare_label() {
		let node = compaction_node(Some("remote"), 256_000, 20_000, Some("stalled"));
		let text = render(SummaryDivider::compaction(&node, false), 40);
		assert_eq!(text, "📷 remote-compacted · 256K→20K ⚠");
	}

	#[test]
	fn expanded_divider_reveals_summary_markdown() {
		let node = compaction_node(Some("remote"), 256_000, 20_000, Some("stalled"));
		let collapsed = render(SummaryDivider::compaction(&node, false), 60);
		assert_eq!(collapsed.lines().count(), 1);
		let divider = SummaryDivider::compaction(&node, true);
		assert_eq!(
			divider.detail,
			"**Compacted from 256,000 to 20,000 tokens**\n\n**Warning:** stalled\n\nEarlier work: \
			 wired the parser."
		);
		let text = render(divider, 60);
		let lines: Vec<&str> = text.lines().collect();
		assert!(lines[0].contains("remote-compacted"), "{text:?}");
		assert_eq!(lines[1], "", "blank row separates the banner from the detail box");
		assert!(text.contains("Compacted from 256,000 to 20,000 tokens"), "{text:?}");
		assert!(text.contains("Warning: stalled"), "{text:?}");
		assert!(text.contains("Earlier work: wired the parser."), "{text:?}");

		let bare = SummaryDivider::compaction(&compaction_node(None, 0, 0, None), true);
		assert!(bare.detail.starts_with("**Compacted context**\n\n"));
		let from_only = SummaryDivider::compaction(&compaction_node(None, 1_500, 0, None), true);
		assert!(
			from_only
				.detail
				.starts_with("**Compacted from 1,500 tokens**")
		);
		let to_only = SummaryDivider::compaction(&compaction_node(None, 0, 900, None), true);
		assert!(to_only.detail.starts_with("**Compacted to 900 tokens**"));
	}

	#[test]
	fn snapcompact_detail_counts_and_renders_retained_frames_with_missing_fallback() {
		let one = SummaryDivider::compaction(
			&with_frames(compaction_node(Some("snapcompact"), 84_000, 12_000, None), 1),
			true,
		);
		assert!(one.detail.ends_with("_1 snapcompact frame attached_"), "{:?}", one.detail);
		let rendered = render(one, 72);
		assert!(rendered.contains("1 snapcompact frame attached"), "{rendered:?}");
		assert!(
			rendered.contains("[img:"),
			"missing CAS frame uses the image fallback: {rendered:?}"
		);

		let two = SummaryDivider::compaction(
			&with_frames(compaction_node(Some("snapcompact"), 84_000, 12_000, None), 2),
			true,
		);
		assert!(two.detail.ends_with("_2 snapcompact frames attached_"), "{:?}", two.detail);
		let collapsed = SummaryDivider::compaction(
			&with_frames(compaction_node(Some("snapcompact"), 84_000, 12_000, None), 2),
			false,
		);
		assert!(!render(collapsed, 72).contains("snapcompact frames attached"));
	}

	#[test]
	fn branch_and_handoff_dividers_use_their_icons() {
		let branch =
			SummaryDivider::compaction(&compaction_node(Some("branch"), 9_000, 1_000, None), false);
		assert_eq!(branch.icon, "branch");
		assert_eq!(branch.label, "branch", "branch banners carry no amount badge");
		assert_eq!(branch.detail, "**Branch summary**\n\nEarlier work: wired the parser.");
		assert!(render(branch, 40).contains("⑂ branch · ctrl+o"));

		let mut node = compaction_node(Some("handoff"), 0, 0, None);
		node.props[0].1 = Value::Str(Str::new_static(
			"preamble <handoff-context>\n# Goal\nShip it.\n</handoff-context> trailer",
		));
		let handoff = SummaryDivider::compaction(&node, false);
		assert_eq!(handoff.icon, "handoff");
		assert_eq!(handoff.label, "handed-off");
		assert_eq!(handoff.detail, "**Handoff context**\n\n# Goal\nShip it.");
		assert!(render(handoff, 40).contains("➦ handed-off · ctrl+o"));

		let empty = SummaryDivider::compaction(&compaction_node(Some("handoff"), 0, 0, None), false);
		assert!(empty.detail.ends_with("Earlier work: wired the parser."));
		node.props[0].1 = Value::Str(Str::new_static("<handoff-context>  </handoff-context>"));
		assert_eq!(
			SummaryDivider::compaction(&node, false).detail,
			"**Handoff context**\n\n_No handoff content._"
		);
	}

	#[test]
	fn boundary_places_divider_after_its_turn() {
		let directory = tempfile::tempdir().expect("temp directory");
		let path = directory.path().join("divider.oms");
		let store = BlobStore::open(directory.path()).expect("blob store");
		let summary = store.put(b"summary of turn one").expect("summary blob");
		let mut session =
			Session::create(&path, ComponentRegistry::standard()).expect("create session");
		session.begin_turn().expect("turn one");
		session.user("first", Vec::new()).expect("user one");
		let boundary = session
			.receipt(omp_journal::data::TurnReceipt::tokens(12, 7, 0))
			.expect("receipt one");
		session.begin_turn().expect("turn two");
		session.user("second", Vec::new()).expect("user two");
		session
			.compaction(Compaction {
				summary,
				boundary,
				method: Some(Str::new_static("remote")),
				tokens_before: Some(256_000),
				tokens_after: Some(20_000),
				warning: None,
				frames: Vec::new(),
			})
			.expect("compaction");
		let dom = session.dom();
		let turns = dom.children(dom.body());
		assert_eq!(turns.len(), 2);

		let first = compaction_dividers(dom, turns[0], false);
		assert_eq!(first.len(), 1, "the boundary receipt lives in turn one");
		let compaction = dom.children(dom.meta()).iter().copied().find(|handle| {
			dom.get(*handle)
				.is_some_and(|node| node.tag == Tag::Known(KnownTag::Compaction))
		});
		assert_eq!(Some(first[0].0), compaction, "block key is the compaction handle");
		let ui = Ui::from_root(first.into_iter().next().unwrap().1, 60, UiContext::default());
		assert!(frame_text(ui.frame()).contains("remote-compacted · 256K→20K"));

		assert!(compaction_dividers(dom, turns[1], false).is_empty(), "turn two owns no boundary");
	}
}
