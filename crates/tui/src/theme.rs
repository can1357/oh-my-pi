//! JSON theme loading with rich-slot lowering and appearance selection.

use std::{
	collections::BTreeMap,
	fs, io,
	path::{Path, PathBuf},
	sync::Arc,
};

use omp_core::{IntoStr, Str};
use serde::Deserialize;
use thiserror::Error;

use crate::{Appearance, Color, Theme};
impl Theme {
	/// Returns a canvas-adjacent selection fill, dimmed for an unfocused pane.
	pub fn selection_bg(&self, dim: bool) -> Color {
		self.panel.mix(self.fg, if dim { 0.08 } else { 0.14 })
	}

	/// Tints the panel surface toward `base` by `amount`.
	pub fn tint_bg(&self, base: Color, amount: f32) -> Color {
		self.panel.mix(base, amount)
	}
}

/// Parsed named theme with dark and optional light variants.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct JsonTheme {
	/// Human-readable theme name.
	pub name: Str,
	dark:     Theme,
	light:    Theme,
}

impl JsonTheme {
	/// Parses either omp's compact semantic palette or the richer `colors`
	/// palette. Status, diff, and code-border slots remain independent so
	/// unrelated rich-theme roles never overwrite their presentation colors.
	pub fn parse(source: &str) -> Result<Self, ThemeError> {
		let file: ThemeFile = serde_json::from_str(source).map_err(ThemeError::Json)?;
		let (dark, light) = if let Some(colors) = &file.colors {
			let page_background = file
				.export
				.as_ref()
				.and_then(|export| export.page_bg.as_ref())
				.map(|value| resolve_color("export.pageBg", value, &file.vars))
				.transpose()?
				.flatten();
			let mut dark = apply_rich(colors, &file.vars, Theme::for_appearance(Appearance::Dark))?;
			let mut light = apply_rich(colors, &file.vars, Theme::for_appearance(Appearance::Light))?;
			if let Some(background) = page_background {
				dark.code_border = fence_border_with_contrast(dark.code_border, background);
				light.code_border = fence_border_with_contrast(light.code_border, background);
			}
			(dark, light)
		} else {
			let dark = file.dark.apply(Theme::for_appearance(Appearance::Dark))?;
			let light = file
				.light
				.unwrap_or_else(|| file.dark.clone())
				.apply(Theme::for_appearance(Appearance::Light))?;
			(dark, light)
		};
		Ok(Self { name: file.name.into_str(), dark, light })
	}

	/// Selects the palette matching the terminal's current appearance.
	pub const fn for_appearance(&self, appearance: Appearance) -> Theme {
		match appearance {
			Appearance::Dark => self.dark,
			Appearance::Light => self.light,
		}
	}

	/// Selects and quantizes the palette for an indexed-color terminal.
	pub const fn for_appearance_256(&self, appearance: Appearance) -> Theme {
		self.for_appearance(appearance).quantized_256()
	}
}

/// One theme file loaded into a [`ThemeCatalog`].
#[derive(Clone, Debug)]
pub struct LoadedTheme {
	/// Lookup name: the file stem of `<themes>/<name>.json`.
	pub name:  Str,
	/// Source file.
	pub path:  PathBuf,
	/// Parsed palette.
	pub theme: Arc<JsonTheme>,
}

/// Non-fatal diagnostic from a discovered theme directory.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ThemeWarning {
	/// Offending file or directory.
	pub path:    PathBuf,
	/// Human-readable reason.
	pub message: Str,
}

/// Failure loading a theme path the operator named explicitly.
#[derive(Debug, Error)]
pub enum ThemeLoadError {
	/// The path could not be read.
	#[error("cannot read theme {}", path.display())]
	Io {
		/// Offending path.
		path:   PathBuf,
		/// Underlying error.
		#[source]
		source: io::Error,
	},
	/// The file is not a valid theme.
	#[error("invalid theme {}", path.display())]
	Theme {
		/// Offending file.
		path:   PathBuf,
		/// Parse failure.
		#[source]
		source: ThemeError,
	},
}

/// Named themes loaded from disk, in precedence order: paths named on the
/// command line (`--theme <file|dir>`) first, then each discovered theme
/// directory (`<config root>/agent/themes`, `<project>/.omp/themes`). Within
/// a name the first source wins.
#[derive(Clone, Debug, Default)]
pub struct ThemeCatalog {
	themes:       Vec<LoadedTheme>,
	explicit:     usize,
	/// Unreadable or malformed files inside discovered directories.
	pub warnings: Vec<ThemeWarning>,
}

impl ThemeCatalog {
	/// Loads `explicit` files or directories (every failure is an error: the
	/// operator asked for them) and then scans `dirs` for `*.json` themes
	/// (a missing directory is nothing; a broken file is a warning).
	pub fn load(explicit: &[PathBuf], dirs: &[PathBuf]) -> Result<Self, ThemeLoadError> {
		let mut catalog = Self::default();
		for path in explicit {
			let metadata = fs::metadata(path)
				.map_err(|source| ThemeLoadError::Io { path: path.clone(), source })?;
			if metadata.is_dir() {
				for file in theme_files(path)
					.map_err(|source| ThemeLoadError::Io { path: path.clone(), source })?
				{
					let theme = load_theme_file(&file)?;
					catalog.push(file, theme);
				}
			} else {
				let theme = load_theme_file(path)?;
				catalog.push(path.clone(), theme);
			}
		}
		catalog.explicit = catalog.themes.len();
		for dir in dirs {
			let files = match theme_files(dir) {
				Ok(files) => files,
				Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
				Err(error) => {
					catalog.warnings.push(ThemeWarning {
						path:    dir.clone(),
						message: Str::new(format!("cannot read theme directory: {error}")),
					});
					continue;
				},
			};
			for file in files {
				match load_theme_file(&file) {
					Ok(theme) => catalog.push(file, theme),
					Err(error) => catalog
						.warnings
						.push(ThemeWarning { path: file, message: Str::new(error_chain(&error)) }),
				}
			}
		}
		Ok(catalog)
	}

	fn push(&mut self, path: PathBuf, theme: JsonTheme) {
		let name = path
			.file_stem()
			.map_or_else(|| theme.name.clone(), |stem| Str::new(stem.to_string_lossy()));
		if self.get(&name).is_some() {
			return;
		}
		self
			.themes
			.push(LoadedTheme { name, path, theme: Arc::new(theme) });
	}

	/// The theme filed under `name` (its file stem), when loaded.
	#[must_use]
	pub fn get(&self, name: &str) -> Option<Arc<JsonTheme>> {
		self
			.themes
			.iter()
			.find(|loaded| loaded.name.as_str() == name)
			.map(|loaded| Arc::clone(&loaded.theme))
	}

	/// The first theme named explicitly on the command line, if any.
	#[must_use]
	pub fn first_explicit(&self) -> Option<Arc<JsonTheme>> {
		(self.explicit > 0).then(|| Arc::clone(&self.themes[0].theme))
	}

	/// Every loaded theme in precedence order.
	#[must_use]
	pub fn themes(&self) -> &[LoadedTheme] {
		&self.themes
	}
}

fn load_theme_file(path: &Path) -> Result<JsonTheme, ThemeLoadError> {
	let source = fs::read_to_string(path)
		.map_err(|source| ThemeLoadError::Io { path: path.to_path_buf(), source })?;
	JsonTheme::parse(&source)
		.map_err(|source| ThemeLoadError::Theme { path: path.to_path_buf(), source })
}

/// Sorted `*.json` files directly below `dir`.
fn theme_files(dir: &Path) -> io::Result<Vec<PathBuf>> {
	let mut files = fs::read_dir(dir)?
		.filter_map(Result::ok)
		.map(|entry| entry.path())
		.filter(|path| {
			path
				.extension()
				.is_some_and(|extension| extension.eq_ignore_ascii_case("json"))
				&& path.is_file()
		})
		.collect::<Vec<_>>();
	files.sort();
	Ok(files)
}

fn error_chain(error: &dyn std::error::Error) -> String {
	let mut text = error.to_string();
	let mut source = error.source();
	while let Some(cause) = source {
		text.push_str(": ");
		text.push_str(&cause.to_string());
		source = cause.source();
	}
	text
}

/// Theme parsing failure with a stable diagnostic.
#[derive(Debug, Error)]
pub enum ThemeError {
	/// Invalid JSON shape.
	#[error("invalid theme JSON")]
	Json(#[source] serde_json::Error),
	/// A named token did not contain a supported color.
	#[error("invalid theme color `{token}`: {value}")]
	Color {
		/// Semantic token containing the bad value.
		token: Str,
		/// Unparsed color source.
		value: Str,
	},
	/// An indexed color exceeded the terminal palette.
	#[error("theme color `{token}` has an index above 255")]
	Index {
		/// Semantic token containing the bad value.
		token: Str,
	},
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct ThemeFile {
	#[serde(rename = "$schema")]
	_schema: Option<String>,
	name:    String,
	vars:    BTreeMap<String, ColorValue>,
	colors:  Option<BTreeMap<String, ColorValue>>,
	dark:    ThemePatch,
	light:   Option<ThemePatch>,
	export:  Option<ThemeExport>,
	symbols: Option<serde_json::Value>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
struct ThemeExport {
	#[serde(rename = "pageBg")]
	page_bg: Option<ColorValue>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(untagged)]
enum ColorValue {
	Text(String),
	Index(u16),
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct ThemePatch {
	fg:                Option<String>,
	accent:            Option<String>,
	info:              Option<String>,
	ok:                Option<String>,
	warn:              Option<String>,
	err:               Option<String>,
	muted:             Option<String>,
	dim:               Option<String>,
	output:            Option<String>,
	border:            Option<String>,
	code_border:       Option<String>,
	tool_diff_added:   Option<String>,
	tool_diff_removed: Option<String>,
	tool_diff_context: Option<String>,
	surface:           Option<String>,
	hover:             Option<String>,
	selection:         Option<String>,
	shadow:            Option<String>,
	panel:             Option<String>,
	error_surface:     Option<String>,
	secondary:         Option<String>,
	python:            Option<String>,
	status_rule:       Option<String>,
	border_muted:      Option<String>,
	status_bg:         Option<String>,
	status_sep:        Option<String>,
	status_model:      Option<String>,
	status_path:       Option<String>,
	status_git_clean:  Option<String>,
	status_git_dirty:  Option<String>,
	status_context:    Option<String>,
	status_spend:      Option<String>,
	status_staged:     Option<String>,
	status_dirty:      Option<String>,
	status_untracked:  Option<String>,
	status_output:     Option<String>,
	status_cost:       Option<String>,
	status_subagents:  Option<String>,
	contrast:          Option<String>,
}

impl ThemePatch {
	fn apply(&self, mut theme: Theme) -> Result<Theme, ThemeError> {
		macro_rules! apply {
			($field:ident) => {
				if let Some(value) = &self.$field {
					theme.$field = Color::parse(value).ok_or_else(|| ThemeError::Color {
						token: Str::new_static(stringify!($field)),
						value: Str::new(value.as_str()),
					})?;
				}
			};
		}
		apply!(fg);
		apply!(accent);
		apply!(info);
		apply!(ok);
		apply!(warn);
		apply!(err);
		apply!(muted);
		apply!(dim);
		apply!(output);
		apply!(border);
		apply!(code_border);
		apply!(tool_diff_added);
		apply!(tool_diff_removed);
		apply!(tool_diff_context);
		apply!(surface);
		apply!(hover);
		apply!(selection);
		apply!(shadow);
		apply!(panel);
		apply!(error_surface);
		apply!(secondary);
		apply!(python);
		apply!(status_rule);
		apply!(border_muted);
		apply!(status_bg);
		apply!(status_sep);
		apply!(status_model);
		apply!(status_path);
		apply!(status_git_clean);
		apply!(status_git_dirty);
		apply!(status_context);
		apply!(status_spend);
		apply!(status_staged);
		apply!(status_dirty);
		apply!(status_untracked);
		apply!(status_output);
		apply!(status_cost);
		apply!(status_subagents);
		apply!(contrast);
		Ok(theme)
	}
}

fn apply_rich(
	colors: &BTreeMap<String, ColorValue>,
	vars: &BTreeMap<String, ColorValue>,
	mut theme: Theme,
) -> Result<Theme, ThemeError> {
	for (slot, value) in colors {
		let color = resolve_color(slot, value, vars)?.unwrap_or(Color::Default);
		match slot.as_str() {
			"text" => theme.fg = color,
			"accent" => theme.accent = color,
			"borderAccent" => theme.info = color,
			"statusLineModel" => theme.status_model = color,
			"mdCodeBlock" | "bashMode" => theme.info = color,
			"statusLinePath" => theme.status_path = color,
			"success" => theme.ok = color,
			"toolDiffAdded" => theme.tool_diff_added = color,
			"statusLineGitClean" => theme.status_git_clean = color,
			"warning" => theme.warn = color,
			"statusLineGitDirty" => theme.status_git_dirty = color,
			"statusLineDirty" => theme.status_dirty = color,
			"error" => theme.err = color,
			"toolDiffRemoved" => theme.tool_diff_removed = color,
			"toolErrorBg" => theme.error_surface = color,
			"statusLineBg" => theme.status_bg = color,
			"statusLineSep" => theme.status_sep = color,
			"muted" => theme.muted = color,
			"dim" => theme.dim = color,
			"toolOutput" => theme.output = color,
			"toolDiffContext" => theme.tool_diff_context = color,
			"mdCodeBlockBorder" => theme.code_border = color,
			"border" => theme.border = color,
			"borderMuted" => theme.border_muted = color,
			"selectedBg" => theme.selection = color,
			"toolPendingBg" => theme.surface = color,
			"userMessageBg" | "customMessageBg" | "toolSuccessBg" => theme.panel = color,
			"pythonMode" => theme.python = color,
			"customMessageLabel" => theme.secondary = color,
			"statusLineContext" => theme.status_context = color,
			"statusLineSpend" => theme.status_spend = color,
			"statusLineStaged" => theme.status_staged = color,
			"statusLineUntracked" => theme.status_untracked = color,
			"statusLineOutput" => theme.status_output = color,
			"statusLineCost" => theme.status_cost = color,
			"statusLineSubagents" => theme.status_subagents = color,
			"userMessageText" | "customMessageText" => theme.contrast = color,
			_ => {},
		}
	}

	// Rich themes name concrete presentation roles while omp components
	// consume a smaller semantic palette. Preserve an explicitly authored
	// semantic slot, otherwise use the closest concrete role as its fallback.
	if !colors.contains_key("accent")
		&& let Some(value) = colors.get("borderAccent")
	{
		theme.accent = resolve_color("borderAccent", value, vars)?.unwrap_or(Color::Default);
	}
	if !colors.contains_key("success")
		&& let Some(value) = colors.get("toolDiffAdded")
	{
		theme.ok = resolve_color("toolDiffAdded", value, vars)?.unwrap_or(Color::Default);
	}
	if !colors.contains_key("error")
		&& let Some(value) = colors.get("toolDiffRemoved")
	{
		theme.err = resolve_color("toolDiffRemoved", value, vars)?.unwrap_or(Color::Default);
	}
	if !colors.contains_key("userMessageBg")
		&& !colors.contains_key("customMessageBg")
		&& !colors.contains_key("toolSuccessBg")
		&& let Some(value) = colors.get("statusLineBg")
	{
		theme.panel = resolve_color("statusLineBg", value, vars)?.unwrap_or(Color::Default);
	}
	Ok(theme)
}

fn resolve_color(
	token: &str,
	value: &ColorValue,
	vars: &BTreeMap<String, ColorValue>,
) -> Result<Option<Color>, ThemeError> {
	let mut value = value;
	for _ in 0..16 {
		match value {
			ColorValue::Index(index) => {
				let index =
					u8::try_from(*index).map_err(|_| ThemeError::Index { token: Str::new(token) })?;
				return Ok(Some(Color::Indexed(index)));
			},
			ColorValue::Text(source) if source.is_empty() => return Ok(None),
			ColorValue::Text(source) => {
				if let Some(variable) = vars.get(source) {
					value = variable;
					continue;
				}
				return Color::parse(source)
					.map(Some)
					.ok_or_else(|| ThemeError::Color {
						token: Str::new(token),
						value: Str::new(source.as_str()),
					});
			},
		}
	}
	Err(ThemeError::Color { token: Str::new(token), value: Str::new_static("variable cycle") })
}

/// Code-fence rails are intentionally subdued chrome, but below this ratio
/// they disappear against the canvas used by the theme.
const MIN_FENCE_CONTRAST: f64 = 2.4;

fn fence_border_with_contrast(border: Color, background: Color) -> Color {
	let Some(ratio) = color_contrast(border, background) else {
		return border;
	};
	if ratio >= MIN_FENCE_CONTRAST {
		return border;
	}

	let black = Color::Rgb(0, 0, 0);
	let white = Color::Rgb(255, 255, 255);
	let target = if color_contrast(black, background) >= color_contrast(white, background) {
		black
	} else {
		white
	};
	let Some(target_ratio) = color_contrast(target, background) else {
		return border;
	};
	if target_ratio < MIN_FENCE_CONTRAST {
		return border;
	}

	// Find the smallest channel-space adjustment that restores legibility, so
	// the authored hue and the intentionally quiet fence treatment survive.
	let mut insufficient = 0.0_f32;
	let mut sufficient = 1.0_f32;
	for _ in 0..16 {
		let amount = f32::midpoint(insufficient, sufficient);
		let candidate = border.mix(target, amount);
		if color_contrast(candidate, background).is_some_and(|ratio| ratio >= MIN_FENCE_CONTRAST) {
			sufficient = amount;
		} else {
			insufficient = amount;
		}
	}
	border.mix(target, sufficient)
}

fn color_contrast(left: Color, right: Color) -> Option<f64> {
	let Color::Rgb(left_red, left_green, left_blue) = left else {
		return None;
	};
	let Color::Rgb(right_red, right_green, right_blue) = right else {
		return None;
	};
	let left = relative_luminance([left_red, left_green, left_blue]);
	let right = relative_luminance([right_red, right_green, right_blue]);
	let (lighter, darker) = if left > right {
		(left, right)
	} else {
		(right, left)
	};
	Some((lighter + 0.05) / (darker + 0.05))
}

/// Derives a stable `TrueColor` accent from a session name and active theme.
///
/// Dark surfaces use the warm 0–120° band. Supplying a light-surface
/// luminance selects the cool 180–300° band and lowers lightness until WCAG
/// 3:1 contrast is met. Occupied theme hues are avoided by at least 10° when
/// the selected band has room.
pub fn session_accent_color(
	name: &str,
	theme_colors: &[Color],
	surface_luminance: Option<f64>,
) -> Color {
	let (hue_start, hue_end) = if surface_luminance.is_some() {
		(180_u32, 300_u32)
	} else {
		(0_u32, 120_u32)
	};
	let mut hash = 5_381_u32;
	for unit in name.encode_utf16() {
		hash = hash.wrapping_mul(33) ^ u32::from(unit);
	}
	let mut hue = hue_start + hash % (hue_end - hue_start);
	let occupied = theme_colors
		.iter()
		.filter_map(|color| match *color {
			Color::Rgb(red, green, blue) => rgb_hue(red, green, blue),
			_ => None,
		})
		.collect::<Vec<_>>();
	if occupied
		.iter()
		.any(|occupied| hue_distance(f64::from(hue), *occupied) < 10.0)
	{
		'search: for distance in 1..=hue_end - hue_start {
			for candidate in
				[hue.saturating_add(distance).min(hue_end), hue.saturating_sub(distance).max(hue_start)]
			{
				if occupied
					.iter()
					.all(|occupied| hue_distance(f64::from(candidate), *occupied) >= 10.0)
				{
					hue = candidate;
					break 'search;
				}
			}
		}
	}
	let mut lightness = 0.72;
	if let Some(surface_luminance) = surface_luminance {
		let cap = ((surface_luminance + 0.05) / 3.0 - 0.05).max(0.0);
		if relative_luminance(hsl_rgb(f64::from(hue), 0.9, lightness)) > cap {
			let mut low = 0.0;
			let mut high = lightness;
			for _ in 0..20 {
				let middle = f64::midpoint(low, high);
				if relative_luminance(hsl_rgb(f64::from(hue), 0.9, middle)) > cap {
					high = middle;
				} else {
					low = middle;
				}
			}
			lightness = low;
		}
	}
	let [red, green, blue] = hsl_rgb(f64::from(hue), 0.9, lightness);
	Color::Rgb(red, green, blue)
}

fn rgb_hue(red: u8, green: u8, blue: u8) -> Option<f64> {
	let red = f64::from(red) / 255.0;
	let green = f64::from(green) / 255.0;
	let blue = f64::from(blue) / 255.0;
	let maximum = red.max(green).max(blue);
	let minimum = red.min(green).min(blue);
	let delta = maximum - minimum;
	if maximum == 0.0 || delta / maximum < 0.1 {
		return None;
	}
	let sector = if maximum == red {
		((green - blue) / delta).rem_euclid(6.0)
	} else if maximum == green {
		(blue - red) / delta + 2.0
	} else {
		(red - green) / delta + 4.0
	};
	Some(sector * 60.0)
}

fn hue_distance(left: f64, right: f64) -> f64 {
	let distance = (left - right).abs();
	distance.min(360.0 - distance)
}

fn hsl_rgb(hue: f64, saturation: f64, lightness: f64) -> [u8; 3] {
	let chroma = (1.0 - 2.0f64.mul_add(lightness, -1.0).abs()) * saturation;
	let sector = hue / 60.0;
	let secondary = chroma * (1.0 - (sector.rem_euclid(2.0) - 1.0).abs());
	let (red, green, blue) = match sector as u8 {
		0 => (chroma, secondary, 0.0),
		1 => (secondary, chroma, 0.0),
		2 => (0.0, chroma, secondary),
		3 => (0.0, secondary, chroma),
		4 => (secondary, 0.0, chroma),
		_ => (chroma, 0.0, secondary),
	};
	let offset = lightness - chroma / 2.0;
	[
		((red + offset) * 255.0).round().clamp(0.0, 255.0) as u8,
		((green + offset) * 255.0).round().clamp(0.0, 255.0) as u8,
		((blue + offset) * 255.0).round().clamp(0.0, 255.0) as u8,
	]
}

fn relative_luminance([red, green, blue]: [u8; 3]) -> f64 {
	let linear = |value: u8| {
		let value = f64::from(value) / 255.0;
		if value <= 0.04045 {
			value / 12.92
		} else {
			((value + 0.055) / 1.055).powf(2.4)
		}
	};
	0.7152f64.mul_add(linear(green), 0.2126 * linear(red)) + 0.0722 * linear(blue)
}

#[cfg(test)]
mod tests {
	use super::*;
	#[test]
	fn selection_and_tint_backgrounds_use_panel_mix_math() {
		let theme =
			Theme { panel: Color::Rgb(10, 20, 30), fg: Color::Rgb(210, 220, 230), ..Theme::default() };
		assert_eq!(theme.selection_bg(false), Color::Rgb(38, 48, 58));
		assert_eq!(theme.selection_bg(true), Color::Rgb(26, 36, 46));
		assert_eq!(theme.tint_bg(Color::Rgb(110, 120, 130), 0.18), Color::Rgb(28, 38, 48));
	}

	#[test]
	fn json_theme_selects_dark_and_light_variants() {
		let theme = JsonTheme::parse(
			r##"{
			"name":"cyanotype",
			"dark":{"accent":"#00ffff","panel":"rgb(1 2 3)"},
			"light":{"accent":"#005faf"}
		}"##,
		)
		.unwrap();
		assert_eq!(theme.name, "cyanotype");
		assert_eq!(theme.for_appearance(Appearance::Dark).accent, Color::Rgb(0, 255, 255));
		assert_eq!(theme.for_appearance(Appearance::Dark).panel, Color::Rgb(1, 2, 3));
		assert_eq!(theme.for_appearance(Appearance::Light).accent, Color::Rgb(0, 95, 175));
	}

	#[test]
	fn rich_pi_slots_and_variables_lower_to_semantic_tokens() {
		let theme = JsonTheme::parse(
			r##"{
			"name":"rich",
			"vars":{"violet":"#8855ee"},
			"colors":{
				"text":"#eeeeee","borderAccent":"violet","success":40,
				"toolDiffRemoved":"#ff3344","statusLineBg":"#101216",
				"syntaxKeyword":"#abcdef"
			}
		}"##,
		)
		.expect("rich theme");
		let dark = theme.for_appearance(Appearance::Dark);
		assert_eq!(dark.fg, Color::Rgb(0xee, 0xee, 0xee));
		assert_eq!(dark.accent, Color::Rgb(0x88, 0x55, 0xee));
		assert_eq!(dark.ok, Color::Indexed(40));
		assert_eq!(dark.err, Color::Rgb(0xff, 0x33, 0x44));
		assert_eq!(dark.panel, Color::Rgb(0x10, 0x12, 0x16));
		assert!(matches!(theme.for_appearance_256(Appearance::Dark).accent, Color::Indexed(_)));
	}

	#[test]
	fn affected_dark_theme_fence_borders_meet_contrast_floor() {
		for (name, border, broken_border, muted, background) in [
			("dark", "#777d88", "#3d424a", "#777d88", "#18181e"),
			("dark-catppuccin", "#6c7086", "#313244", "#7f849c", "#1e1e2e"),
			("dark-nord", "#616e88", "#434c5e", "#4c566a", "#2e3440"),
			("dark-eclipse", "#67616c", "#111018", "#8b8792", "#08070d"),
			("dark-retro", "#cc8800", "#664400", "#cc8800", "#0a0a0a"),
		] {
			for candidate in [border, broken_border] {
				let source = format!(
					r##"{{
						"name":"{name}",
						"colors":{{"muted":"{muted}","mdCodeBlockBorder":"{candidate}"}},
						"export":{{"pageBg":"{background}"}}
					}}"##
				);
				let theme = JsonTheme::parse(&source).expect("dark theme");
				let resolved = theme.for_appearance(Appearance::Dark).code_border;
				let requested = Color::parse(candidate).expect("fence border");
				if candidate == border {
					assert_eq!(resolved, requested, "{name} changed an already-legible border");
				} else {
					assert_ne!(resolved, requested, "{name} kept its illegible border");
				}
				let background = Color::parse(background).expect("page background");
				let ratio = color_contrast(resolved, background).expect("RGB colors");
				assert!(ratio >= MIN_FENCE_CONTRAST, "{name} fence border contrast was {ratio:.3}:1");
			}
		}
	}

	#[test]
	fn catalog_prefers_explicit_files_and_warns_on_broken_discovered_themes() {
		let dir = tempfile::tempdir().unwrap();
		let explicit = dir.path().join("ocean.json");
		fs::write(&explicit, r##"{"name":"Ocean","dark":{"accent":"#0000ff"}}"##).unwrap();
		let themes = dir.path().join("themes");
		fs::create_dir_all(&themes).unwrap();
		fs::write(themes.join("ocean.json"), r##"{"name":"Other","dark":{"accent":"#00ff00"}}"##)
			.unwrap();
		fs::write(themes.join("forest.json"), r##"{"name":"Forest","dark":{"accent":"#00aa00"}}"##)
			.unwrap();
		fs::write(themes.join("broken.json"), "{").unwrap();
		fs::write(themes.join("notes.txt"), "ignored").unwrap();

		let catalog = ThemeCatalog::load(std::slice::from_ref(&explicit), &[
			themes.clone(),
			dir.path().join("missing"),
		])
		.unwrap();
		let names = catalog
			.themes()
			.iter()
			.map(|loaded| loaded.name.as_str())
			.collect::<Vec<_>>();
		assert_eq!(names, ["ocean", "forest"], "explicit file shadows the discovered one");
		assert_eq!(
			catalog
				.get("ocean")
				.unwrap()
				.for_appearance(Appearance::Dark)
				.accent,
			Color::Rgb(0, 0, 255)
		);
		assert_eq!(catalog.first_explicit().unwrap().name, "Ocean");
		assert_eq!(catalog.warnings.len(), 1, "{:?}", catalog.warnings);
		assert_eq!(catalog.warnings[0].path, themes.join("broken.json"));

		let error = ThemeCatalog::load(&[dir.path().join("nope.json")], &[]).unwrap_err();
		assert!(matches!(error, ThemeLoadError::Io { .. }), "{error}");
		let error = ThemeCatalog::load(&[themes.join("broken.json")], &[]).unwrap_err();
		assert!(matches!(error, ThemeLoadError::Theme { .. }), "{error}");
	}

	#[test]
	fn named_palette_follows_appearance_changes() {
		let theme = Arc::new(
			JsonTheme::parse(
				r##"{"name":"two","dark":{"accent":"#111111"},"light":{"accent":"#eeeeee"}}"##,
			)
			.unwrap(),
		);
		let mut ui = crate::UiContext::default().with_palette(Some(Arc::clone(&theme)));
		assert_eq!(ui.appearance, Appearance::Dark);
		assert_eq!(ui.theme.accent, Color::Rgb(0x11, 0x11, 0x11));
		assert!(ui.apply_appearance(Appearance::Light));
		assert_eq!(ui.theme.accent, Color::Rgb(0xee, 0xee, 0xee), "light variant selected");
		assert!(ui.set_palette(None));
		assert_eq!(ui.theme, Theme::for_appearance(Appearance::Light), "stock palette restored");
	}

	#[test]
	fn missing_light_variant_reuses_tokens_over_light_defaults() {
		let theme = JsonTheme::parse(r##"{"name":"one","dark":{"accent":"#123456"}}"##).unwrap();
		assert_eq!(theme.for_appearance(Appearance::Light).accent, Color::Rgb(0x12, 0x34, 0x56));
		assert_eq!(
			theme.for_appearance(Appearance::Light).fg,
			Theme::for_appearance(Appearance::Light).fg
		);
	}
}
