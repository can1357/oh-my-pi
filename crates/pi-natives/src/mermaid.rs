//! N-API wrapper for the `pi-mermaid` diagram renderer.

use napi::bindgen_prelude::Error as NapiError;
use napi_derive::napi;
pub use pi_mermaid::*;

/// Theme colors for [`render_mermaid_ascii`]; hex strings, all optional.
#[napi(object)]
#[derive(Debug, Default)]
pub struct MermaidTheme {
	pub fg:       Option<String>,
	pub border:   Option<String>,
	pub line:     Option<String>,
	pub arrow:    Option<String>,
	pub accent:   Option<String>,
	pub bg:       Option<String>,
	pub corner:   Option<String>,
	pub junction: Option<String>,
}

/// Options for [`render_mermaid_ascii`]; every field defaults like the
/// TypeScript renderer (`useAscii: false`, paddings 5, border padding 1,
/// `colorMode: "auto"`).
#[napi(object)]
#[derive(Debug, Default)]
pub struct MermaidRenderOptions {
	/// `+-|>` instead of Unicode box-drawing characters.
	pub use_ascii:          Option<bool>,
	pub padding_x:          Option<i32>,
	pub padding_y:          Option<i32>,
	pub box_border_padding: Option<i32>,
	/// Force the flowchart/state layout direction.
	#[napi(ts_type = "'TD' | 'TB' | 'LR' | 'BT' | 'RL'")]
	pub direction:          Option<String>,
	/// `auto` (or omitted) detects from the terminal environment.
	#[napi(ts_type = "'none' | 'auto' | 'ansi16' | 'ansi256' | 'truecolor' | 'html'")]
	pub color_mode:         Option<String>,
	pub theme:              Option<MermaidTheme>,
}

impl MermaidRenderOptions {
	fn resolve(self) -> napi::Result<RenderOptions> {
		let defaults = RenderOptions::default();
		let direction = match self.direction.as_deref() {
			None => None,
			Some(token) => Some(
				Direction::parse(token)
					.ok_or_else(|| NapiError::from_reason(format!("unknown direction: {token}")))?,
			),
		};
		let color_mode = match self.color_mode.as_deref() {
			None | Some("auto") => None,
			Some("none") => Some(ColorMode::None),
			Some("ansi16") => Some(ColorMode::Ansi16),
			Some("ansi256") => Some(ColorMode::Ansi256),
			Some("truecolor") => Some(ColorMode::Truecolor),
			Some("html") => Some(ColorMode::Html),
			Some(other) => return Err(NapiError::from_reason(format!("unknown color mode: {other}"))),
		};
		let mut theme = defaults.theme;
		if let Some(overrides) = self.theme {
			let MermaidTheme { fg, border, line, arrow, accent, bg, corner, junction } = overrides;
			theme.fg = fg.unwrap_or(theme.fg);
			theme.border = border.unwrap_or(theme.border);
			theme.line = line.unwrap_or(theme.line);
			theme.arrow = arrow.unwrap_or(theme.arrow);
			theme.accent = accent.or(theme.accent);
			theme.bg = bg.or(theme.bg);
			theme.corner = corner.or(theme.corner);
			theme.junction = junction.or(theme.junction);
		}
		Ok(RenderOptions {
			use_ascii: self.use_ascii.unwrap_or(defaults.use_ascii),
			padding_x: self.padding_x.unwrap_or(defaults.padding_x),
			padding_y: self.padding_y.unwrap_or(defaults.padding_y),
			box_border_padding: self
				.box_border_padding
				.unwrap_or(defaults.box_border_padding),
			direction,
			color_mode,
			theme,
		})
	}
}

/// Render Mermaid diagram text (flowchart, state, sequence, class, ER, or
/// xychart) to ASCII/Unicode art. Synchronous: callers render inside the
/// TUI compositor.
///
/// # Errors
/// Unparseable flowchart source or an unknown `direction`/`colorMode` value.
#[napi]
pub fn render_mermaid_ascii(
	text: String,
	options: Option<MermaidRenderOptions>,
) -> napi::Result<String> {
	let options = options.unwrap_or_default().resolve()?;
	render(&text, &options).map_err(|err| NapiError::from_reason(err.0))
}
