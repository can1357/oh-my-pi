//! Provider error surfaces: the capped inline transcript block, the pinned
//! banner above the editor, the pin/suppression predicates that keep the
//! two from showing the same error twice, and the idle retry hint.

use omp_core::{Str, StrMut, sf};
use omp_dom::{Dom, Handle, KnownTag, Node, PropId, Tag, Value};
use omp_tui::{
	Charset, Component as TuiComponent, Icon, IntoComponent as _, PaintCtx, Pipeline as _, Props,
	Rect, RichSink as _, RichText, Slot, Style, UiContext, cell_width, dom, next_slot,
};

use super::prop_text;
use crate::cards::Component;

/// Wrapped rows the collapsed inline transcript block keeps.
pub const MAX_INLINE_ROWS: usize = 8;
/// Wrapped rows the pinned banner keeps.
pub const MAX_BANNER_ROWS: usize = 4;
/// Indent for every row after the first, so continuations hang under the
/// lead-in.
pub const CONTINUATION_INDENT: &str = "  ";
/// Spaces standing in for one tab.
const TAB: &str = "   ";
/// The body shown when the message has no non-blank
/// line.
const UNKNOWN_ERROR: &str = "Unknown error";
/// The key the overflow row advertises.
const EXPAND_KEY: &str = "ctrl+o";
/// Hint shown after a pinned banner is dismissed.
const DISMISSAL_HINT: &str = "Dismissed when you send your next message.";

/// Wrapped, capped rows of one provider error.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ErrorRows {
	/// Rows kept after the cap; every row after the first starts with
	/// [`CONTINUATION_INDENT`].
	pub rows:   Vec<Str>,
	/// Rows cut by the cap; zero when every row is present.
	pub hidden: usize,
}

impl ErrorRows {
	/// The dim overflow row that follows the kept rows when rows were cut:
	/// `  … +N more line(s) (ctrl+o to expand)`.
	#[must_use]
	pub fn hint(&self) -> Option<Str> {
		(self.hidden > 0).then(|| {
			let plural = if self.hidden == 1 { "" } else { "s" };
			sf!("{CONTINUATION_INDENT}… +{} more line{plural} ({EXPAND_KEY} to expand)", self.hidden)
		})
	}
}

/// Tabs become spaces, lines are trimmed and blank
/// lines dropped (`Unknown error` when nothing remains), each logical line
/// word-wraps at `content_width - 2` cells so continuation rows can hang
/// under the two-space indent, and the row list is cut at `max_rows`
/// (`None` keeps every row: the expanded state).
#[must_use]
pub fn format_error_rows(message: &str, content_width: u16, max_rows: Option<usize>) -> ErrorRows {
	wrap_rows(message, content_width, max_rows, &[])
}

/// [`format_error_rows`] with `lead` pieces run ahead of the first logical
/// line so the lead-in counts toward the first row's width before wrapping.
fn wrap_rows(
	message: &str,
	content_width: u16,
	max_rows: Option<usize>,
	lead: &[&str],
) -> ErrorRows {
	let wrap_width = content_width
		.saturating_sub(cell_width(CONTINUATION_INDENT))
		.max(1);
	let mut rich = RichText::default();
	let mut wrap = (&mut rich).wrap(wrap_width);
	let style = Style::new();
	let mut lines = 0_usize;
	for line in logical_lines(message) {
		if lines > 0 {
			wrap.newline();
		} else {
			for piece in lead {
				wrap.run(style, piece);
			}
		}
		for (index, segment) in line.split('\t').enumerate() {
			if index > 0 {
				wrap.run(style, TAB);
			}
			wrap.run(style, segment);
		}
		lines += 1;
	}
	if lines == 0 {
		for piece in lead {
			wrap.run(style, piece);
		}
		wrap.run(style, UNKNOWN_ERROR);
	}
	wrap.finish();
	let total = usize::from(RichText::rows(&rich));
	let keep = max_rows.map_or(total, |max| total.min(max));
	let mut rows = Vec::with_capacity(keep);
	for row in 0..keep {
		let text = rich.row_text(u16::try_from(row).unwrap_or(u16::MAX));
		rows.push(if row == 0 {
			Str::new(text)
		} else {
			let mut indented = StrMut::new(CONTINUATION_INDENT);
			indented.push_str(text);
			indented.freeze()
		});
	}
	ErrorRows { rows, hidden: total - keep }
}

/// Trimmed, non-blank logical lines of a message.
fn logical_lines(message: &str) -> impl Iterator<Item = &str> {
	message
		.split('\n')
		.map(str::trim)
		.filter(|line| !line.is_empty())
}

/// The inline first row begins with `Error: `; the banner leads with a bold
/// error glyph.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Lead {
	Prefix,
	Icon,
}

/// Width-aware error body: wraps the message to the painted width on demand
/// and caches the rows per `(width, charset)` so paint never re-wraps.
pub struct ErrorBody {
	props:    Props,
	slot:     Slot,
	message:  Str,
	max_rows: Option<usize>,
	lead:     Lead,
	cached:   Option<(u16, Charset)>,
	rows:     ErrorRows,
	hint:     Option<Str>,
}

impl ErrorBody {
	/// The inline transcript block: `Error: ` lead, capped at
	/// [`MAX_INLINE_ROWS`] unless `expanded`.
	#[must_use]
	pub fn inline(message: Str, expanded: bool) -> Self {
		let max_rows = if expanded {
			None
		} else {
			Some(MAX_INLINE_ROWS)
		};
		Self::new(message, max_rows, Lead::Prefix)
	}

	/// The pinned banner body: bold error-glyph lead, capped at
	/// [`MAX_BANNER_ROWS`].
	#[must_use]
	pub fn banner(message: Str) -> Self {
		Self::new(message, Some(MAX_BANNER_ROWS), Lead::Icon)
	}

	fn new(message: Str, max_rows: Option<usize>, lead: Lead) -> Self {
		Self {
			props: Props::new(),
			slot: next_slot(),
			message,
			max_rows,
			lead,
			cached: None,
			rows: ErrorRows::default(),
			hint: None,
		}
	}

	fn ensure(&mut self, ctx: &UiContext, width: u16) {
		let key = (width, ctx.charset);
		if self.cached == Some(key) {
			return;
		}
		self.rows = match self.lead {
			Lead::Prefix => wrap_rows(&self.message, width, self.max_rows, &["Error: "]),
			Lead::Icon => {
				wrap_rows(&self.message, width, self.max_rows, &[ctx.charset.icon(Icon::Error), " "])
			},
		};
		self.hint = self.rows.hint();
		self.cached = Some(key);
	}

	fn lead_width(&self, ctx: &UiContext) -> u16 {
		match self.lead {
			Lead::Prefix => cell_width("Error: "),
			Lead::Icon => cell_width(ctx.charset.icon(Icon::Error)).saturating_add(1),
		}
	}
}

impl TuiComponent for ErrorBody {
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
		let widest = logical_lines(&self.message)
			.map(cell_width)
			.max()
			.unwrap_or_else(|| cell_width(UNKNOWN_ERROR));
		let natural = widest
			.saturating_add(self.lead_width(ctx))
			.saturating_add(cell_width(CONTINUATION_INDENT));
		(1, natural)
	}

	fn height(&mut self, ctx: &UiContext, width: u16) -> u16 {
		self.ensure(ctx, width);
		let rows = self.rows.rows.len() + usize::from(self.hint.is_some());
		u16::try_from(rows).unwrap_or(u16::MAX)
	}

	fn paint(&mut self, pc: &mut PaintCtx<'_>, rect: Rect) {
		self.ensure(pc.ctx, rect.width);
		let theme = &pc.ctx.theme;
		let base = self.props.style(theme).fg(theme.err);
		let mut y = rect.y;
		for (index, row) in self.rows.rows.iter().enumerate() {
			if y >= pc.clip {
				return;
			}
			let style = if index == 0 && self.lead == Lead::Icon {
				base.bold()
			} else {
				base
			};
			pc.frame.put_clipped(rect.x, y, rect.width, row, style);
			y = y.saturating_add(1);
		}
		if let Some(hint) = &self.hint
			&& y < pc.clip
		{
			let dim = self.props.style(theme).fg(theme.muted);
			pc.frame.put_clipped(rect.x, y, rect.width, hint, dim);
		}
	}
}

/// Controller notice: rules above and below and an icon in the kind's
/// color. `error` notices render the message through [`ErrorBody`]: the
/// `Error: ` lead, [`MAX_INLINE_ROWS`] wrapped rows unless `expanded`, and
/// the dim overflow hint.
#[must_use]
pub fn notice_card(kind: &str, text: Str, expanded: bool) -> Component {
	if kind == "error" {
		let body = ErrorBody::inline(text, expanded);
		return dom! {
			<col>
				<hr fg=muted/>
				<col pad-x=1>{body}</col>
				<hr fg=muted/>
			</col>
		}
		.into_component();
	}
	let glyph = match kind {
		"warn" | "warning" => dom! { <icon name="warning" fg=warning/> },
		"success" => dom! { <icon name="success" fg=success/> },
		_ => dom! { <icon name="info" fg=info/> },
	};
	dom! {
		<col>
			<hr fg=muted/>
			<row gap=1 pad-x=1>
				{glyph}
				<text grow>{text}</text>
			</row>
			<hr fg=muted/>
		</col>
	}
	.into_component()
}

/// A spacer, an error-colored rule, up to
/// [`MAX_BANNER_ROWS`] wrapped rows led by the bold error glyph, the dim
/// dismissal hint, and a closing rule. Pinned above the editor until the
/// next turn starts.
#[must_use]
pub fn error_banner(message: Str) -> Component {
	let body = ErrorBody::banner(message);
	dom! {
		<col>
			<spacer/>
			<hr fg=error/>
			<col pad-x=1>{body}</col>
			<text fg=muted pad-x=1>{DISMISSAL_HINT}</text>
			<hr fg=error/>
		</col>
	}
	.into_component()
}

/// The last `<turn>` in `<body>`.
fn last_turn(dom: &Dom) -> Option<Handle> {
	dom.children(dom.body()).iter().rev().copied().find(|turn| {
		dom.get(*turn)
			.is_some_and(|node| node.tag == Tag::Known(KnownTag::Turn))
	})
}

/// Whether `node` is `<notice kind=K>` for one of `kinds`.
fn is_notice(node: &Node, kinds: &[&str]) -> bool {
	node.tag == Tag::Known(KnownTag::Notice)
		&& prop_text(node, PropId::Kind).is_some_and(|kind| kinds.contains(&kind.as_str()))
}

/// The `<notice kind=error>` that ended the last turn, if the turn ended on
/// one: its newest lifecycle child (receipts aside) is the notice. The
/// banner stays pinned until the next turn starts.
#[must_use]
pub fn pinned_error(dom: &Dom) -> Option<(Handle, Str)> {
	let turn = last_turn(dom)?;
	let tail = dom.children(turn).iter().rev().copied().find(|handle| {
		dom.get(*handle)
			.is_none_or(|node| node.tag != Tag::Known(KnownTag::Usage))
	})?;
	let node = dom.get(tail)?;
	is_notice(node, &["error"]).then(|| (tail, node.content.clone().unwrap_or_default()))
}

/// ERR-06: while the identical error is
/// pinned in the banner, its inline transcript notice is not rendered
/// (the expanded inline block is still drawn: callers pass `expanded`
/// through to [`notice_card`] and skip this check).
#[must_use]
pub fn suppressed_inline(dom: &Dom, handle: Handle) -> bool {
	pinned_error(dom).is_some_and(|(pinned, _)| pinned == handle)
}

/// ERR-09: the last
/// turn died on a tool call. Its newest element (receipts and the interrupt
/// `<notice kind=warn>` aside) is a tool whose status is `cancelled` or
/// `aborted`, or one still `running` when the interrupt notice landed after
/// it (Esc mid-execution). A turn that ends on assistant output or a
/// settled tool leaves nothing to retry.
#[must_use]
pub fn aborted_tool_tail(dom: &Dom) -> bool {
	let Some(turn) = last_turn(dom) else {
		return false;
	};
	let mut interrupted = false;
	for handle in dom.children(turn).iter().rev() {
		let Some(node) = dom.get(*handle) else {
			continue;
		};
		match &node.tag {
			Tag::Known(KnownTag::Usage) => {},
			Tag::Known(KnownTag::Notice) if is_notice(node, &["warn", "warning"]) => {
				interrupted = true;
			},
			Tag::Custom(_) => {
				let status = prop_text(node, PropId::Status);
				let status = status.as_deref().unwrap_or("running");
				return match status {
					"cancelled" | "aborted" => true,
					// The kernel journals an abort as a fault whose `<diag>`
					// carries `omp_tool::Abort::render` text.
					"error" => diag_is_abort(dom, *handle),
					"running" | "arguments" => interrupted,
					_ => false,
				};
			},
			_ => return false,
		}
	}
	false
}

/// Whether a faulted tool's `<diag>` is an abort rather than a tool fault —
/// the same rule the kernel's `retry_tool_tail` precondition applies
/// (`omp_agent::aborted_tool_tail`), so the hint never advertises a retry
/// the controller refuses: the journaled fault (`Committer::commit_abort`
/// writes `CallOutcome::aborted`, `{"kind":"aborted",…}`, folded onto the
/// `<diag fault=…>` prop), else that JSON or the `Abort::render` text
/// (`interrupted: …`, `aborted…`, `skipped: …`) as the diag's text.
fn diag_is_abort(dom: &Dom, tool: Handle) -> bool {
	let Some(diag) = dom
		.children(tool)
		.iter()
		.filter_map(|handle| dom.get(*handle))
		.find(|node| node.tag == Tag::Known(KnownTag::Diag))
	else {
		return false;
	};
	match diag.prop(&PropId::Fault.into()) {
		Some(Value::Json(raw)) => return fault_is_abort(raw.get()),
		Some(Value::Str(text)) => return fault_is_abort(text.as_str()),
		_ => {},
	}
	diag
		.content
		.clone()
		.or_else(|| prop_text(diag, PropId::Text))
		.is_some_and(|text| {
			let text = text.as_str().trim_start();
			if text.starts_with('{') {
				return fault_is_abort(text);
			}
			text.starts_with("interrupted:")
				|| text.starts_with("aborted")
				|| text.starts_with("skipped:")
		})
}

/// `CallOutcome` JSON whose arm is `aborted`.
fn fault_is_abort(json: &str) -> bool {
	serde_json::from_str::<serde_json::Value>(json)
		.ok()
		.and_then(|value| value.get("kind")?.as_str().map(|kind| kind == "aborted"))
		.unwrap_or(false)
}

/// The idle `<loop> <key> to Retry` status row.
#[must_use]
pub fn retry_hint_row(key_label: &str) -> Component {
	let text = sf!("{key_label} to Retry");
	dom! {
		<row pad-x=1 gap=1>
			<icon name="loop" fg=muted/>
			<text fg=muted>{text}</text>
		</row>
	}
	.into_component()
}

#[cfg(test)]
mod tests {
	use omp_dom::{NodeSpec, Op, Txn, Value};
	use omp_session::{ComponentRegistry, Session};
	use omp_tui::{Ui, frame_text};
	use tempfile::tempdir;

	use super::*;

	fn numbered(count: usize) -> String {
		(1..=count)
			.map(|index| format!("line {index}"))
			.collect::<Vec<_>>()
			.join("\n")
	}

	fn rows(component: Component, width: u16) -> Vec<String> {
		let ui = Ui::from_root(component, width, UiContext::default());
		frame_text(ui.frame())
			.lines()
			.map(|row| row.trim_end().to_owned())
			.collect()
	}

	fn session() -> Session {
		let directory = tempdir().expect("temp directory");
		let path = directory.keep().join("notices.oms");
		let mut session =
			Session::create(path, ComponentRegistry::standard()).expect("create session");
		session.begin_turn().expect("begin turn");
		session.user("hello", Vec::new()).expect("user");
		session
	}

	fn current_turn(session: &Session) -> Handle {
		last_turn(session.dom()).expect("turn")
	}

	fn append_notice(session: &mut Session, kind: &'static str, text: &'static str) {
		let turn = current_turn(session);
		session
			.patch(Txn {
				cause: session.head().expect("head"),
				label: Some(Str::new_static("kernel.notice")),
				ops:   vec![Op::Ins {
					parent: turn,
					after:  session.dom().children(turn).last().copied(),
					node:   NodeSpec::new(KnownTag::Notice)
						.with_prop(PropId::Kind, Value::Str(Str::new_static(kind)))
						.with_content(Str::new_static(text)),
				}],
			})
			.expect("notice");
	}

	fn open_tool_call(session: &mut Session) -> Handle {
		session
			.assistant_start("test/model", "test", "test/model")
			.expect("assistant start");
		session.assistant_end("tool_calls").expect("assistant end");
		let args =
			serde_json::value::to_raw_value(&serde_json::json!({"cmd":"sleep 9"})).expect("args");
		session
			.call("bash", 1, "call-1", None, Some(args), None)
			.expect("tool call");
		let turn = current_turn(session);
		*session.dom().children(turn).last().expect("tool")
	}

	#[test]
	fn error_rows_cap_at_eight_with_overflow_hint() {
		let rows = format_error_rows(&numbered(12), 80, Some(MAX_INLINE_ROWS));
		assert_eq!(rows.rows.len(), 8);
		assert_eq!(rows.hidden, 4);
		assert_eq!(rows.rows[0].as_str(), "line 1");
		assert_eq!(rows.rows[7].as_str(), "  line 8");
		let hint = rows.hint().expect("hint");
		assert!(hint.contains("… +4 more lines (ctrl+o to expand)"), "{hint}");
	}

	#[test]
	fn error_rows_wrap_long_line_with_continuation_indent() {
		let message = "abcdefghij".repeat(20);
		assert_eq!(message.len(), 200);
		let rows = format_error_rows(&message, 40, None);
		assert!(rows.rows.len() > 1, "{rows:?}");
		assert_eq!(rows.hidden, 0);
		assert!(!rows.rows[0].starts_with(' '));
		for row in &rows.rows[1..] {
			assert!(row.starts_with(CONTINUATION_INDENT), "{row:?}");
			assert!(cell_width(row) <= 40, "{row:?}");
		}
		let joined: String = rows.rows.iter().map(|row| row.as_str().trim()).collect();
		assert_eq!(joined, message);
	}

	#[test]
	fn error_rows_singular_hidden_line() {
		let rows = format_error_rows(&numbered(9), 80, Some(MAX_INLINE_ROWS));
		assert_eq!(rows.hidden, 1);
		assert_eq!(rows.hint().expect("hint").as_str(), "  … +1 more line (ctrl+o to expand)");
		assert_eq!(format_error_rows("  \n\t\n", 80, None).rows[0].as_str(), "Unknown error");
	}

	#[test]
	fn expanded_error_shows_every_row() {
		let message = Str::new(numbered(12));
		let collapsed = rows(notice_card("error", message.clone(), false), 60);
		assert_eq!(collapsed[1], " Error: line 1");
		assert!(
			collapsed
				.iter()
				.any(|row| row.contains("+4 more lines (ctrl+o to expand)")),
			"{collapsed:?}"
		);
		assert!(!collapsed.iter().any(|row| row.contains("line 12")));

		let expanded = rows(notice_card("error", message, true), 60);
		assert!(expanded.iter().any(|row| row == "   line 12"), "{expanded:?}");
		assert!(!expanded.iter().any(|row| row.contains("more line")), "{expanded:?}");
	}

	#[test]
	fn banner_keeps_four_rows_and_dismissal_hint() {
		let banner = rows(error_banner(Str::new(numbered(12))), 60);
		let glyph = Charset::default().icon(Icon::Error);
		assert_eq!(banner[0], "", "leading spacer");
		assert!(banner[1].chars().all(|c| c == '─'), "{banner:?}");
		assert_eq!(banner[2], format!(" {glyph} line 1"));
		assert_eq!(banner[5], "   line 4");
		assert!(banner[6].contains("+8 more lines (ctrl+o to expand)"), "{banner:?}");
		assert_eq!(banner[7], format!(" {DISMISSAL_HINT}"));
		assert!(banner[8].chars().all(|c| c == '─'), "{banner:?}");
		assert_eq!(banner.len(), 9);
	}

	#[test]
	fn pinned_error_is_last_turns_error_notice() {
		let mut session = session();
		assert_eq!(pinned_error(session.dom()), None);
		append_notice(&mut session, "error", "boom");
		let (handle, text) = pinned_error(session.dom()).expect("pinned");
		assert_eq!(text.as_str(), "boom");
		assert!(suppressed_inline(session.dom(), handle));
		let user = session.dom().children(current_turn(&session))[0];
		assert!(!suppressed_inline(session.dom(), user));
		// A receipt after the notice does not unpin it; a warning does.
		session
			.receipt(omp_journal::data::TurnReceipt::tokens(1, 1, 0))
			.expect("receipt");
		assert_eq!(pinned_error(session.dom()).map(|(h, _)| h), Some(handle));
		append_notice(&mut session, "warn", "later");
		assert_eq!(pinned_error(session.dom()), None);
	}

	#[test]
	fn no_pin_once_next_turn_starts() {
		let mut session = session();
		append_notice(&mut session, "error", "boom");
		let (handle, _) = pinned_error(session.dom()).expect("pinned");
		session.begin_turn().expect("next turn");
		assert_eq!(pinned_error(session.dom()), None);
		assert!(!suppressed_inline(session.dom(), handle));
	}

	#[test]
	fn aborted_tail_detected_after_cancelled_tool() {
		let mut session = session();
		assert!(!aborted_tool_tail(session.dom()));
		let tool = open_tool_call(&mut session);
		assert!(!aborted_tool_tail(session.dom()), "a running tool is not a retryable tail");
		append_notice(&mut session, "warn", "Interrupted");
		assert!(aborted_tool_tail(session.dom()), "interrupt notice after a running tool");

		session
			.patch(Txn {
				cause: session.head().expect("head"),
				label: None,
				ops:   vec![Op::Set {
					h:     tool,
					prop:  PropId::Status.into(),
					value: Value::Str(Str::new_static("cancelled")),
				}],
			})
			.expect("cancel");
		assert!(aborted_tool_tail(session.dom()));

		session
			.patch(Txn {
				cause: session.head().expect("head"),
				label: None,
				ops:   vec![Op::Set {
					h:     tool,
					prop:  PropId::Status.into(),
					value: Value::Str(Str::new_static("ok")),
				}],
			})
			.expect("settle");
		assert!(!aborted_tool_tail(session.dom()), "a settled tool leaves nothing to retry");
		session.begin_turn().expect("next turn");
		assert!(!aborted_tool_tail(session.dom()));
	}

	/// The kernel journals an interrupt as a fault (`Committer::commit_abort`:
	/// `CallOutcome::aborted`), never a `cancelled` status: the tool settles
	/// `error` with a `<diag fault={"kind":"aborted",…}>`, and that is a
	/// retryable tail; an ordinary tool fault is not.
	#[test]
	fn aborted_tail_detected_from_the_journaled_abort_fault() {
		let mut session = session();
		open_tool_call(&mut session);
		let call = session.head().expect("call entry");
		let abort = serde_json::value::to_raw_value(&serde_json::json!({
			"kind": "aborted",
			"abort": {"kind": "interrupted", "reason": "user interrupt"},
		}))
		.expect("abort fault");
		session.fail(call, abort).expect("fail");
		assert!(aborted_tool_tail(session.dom()), "an abort fault is a retryable tail");

		let mut faulted = self::session();
		open_tool_call(&mut faulted);
		let call = faulted.head().expect("call entry");
		let fault = serde_json::value::to_raw_value(&serde_json::json!({
			"kind": "faulted",
			"fault": {"message": "aborted transaction: disk full"},
		}))
		.expect("tool fault");
		faulted.fail(call, fault).expect("fail");
		assert!(!aborted_tool_tail(faulted.dom()), "a tool's own fault leaves nothing to replay");
	}

	#[test]
	fn retry_hint_row_names_the_key() {
		let row = rows(retry_hint_row("f5"), 40);
		assert_eq!(row[0], format!(" {} f5 to Retry", Charset::default().icon(Icon::Loop)));
	}
}
