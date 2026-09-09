//! Composer footer studies: split band + air gap, with a session title.
//!
//! ```sh
//! cargo run -p omp-tui --example footers
//! ```
//!
//! The direction is settled — a split status band (brand caps left,
//! session caps right) with breathing room under the working narration.
//! What's still open is where the *session title* lives: the named task
//! ("Immutable Commit Placement…"), which is not the same thing as the
//! current working narration. Each study places that title somewhere
//! else, the border-fused layout included as the reference point.
//!
//! Every study animates live — spinner, session timer, and the narration
//! shimmer all run — so spacing can be judged in motion.
//!
//! `↑`/`↓`/`j`/`k` scroll a row, PageUp/PageDown a viewport, Home/End
//! jump, the mouse wheel scrolls, and `q`, Escape, or Ctrl-C quits.

use std::{
	io, slice,
	time::{Duration, Instant},
};

use omp_core::{Str, sf};
use omp_tui::{
	AltScreenUse, Charset, Color, Frame, Icon, InputEvent, Key, Mouse, Rect, Renderer, Size, Style,
	Terminal, TerminalEvent, TerminalOptions, TtyOut, UiContext, anim::Shimmer, detect,
};

// The chat demo's chrome palette, so studies read like the real composer.
const TEXT: Color = Color::Rgb(194, 198, 204);
const MUTED: Color = Color::Rgb(110, 116, 124);
const FAINT: Color = Color::Rgb(72, 78, 86);
const GREEN: Color = Color::Rgb(81, 196, 112);
const CYAN: Color = Color::Rgb(62, 190, 203);
const PURPLE: Color = Color::Rgb(171, 119, 230);
const GOLD: Color = Color::Rgb(210, 167, 86);
const BAND_BG: Color = Color::Rgb(18, 18, 18);

const WORKING: &str = "Implementing immutable seam commits";
const TITLE: &str = "Immutable Commit Placement & Status Bar Layout Options";
const MODEL: &str = "Fable 5++";
const GIT: &str = "main *5 +9";
const CONTEXT: &str = "39.1%/1M";
const COST: &str = "$60.07 (sub) + $8.65 (adv)";
const COST_SHORT: &str = "$60.07";

const FRAME_INTERVAL: Duration = Duration::from_millis(33);
const SHIMMER_PERIOD: Duration = Duration::from_millis(1900);

#[tokio::main]
async fn main() -> io::Result<()> {
	let caps = detect();
	let charset = UiContext::default().with_terminal_caps(&caps).charset;
	let mut terminal = Terminal::enter(TerminalOptions::new(caps).mouse(true))?;
	let mut renderer = Renderer::new(TtyOut::new()?);
	renderer.apply_caps(&caps)?;
	match run(&mut terminal, &mut renderer, charset).await {
		Ok(()) => terminal.leave_alt(),
		Err(error) => {
			let _ = terminal.leave_alt();
			Err(error)
		},
	}
}

async fn run<'a>(
	terminal: &'a mut Terminal,
	renderer: &'a mut Renderer<TtyOut>,
	charset: Charset,
) -> io::Result<()> {
	let started = Instant::now();
	let mut viewport = terminal.size()?;
	let mut scroll: u16 = 0;
	let mut alt_enter = terminal.stage_alt_enter(AltScreenUse::Interactive);
	loop {
		tokio::select! {
			event = terminal.next() => match event? {
				TerminalEvent::Input(event)
				| TerminalEvent::InputWithMeta { event, .. } => {
					match event {
						InputEvent::Key(key) => match key {
							Key::Char('q') | Key::Esc | Key::Ctrl('c') => return Ok(()),
							Key::Up | Key::Char('k') => scroll = scroll.saturating_sub(1),
							Key::Down | Key::Char('j') => scroll = scroll.saturating_add(1),
							Key::PageUp => scroll = scroll.saturating_sub(viewport.height),
							Key::PageDown => scroll = scroll.saturating_add(viewport.height),
							Key::Home => scroll = 0,
							Key::End => scroll = u16::MAX,
							_ => {},
						},
						InputEvent::Chord(event) if event.pressed => {
							if let Some(key) = event.key {
								match key {
									Key::Char('q') | Key::Esc | Key::Ctrl('c') => return Ok(()),
									Key::Up | Key::Char('k') => scroll = scroll.saturating_sub(1),
									Key::Down | Key::Char('j') => scroll = scroll.saturating_add(1),
									Key::PageUp => scroll = scroll.saturating_sub(viewport.height),
									Key::PageDown => scroll = scroll.saturating_add(viewport.height),
									Key::Home => scroll = 0,
									Key::End => scroll = u16::MAX,
									_ => {},
								}
							}
						},
						InputEvent::Chord(_) => {},
						InputEvent::Mouse(report) => match report.kind {
							Mouse::WheelUp => scroll = scroll.saturating_sub(2),
							Mouse::WheelDown => scroll = scroll.saturating_add(2),
							_ => {},
						},
						InputEvent::Paste(_) | InputEvent::Focus(_) | InputEvent::Response(_) => {},
					}
					terminal.sync_renderer(renderer)?;
				},
				TerminalEvent::Resize => {
					if let Some(size) = terminal.take_resize()? {
						viewport = size;
					}
				},
				TerminalEvent::Debug(_) | TerminalEvent::Effect(_) => {},
				TerminalEvent::Closed => return Ok(()),
			},
			() = tokio::time::sleep(FRAME_INTERVAL) => {},
		}
		if viewport.width == 0 || viewport.height == 0 {
			continue;
		}
		let scene = Scene { charset, width: viewport.width, elapsed: started.elapsed() };
		let document = compose(&scene);
		scroll = scroll.min(document.size().height.saturating_sub(viewport.height));
		let mut screen = Frame::new(viewport);
		screen.fill(Rect::new(0, 0, viewport.width, viewport.height), ink(TEXT));
		screen.blit(&document, scroll, viewport.height, 0, 0);
		renderer.repaint(alt_enter.take().as_deref().unwrap_or(""), screen, viewport.height, &[])?;
	}
}

/// Per-frame paint inputs shared by every study.
struct Scene {
	charset: Charset,
	width:   u16,
	elapsed: Duration,
}

impl Scene {
	const fn spinner(&self) -> &'static str {
		self.charset.spinner().at(self.elapsed)
	}

	fn timer(&self) -> Str {
		let seconds = self.elapsed.as_secs();
		if seconds < 60 {
			sf!("{seconds}s")
		} else {
			sf!("{}m", seconds / 60)
		}
	}

	const fn right_edge(&self) -> u16 {
		self.width.saturating_sub(1)
	}
}

/// One study: a header line and a `rows`-tall live mock beneath it.
struct Study {
	title: &'static str,
	note:  &'static str,
	rows:  u16,
	draw:  fn(&mut Frame, u16, &Scene),
}

const STUDIES: [Study; 6] = [
	Study {
		title: "border-fused",
		note:  "border carries the band left and the title right; the intent rides its own spinner \
		        row",
		rows:  4,
		draw:  study_primary,
	},
	Study {
		title: "gap title",
		note:  "the air row earns its keep — session title idles right-aligned in the gap",
		rows:  4,
		draw:  study_gap_title,
	},
	Study {
		title: "band title",
		note:  "title as the left band's second segment; session facts dock right",
		rows:  4,
		draw:  study_band_title,
	},
	Study {
		title: "prompt title",
		note:  "split + air untouched; the title rests on the prompt row and yields while typing",
		rows:  4,
		draw:  study_prompt_title,
	},
	Study {
		title: "crown",
		note:  "title crowns the whole block; narration, gap, and split bands breathe below it",
		rows:  5,
		draw:  study_crown,
	},
	Study {
		title: "hem",
		note:  "title stitched into the top border, band into the bottom hem",
		rows:  4,
		draw:  study_hem,
	},
];

/// Renders the full document — title block plus every study — at width.
fn compose(scene: &Scene) -> Frame {
	let height = STUDIES
		.iter()
		.map(|study| study.rows + 3)
		.fold(3_u16, u16::saturating_add);
	let mut frame = Frame::new(Size::new(scene.width, height));
	frame.fill(Rect::new(0, 0, scene.width, height), ink(TEXT));

	let column = frame.put(1, 0, "composer footer studies", ink(TEXT).bold());
	frame.put(
		column.saturating_add(2),
		0,
		"split + air gap, six session-title placements",
		ink(MUTED),
	);
	frame.put(1, 1, "↑/↓ scroll · PgUp/PgDn page · Home/End jump · q quits", ink(FAINT));

	let mut y = 3_u16;
	for (index, study) in STUDIES.iter().enumerate() {
		let number = sf!("{:>2} ", index + 1);
		let mut column = frame.put(1, y, &number, ink(GOLD).bold());
		column = frame.put(column, y, study.title, ink(TEXT).bold());
		column = frame.put(column, y, "  ", ink(FAINT));
		frame.put(column, y, study.note, ink(MUTED));
		(study.draw)(&mut frame, y + 1, scene);
		y = y.saturating_add(study.rows + 3);
	}
	frame
}

// ── studies ─────────────────────────────────────────────────────────────────

/// 1: a bordered composer whose top border
/// carries the session band on the left and the title on the right, with
/// the spinner narrating intent on its own row above the box.
fn study_primary(frame: &mut Frame, y: u16, scene: &Scene) {
	draw_working_spin(frame, 1, y, scene);
	let (tl, tr, bl, br, horizontal, vertical) = border_glyphs(scene.charset);
	let right = scene.right_edge();
	draw_border_row(frame, y + 1, scene, tl, tr, horizontal);
	let segments = [model(scene), omp_brand(scene), git(scene), context(scene), cost()];
	draw_band(frame, 2, y + 1, scene, &segments);
	let band_end = 2_u16.saturating_add(band_width(scene, &segments));
	draw_border_title(frame, y + 1, scene, band_end.saturating_add(2));
	frame.put(0, y + 2, vertical, ink(FAINT));
	frame.put(2, y + 2, beam(scene.charset), ink(TEXT));
	frame.put(right, y + 2, vertical, ink(FAINT));
	draw_border_row(frame, y + 3, scene, bl, br, horizontal);
}

/// 2: split + air gap as picked, with the title moving into the air row
/// so the breathing space doubles as identity.
fn study_gap_title(frame: &mut Frame, y: u16, scene: &Scene) {
	draw_working(frame, 1, y, scene);
	let title = fit_title(scene, scene.width.saturating_sub(2));
	let x = scene
		.width
		.saturating_sub(width_of(&title).saturating_add(1));
	frame.put(x, y + 1, &title, ink(FAINT).italic());
	draw_split_bands(frame, y + 2, scene);
	draw_input(frame, 0, y + 3, scene);
}

/// 3: the title joins the left band beside the brand segment, so the
/// band row itself answers "what session is this"; session facts keep
/// the right cap.
fn study_band_title(frame: &mut Frame, y: u16, scene: &Scene) {
	draw_working(frame, 1, y, scene);
	let right = [model(scene), git(scene), context(scene), Seg::new(COST_SHORT, PURPLE)];
	let right_width = band_width(scene, &right);
	let brand_seg = brand(scene);
	let (_, separator, _) = band_chrome(scene.charset);
	let fixed = band_width(scene, slice::from_ref(&brand_seg))
		.saturating_add(width_of(separator).saturating_add(2));
	let budget = scene
		.width
		.saturating_sub(right_width.saturating_add(2))
		.saturating_sub(fixed);
	let left = [brand_seg, Seg::new(fit_title(scene, budget), TEXT)];
	draw_band(frame, 0, y + 2, scene, &left);
	draw_band(frame, scene.width.saturating_sub(right_width), y + 2, scene, &right);
	draw_input(frame, 0, y + 3, scene);
}

/// 4: split + air untouched; the title borrows the prompt row's right
/// edge and would yield to long input lines.
fn study_prompt_title(frame: &mut Frame, y: u16, scene: &Scene) {
	draw_working(frame, 1, y, scene);
	draw_split_bands(frame, y + 2, scene);
	draw_input(frame, 0, y + 3, scene);
	let title = fit_title(scene, scene.width.saturating_sub(8));
	let x = scene
		.width
		.saturating_sub(width_of(&title).saturating_add(1));
	frame.put(x, y + 3, &title, ink(FAINT).italic());
}

/// 5: the title gets its own dim row above the narration, heading the
/// whole live block like a section title.
fn study_crown(frame: &mut Frame, y: u16, scene: &Scene) {
	let title = fit_title(scene, scene.width.saturating_sub(2));
	frame.put(1, y, &title, ink(MUTED).bold());
	draw_working(frame, 1, y + 1, scene);
	draw_split_bands(frame, y + 3, scene);
	draw_input(frame, 0, y + 4, scene);
}

/// 6: a bordered composer again, but the title takes the top border and
/// the band moves into the bottom hem, so chrome frames the input from
/// both sides.
fn study_hem(frame: &mut Frame, y: u16, scene: &Scene) {
	draw_working(frame, 1, y, scene);
	let (tl, tr, bl, br, horizontal, vertical) = border_glyphs(scene.charset);
	let right = scene.right_edge();
	draw_border_row(frame, y + 1, scene, tl, tr, horizontal);
	draw_border_title(frame, y + 1, scene, 4);
	frame.put(0, y + 2, vertical, ink(FAINT));
	frame.put(2, y + 2, beam(scene.charset), ink(TEXT));
	frame.put(right, y + 2, vertical, ink(FAINT));
	draw_border_row(frame, y + 3, scene, bl, br, horizontal);
	draw_band(frame, 2, y + 3, scene, &full_band(scene));
}

// ── shared chrome ───────────────────────────────────────────────────────────

/// One status item: a label painted in its identity color.
struct Seg {
	label: Str,
	color: Color,
}

impl Seg {
	fn new(label: impl Into<Str>, color: Color) -> Self {
		Self { label: label.into(), color }
	}
}

fn brand(scene: &Scene) -> Seg {
	Seg::new(sf!("{} {}", scene.spinner(), scene.timer()), GREEN)
}

fn omp_brand(scene: &Scene) -> Seg {
	Seg::new(sf!("{} omp", scene.charset.icon(Icon::Omp)), MUTED)
}

fn model(scene: &Scene) -> Seg {
	Seg::new(sf!("{} {MODEL}", scene.charset.icon(Icon::Model)), GREEN)
}

fn git(scene: &Scene) -> Seg {
	Seg::new(sf!("{} {GIT}", scene.charset.icon(Icon::Branch)), CYAN)
}

fn context(scene: &Scene) -> Seg {
	Seg::new(sf!("{} {CONTEXT}", scene.charset.icon(Icon::Context)), GOLD)
}

fn cost() -> Seg {
	Seg::new(sf!(COST), PURPLE)
}

fn full_band(scene: &Scene) -> [Seg; 5] {
	[brand(scene), model(scene), git(scene), context(scene), cost()]
}

/// The picked split arrangement: brand caps left, session caps right.
fn draw_split_bands(frame: &mut Frame, y: u16, scene: &Scene) {
	let left = [brand(scene), model(scene)];
	let right = [git(scene), context(scene), cost()];
	draw_band(frame, 0, y, scene, &left);
	let x = scene.width.saturating_sub(band_width(scene, &right));
	draw_band(frame, x, y, scene, &right);
}

/// Status-band chrome per tier, mirroring the `<status>` component.
const fn band_chrome(charset: Charset) -> (&'static str, &'static str, &'static str) {
	match charset {
		Charset::Ascii => ("", ">", ">"),
		Charset::Unicode => ("", "›", "›"),
		Charset::NerdFont => ("\u{e0b6}", "\u{e0b1}", "\u{e0b0}"),
	}
}

const fn border_glyphs(
	charset: Charset,
) -> (&'static str, &'static str, &'static str, &'static str, &'static str, &'static str) {
	match charset {
		Charset::Ascii => ("+", "+", "+", "+", "-", "|"),
		_ => ("╭", "╮", "╰", "╯", "─", "│"),
	}
}

const fn beam(charset: Charset) -> &'static str {
	match charset {
		Charset::Ascii => "_",
		_ => "▏",
	}
}

const fn ink(color: Color) -> Style {
	Style::new().fg(color)
}

fn width_of(text: &str) -> u16 {
	u16::try_from(xutf::width_str(text)).unwrap_or(u16::MAX)
}

/// [`TITLE`] truncated to at most `max` cells, ellipsized when it cannot
/// fit whole.
fn fit_title(scene: &Scene, max: u16) -> Str {
	if width_of(TITLE) <= max {
		return sf!(TITLE);
	}
	let ellipsis = match scene.charset {
		Charset::Ascii => "...",
		_ => "…",
	};
	let budget = max.saturating_sub(width_of(ellipsis));
	let mut used = 0_u16;
	let mut end = 0_usize;
	for grapheme in xutf::graphemes_str(TITLE) {
		let cells = width_of(grapheme);
		if used.saturating_add(cells) > budget {
			break;
		}
		used = used.saturating_add(cells);
		end += grapheme.len();
	}
	if end == 0 {
		return Str::default();
	}
	sf!("{}{ellipsis}", TITLE[..end].trim_end())
}

/// Total cells a powerline band with `segments` occupies, mirroring the
/// `<status>` component's measurement.
fn band_width(scene: &Scene, segments: &[Seg]) -> u16 {
	let (left_cap, separator, right_cap) = band_chrome(scene.charset);
	let text = segments
		.iter()
		.map(|segment| width_of(&segment.label))
		.fold(0_u16, u16::saturating_add);
	let separators = u16::try_from(segments.len().saturating_sub(1))
		.unwrap_or(u16::MAX)
		.saturating_mul(width_of(separator).saturating_add(2));
	text
		.saturating_add(separators)
		.saturating_add(width_of(left_cap))
		.saturating_add(2)
		.saturating_add(width_of(right_cap))
}

/// Paints a powerline band at `x`: cap, padded segments, cap.
fn draw_band(frame: &mut Frame, x: u16, y: u16, scene: &Scene, segments: &[Seg]) {
	let (left_cap, separator, right_cap) = band_chrome(scene.charset);
	let base = Style::new().fg(TEXT).bg(BAND_BG);
	let edge = ink(BAND_BG);
	let mut column = frame.put(x, y, left_cap, edge);
	column = frame.put(column, y, " ", base);
	for (index, segment) in segments.iter().enumerate() {
		if index > 0 {
			column = frame.put(column, y, " ", base.dim());
			column = frame.put(column, y, separator, base.dim());
			column = frame.put(column, y, " ", base.dim());
		}
		column = frame.put(column, y, &segment.label, base.fg(segment.color));
	}
	column = frame.put(column, y, " ", base);
	frame.put(column, y, right_cap, edge);
}

/// A full-width horizontal border row: corner, rule fill, corner.
fn draw_border_row(
	frame: &mut Frame,
	y: u16,
	scene: &Scene,
	left: &str,
	right: &str,
	horizontal: &str,
) {
	let edge = scene.right_edge();
	let mut column = frame.put(0, y, left, ink(FAINT));
	while column < edge {
		column = frame.put(column, y, horizontal, ink(FAINT));
	}
	frame.put(edge, y, right, ink(FAINT));
}

/// Right-aligns ` TITLE ` into an already-painted border row, keeping two
/// rule cells before the corner and truncating against `min_x`.
fn draw_border_title(frame: &mut Frame, y: u16, scene: &Scene, min_x: u16) {
	let slot_end = scene.right_edge().saturating_sub(2);
	let title = fit_title(scene, slot_end.saturating_sub(min_x).saturating_sub(2));
	if title.is_empty() {
		return;
	}
	let x = slot_end.saturating_sub(width_of(&title).saturating_add(2));
	let column = frame.put(x, y, " ", ink(FAINT));
	let column = frame.put(column, y, &title, ink(TEXT));
	frame.put(column, y, " ", ink(FAINT));
}

/// The shimmering working line: cancel hint, then the narration, riding
/// one crest sweep exactly like the chat demo's activity row.
fn draw_working(frame: &mut Frame, x: u16, y: u16, scene: &Scene) {
	let hint = scene.charset.icon(Icon::Cancellable);
	let length = width_of(hint)
		.saturating_add(1)
		.saturating_add(width_of(WORKING));
	let shimmer = Shimmer::new(scene.elapsed, SHIMMER_PERIOD, length);
	let mut column = x;
	draw_shimmer(frame, &mut column, x, y, scene.right_edge(), hint, shimmer, ink(CYAN));
	draw_shimmer(frame, &mut column, x, y, scene.right_edge(), " ", shimmer, ink(GREEN));
	draw_shimmer(frame, &mut column, x, y, scene.right_edge(), WORKING, shimmer, ink(GREEN));
}

/// The working line: the spinner and timer lead, then
/// the shimmering narration — the band below carries no brand segment.
fn draw_working_spin(frame: &mut Frame, x: u16, y: u16, scene: &Scene) {
	let mut column = frame.put(x, y, scene.spinner(), ink(GREEN));
	column = frame.put(column, y, " ", ink(GREEN));
	column = frame.put(column, y, &scene.timer(), ink(MUTED));
	column = frame.put(column, y, " ", ink(MUTED));
	let shimmer = Shimmer::new(scene.elapsed, SHIMMER_PERIOD, width_of(WORKING));
	let start = column;
	draw_shimmer(frame, &mut column, start, y, scene.right_edge(), WORKING, shimmer, ink(GREEN));
}

/// Paints `text` under the crest, advancing `column`; `start` anchors
/// cell zero so every segment rides one sweep.
#[allow(clippy::too_many_arguments, reason = "immediate-mode painter threading frame state")]
fn draw_shimmer(
	frame: &mut Frame,
	column: &mut u16,
	start: u16,
	y: u16,
	right: u16,
	text: &str,
	shimmer: Shimmer,
	high: Style,
) {
	for grapheme in xutf::graphemes_str(text) {
		if *column >= right {
			return;
		}
		let style = shimmer.pick(*column - start, ink(FAINT), ink(MUTED), high);
		let next = frame.put(*column, y, grapheme, style);
		if next == *column {
			return;
		}
		*column = next;
	}
}

/// The composer prompt row: corner, then the idle cursor beam.
fn draw_input(frame: &mut Frame, x: u16, y: u16, scene: &Scene) {
	let prompt = match scene.charset {
		Charset::Ascii => "+-",
		_ => "╰─",
	};
	let column = frame.put(x, y, prompt, ink(FAINT));
	frame.put(column.saturating_add(1), y, beam(scene.charset), ink(TEXT));
}
