//! Prompt-cache invalidation detection and its transcript marker
//! (`detectCacheInvalidation`,
//! `CacheInvalidationMarkerComponent`).

use omp_core::{Str, sf};
use omp_dom::{Dom, Handle, KnownTag, PropId, Tag, Value};
use omp_tui::{
	Charset, Component as TuiComponent, Icon, PaintCtx, Props, Rect, Slot, UiContext, cell_width,
	next_slot,
};

use super::{
	format_number,
	usage::{UsageFacts, usage_facts},
};
use crate::cards::Component;

/// `MIN_CACHE_FOOTPRINT`: the prefix the
/// previous turn must have read back from cache before a collapse counts as
/// an invalidation, filtering tiny contexts and providers below the
/// cacheable-prefix floor where a zero `cacheRead` is expected.
pub const MIN_CACHE_FOOTPRINT: u64 = 2048;

/// `CACHE_INVALIDATION_RULE_WIDTH`.
const RULE_WIDTH: u16 = 10;

/// A prompt-cache invalidation detected from a turn's usage.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CacheInvalidation {
	/// Prompt tokens the cold turn had to (re)process instead of reading
	/// from cache.
	pub reprocessed_tokens: u64,
}

/// Detects only the warm→cold transition. `prev` must have read at least
/// [`MIN_CACHE_FOOTPRINT`] back, `current` reads nothing, an explicit cache
/// re-created the prefix (`cache_write > 0`; implicit caches report zero and
/// drop reads as propagation noise), and the reprocessed prompt
/// (`cache_write + input`) is itself at least the footprint.
#[must_use]
pub fn detect_cache_invalidation(
	prev: Option<&UsageFacts>,
	current: &UsageFacts,
) -> Option<CacheInvalidation> {
	let prev = prev?;
	if prev.cache_read < MIN_CACHE_FOOTPRINT || current.cache_read > 0 || current.cache_write == 0 {
		return None;
	}
	let reprocessed_tokens = current.cache_write.saturating_add(current.input);
	(reprocessed_tokens >= MIN_CACHE_FOOTPRINT).then_some(CacheInvalidation { reprocessed_tokens })
}

/// Every `<usage>` element in `<body>` document order whose request lost the
/// cache its predecessor was reusing, paired with the invalidation. When
/// comparing consecutive assistant turns, `prev` is the nearest earlier
/// `<usage>` anywhere in the transcript.
#[must_use]
pub fn cache_invalidations(dom: &Dom) -> Vec<(Handle, CacheInvalidation)> {
	let mut found = Vec::new();
	let mut prev: Option<UsageFacts> = None;
	for turn in dom.children(dom.body()) {
		for child in dom.children(*turn) {
			if dom.get(*child).is_none_or(|node| {
				node.tag != Tag::Known(KnownTag::Usage)
					|| node.prop(&PropId::Kind.into()).and_then(Value::as_str) == Some("advisor")
			}) {
				continue;
			}
			let current = usage_facts(dom, *child);
			if let Some(info) = detect_cache_invalidation(prev.as_ref(), &current) {
				found.push((*child, info));
			}
			prev = Some(current);
		}
	}
	found
}

/// Blank row, a ten-cell rule, and
/// muted label, blank row. Too narrow to frame, only the label paints.
#[must_use]
pub fn cache_miss_marker(info: &CacheInvalidation) -> Component {
	Box::new(CacheMissMarker::new(*info))
}

/// Retained marker; the label is rebuilt only when the charset changes.
struct CacheMissMarker {
	props:   Props,
	slot:    Slot,
	tokens:  u64,
	charset: Option<Charset>,
	label:   Str,
}

impl CacheMissMarker {
	fn new(info: CacheInvalidation) -> Self {
		Self {
			props:   Props::new(),
			slot:    next_slot(),
			tokens:  info.reprocessed_tokens,
			charset: None,
			label:   Str::default(),
		}
	}

	fn label(&mut self, charset: Charset) -> &str {
		if self.charset != Some(charset) {
			self.charset = Some(charset);
			let icon = charset.icon(Icon::CacheMiss);
			self.label = if self.tokens > 0 {
				sf!("{icon} cache miss · {} tokens", format_number(self.tokens))
			} else {
				sf!("{icon} cache miss")
			};
		}
		&self.label
	}
}

impl TuiComponent for CacheMissMarker {
	fn props(&self) -> &Props {
		&self.props
	}

	fn props_mut(&mut self) -> &mut Props {
		&mut self.props
	}

	fn slot(&self) -> Slot {
		self.slot
	}

	fn paints_border(&self) -> bool {
		false
	}

	fn measure(&mut self, ctx: &UiContext) -> (u16, u16) {
		let label = cell_width(self.label(ctx.charset));
		(1, label.saturating_add(RULE_WIDTH + 1))
	}

	fn height(&mut self, _ctx: &UiContext, _width: u16) -> u16 {
		3
	}

	fn paint(&mut self, pc: &mut PaintCtx<'_>, rect: Rect) {
		let y = rect.y.saturating_add(1);
		if y >= pc.clip || rect.width == 0 || rect.height < 2 {
			return;
		}
		let charset = pc.ctx.charset;
		let label_width = cell_width(self.label(charset));
		let style = self.props.style(&pc.ctx.theme).fg(pc.ctx.theme.muted);
		let rule_width = RULE_WIDTH.min(rect.width.saturating_sub(label_width).saturating_sub(1));
		let mut column = rect.x;
		if rule_width >= 1 {
			let mut encoded = [0; 4];
			let glyph = charset.rule().encode_utf8(&mut encoded);
			let dim = style.dim();
			for _ in 0..rule_width {
				column = pc.frame.put(column, y, glyph, dim);
			}
			column = pc.frame.put(column, y, " ", style);
		}
		pc.frame.put(column, y, &self.label, style);
	}
}

#[cfg(test)]
mod tests {
	use omp_dom::{Op, PropKey, Txn, Value};
	use omp_journal::data::{ReceiptIdentity, ReceiptRole, TurnReceipt};
	use omp_session::{ComponentRegistry, Session};
	use omp_tui::{Ui, frame_text};

	use super::*;

	fn warm() -> UsageFacts {
		UsageFacts {
			input: 900,
			output: 300,
			cache_read: 40_000,
			cache_write: 0,
			..UsageFacts::default()
		}
	}

	fn cold() -> UsageFacts {
		UsageFacts {
			input: 900,
			output: 300,
			cache_read: 0,
			cache_write: 50_000,
			..UsageFacts::default()
		}
	}

	#[test]
	fn cache_miss_needs_warm_predecessor() {
		assert_eq!(detect_cache_invalidation(None, &cold()), None);
		let write_only = UsageFacts { cache_read: 0, cache_write: 40_000, ..warm() };
		assert_eq!(detect_cache_invalidation(Some(&write_only), &cold()), None);
		let tiny = UsageFacts { cache_read: MIN_CACHE_FOOTPRINT - 1, ..warm() };
		assert_eq!(detect_cache_invalidation(Some(&tiny), &cold()), None);
		let floor = UsageFacts { cache_read: MIN_CACHE_FOOTPRINT, ..warm() };
		assert!(detect_cache_invalidation(Some(&floor), &cold()).is_some());
		let reused = UsageFacts { cache_read: 1, ..cold() };
		assert_eq!(detect_cache_invalidation(Some(&warm()), &reused), None);
	}

	#[test]
	fn cache_miss_ignores_implicit_caches() {
		let implicit = UsageFacts { cache_write: 0, input: 60_000, ..cold() };
		assert_eq!(detect_cache_invalidation(Some(&warm()), &implicit), None);
	}

	#[test]
	fn cache_miss_reports_reprocessed_tokens() {
		assert_eq!(
			detect_cache_invalidation(Some(&warm()), &cold()),
			Some(CacheInvalidation { reprocessed_tokens: 50_900 })
		);
		let small = UsageFacts { input: 1_000, cache_write: MIN_CACHE_FOOTPRINT - 1_001, ..cold() };
		assert_eq!(detect_cache_invalidation(Some(&warm()), &small), None);
		let exact = UsageFacts { input: 1_000, cache_write: MIN_CACHE_FOOTPRINT - 1_000, ..cold() };
		assert_eq!(
			detect_cache_invalidation(Some(&warm()), &exact),
			Some(CacheInvalidation { reprocessed_tokens: MIN_CACHE_FOOTPRINT })
		);
	}

	#[test]
	fn cache_marker_renders_short_rule_and_label() {
		let info = CacheInvalidation { reprocessed_tokens: 50_900 };
		let ctx = UiContext::default();
		let miss = ctx.charset.icon(Icon::CacheMiss);
		let rule = |cells: usize| ctx.charset.rule().to_string().repeat(cells);
		let label = format!("{miss} cache miss · 51K tokens");
		let wide = Ui::from_root(cache_miss_marker(&info), 80, ctx.clone());
		let text = frame_text(wide.frame());
		let rows: Vec<&str> = text.split('\n').collect();
		assert_eq!(rows.len(), 3, "{text}");
		assert!(rows[0].is_empty() && rows[2].is_empty(), "{text}");
		assert_eq!(rows[1], format!("{} {label}", rule(10)), "{text}");

		let width = cell_width(&label);
		let framed = Ui::from_root(cache_miss_marker(&info), width + 4, ctx.clone());
		let row = frame_text(framed.frame())
			.lines()
			.nth(1)
			.unwrap()
			.to_owned();
		assert_eq!(row, format!("{} {label}", rule(3)), "{row}");

		let bare = Ui::from_root(cache_miss_marker(&info), width + 1, ctx);
		let row = frame_text(bare.frame()).lines().nth(1).unwrap().to_owned();
		assert_eq!(row, label, "{row}");
	}

	#[test]
	fn consecutive_usages_across_turns_are_compared() {
		let directory = tempfile::tempdir().expect("temp directory");
		let path = directory.path().join("cache.oms");
		let mut session = Session::create(path, ComponentRegistry::standard()).expect("session");
		let turn = |session: &mut Session, receipt: TurnReceipt| -> Handle {
			session.begin_turn().expect("turn");
			session.user("prompt", Vec::new()).expect("user");
			session
				.assistant_start("test/model", "test", "test/model")
				.expect("assistant");
			session.assistant_end("stop").expect("assistant end");
			session.receipt(receipt).expect("receipt");
			let turn = *session
				.dom()
				.children(session.dom().body())
				.last()
				.expect("turn");
			*session.dom().children(turn).last().expect("usage")
		};
		let warm = TurnReceipt { cache_read: 40_000, ..TurnReceipt::tokens(900, 300, 0) };
		let cold = TurnReceipt { cache_write: 50_000, ..TurnReceipt::tokens(900, 300, 0) };
		let first = turn(&mut session, cold.clone());
		assert_eq!(cache_invalidations(session.dom()), vec![], "first turn has no predecessor");
		let second = turn(&mut session, warm);
		session
			.receipt(TurnReceipt {
				cache_write: 80_000,
				identity: Some(ReceiptIdentity {
					role:     ReceiptRole::Advisor,
					provider: Str::new_static("anthropic"),
					model:    Str::new_static("claude-sonnet-4-5"),
				}),
				..TurnReceipt::default()
			})
			.expect("advisor receipt");
		let third = turn(&mut session, cold.clone());
		let _still_cold = turn(&mut session, cold);
		assert_ne!(first, third);
		assert_eq!(
			cache_invalidations(session.dom()),
			vec![(third, CacheInvalidation { reprocessed_tokens: 50_900 })],
			"advisor receipts do not break the primary warm-to-cold comparison"
		);

		// The scan reads DOM state: cooling the predecessor below the
		// footprint retracts the marker.
		session
			.patch(Txn {
				cause: session.head().expect("head"),
				label: None,
				ops:   vec![Op::Set {
					h:     second,
					prop:  PropKey::from(omp_dom::PropId::CacheRead),
					value: Value::Int(i64::try_from(MIN_CACHE_FOOTPRINT - 1).unwrap()),
				}],
			})
			.expect("patch");
		assert_eq!(cache_invalidations(session.dom()), vec![]);

		let facts = usage_facts(session.dom(), third);
		assert!(facts.completed_ms.is_some() && facts.started_ms.is_some());
		assert!(facts.completed_ms >= facts.started_ms);
	}
}
