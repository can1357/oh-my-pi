//! Gallery and transcript projection of the production context-usage gauge.

use omp_core::Str;
use omp_dom::{Node, PropId};
use omp_tui::{
	Component as TuiComponent, PaintCtx, Props, Rect, Slot, Style, UiContext,
	components::{
		CompactionBoundaries, ContextGauge, GaugeCell, compaction_boundary_color,
		compaction_threshold_color,
	},
	next_slot,
};
use serde_json::Value;

use super::{Card, CardView, Component};

/// Renders numeric and embedded context-window status gauges.
pub struct ContextGaugeCard;

impl Card for ContextGaugeCard {
	fn tool(&self) -> &'static str {
		"context_gauge"
	}

	fn render(&self, view: &CardView<'_>, _expanded: bool, _ui: &UiContext) -> Component {
		let args = parse_node(view.input).unwrap_or(Value::Null);
		Box::new(GaugeRows {
			props:     Props::new(),
			slot:      next_slot(),
			percent:   args
				.get("percent")
				.and_then(Value::as_f64)
				.unwrap_or_default(),
			label:     Str::new(
				args
					.get("label")
					.and_then(Value::as_str)
					.unwrap_or_default(),
			),
			model:     Str::new(args.get("model").and_then(Value::as_str).unwrap_or("model")),
			window:    args
				.get("context")
				.and_then(Value::as_u64)
				.unwrap_or_default(),
			directory: Str::new(
				args
					.get("directory")
					.and_then(Value::as_str)
					.unwrap_or("session"),
			),
		})
	}
}

struct GaugeRows {
	props:     Props,
	slot:      Slot,
	percent:   f64,
	label:     Str,
	model:     Str,
	window:    u64,
	directory: Str,
}

impl TuiComponent for GaugeRows {
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
		(24, 100)
	}

	fn height(&mut self, _ctx: &UiContext, _width: u16) -> u16 {
		3
	}

	fn paint(&mut self, pc: &mut PaintCtx<'_>, rect: Rect) {
		pc.frame.put(
			rect.x,
			rect.y,
			&format!("  {}", self.label),
			Style::new().fg(pc.ctx.theme.muted),
		);
		if rect.height < 2 {
			return;
		}
		let model = pc.ctx.charset.icon_named("model").unwrap_or_default();
		let cap = pc.ctx.charset.icon_named("powerline").unwrap_or_default();
		let left_cap = pc
			.ctx
			.charset
			.icon_named("powerline-right")
			.unwrap_or_default();
		let context = pc.ctx.charset.icon_named("context").unwrap_or_default();
		let auto = pc.ctx.charset.icon_named("auto").unwrap_or_default();
		let threshold = pc
			.ctx
			.charset
			.icon_named("context-compaction")
			.unwrap_or_default();
		let rule = pc.ctx.charset.rule();
		let window = compact(self.window);
		let left = format!(" {model} {} ", self.model);
		let right = format!(" {context} {:.1}%/{window} {auto} ", self.percent);
		let boundary =
			usize::from(rect.width).saturating_sub(left.chars().count() + right.chars().count() + 2);
		let tick = ((boundary as f64) * 0.85).round() as usize;
		let theme = pc.ctx.theme;
		let model_style = Style::new().fg(theme.accent).bg(theme.panel);
		let cap_style = Style::new().fg(theme.panel);
		let used = Style::new().fg(compaction_threshold_color(&theme));
		let unused = Style::new().fg(theme.status_rule);
		let boundary_style = Style::new().fg(compaction_boundary_color(&theme));
		let right_style = Style::new().bg(theme.panel);
		let percent_style = Style::new()
			.fg(if self.percent >= 85.0 {
				theme.err
			} else if self.percent >= 50.0 {
				theme.warn
			} else {
				theme.output
			})
			.bg(theme.panel);
		let mut x = pc.frame.put(rect.x, rect.y + 1, &left, model_style);
		x = pc.frame.put(x, rect.y + 1, cap, cap_style);
		x = pc
			.frame
			.put(x, rect.y + 1, &rule.to_string().repeat(tick.min(boundary)), used);
		x = pc.frame.put(x, rect.y + 1, threshold, boundary_style);
		x = pc.frame.put(
			x,
			rect.y + 1,
			&rule.to_string().repeat(boundary.saturating_sub(tick + 1)),
			unused,
		);
		x = pc.frame.put(x, rect.y + 1, left_cap, cap_style);
		let split = right
			.find(|ch: char| ch.is_ascii_digit())
			.unwrap_or(right.len());
		x = pc.frame.put(x, rect.y + 1, &right[..split], right_style);
		pc.frame.put(x, rect.y + 1, &right[split..], percent_style);
		if rect.height < 3 {
			return;
		}
		let right = format!(" {} ", self.directory);
		let boundary_width =
			usize::from(rect.width).saturating_sub(left.chars().count() + right.chars().count() + 2);
		let width = u16::try_from(boundary_width).unwrap_or(u16::MAX);
		let tokens = (self.percent / 100.0 * self.window as f64).round() as u64;
		let gauge = ContextGauge::plan(
			width,
			tokens,
			Some(self.window),
			Some(CompactionBoundaries { threshold_percent: 85.0, speculation_percent: None }),
		);
		let mut x = pc.frame.put(rect.x, rect.y + 2, &left, model_style);
		x = pc.frame.put(x, rect.y + 2, cap, cap_style);
		for index in 0..gauge.width() {
			x = match gauge.cell(index) {
				GaugeCell::Used => pc.frame.put(x, rect.y + 2, &rule.to_string(), used),
				GaugeCell::Unused => pc.frame.put(x, rect.y + 2, &rule.to_string(), unused),
				GaugeCell::Threshold | GaugeCell::Speculation => {
					pc.frame.put(x, rect.y + 2, threshold, boundary_style)
				},
				GaugeCell::Percent(text) => pc.frame.put(
					x,
					rect.y + 2,
					text,
					if gauge.overflowed() {
						Style::new().fg(theme.err)
					} else {
						used
					},
				),
				GaugeCell::Window(text) => pc.frame.put(x, rect.y + 2, text, boundary_style),
			};
		}
		x = pc.frame.put(x, rect.y + 2, left_cap, cap_style);
		pc.frame.put(x, rect.y + 2, &right, model_style);
	}
}

fn compact(value: u64) -> String {
	if value >= 1_000_000 {
		format!("{}M", value / 1_000_000)
	} else if value >= 1_000 {
		format!("{}K", value / 1_000)
	} else {
		value.to_string()
	}
}
fn parse_node(node: &Node) -> Option<Value> {
	serde_json::from_str(node_text(node)?.as_str()).ok()
}
fn node_text(node: &Node) -> Option<Str> {
	node.content.clone().or_else(|| {
		node
			.prop(&PropId::Text.into())
			.and_then(|value| value.as_str())
			.map(Str::new)
	})
}
