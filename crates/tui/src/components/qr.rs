//! Scannable QR-code matrix backing the `<qr>` markup tag.

use omp_core::{
	IntoStr, Str,
	qr::{QrCode, QrEc},
};

use crate::{
	component::{Component, PaintCtx, Slot, next_slot},
	context::UiContext,
	frame::{Color, Rect, Style},
	props::{Prop, PropValue, Props},
	rich::cell_width,
};

/// Light modules framing the symbol on every side, per the QR specification.
const QUIET_ZONE: u16 = 4;
/// Upper-half-block cell: the foreground paints the top module and the
/// background the bottom one, so every terminal row carries two module rows.
const HALF_BLOCK: &str = "▀";

/// A scannable QR code backing the `<qr>` markup tag.
///
/// The payload encodes once; paint re-slices the cached module grid into
/// half-block cells inside the spec-required four-module quiet zone. Modules
/// default to black on white — a scanner contract, like image pixels, not
/// theming — while `fg`/`bg` override the dark/light module colors and
/// `kind=l|m|q|h` selects the error-correction level (default `m`).
/// URL-shaped payloads carry an OSC-8 hyperlink on every cell. A box too
/// narrow or short for a scannable symbol, or a payload beyond QR capacity,
/// degrades to one hyperlinked text row showing `label` (default: the
/// payload itself).
pub struct Qr {
	props: Props,
	slot:  Slot,
	data:  Str,
	cache: Option<Cache>,
}

/// One encode outcome; `modules` is `None` when the payload cannot encode.
struct Cache {
	level:   QrEc,
	modules: Option<Modules>,
}

/// One encoded symbol, addressed through the quiet-zone-inclusive grid.
struct Modules {
	code: QrCode,
}

impl Modules {
	/// Whether the module at quiet-zone-inclusive `(x, y)` is dark; the
	/// quiet zone and anything beyond the grid read light.
	fn dark_at(&self, x: u16, y: u16) -> bool {
		let (Some(x), Some(y)) = (x.checked_sub(QUIET_ZONE), y.checked_sub(QUIET_ZONE)) else {
			return false;
		};
		self.code.dark(x, y)
	}

	/// Cell columns including the quiet zone (one module per column).
	const fn columns(&self) -> u16 {
		self.code.side() + 2 * QUIET_ZONE
	}

	/// Cell rows including the quiet zone (two modules per row).
	const fn rows(&self) -> u16 {
		self.columns().div_ceil(2)
	}
}

impl Qr {
	/// Creates a QR code with an empty payload; it lays out to nothing
	/// until [`Qr::text`] supplies data.
	pub fn new() -> Self {
		Self { props: Props::new(), slot: next_slot(), data: Str::default(), cache: None }
	}

	/// Appends payload text; markup body and `dom!` text children arrive
	/// here. Surrounding whitespace is ignored when encoding.
	pub fn text(mut self, value: impl IntoStr) -> Self {
		let value = value.into_str();
		self.data = if self.data.is_empty() {
			value
		} else {
			omp_core::sf!("{}{}", self.data, value)
		};
		self.cache = None;
		self
	}

	/// Sets one QR property.
	pub fn with(mut self, prop: Prop, value: impl Into<PropValue>) -> Self {
		self.props.set(prop, value);
		self
	}

	/// Sets one QR property from a string.
	pub fn with_str(self, prop: Prop, value: &str) -> Self {
		self.with(prop, value)
	}

	/// The encoded payload: body text minus markup indentation whitespace.
	fn payload(&self) -> &str {
		self.data.as_str().trim()
	}

	/// Error-correction level from `kind`, defaulting to `M` like most
	/// URL-bearing codes in the wild.
	fn level(&self) -> QrEc {
		match self.props.str_of(Prop::Kind) {
			Some(kind) if kind.eq_ignore_ascii_case("l") => QrEc::L,
			Some(kind) if kind.eq_ignore_ascii_case("q") => QrEc::Q,
			Some(kind) if kind.eq_ignore_ascii_case("h") => QrEc::H,
			_ => QrEc::M,
		}
	}

	/// Encodes the payload once per `(payload, level)` and returns the
	/// cached module grid; `None` when empty or beyond QR capacity.
	fn modules(&mut self) -> Option<&Modules> {
		let level = self.level();
		if self.cache.as_ref().is_none_or(|cache| cache.level != level) {
			let payload = self.data.trim();
			let modules = (!payload.is_empty())
				.then(|| QrCode::encode(payload.as_bytes(), level).ok())
				.flatten()
				.map(|code| Modules { code });
			self.cache = Some(Cache { level, modules });
		}
		self.cache.as_ref().and_then(|cache| cache.modules.as_ref())
	}

	/// Dark- and light-module colors: `fg`/`bg` props when set, else the
	/// black-on-white contrast scanners require.
	fn module_colors(&self, ctx: &UiContext) -> (Color, Color) {
		let dark = self
			.props
			.foreground(&ctx.theme)
			.unwrap_or(Color::Rgb(0, 0, 0));
		let light = if self.props.get(Prop::Bg).is_some() {
			self.props.color(Prop::Bg, &ctx.theme)
		} else {
			self.props.color(Prop::On, &ctx.theme)
		}
		.unwrap_or(Color::Rgb(255, 255, 255));
		(dark, light)
	}

	/// Attaches the payload as an OSC-8 target when it is link-shaped, so
	/// both the symbol and its degraded text row stay clickable.
	fn linked(&self, style: Style) -> Style {
		let payload = self.payload();
		if payload.contains("://") || payload.starts_with("mailto:") {
			style.link(payload)
		} else {
			style
		}
	}

	/// Paints the single-row degradation: the `label` prop (default the
	/// payload) as a width-clipped, hyperlinked text row.
	fn paint_fallback(&self, pc: &mut PaintCtx<'_>, rect: Rect) {
		let label = self
			.props
			.str_of(Prop::Label)
			.map_or_else(|| self.payload(), Str::as_str);
		let style = self.linked(self.props.style(&pc.ctx.theme));
		pc.frame
			.put_clipped(rect.x, rect.y, rect.width, label, style);
	}
}

impl Default for Qr {
	fn default() -> Self {
		Self::new()
	}
}

impl Component for Qr {
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
		if let Some(modules) = self.modules() {
			let columns = modules.columns();
			(columns, columns)
		} else {
			let width = cell_width(self.payload());
			(width.min(8), width)
		}
	}

	fn height(&mut self, _ctx: &UiContext, width: u16) -> u16 {
		if self.payload().is_empty() {
			return 0;
		}
		match self.modules() {
			Some(modules) if width >= modules.columns() => modules.rows(),
			_ => 1,
		}
	}

	fn paint(&mut self, pc: &mut PaintCtx<'_>, rect: Rect) {
		if rect.y >= pc.clip || rect.width == 0 || rect.height == 0 || self.payload().is_empty() {
			return;
		}
		self.modules();
		let modules = self.cache.as_ref().and_then(|cache| cache.modules.as_ref());
		let Some(modules) =
			modules.filter(|modules| rect.width >= modules.columns() && rect.height >= modules.rows())
		else {
			self.paint_fallback(pc, rect);
			return;
		};
		let (dark, light) = self.module_colors(pc.ctx);
		let base = self.linked(Style::new());
		for row in 0..modules.rows() {
			let y = rect.y.saturating_add(row);
			if y >= pc.clip {
				break;
			}
			for column in 0..modules.columns() {
				let top = if modules.dark_at(column, row * 2) {
					dark
				} else {
					light
				};
				let bottom = if modules.dark_at(column, row * 2 + 1) {
					dark
				} else {
					light
				};
				pc.frame
					.put(rect.x.saturating_add(column), y, HALF_BLOCK, base.fg(top).bg(bottom));
			}
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::{
		frame::{Frame, Size, with_link_url},
		test_support::frame_row_text,
		ui::Ui,
	};

	fn paint(qr: &mut Qr, width: u16, height: u16) -> Frame {
		let ctx = UiContext::default();
		let mut frame = Frame::new(Size::new(width, height));
		let mut hits = Vec::new();
		qr.paint(
			&mut PaintCtx::new(&mut frame, &ctx, &mut hits, &mut Vec::new()),
			Rect::new(0, 0, width, height),
		);
		frame
	}

	#[test]
	fn encodes_half_block_matrix_with_quiet_zone() {
		let mut qr = Qr::new().text("https://omp.sh");
		let ctx = UiContext::default();
		let (min, max) = qr.measure(&ctx);
		assert_eq!(min, max, "a QR symbol has one fixed cell width");
		let columns = min;
		let rows = qr.height(&ctx, columns);
		assert_eq!(rows, columns.div_ceil(2), "half blocks pack two module rows per cell row");
		let frame = paint(&mut qr, columns, rows);
		assert_eq!(frame_row_text(&frame, 0), HALF_BLOCK.repeat(usize::from(columns)));
		let white = Color::Rgb(255, 255, 255);
		let black = Color::Rgb(0, 0, 0);
		let corner = frame.cell(0, 0).style;
		assert_eq!(
			(corner.foreground_color(), corner.background_color()),
			(white, white),
			"the quiet zone stays light"
		);
		// Cell row 2 holds module rows 4..6: the first two rows of the
		// top-left finder pattern, whose leading module is dark.
		let finder = frame.cell(QUIET_ZONE, 2).style;
		assert_eq!(
			(finder.foreground_color(), finder.background_color()),
			(black, black),
			"the finder corner is dark"
		);
		let link = finder
			.spec()
			.link
			.expect("URL payloads hyperlink the symbol");
		assert_eq!(with_link_url(link, str::to_owned).as_deref(), Some("https://omp.sh"));
		// Every painted module must match the encoder's ground truth.
		let code = QrCode::encode(b"https://omp.sh", QrEc::M).expect("encode");
		for y in 0..code.side() {
			let row = y + QUIET_ZONE;
			for x in 0..code.side() {
				let cell = frame.cell(x + QUIET_ZONE, row / 2).style;
				let painted = if row % 2 == 0 {
					cell.foreground_color()
				} else {
					cell.background_color()
				};
				assert_eq!(painted == black, code.dark(x, y), "module ({x}, {y}) mismatch");
			}
		}
	}

	#[test]
	fn narrow_box_degrades_to_hyperlinked_text_row() {
		let mut qr = Qr::new().text("https://omp.sh");
		let ctx = UiContext::default();
		assert_eq!(qr.height(&ctx, 10), 1);
		let frame = paint(&mut qr, 10, 1);
		assert_eq!(frame_row_text(&frame, 0), "https://om");
		let link = frame
			.cell(0, 0)
			.style
			.spec()
			.link
			.expect("fallback row keeps the link");
		assert_eq!(with_link_url(link, str::to_owned).as_deref(), Some("https://omp.sh"));
	}

	#[test]
	fn label_prop_names_the_degraded_row() {
		let mut qr = Qr::new()
			.text("https://omp.sh")
			.with_str(Prop::Label, "Join");
		let frame = paint(&mut qr, 6, 1);
		assert_eq!(frame_row_text(&frame, 0), "Join");
	}

	#[test]
	fn oversized_payload_degrades_instead_of_failing() {
		let mut qr = Qr::new().text("x".repeat(3000));
		let ctx = UiContext::default();
		assert_eq!(qr.height(&ctx, 500), 1, "payloads beyond QR capacity fall back to text");
		let frame = paint(&mut qr, 12, 1);
		assert_eq!(frame_row_text(&frame, 0), "xxxxxxxxxxxx");
		assert!(frame.cell(0, 0).style.spec().link.is_none(), "non-URL payloads carry no hyperlink");
	}

	#[test]
	fn kind_selects_error_correction_level() {
		let data = "https://omp.sh/r/0123456789abcdef0123456789abcdef";
		let ctx = UiContext::default();
		let side = |kind: &str| {
			Qr::new()
				.text(data)
				.with_str(Prop::Kind, kind)
				.measure(&ctx)
				.0
		};
		assert!(side("h") > side("l"), "higher correction needs a larger symbol");
	}

	#[test]
	fn empty_payload_lays_out_to_nothing() {
		let mut qr = Qr::new();
		assert_eq!(qr.height(&UiContext::default(), 40), 0);
	}

	#[test]
	fn markup_body_becomes_a_scannable_symbol() {
		let ctx = UiContext::default();
		let columns = usize::from(Qr::new().text("https://omp.sh").measure(&ctx).0);
		let ui = Ui::from_markup("<qr>\n\thttps://omp.sh\n</qr>", 60, UiContext::default())
			.expect("qr markup parses");
		assert!(ui.height() > 1, "wide viewports render the full symbol");
		assert_eq!(frame_row_text(ui.frame(), 0), HALF_BLOCK.repeat(columns));
	}
}
