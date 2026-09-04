//! Journal-derived tool-card lifecycle gallery and PNG capture command.

use std::{fs, path::PathBuf};

use clap::{Args, ValueEnum};
use miette::IntoDiagnostic as _;
use omp_chat::gallery::{self, GallerySection};
use omp_core::Str;
use omp_tui::{IntoComponent as _, Ui, UiContext, dom};
use strum::{Display, EnumIter, IntoEnumIterator as _};

/// Gallery surface to render.
#[derive(Clone, Copy, Debug, Eq, PartialEq, ValueEnum)]
pub enum GallerySurface {
	/// Typed cards projected from journal-derived tool elements.
	Tool,
}

/// Tool lifecycle states rendered by the gallery, in display order.
#[derive(Clone, Copy, Debug, Display, EnumIter, Eq, PartialEq, ValueEnum)]
#[strum(serialize_all = "snake_case")]
pub enum GalleryState {
	/// Streaming arguments before the call is ready to execute.
	#[value(alias = "streaming-args")]
	Streaming,
	/// A live call with an optional typed progress update.
	#[value(alias = "in-progress")]
	Progress,
	/// A successfully settled call.
	#[value(alias = "done")]
	Success,
	/// A faulted call.
	#[value(alias = "failed")]
	Error,
}

/// Native renderer gallery options.
#[derive(Clone, Debug, Args)]
pub struct GalleryArgs {
	/// Restrict output to the tool-card surface.
	#[arg(long, value_delimiter = ',')]
	pub surface:    Vec<GallerySurface>,
	/// Restrict output to one registered card name.
	#[arg(short = 't', long)]
	pub tool:       Option<Str>,
	/// Restrict output to lifecycle states.
	#[arg(short = 's', long = "state", value_delimiter = ',')]
	pub states:     Vec<GalleryState>,
	/// Terminal width in columns, clamped to 40..=200.
	#[arg(short = 'w', long, default_value_t = 100)]
	pub width:      u16,
	/// Render expanded card details.
	#[arg(short = 'e', long)]
	pub expanded:   bool,
	/// Emit text without terminal styling.
	#[arg(long)]
	pub plain:      bool,
	/// Capture one native PNG per card and lifecycle state.
	#[arg(long)]
	pub screenshot: bool,
	/// PNG output directory.
	#[arg(short = 'o', long, default_value = "gallery")]
	pub out:        PathBuf,
}

/// Renders the selected lifecycle gallery to stdout or PNG files.
pub fn run(args: GalleryArgs) -> miette::Result<()> {
	run_tool(&args)
}

fn run_tool(args: &GalleryArgs) -> miette::Result<()> {
	let states = selected_states(args)
		.into_iter()
		.map(to_card_state)
		.collect::<Vec<_>>();
	let width = args.width.clamp(40, 200);
	let names = gallery::fixture_names();
	if let Some(tool) = &args.tool
		&& !names.contains(&tool.as_str())
	{
		println!("Unknown tool '{tool}'. Known tools: {}", names.join(", "));
		return Ok(());
	}
	let sections = gallery::render_sections(args.tool.as_deref(), &states, width, args.expanded)
		.into_diagnostic()?;
	if args.screenshot {
		fs::create_dir_all(&args.out).into_diagnostic()?;
		for section in sections {
			let state = state_name(section.state);
			let path = args.out.join(format!("{}-{state}.png", section.tool));
			let png = omp_tui::frame_png(&section.frame).into_diagnostic()?;
			fs::write(&path, png).into_diagnostic()?;
			println!("{}", path.display());
		}
		return Ok(());
	}
	// The block layout has a leading blank and the section rule per tool, then a
	// blank, the dim state label, and the card frame per lifecycle state.
	let mut current = None;
	for section in sections {
		if current != Some(section.tool) {
			println!();
			let rule = section_rule(&section, width);
			println!(
				"{}",
				if args.plain {
					rule
				} else {
					ansi_accent(rule, width)
				}
			);
			current = Some(section.tool);
		}
		println!();
		let label = format!("  · {}", section.state);
		println!(
			"{}",
			if args.plain {
				label
			} else {
				ansi_dim(label, width)
			}
		);
		println!(
			"{}",
			if args.plain {
				omp_tui::frame_text(&section.frame)
			} else {
				omp_tui::frame_ansi(&section.frame)
			}
		);
	}
	println!();
	Ok(())
}

fn selected_states(args: &GalleryArgs) -> Vec<GalleryState> {
	if args.states.is_empty() {
		GalleryState::iter().collect()
	} else {
		args.states.clone()
	}
}

const fn to_card_state(state: GalleryState) -> gallery::GalleryState {
	match state {
		GalleryState::Streaming => gallery::GalleryState::StreamingArgs,
		GalleryState::Progress => gallery::GalleryState::InProgress,
		GalleryState::Success => gallery::GalleryState::Done,
		GalleryState::Error => gallery::GalleryState::Failed,
	}
}

const fn state_name(state: gallery::GalleryState) -> &'static str {
	match state {
		gallery::GalleryState::StreamingArgs => "streaming",
		gallery::GalleryState::InProgress => "progress",
		gallery::GalleryState::Done => "success",
		gallery::GalleryState::Failed => "error",
	}
}

fn ansi_accent(text: String, width: u16) -> String {
	let component = dom! { <text fg=accent bold>{text}</text> }.into_component();
	omp_tui::frame_ansi(Ui::from_root(component, width, UiContext::default()).frame())
}

fn ansi_dim(text: String, width: u16) -> String {
	let component = dom! { <text fg=dim>{text}</text> }.into_component();
	omp_tui::frame_ansi(Ui::from_root(component, width, UiContext::default()).frame())
}

fn section_rule(section: &GallerySection, width: u16) -> String {
	let prefix = if section.title.is_empty() {
		format!("── {} ", section.tool)
	} else {
		format!("── {} — {} ", section.tool, section.title)
	};
	let fill = usize::from(width).saturating_sub(prefix.chars().count());
	format!("{prefix}{}", "─".repeat(fill))
}
