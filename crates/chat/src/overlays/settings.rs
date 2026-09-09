//! Curated `/settings` selector over convars.
//!
//! Values, types, validation, and persistence remain owned by `omp_con`.
//! This panel consumes only explicit product UI metadata and never derives a
//! visible row, label, tab, or group from a variable name.

use std::fmt::Write as _;

use omp_con::{Ctx, Hint, Value, ValueKind, VarFlags, VarView};
use omp_core::{Str, StrMut, sf};
use omp_tui::{
	Component, Frame, IntoComponent as _, Key, MouseReport, Prop, Size, Ui, UiContext, UiEvent,
	cell_width,
	components::{Input, Tabs},
	dom,
};

use super::{
	Panel, PanelAnchor, PanelCx, PanelEvent, PanelNote,
	services::{SettingsChoice, SettingsInventory},
};

const TEXT_FOOTER: &str = "Enter to save · Esc to cancel · Clear field to unset";
const CHOICE_FOOTER: &str = "Enter to select · Esc to go back";
const MULTI_FOOTER: &str = "Click/Enter/Space to toggle · Esc to go back";
const ORDERED_MULTI_FOOTER: &str =
	"Click to toggle · drag selected items to reorder · ←/→ move · 1-9 place · Esc to go back";
const PROVIDER_FOOTER: &str = "Enter to edit provider · Esc to go back";
const EMPTY: &str = "(empty)";
const CHROME_ROWS: u16 = 11;

/// Settings declaration metadata understood by this projection:
///
/// - `ui.tab` and `ui.group` opt an archived variable into this layout.
/// - `ui.label`, `ui.warning`, and `ui.unit` control presentation.
/// - `ui.secret`, `ui.ordered`, and `ui.widget=provider-limits` refine widgets.
/// - `ui.choices` selects a runtime roster (`themes`, `composer-shapes`, or
///   `thinking-levels`).
/// - `ui.option.<value>` and `ui.option.<value>.desc` describe finite choices.
/// - `ui.when` accepts `<convar>=<value>`, `os=macos`, or `term=images`.
///
/// Types and [`Hint`] select the ordinary widget; values are always read and
/// written in their raw convar representation.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq, strum::EnumString, strum::IntoStaticStr)]
#[strum(serialize_all = "lowercase")]
enum SettingTab {
	Appearance,
	Model,
	Interaction,
	Context,
	Memory,
	Files,
	Shell,
	Tools,
	Tasks,
	Providers,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct TabSpec {
	tab:    SettingTab,
	label:  &'static str,
	icon:   &'static str,
	groups: &'static [&'static str],
}

const SETTING_TABS: &[TabSpec] = &[
	TabSpec {
		tab:    SettingTab::Appearance,
		label:  "Appearance",
		icon:   "tab.appearance",
		groups: &["Theme", "Composer", "Status Line", "Display", "Images"],
	},
	TabSpec {
		tab:    SettingTab::Model,
		label:  "Model",
		icon:   "tab.model",
		groups: &[
			"Thinking",
			"Sampling",
			"Prompt",
			"Retry & Fallback",
			"Advisor",
			"Prewalk",
			"Vision",
		],
	},
	TabSpec {
		tab:    SettingTab::Interaction,
		label:  "Interaction",
		icon:   "tab.interaction",
		groups: &[
			"Input",
			"Approvals",
			"Notifications",
			"Speech",
			"Collab",
			"Magic Keywords",
			"Startup & Updates",
			"Power",
			"Agent",
			"Git",
		],
	},
	TabSpec {
		tab:    SettingTab::Context,
		label:  "Context",
		icon:   "tab.context",
		groups: &["General", "Compaction", "Rules (TTSR)", "Experimental"],
	},
	TabSpec {
		tab:    SettingTab::Memory,
		label:  "Memory",
		icon:   "tab.memory",
		groups: &["General", "Auto-Learn", "Mnemopi", "Hindsight", "Sharpshooter"],
	},
	TabSpec {
		tab:    SettingTab::Files,
		label:  "Files",
		icon:   "tab.files",
		groups: &["Editing", "Reading", "Read Summaries", "LSP"],
	},
	TabSpec {
		tab:    SettingTab::Shell,
		label:  "Shell",
		icon:   "tab.shell",
		groups: &["Bash", "Eval & Runtimes"],
	},
	TabSpec {
		tab:    SettingTab::Tools,
		label:  "Tools",
		icon:   "tab.tools",
		groups: &[
			"Available Tools",
			"Todos",
			"Grep & Browser",
			"Computer",
			"GitHub",
			"Output Limits",
			"Execution",
			"Discovery & MCP",
			"Extensions",
			"Developer",
		],
	},
	TabSpec {
		tab:    SettingTab::Tasks,
		label:  "Tasks",
		icon:   "tab.tasks",
		groups: &["Modes", "Subagents", "Isolation", "Commands & Skills"],
	},
	TabSpec {
		tab:    SettingTab::Providers,
		label:  "Providers",
		icon:   "tab.providers",
		groups: &["Services", "Fireworks", "Tiny Model", "Protocol", "Timeouts", "Privacy"],
	},
];

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum RuntimeChoices {
	Themes,
	ComposerShapes,
	ThinkingLevels,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct Choice {
	value:       Str,
	label:       Str,
	description: Str,
}

impl From<&SettingsChoice> for Choice {
	fn from(option: &SettingsChoice) -> Self {
		Self {
			value:       option.value.clone(),
			label:       option.label.clone(),
			description: option.description.clone(),
		}
	}
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum RowWidget {
	Boolean,
	Submenu(Vec<Choice>),
	RuntimeSubmenu(RuntimeChoices, Vec<Choice>),
	ProviderLimits,
	Text { secret: bool },
	MultiSelect { options: Vec<Choice>, ordered: bool },
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum RowValue {
	Boolean(bool),
	Scalar(Str),
	Multi(Vec<Str>),
	ProviderLimits(Vec<(Str, i64)>),
	Text(Str),
}

/// One curated editable convar. `convar` is command metadata and is never a
/// display label.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SettingRow {
	convar:      Str,
	label:       Str,
	description: Str,
	warning:     Option<Str>,
	unit:        Option<Str>,
	tab:         SettingTab,
	group:       Str,
	widget:      RowWidget,
	value:       RowValue,
	default:     RowValue,
	value_kind:  ValueKind,
	visibility:  Option<(Str, bool)>,
}

impl SettingRow {
	fn changed(&self) -> bool {
		self.value != self.default
	}

	fn display(&self) -> Str {
		let display = match (&self.widget, &self.value) {
			(RowWidget::Boolean, RowValue::Boolean(value)) => {
				Str::new_static(if *value { "On" } else { "Off" })
			},
			(
				RowWidget::Submenu(options) | RowWidget::RuntimeSubmenu(_, options),
				RowValue::Scalar(value),
			) => options
				.iter()
				.find(|option| option.value == *value)
				.map_or_else(|| value.clone(), |option| option.label.clone()),
			(RowWidget::MultiSelect { options, ordered }, RowValue::Multi(values)) => {
				if values.is_empty() {
					return Str::new_static(if *ordered { "default" } else { "none" });
				}
				let mut text = StrMut::new("");
				for (index, value) in values.iter().enumerate() {
					if index > 0 {
						text.push_str(if *ordered { " → " } else { ", " });
					}
					let label = options
						.iter()
						.find(|option| option.value == *value)
						.map_or(value.as_str(), |option| option.label.as_str());
					text.push_str(label);
				}
				text.freeze()
			},
			(RowWidget::ProviderLimits, RowValue::ProviderLimits(limits)) => {
				if limits.is_empty() {
					return Str::new_static("Unlimited");
				}
				let mut text = StrMut::new("");
				for (index, (provider, limit)) in limits.iter().enumerate() {
					if index > 0 {
						text.push_str(", ");
					}
					let _ = write!(text, "{provider}: {limit}");
				}
				text.freeze()
			},
			(RowWidget::Text { secret: true }, RowValue::Text(value)) => {
				return Str::new_static(if value.is_empty() {
					EMPTY
				} else {
					"••••••••"
				});
			},
			(_, RowValue::Scalar(value) | RowValue::Text(value)) if value.is_empty() => {
				return Str::new_static(EMPTY);
			},
			(_, RowValue::Scalar(value) | RowValue::Text(value)) => value.clone(),
			_ => return Str::new_static(EMPTY),
		};
		let Some(unit) = self.unit.as_deref() else {
			return display;
		};
		if self.value_kind == ValueKind::Duration {
			return display;
		}
		let (suffix, already_labeled) = match unit {
			"kib" => (" KiB", display.ends_with("KiB") || display.ends_with("KB")),
			"percent" => ("%", display.ends_with('%')),
			"s" => (" s", display.ends_with('s')),
			"ms" => (" ms", display.ends_with("ms")),
			_ => return display,
		};
		if already_labeled {
			display
		} else {
			sf!("{display}{suffix}")
		}
	}

	fn editable(&self) -> String {
		match &self.value {
			RowValue::Text(value) | RowValue::Scalar(value) => value.to_string(),
			RowValue::Boolean(value) => value.to_string(),
			RowValue::Multi(values) => values.iter().map(Str::as_str).collect::<Vec<_>>().join(" "),
			RowValue::ProviderLimits(_) => String::new(),
		}
	}
}

fn static_choice(spec: &VarView<'_>, value: &'static str) -> Choice {
	let label_key = sf!("ui.option.{value}");
	let description_key = sf!("ui.option.{value}.desc");
	Choice {
		value:       Str::new_static(value),
		label:       spec
			.meta_get(label_key.as_str())
			.map_or_else(|| Str::new_static(value), Str::new),
		description: spec
			.meta_get(description_key.as_str())
			.map_or_else(Str::default, Str::new),
	}
}

fn suggested_values(spec: &VarView<'_>) -> Option<&'static [&'static str]> {
	match spec.hint {
		Hint::Suggest(values) => Some(values),
		Hint::None | Hint::Group(_) => None,
	}
}

fn finite_values(spec: &VarView<'_>) -> Option<&'static [&'static str]> {
	match spec.ty.kind {
		ValueKind::Enum => Some(spec.ty.variants),
		ValueKind::Str => suggested_values(spec),
		ValueKind::List => match spec.ty.elem {
			Some(elem) if elem.kind == ValueKind::Enum => Some(elem.variants),
			Some(elem) if elem.kind == ValueKind::Str => suggested_values(spec),
			_ => None,
		},
		_ => None,
	}
}

fn declared_choices(spec: &VarView<'_>) -> Vec<Choice> {
	if let Some(values) = finite_values(spec) {
		let constrained = spec.metadata().any(|(key, _)| {
			key.strip_prefix("ui.option.")
				.is_some_and(|value| !value.ends_with(".desc"))
		});
		return values
			.iter()
			.copied()
			.filter(|value| {
				if !constrained {
					return true;
				}
				let label_key = sf!("ui.option.{value}");
				spec.meta_get(label_key.as_str()).is_some()
			})
			.map(|value| static_choice(spec, value))
			.collect();
	}
	spec
		.metadata()
		.filter_map(|(key, label)| {
			let value = key.strip_prefix("ui.option.")?;
			if value.ends_with(".desc") {
				return None;
			}
			let description_key = sf!("ui.option.{value}.desc");
			Some(Choice {
				value:       Str::new(value),
				label:       Str::new(label),
				description: spec
					.meta_get(description_key.as_str())
					.map_or_else(Str::default, Str::new),
			})
		})
		.collect()
}

fn runtime_choices(spec: &VarView<'_>) -> Option<RuntimeChoices> {
	match spec.meta_get("ui.choices")? {
		"themes" => Some(RuntimeChoices::Themes),
		"composer-shapes" => Some(RuntimeChoices::ComposerShapes),
		"thinking-levels" => Some(RuntimeChoices::ThinkingLevels),
		_ => None,
	}
}

fn widget(spec: &VarView<'_>) -> Option<RowWidget> {
	if spec.meta_get("ui.widget") == Some("provider-limits") {
		return (spec.ty.kind == ValueKind::Kv).then_some(RowWidget::ProviderLimits);
	}
	if let Some(source) = runtime_choices(spec) {
		return Some(RowWidget::RuntimeSubmenu(source, Vec::new()));
	}
	match spec.ty.kind {
		ValueKind::Bool => Some(RowWidget::Boolean),
		ValueKind::Enum => {
			let options = declared_choices(spec);
			(!options.is_empty()).then_some(RowWidget::Submenu(options))
		},
		ValueKind::Str => {
			let options = declared_choices(spec);
			if options.is_empty() {
				Some(RowWidget::Text { secret: spec.meta_get("ui.secret") == Some("true") })
			} else {
				Some(RowWidget::Submenu(options))
			}
		},
		ValueKind::List => {
			let options = declared_choices(spec);
			(!options.is_empty()).then_some(RowWidget::MultiSelect {
				options,
				ordered: spec.meta_get("ui.ordered") == Some("true"),
			})
		},
		ValueKind::Int | ValueKind::Float => {
			let options = declared_choices(spec);
			if options.is_empty() {
				Some(RowWidget::Text { secret: spec.meta_get("ui.secret") == Some("true") })
			} else {
				Some(RowWidget::Submenu(options))
			}
		},
		ValueKind::Duration => {
			Some(RowWidget::Text { secret: spec.meta_get("ui.secret") == Some("true") })
		},
		ValueKind::Kv => None,
	}
}

fn project_value(widget: &RowWidget, value: &Value) -> RowValue {
	match (widget, value) {
		(RowWidget::Boolean, Value::Bool(value)) => RowValue::Boolean(*value),
		(RowWidget::MultiSelect { .. }, Value::List(values)) => RowValue::Multi(
			values
				.iter()
				.filter_map(|value| value.as_str().map(Str::new))
				.collect(),
		),
		(RowWidget::ProviderLimits, Value::Kv(values)) => {
			let mut limits = values
				.iter()
				.filter_map(|(provider, value)| {
					value
						.as_int()
						.filter(|limit| *limit > 0)
						.map(|limit| (provider.clone(), limit))
				})
				.collect::<Vec<_>>();
			limits.sort_by(|left, right| left.0.cmp(&right.0));
			RowValue::ProviderLimits(limits)
		},
		(RowWidget::Text { .. }, Value::Str(value)) => RowValue::Text(value.clone()),
		(RowWidget::Text { .. }, value) => RowValue::Text(Str::new(value.to_string())),
		(_, value) => RowValue::Scalar(
			value
				.as_str()
				.map_or_else(|| Str::new(value.to_string()), Str::new),
		),
	}
}

fn raw_scalar(value: &Value) -> Str {
	match value {
		Value::Bool(value) => Str::new_static(if *value { "true" } else { "false" }),
		Value::Str(value) | Value::Enum(value) => value.clone(),
		value => Str::new(value.to_string()),
	}
}

fn initial_visibility(con: &Ctx, expression: &str) -> bool {
	match expression {
		"os=macos" => cfg!(target_os = "macos"),
		"term=images" => false,
		_ => expression
			.split_once('=')
			.and_then(|(name, expected)| con.get(name).map(|value| (value, expected)))
			.is_some_and(|(value, expected)| raw_scalar(&value) == expected),
	}
}

fn row(con: &Ctx, spec: &VarView<'_>) -> Option<SettingRow> {
	if !spec.flags.contains(VarFlags::ARCHIVE) {
		return None;
	}
	let tab = spec.meta_get("ui.tab")?.parse::<SettingTab>().ok()?;
	let group = spec.meta_get("ui.group")?;
	let label = spec.meta_get("ui.label")?;
	let tab_spec = SETTING_TABS.iter().find(|candidate| candidate.tab == tab)?;
	if label.trim().is_empty()
		|| label == spec.name
		|| label.contains("::")
		|| !tab_spec.groups.contains(&group)
	{
		return None;
	}
	let widget = widget(spec)?;
	let value = con.get(spec.name).unwrap_or_else(|| spec.default());
	let default = spec.default();
	let visibility = spec
		.meta_get("ui.when")
		.map(|expression| (Str::new(expression), initial_visibility(con, expression)));
	let description = if spec.desc.is_empty() {
		spec.meta_get("ui.description").unwrap_or_default()
	} else {
		spec.desc
	};
	Some(SettingRow {
		convar: Str::new(spec.name),
		label: Str::new(label),
		description: Str::new(description),
		warning: spec.meta_get("ui.warning").map(Str::new),
		unit: spec.meta_get("ui.unit").map(Str::new),
		tab,
		group: Str::new(group),
		value: project_value(&widget, &value),
		default: project_value(&widget, &default),
		value_kind: spec.ty.kind,
		widget,
		visibility,
	})
}

/// Projects archived declarations carrying valid `ui.tab` and `ui.group`
/// metadata into the curated chat layout.
#[must_use]
pub fn settings_rows(con: &Ctx) -> Vec<SettingRow> {
	con.vars().filter_map(|spec| row(con, &spec)).collect()
}

fn row_scalar(row: &SettingRow) -> Option<Str> {
	match &row.value {
		RowValue::Boolean(value) => Some(Str::new_static(if *value { "true" } else { "false" })),
		RowValue::Scalar(value) | RowValue::Text(value) => Some(value.clone()),
		RowValue::Multi(_) | RowValue::ProviderLimits(_) => None,
	}
}

fn visibility_matches(
	expression: &str,
	rows: &[SettingRow],
	initial: bool,
	has_image_protocol: bool,
) -> bool {
	match expression {
		"os=macos" => cfg!(target_os = "macos"),
		"term=images" => has_image_protocol,
		_ => {
			let Some((name, expected)) = expression.split_once('=') else {
				return false;
			};
			rows
				.iter()
				.find(|row| row.convar == name)
				.and_then(row_scalar)
				.map_or(initial, |value| value == expected)
		},
	}
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum Item {
	TabHeader(SettingTab),
	Row(usize),
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum Editor {
	Text {
		buffer: String,
		error:  Option<Str>,
	},
	Submenu {
		cursor: usize,
	},
	Multi {
		cursor:   usize,
		selected: Vec<Str>,
		ordered:  bool,
		pressed:  Option<Str>,
		drop:     Option<Str>,
	},
	ProviderList {
		cursor: usize,
	},
	ProviderValue {
		provider: Str,
		buffer:   String,
		error:    Option<Str>,
	},
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct PendingSetting {
	convar:          Str,
	index:           usize,
	previous:        RowValue,
	rejected_editor: Option<Editor>,
}

/// Retained curated settings selector.
pub struct SettingsPanel {
	rows:               Vec<SettingRow>,
	tab:                usize,
	pre_search_tab:     usize,
	query:              String,
	query_cursor:       usize,
	items:              Vec<Item>,
	selected:           usize,
	scroll:             usize,
	list_rows:          usize,
	section_focus:      bool,
	section_cursor:     usize,
	editor:             Option<Editor>,
	pending:            Option<PendingSetting>,
	providers:          Vec<Str>,
	has_image_protocol: bool,
	ui:                 Ui,
	ctx:                UiContext,
	width:              u16,
	height:             u16,
}

impl SettingsPanel {
	/// Opens the selector over explicit product metadata.
	pub fn open(cx: &PanelCx<'_>) -> Result<Self, Str> {
		let rows = settings_rows(cx.con);
		if rows.is_empty() {
			return Err(Str::new_static("No curated settings are registered"));
		}
		let inventory = cx.services.settings_inventory().unwrap_or_default();
		Ok(Self::from_rows_with_inventory(rows, inventory, cx.ui))
	}

	#[cfg(test)]
	#[must_use]
	fn from_rows(rows: Vec<SettingRow>, ctx: &UiContext) -> Self {
		Self::from_rows_with_inventory(rows, SettingsInventory::default(), ctx)
	}

	#[must_use]
	fn from_rows_with_inventory(
		mut rows: Vec<SettingRow>,
		inventory: SettingsInventory,
		ctx: &UiContext,
	) -> Self {
		const COMPOSER_SHAPES: &[(&str, &str, &str)] = &[
			(
				"band",
				"Status Band (Default)",
				"Flush soft-capped status band above a curved prompt, no frame",
			),
			("box", "Rounded Box", "Status line embedded in top border, compact 2-line prompt"),
			(
				"claude",
				"Claude Code",
				"Full-width horizontal rules above and below, status line at bottom",
			),
			("pi", "Pi", "Framed horizontal rules with status line at bottom"),
			(
				"borderless",
				"Borderless",
				"Clean prompt glyph with status line at bottom, no box borders",
			),
			("rule", "Top Rule Dock", "Single top rule with status docked onto it and below"),
			("field", "Compact Field", "Filled one-row field with accent end caps"),
			("rail", "Accent Rail", "Filled one-row field anchored by a single accent rail"),
		];
		for row in &mut rows {
			let RowWidget::RuntimeSubmenu(source, options) = &mut row.widget else {
				continue;
			};
			let runtime = match source {
				RuntimeChoices::Themes => &inventory.themes,
				RuntimeChoices::ComposerShapes => &inventory.composer_shapes,
				RuntimeChoices::ThinkingLevels => &inventory.thinking_levels,
			};
			options.extend(runtime.iter().map(Choice::from));
			if *source == RuntimeChoices::ComposerShapes {
				for &(value, label, description) in COMPOSER_SHAPES {
					if !options.iter().any(|candidate| candidate.value == value) {
						options.push(Choice {
							value:       Str::new_static(value),
							label:       Str::new_static(label),
							description: Str::new_static(description),
						});
					}
				}
			}
			if *source != RuntimeChoices::ThinkingLevels {
				for value in [&row.value, &row.default] {
					let RowValue::Scalar(value) = value else {
						continue;
					};
					if !value.is_empty() && !options.iter().any(|option| option.value == *value) {
						options.push(Choice {
							value:       value.clone(),
							label:       value.clone(),
							description: Str::default(),
						});
					}
				}
			}
		}
		let mut panel = Self {
			rows,
			tab: 0,
			pre_search_tab: 0,
			query: String::new(),
			query_cursor: 0,
			items: Vec::new(),
			selected: 0,
			scroll: 0,
			list_rows: 10,
			section_focus: false,
			section_cursor: 0,
			editor: None,
			pending: None,
			providers: inventory.providers,
			has_image_protocol: !matches!(ctx.graphics, omp_tui::Graphics::Cells),
			ui: Ui::from_root(dom! { <col/> }, 80, ctx.clone()),
			ctx: ctx.clone(),
			width: 80,
			height: 24,
		};
		panel.reflow_items();
		panel.rebuild();
		panel
	}

	fn tab(&self) -> SettingTab {
		SETTING_TABS[self.tab].tab
	}

	fn selected(&self) -> Option<&SettingRow> {
		match self.items.get(self.selected)? {
			Item::Row(index) => self.rows.get(*index),
			Item::TabHeader(_) => None,
		}
	}

	fn visible_groups(&self) -> Vec<&'static str> {
		SETTING_TABS[self.tab]
			.groups
			.iter()
			.copied()
			.filter(|group| !self.matching_indices(self.tab(), group).is_empty())
			.collect()
	}

	fn sync_section_to_selection(&mut self) {
		let Some(group) = self.selected().map(|row| row.group.clone()) else {
			return;
		};
		self.section_cursor = self
			.visible_groups()
			.iter()
			.position(|candidate| *candidate == group.as_str())
			.unwrap_or(0);
	}

	fn move_section(&mut self, delta: isize) {
		let groups = self.visible_groups();
		if groups.is_empty() {
			return;
		}
		self.section_cursor =
			(self.section_cursor as isize + delta.signum()).rem_euclid(groups.len() as isize) as usize;
		let group = groups[self.section_cursor];
		if let Some(index) = self
			.items
			.iter()
			.position(|item| matches!(item, Item::Row(row) if self.rows[*row].group == group))
		{
			self.selected = index;
			self.clamp_scroll();
		}
	}

	fn row_visible(&self, row: &SettingRow) -> bool {
		row.visibility.as_ref().is_none_or(|(expression, initial)| {
			visibility_matches(expression, &self.rows, *initial, self.has_image_protocol)
		})
	}

	fn matching_indices(&self, tab: SettingTab, group: &str) -> Vec<usize> {
		self
			.rows
			.iter()
			.enumerate()
			.filter(|(_, row)| row.tab == tab && row.group == group && self.row_visible(row))
			.map(|(index, _)| index)
			.collect()
	}

	fn search_matches(&self, tab: SettingTab) -> Vec<(i32, usize)> {
		let mut matched = self
			.rows
			.iter()
			.enumerate()
			.filter(|(_, row)| row.tab == tab && self.row_visible(row))
			.filter_map(|(index, row)| {
				let mut text = StrMut::new(row.label.as_str());
				text.push(' ');
				text.push_str(&row.display());
				text.push(' ');
				text.push_str(&row.description);
				if let Some(warning) = &row.warning {
					text.push(' ');
					text.push_str(warning);
				}
				omp_tui::fuzzy::fuzzy_match(&self.query, text.as_str()).map(|score| (score, index))
			})
			.collect::<Vec<_>>();
		matched.sort_by_key(|(score, index)| (*score, *index));
		matched
	}

	fn reflow_items(&mut self) {
		self.items.clear();
		let searching = !self.query.is_empty();
		if searching {
			let mut tabs = SETTING_TABS
				.iter()
				.enumerate()
				.filter_map(|(order, tab)| {
					let matched = self.search_matches(tab.tab);
					let score = matched.first().map(|(score, _)| *score)?;
					Some((score, order, tab.tab, matched))
				})
				.collect::<Vec<_>>();
			tabs.sort_by_key(|(score, order, ..)| (*score, *order));
			for (_, _, tab, matched) in tabs {
				self.items.push(Item::TabHeader(tab));
				self
					.items
					.extend(matched.into_iter().map(|(_, index)| Item::Row(index)));
			}
		} else {
			let tab = SETTING_TABS[self.tab];
			for group in tab.groups {
				let indices = self.matching_indices(tab.tab, group);
				if indices.is_empty() {
					continue;
				}
				self.items.extend(indices.into_iter().map(Item::Row));
			}
		}
		self.selected = self
			.items
			.iter()
			.position(|item| matches!(item, Item::Row(_)))
			.unwrap_or(0);
		self.scroll = 0;
		self.clamp_scroll();
		self.sync_tab_to_selection();
		self.sync_section_to_selection();
	}

	fn clamp_scroll(&mut self) {
		if self.selected < self.scroll {
			self.scroll = self.selected;
		} else if self.selected >= self.scroll + self.list_rows {
			self.scroll = self.selected + 1 - self.list_rows;
		}
		self.scroll = self
			.scroll
			.min(self.items.len().saturating_sub(self.list_rows));
	}

	fn move_selection(&mut self, delta: isize) -> bool {
		if self.items.is_empty() || delta == 0 {
			return false;
		}
		let mut next = self.selected;
		let mut last = self.selected;
		let mut moved = 0;
		while moved < delta.unsigned_abs() {
			let Some(candidate) = next.checked_add_signed(delta.signum()) else {
				break;
			};
			if candidate >= self.items.len() {
				break;
			}
			next = candidate;
			if matches!(self.items[next], Item::Row(_)) {
				last = next;
				moved += 1;
			}
		}
		if last == self.selected {
			return false;
		}
		self.selected = last;
		self.clamp_scroll();
		true
	}

	fn switch_tab(&mut self, delta: isize) {
		if self.query.is_empty() {
			let len = SETTING_TABS.len() as isize;
			self.tab = ((self.tab as isize + delta).rem_euclid(len)) as usize;
			self.section_focus = false;
			self.reflow_items();
			return;
		}
		let headers = self
			.items
			.iter()
			.enumerate()
			.filter_map(|(index, item)| match item {
				Item::TabHeader(tab) => Some((index, *tab)),
				Item::Row(_) => None,
			})
			.collect::<Vec<_>>();
		if headers.is_empty() {
			return;
		}
		let current = headers
			.iter()
			.position(|(_, tab)| *tab == self.tab())
			.unwrap_or(0);
		let next = (current as isize + delta.signum()).rem_euclid(headers.len() as isize) as usize;
		let (index, tab) = headers[next];
		self.tab = SETTING_TABS
			.iter()
			.position(|candidate| candidate.tab == tab)
			.unwrap_or(self.tab);
		self.selected = self.items[index + 1..]
			.iter()
			.position(|item| matches!(item, Item::Row(_)))
			.map_or(index, |offset| index + 1 + offset);
		self.clamp_scroll();
	}

	fn sync_tab_to_selection(&mut self) {
		if let Some(row) = self.selected()
			&& let Some(index) = SETTING_TABS.iter().position(|tab| tab.tab == row.tab)
		{
			self.tab = index;
		}
	}

	fn select_tab(&mut self, tab: usize) {
		if tab >= SETTING_TABS.len() || tab == self.tab {
			return;
		}
		self.tab = tab;
		if self.query.is_empty() {
			self.reflow_items();
		} else {
			self.switch_tab(0);
		}
		self.rebuild();
	}

	fn sync_pointer_tab(&mut self) {
		let values = self.ui.values();
		let Some(label) = values.get("settings-tabs").and_then(|value| value.as_str()) else {
			return;
		};
		if let Some(index) = SETTING_TABS
			.iter()
			.position(|tab| label == tab.label || label.starts_with(&format!("{} (", tab.label)))
		{
			self.select_tab(index);
		}
	}

	fn end_search(&mut self, jump_to_selection: bool) {
		let keep = jump_to_selection
			.then(|| self.selected().map(|row| row.convar.clone()))
			.flatten();
		if !jump_to_selection {
			self.tab = self.pre_search_tab;
		}
		self.query.clear();
		self.query_cursor = 0;
		self.reflow_items();
		if let Some(keep) = keep
			&& let Some(index) = self
				.items
				.iter()
				.position(|item| matches!(item, Item::Row(row) if self.rows[*row].convar == keep))
		{
			self.selected = index;
			self.clamp_scroll();
		}
	}

	fn activate(&mut self) -> PanelEvent {
		let Some(Item::Row(index)) = self.items.get(self.selected).cloned() else {
			return PanelEvent::Consumed;
		};
		match &self.rows[index].widget {
			RowWidget::Boolean => {
				let RowValue::Boolean(value) = self.rows[index].value else {
					return PanelEvent::Consumed;
				};
				self.commit(index, RowValue::Boolean(!value))
			},
			RowWidget::Submenu(options) | RowWidget::RuntimeSubmenu(_, options) => {
				let current = match &self.rows[index].value {
					RowValue::Scalar(value) => value,
					_ => return PanelEvent::Consumed,
				};
				let cursor = options
					.iter()
					.position(|option| option.value == *current)
					.unwrap_or(0);
				self.editor = Some(Editor::Submenu { cursor });
				self.rebuild();
				PanelEvent::Consumed
			},
			RowWidget::ProviderLimits => {
				if let RowValue::ProviderLimits(limits) = &self.rows[index].value {
					for (provider, _) in limits {
						if !self.providers.contains(provider) {
							self.providers.push(provider.clone());
						}
					}
				}
				self.providers.sort();
				self.providers.dedup();
				self.editor = Some(Editor::ProviderList { cursor: 0 });
				self.rebuild();
				PanelEvent::Consumed
			},
			RowWidget::Text { .. } => {
				self.editor = Some(Editor::Text { buffer: self.rows[index].editable(), error: None });
				self.rebuild();
				PanelEvent::Consumed
			},
			RowWidget::MultiSelect { options, ordered } => {
				let selected = match &self.rows[index].value {
					RowValue::Multi(value) => value
						.iter()
						.filter(|selected| {
							options
								.iter()
								.any(|option| option.value.as_str() == selected.as_str())
						})
						.cloned()
						.collect(),
					_ => Vec::new(),
				};
				self.editor = Some(Editor::Multi {
					cursor: 0,
					selected,
					ordered: *ordered,
					pressed: None,
					drop: None,
				});
				self.rebuild();
				PanelEvent::Consumed
			},
		}
	}

	fn command_value(row: &SettingRow, value: &RowValue) -> Result<Str, Str> {
		match value {
			RowValue::Boolean(value) => Ok(Str::new_static(if *value { "true" } else { "false" })),
			RowValue::Scalar(value) => Ok(value.clone()),
			RowValue::Text(value) if row.value_kind == ValueKind::Str => {
				Ok(Str::new(Value::Str(value.clone()).to_string()))
			},
			RowValue::Text(value) => Ok(value.clone()),
			RowValue::Multi(values) => {
				let mut text = StrMut::new("[");
				for (index, value) in values.iter().enumerate() {
					if index > 0 {
						text.push(' ')
					}
					let _ = write!(text, "{}", Value::Str(value.clone()));
				}
				text.push(']');
				Ok(text.freeze())
			},
			RowValue::ProviderLimits(limits) => {
				let value = Value::Kv(omp_con::Kv(
					limits
						.iter()
						.map(|(provider, limit)| (provider.clone(), Value::Int(*limit)))
						.collect(),
				));
				Ok(Str::new(value.to_string()))
			},
		}
	}

	fn show_editor_error(&mut self, error: Str) -> PanelEvent {
		let inline = match self.editor.as_mut() {
			Some(Editor::Text { error: shown, .. })
			| Some(Editor::ProviderValue { error: shown, .. }) => {
				*shown = Some(error.clone());
				true
			},
			_ => false,
		};
		if inline {
			let _ = self.ui.set_text("settings-editor-error", error);
			PanelEvent::Consumed
		} else {
			PanelEvent::Notice(error)
		}
	}

	fn stage_commit(&mut self, index: usize, value: RowValue, close_editor: bool) -> PanelEvent {
		if self.pending.is_some() {
			return PanelEvent::Consumed;
		}
		if self.rows[index].value == value {
			if close_editor {
				self.editor = None;
				self.rebuild();
			}
			return PanelEvent::Consumed;
		}
		let command = match Self::command_value(&self.rows[index], &value) {
			Ok(command) => command,
			Err(error) => return self.show_editor_error(error),
		};
		let convar = self.rows[index].convar.clone();
		self.pending = Some(PendingSetting {
			convar: convar.clone(),
			index,
			previous: self.rows[index].value.clone(),
			rejected_editor: self.editor.clone(),
		});
		self.rows[index].value = value;
		if close_editor {
			self.editor = None;
			self.reflow_items();
		}
		self.rebuild();
		PanelEvent::RunSetting { convar: convar.clone(), line: sf!("{convar} {command}; writecfg") }
	}

	fn commit(&mut self, index: usize, value: RowValue) -> PanelEvent {
		self.stage_commit(index, value, true)
	}

	fn commit_live(&mut self, index: usize, value: RowValue) -> PanelEvent {
		self.stage_commit(index, value, false)
	}

	fn settle_setting(&mut self, convar: &str, error: Option<&str>) -> PanelEvent {
		if self
			.pending
			.as_ref()
			.is_none_or(|pending| pending.convar != convar)
		{
			return PanelEvent::Ignored;
		}
		let pending = self.pending.take().expect("matching pending setting");
		let Some(message) = error else {
			return PanelEvent::Consumed;
		};
		self.rows[pending.index].value = pending.previous.clone();
		self.editor = pending.rejected_editor;
		if let (Some(Editor::Multi { selected, .. }), RowValue::Multi(previous)) =
			(self.editor.as_mut(), pending.previous)
		{
			*selected = previous;
		}
		self.reflow_items();
		if let Some(selected) = self
			.items
			.iter()
			.position(|item| matches!(item, Item::Row(index) if *index == pending.index))
		{
			self.selected = selected;
			self.clamp_scroll();
		}
		if self.editor.is_some() {
			self.rebuild();
			self.show_editor_error(Str::new(message))
		} else {
			self.rebuild();
			PanelEvent::Notice(Str::new(message))
		}
	}

	fn previewable(row: &SettingRow) -> bool {
		matches!(
			row.convar.as_str(),
			"cl_theme_dark"
				| "cl_theme_light"
				| "cl_composer_shape"
				| "cl_status_line_preset"
				| "cl_status_line_separator"
				| "cl_status_line_context_line"
		)
	}

	fn preview_event(&self, index: usize, cursor: usize) -> PanelEvent {
		let row = &self.rows[index];
		let (RowWidget::Submenu(options) | RowWidget::RuntimeSubmenu(_, options)) = &row.widget
		else {
			return PanelEvent::Consumed;
		};
		if !Self::previewable(row) || options.is_empty() {
			return PanelEvent::Consumed;
		}
		PanelEvent::PreviewSetting {
			convar: row.convar.clone(),
			value:  options[cursor.min(options.len() - 1)].value.clone(),
		}
	}

	fn apply_editor_event(&mut self, event: UiEvent) -> PanelEvent {
		let UiEvent::Changed { id, value } = event else {
			return PanelEvent::Consumed;
		};
		if id != "settings-editor-input" {
			return PanelEvent::Consumed;
		}
		match self.editor.as_mut() {
			Some(Editor::Text { buffer, error })
			| Some(Editor::ProviderValue { buffer, error, .. }) => {
				buffer.clear();
				buffer.push_str(&value);
				*error = None;
				let _ = self.ui.set_text("settings-editor-error", "");
			},
			_ => {},
		}
		PanelEvent::Consumed
	}

	fn route_editor_input(&mut self, key: Key) -> PanelEvent {
		let event = self.ui.handle_key(key);
		self.apply_editor_event(event)
	}

	fn ordered_multi_choice_at(&mut self, col: u16, row: u16) -> Option<usize> {
		if let Some(index) = self
			.ui
			.id_at(col, row)
			.as_deref()
			.and_then(|id| id.strip_prefix("setting-choice-"))
			.and_then(|index| index.parse::<usize>().ok())
		{
			return Some(index);
		}
		let cursor = match self.editor.as_ref()? {
			Editor::Multi { cursor, ordered: true, .. } => *cursor,
			_ => return None,
		};
		let Item::Row(row_index) = *self.items.get(self.selected)? else {
			return None;
		};
		let RowWidget::MultiSelect { options, ordered: true } = &self.rows[row_index].widget else {
			return None;
		};
		let start = cursor
			.saturating_sub(11)
			.min(options.len().saturating_sub(12));
		(start..options.len().min(start + 12)).find(|index| {
			let id = sf!("setting-choice-{index}");
			self.ui.rect(&id).is_some_and(|rect| {
				col >= rect.x
					&& col < rect.x.saturating_add(rect.width)
					&& row >= rect.y
					&& row < rect.y.saturating_add(rect.height)
			})
		})
	}

	fn ordered_multi_pointer(
		&mut self,
		option_index: Option<usize>,
		report: MouseReport,
	) -> Option<PanelEvent> {
		let Item::Row(row_index) = *self.items.get(self.selected)? else {
			return None;
		};
		let RowWidget::MultiSelect { options, ordered: true } = &self.rows[row_index].widget else {
			return None;
		};
		let option = option_index.and_then(|index| {
			options
				.get(index)
				.map(|option| (index, option.value.clone()))
		});
		let Some(Editor::Multi { cursor, selected, pressed, drop, .. }) = self.editor.as_mut() else {
			return None;
		};
		match (report.kind, report.button, report.pressed) {
			(omp_tui::Mouse::Click, omp_tui::MouseButton::Left, true) => {
				let Some((index, value)) = option else {
					return Some(PanelEvent::Consumed);
				};
				*cursor = index;
				*pressed = Some(value.clone());
				*drop = Some(value);
				let id = sf!("setting-choice-{index}");
				let _ = self.ui.focus_id(&id);
				Some(PanelEvent::Consumed)
			},
			(omp_tui::Mouse::Drag, omp_tui::MouseButton::Left, true) => {
				let Some((_, target)) = option else {
					return Some(PanelEvent::Consumed);
				};
				if pressed.as_ref().is_some_and(|pressed| {
					pressed != &target && selected.contains(pressed) && selected.contains(&target)
				}) {
					*drop = Some(target);
				}
				Some(PanelEvent::Consumed)
			},
			(omp_tui::Mouse::Release, omp_tui::MouseButton::Left, false) => {
				let Some(pressed) = pressed.take() else {
					return Some(PanelEvent::Consumed);
				};
				let drop = drop.take();
				if let Some(drop) = drop.filter(|drop| drop != &pressed) {
					let mut next = selected
						.iter()
						.filter(|value| value.as_str() != pressed.as_str())
						.cloned()
						.collect::<Vec<_>>();
					if let Some(target) = next.iter().position(|value| *value == drop) {
						next.insert(target, pressed);
						*selected = next;
					}
				} else if let Some(at) = selected.iter().position(|value| *value == pressed) {
					selected.remove(at);
				} else {
					selected.push(pressed);
				}
				let value = RowValue::Multi(selected.clone());
				Some(self.commit_live(row_index, value))
			},
			_ => Some(PanelEvent::Consumed),
		}
	}

	fn text_editor_key(&mut self, index: usize, key: Key) -> PanelEvent {
		match key {
			Key::Esc => {
				self.editor = None;
				self.rebuild();
				PanelEvent::Consumed
			},
			Key::Enter => {
				let value = match self.editor.as_ref() {
					Some(Editor::Text { buffer, .. }) => RowValue::Text(Str::new(buffer.trim())),
					_ => return PanelEvent::Consumed,
				};
				self.commit(index, value)
			},
			_ => self.route_editor_input(key),
		}
	}

	fn provider_editor_key(&mut self, index: usize, key: Key) -> PanelEvent {
		match key {
			Key::Esc => {
				self.editor = Some(Editor::ProviderList { cursor: 0 });
				self.rebuild();
				PanelEvent::Consumed
			},
			Key::Enter => {
				let (provider, buffer) = match self.editor.as_ref() {
					Some(Editor::ProviderValue { provider, buffer, .. }) => {
						(provider.clone(), buffer.clone())
					},
					_ => return PanelEvent::Consumed,
				};
				let trimmed = buffer.trim();
				let parsed = if trimmed.is_empty() {
					None
				} else {
					match trimmed.parse::<f64>() {
						Ok(limit) if limit.is_finite() && limit > 0.0 => {
							Some((limit.floor() as i64).max(1))
						},
						_ => {
							return self
								.show_editor_error(Str::new_static("Limit must be a positive number."));
						},
					}
				};
				let mut limits = match &self.rows[index].value {
					RowValue::ProviderLimits(limits) => limits.clone(),
					_ => Vec::new(),
				};
				limits.retain(|(name, _)| *name != provider);
				if let Some(limit) = parsed {
					limits.push((provider, limit));
					limits.sort_by(|left, right| left.0.cmp(&right.0));
				}
				self.editor = Some(Editor::ProviderList { cursor: 0 });
				self.commit_live(index, RowValue::ProviderLimits(limits))
			},
			_ => self.route_editor_input(key),
		}
	}

	fn editor_key(&mut self, key: Key) -> PanelEvent {
		let Some(Item::Row(index)) = self.items.get(self.selected).cloned() else {
			return PanelEvent::Consumed;
		};
		if matches!(self.editor.as_ref(), Some(Editor::Text { .. })) {
			return self.text_editor_key(index, key);
		}
		if matches!(self.editor.as_ref(), Some(Editor::ProviderValue { .. })) {
			return self.provider_editor_key(index, key);
		}
		match self.editor.as_mut() {
			Some(Editor::Submenu { cursor }) => {
				let (RowWidget::Submenu(options) | RowWidget::RuntimeSubmenu(_, options)) =
					&self.rows[index].widget
				else {
					return PanelEvent::Consumed;
				};
				match key {
					Key::Esc => {
						let previewed = Self::previewable(&self.rows[index]);
						let convar = self.rows[index].convar.clone();
						self.editor = None;
						self.rebuild();
						if previewed {
							PanelEvent::CancelSettingPreview { convar }
						} else {
							PanelEvent::Consumed
						}
					},
					Key::Up => {
						*cursor = cursor.saturating_sub(1);
						let cursor = *cursor;
						self.rebuild();
						self.preview_event(index, cursor)
					},
					Key::Down => {
						*cursor = (*cursor + 1).min(options.len().saturating_sub(1));
						let cursor = *cursor;
						self.rebuild();
						self.preview_event(index, cursor)
					},
					Key::Enter if !options.is_empty() => {
						let value = options[*cursor].value.clone();
						self.editor = None;
						self.commit(index, RowValue::Scalar(value))
					},
					_ => PanelEvent::Consumed,
				}
			},
			Some(Editor::Multi { cursor, selected, ordered, .. }) => {
				let RowWidget::MultiSelect { options, .. } = &self.rows[index].widget else {
					return PanelEvent::Consumed;
				};
				match key {
					Key::Esc => {
						self.editor = None;
						self.rebuild();
						PanelEvent::Consumed
					},
					Key::Up => {
						*cursor = cursor.saturating_sub(1);
						self.rebuild();
						PanelEvent::Consumed
					},
					Key::Down => {
						*cursor = (*cursor + 1).min(options.len().saturating_sub(1));
						self.rebuild();
						PanelEvent::Consumed
					},
					Key::Space | Key::Enter if !options.is_empty() => {
						let value = &options[*cursor].value;
						if let Some(at) = selected.iter().position(|item| item == value) {
							selected.remove(at);
						} else {
							selected.push(value.clone());
						}
						let value = RowValue::Multi(selected.clone());
						self.commit_live(index, value)
					},
					Key::Left | Key::Right if *ordered && !options.is_empty() => {
						let value = &options[*cursor].value;
						if let Some(at) = selected.iter().position(|item| item == value) {
							let next = if key == Key::Left {
								at.saturating_sub(1)
							} else {
								(at + 1).min(selected.len() - 1)
							};
							selected.swap(at, next);
						}
						let value = RowValue::Multi(selected.clone());
						self.commit_live(index, value)
					},
					Key::Char(character @ '1'..='9') if *ordered && !options.is_empty() => {
						let value = options[*cursor].value.clone();
						selected.retain(|item| item != &value);
						let position = character.to_digit(10).unwrap_or(1) as usize;
						selected.insert(position.saturating_sub(1).min(selected.len()), value);
						let value = RowValue::Multi(selected.clone());
						self.commit_live(index, value)
					},
					_ => PanelEvent::Consumed,
				}
			},
			Some(Editor::ProviderList { cursor }) => {
				let limits = match &self.rows[index].value {
					RowValue::ProviderLimits(limits) => limits,
					_ => return PanelEvent::Consumed,
				};
				let clear = !limits.is_empty();
				let choices = self.providers.len() + usize::from(clear);
				match key {
					Key::Esc => {
						self.editor = None;
						self.rebuild();
						PanelEvent::Consumed
					},
					Key::Up => {
						*cursor = cursor.saturating_sub(1);
						self.rebuild();
						PanelEvent::Consumed
					},
					Key::Down => {
						*cursor = (*cursor + 1).min(choices.saturating_sub(1));
						self.rebuild();
						PanelEvent::Consumed
					},
					Key::Enter if clear && *cursor == self.providers.len() => {
						*cursor = 0;
						self.commit_live(index, RowValue::ProviderLimits(Vec::new()))
					},
					Key::Enter if *cursor < self.providers.len() => {
						let provider = self.providers[*cursor].clone();
						let buffer = limits
							.iter()
							.find(|(name, _)| *name == provider)
							.map(|(_, limit)| limit.to_string())
							.unwrap_or_default();
						self.editor = Some(Editor::ProviderValue { provider, buffer, error: None });
						self.rebuild();
						PanelEvent::Consumed
					},
					_ => PanelEvent::Consumed,
				}
			},
			Some(Editor::Text { .. } | Editor::ProviderValue { .. }) => PanelEvent::Consumed,
			None => PanelEvent::Consumed,
		}
	}

	fn insert_query(&mut self, text: &str) {
		if self.query.is_empty() {
			self.pre_search_tab = self.tab;
		}
		self.query_cursor = self.query_cursor.min(self.query.len());
		while !self.query.is_char_boundary(self.query_cursor) {
			self.query_cursor = self.query_cursor.saturating_sub(1);
		}
		self.query.insert_str(self.query_cursor, text);
		self.query_cursor += text.len();
		self.reflow_items();
	}

	fn query_left(&mut self) {
		if self.query_cursor == 0 {
			return;
		}
		self.query_cursor = self.query[..self.query_cursor]
			.char_indices()
			.next_back()
			.map_or(0, |(index, _)| index);
	}

	fn query_right(&mut self) {
		if self.query_cursor >= self.query.len() {
			return;
		}
		self.query_cursor += self.query[self.query_cursor..]
			.chars()
			.next()
			.map_or(0, char::len_utf8);
	}

	fn query_backspace(&mut self) {
		if self.query_cursor == 0 {
			return;
		}
		let previous = self.query[..self.query_cursor]
			.char_indices()
			.next_back()
			.map_or(0, |(index, _)| index);
		self.query.drain(previous..self.query_cursor);
		self.query_cursor = previous;
		if self.query.is_empty() {
			self.end_search(false);
		} else {
			self.reflow_items();
		}
	}

	fn query_word_backspace(&mut self) {
		if self.query_cursor == 0 {
			return;
		}
		let before = &self.query[..self.query_cursor];
		let trimmed = before.trim_end_matches(char::is_whitespace);
		let start = trimmed
			.char_indices()
			.rev()
			.find(|(_, character)| character.is_whitespace())
			.map_or(0, |(index, character)| index + character.len_utf8());
		self.query.drain(start..self.query_cursor);
		self.query_cursor = start;
		if self.query.is_empty() {
			self.end_search(false);
		} else {
			self.reflow_items();
		}
	}

	fn tab_strip(&self) -> (Tabs, u16) {
		let mut ordered = if self.query.is_empty() {
			SETTING_TABS
				.iter()
				.map(|tab| (tab.tab, tab.label.to_owned(), false))
				.collect::<Vec<_>>()
		} else {
			let mut matched = SETTING_TABS
				.iter()
				.enumerate()
				.filter_map(|(order, tab)| {
					let rows = self.search_matches(tab.tab);
					rows.first().map(|(score, _)| {
						(*score, order, tab.tab, format!("{} ({})", tab.label, rows.len()))
					})
				})
				.collect::<Vec<_>>();
			matched.sort_by_key(|(score, order, ..)| (*score, *order));
			let matched_tabs = matched
				.iter()
				.map(|(_, _, tab, _)| *tab)
				.collect::<Vec<_>>();
			let mut ordered = matched
				.into_iter()
				.map(|(_, _, tab, label)| (tab, label, false))
				.collect::<Vec<_>>();
			ordered.extend(
				SETTING_TABS
					.iter()
					.filter(|tab| !matched_tabs.contains(&tab.tab))
					.map(|tab| (tab.tab, tab.label.to_owned(), true)),
			);
			ordered
		};
		let selected = ordered
			.iter()
			.position(|(tab, ..)| *tab == self.tab())
			.unwrap_or(0) as u16;
		let mut tabs = Tabs::new().with_str(Prop::Id, "settings-tabs");
		for (tab, label, muted) in ordered.drain(..) {
			let icon = SETTING_TABS
				.iter()
				.find(|spec| spec.tab == tab)
				.map_or("tab.appearance", |spec| spec.icon);
			tabs = tabs.pane_icon_muted(icon, label, muted, dom! { <col/> });
		}
		(tabs, selected)
	}

	fn rebuild(&mut self) {
		if self.editor.is_some() {
			self.rebuild_editor();
			return;
		}
		let inner = usize::from(self.width.saturating_sub(4).max(20));
		let list_rows = usize::from(self.height.saturating_sub(CHROME_ROWS).max(3));
		if list_rows != self.list_rows {
			self.list_rows = list_rows;
			self.clamp_scroll();
		}
		let label_width = self
			.rows
			.iter()
			.map(|row| usize::from(cell_width(&row.label)))
			.max()
			.unwrap_or(8)
			.clamp(8, inner.saturating_sub(24).max(8));
		let mut list = self
			.items
			.iter()
			.enumerate()
			.skip(self.scroll)
			.take(self.list_rows)
			.map(|(index, item)| self.list_row(item, index, index == self.selected, label_width))
			.collect::<Vec<_>>();
		let empty = self.items.is_empty();
		let shown = list.len() + usize::from(empty);
		list.extend(
			std::iter::repeat_with(|| dom! { <text>{" "}</text> }.into_component())
				.take(self.list_rows.saturating_sub(shown)),
		);
		let searching = !self.query.is_empty();
		self.query_cursor = self.query_cursor.min(self.query.len());
		while !self.query.is_char_boundary(self.query_cursor) {
			self.query_cursor = self.query_cursor.saturating_sub(1);
		}
		let query_before = Str::new(&self.query[..self.query_cursor]);
		let query_after = Str::new(&self.query[self.query_cursor..]);
		let description = self
			.selected()
			.map(|row| row.description.clone())
			.unwrap_or_default();
		let warning = self.selected().and_then(|row| row.warning.clone());
		let (tabs, tab_selection) = self.tab_strip();
		let tabs = tabs.select(tab_selection);
		let match_count = self
			.items
			.iter()
			.filter(|item| matches!(item, Item::Row(_)))
			.count();
		let match_label = if match_count == 1 {
			Str::new_static("1 match")
		} else {
			sf!("{match_count} matches")
		};
		let groups = self.visible_groups();
		let sidebar_width = SETTING_TABS
			.iter()
			.flat_map(|tab| tab.groups.iter())
			.map(|group| cell_width(group))
			.max()
			.unwrap_or(0)
			.min(22)
			.saturating_add(4);
		let body_width = self.width.saturating_sub(sidebar_width + 5).max(20);
		let mut sidebar = groups
			.iter()
			.enumerate()
			.map(|(index, group)| {
				let id = sf!("setting-group-{index}");
				let active = index == self.section_cursor;
				if active && self.section_focus {
					dom! { <row id={id} focus bg=surface><text bold fg=accent>{"› "}{*group}</text></row> }
						.into_component()
				} else if active {
					dom! { <row id={id} focus><text fg=accent>{"  "}{*group}</text></row> }
						.into_component()
				} else {
					dom! { <row id={id} focus><text fg=muted>{"  "}{*group}</text></row> }
						.into_component()
				}
			})
			.collect::<Vec<_>>();
		sidebar.extend(
			std::iter::repeat_with(|| dom! { <text>{" "}</text> }.into_component())
				.take(self.list_rows.saturating_sub(sidebar.len())),
		);
		let footer = if searching {
			"Enter to change · Tab to jump tabs · Esc to exit search"
		} else if self.section_focus {
			"↑/↓ to jump sections · Tab/Enter to settings · ←/→ to switch tabs · Esc to close"
		} else if groups.len() > 1 {
			"Enter/Space to change · Tab to jump sections · ←/→ to switch tabs · Type to search · Esc \
			 to close"
		} else {
			"Enter/Space to change · Tab to switch tabs · Type to search · Esc to close"
		};
		self.ui = Ui::from_root(
			dom! {
				<box border=round title="Settings">
					<col>
						{tabs}
						if searching { <row gap=1><text fg=accent>{"⌕"}</text><row><text bold>{query_before}</text><text fg=accent>{"_"}</text><text bold>{query_after}</text></row><text fg=muted>{match_label}</text></row> }
						else { <text fg=muted>{"Type to search labels, values, and descriptions"}</text> }
						<text>{" "}</text>
						if empty { <text fg=muted truncate>{"  No settings match."}</text> }
						if searching {
							for row in list { {row} }
						} else {
							<row gap=1>
								<col w={sidebar_width}>for row in sidebar { {row} }</col>
								<hr vertical border=round fg=muted/>
								<col w={body_width}>for row in list { {row} }</col>
							</row>
						}
						<hr border=round/>
						<col h=3>
							<text fg=muted wrap=word>{description}</text>
							if let Some(warning) = warning { <text fg=warn wrap=word>{warning}</text> }
						</col>
						<text fg=muted truncate>{footer}</text>
					</col>
				</box>
			},
			self.width,
			self.ctx.clone(),
		);
	}

	fn rebuild_editor(&mut self) {
		let Some(row) = self.selected() else { return };
		let mut title = row.label.clone();
		let mut description = row.description.clone();
		let (lines, footer): (Vec<Box<dyn Component>>, &'static str) = match self
			.editor
			.as_ref()
			.expect("checked")
		{
			Editor::Text { buffer, error } => {
				let mut input = Input::new()
					.with_str(Prop::Id, "settings-editor-input")
					.with_str(Prop::Value, buffer);
				if matches!(row.widget, RowWidget::Text { secret: true }) {
					input = input.with(Prop::Mask, true);
				}
				(
					vec![
						Box::new(input) as Box<dyn Component>,
						dom! { <text id="settings-editor-error" fg=error truncate>{error.clone().unwrap_or_default()}</text> }
							.into_component(),
					],
					TEXT_FOOTER,
				)
			},
			Editor::Submenu { cursor } => {
				let (RowWidget::Submenu(options) | RowWidget::RuntimeSubmenu(_, options)) = &row.widget
				else {
					return;
				};
				let start = cursor
					.saturating_sub(9)
					.min(options.len().saturating_sub(10));
				(options
					.iter()
					.enumerate()
					.skip(start)
					.take(10)
					.map(|(index, option)| {
						let marker = if index == *cursor { "›" } else { " " };
						let selected =
							matches!(&row.value, RowValue::Scalar(value) if *value == option.value);
						let check = if selected { "●" } else { "○" };
						let copy = if option.description.is_empty() {
							option.label.clone()
						} else {
							sf!("{} — {}", option.label, option.description)
						};
						let id = sf!("setting-choice-{index}");
						dom! { <row id={id} focus gap=1><text fg=accent>{marker}</text><text fg=muted>{check}</text><text truncate>{copy}</text></row> }
							.into_component()
					})
					.collect(), CHOICE_FOOTER)
			},
			Editor::Multi { cursor, selected, ordered, .. } => {
				let RowWidget::MultiSelect { options, .. } = &row.widget else {
					return;
				};
				let start = cursor
					.saturating_sub(11)
					.min(options.len().saturating_sub(12));
				(
					options
						.iter()
						.enumerate()
						.skip(start)
						.take(12)
						.map(|(index, option)| {
							let marker = if index == *cursor { "›" } else { " " };
							let at = selected.iter().position(|value| *value == option.value);
							let check = at.map_or_else(
								|| Str::new_static(if *ordered { "·" } else { "○" }),
								|at| {
									if *ordered {
										sf!("{}.", at + 1)
									} else {
										Str::new_static("●")
									}
								},
							);
							let copy = if option.description.is_empty() {
								option.label.clone()
							} else {
								sf!("{} — {}", option.label, option.description)
							};
							let id = sf!("setting-choice-{index}");
							dom! { <row id={id} focus gap=1><text fg=accent>{marker}</text><text fg=muted>{check}</text><text truncate>{copy}</text></row> }
								.into_component()
						})
						.collect(),
					if *ordered { ORDERED_MULTI_FOOTER } else { MULTI_FOOTER },
				)
			},
			Editor::ProviderList { cursor } => {
				let limits = match &row.value {
					RowValue::ProviderLimits(limits) => limits,
					_ => return,
				};
				let mut choices = self
					.providers
					.iter()
					.map(|provider| {
						let detail = limits
							.iter()
							.find(|(name, _)| name == provider)
							.map_or_else(
								|| Str::new_static("Unlimited"),
								|(_, limit)| sf!("Limit: {limit}"),
							);
						(provider.clone(), detail)
					})
					.collect::<Vec<_>>();
				if !limits.is_empty() {
					choices.push((
						Str::new_static("Clear all limits"),
						Str::new_static("Make every provider unlimited"),
					));
				}
				let start = cursor
					.saturating_sub(11)
					.min(choices.len().saturating_sub(12));
				(
					choices
						.into_iter()
						.enumerate()
						.skip(start)
						.take(12)
						.map(|(index, (provider, detail))| {
							let marker = if index == *cursor { "›" } else { " " };
							let id = sf!("setting-choice-{index}");
							dom! { <row id={id} focus gap=1><text fg=accent>{marker}</text><text>{provider}</text><text fg=muted truncate>{detail}</text></row> }
								.into_component()
						})
						.collect(),
					PROVIDER_FOOTER,
				)
			},
			Editor::ProviderValue { provider, buffer, error } => {
				title = sf!("Max In-Flight Requests: {provider}");
				description = Str::new_static(
					"Enter a positive number. Decimals round down. Clear the field to make this \
					 provider unlimited.",
				);
				let input = Input::new()
					.with_str(Prop::Id, "settings-editor-input")
					.with_str(Prop::Value, buffer);
				(
					vec![
						Box::new(input) as Box<dyn Component>,
						dom! { <text id="settings-editor-error" fg=error truncate>{error.clone().unwrap_or_default()}</text> }
							.into_component(),
					],
					TEXT_FOOTER,
				)
			},
		};
		self.ui = Ui::from_root(
			dom! {
				<box border=round title="Settings">
					<col>
						<text bold fg=accent>{title}</text>
						<text fg=muted>{description}</text>
						<text>{" "}</text>
						for line in lines { {line} }
						<text>{" "}</text>
						<text fg=muted>{footer}</text>
					</col>
				</box>
			},
			self.width,
			self.ctx.clone(),
		);
		match self.editor.as_ref() {
			Some(Editor::Text { .. } | Editor::ProviderValue { .. }) => {
				let _ = self.ui.focus_id("settings-editor-input");
			},
			Some(Editor::Multi { cursor, ordered: true, .. }) => {
				let id = sf!("setting-choice-{cursor}");
				let _ = self.ui.focus_id(&id);
			},
			Some(Editor::Submenu { .. } | Editor::Multi { .. } | Editor::ProviderList { .. })
			| None => {},
		}
	}

	fn list_row(
		&self,
		item: &Item,
		item_index: usize,
		selected: bool,
		label_width: usize,
	) -> Box<dyn Component> {
		match item {
			Item::TabHeader(tab) => {
				let label = SETTING_TABS
					.iter()
					.find(|spec| spec.tab == *tab)
					.map_or("", |spec| spec.label);
				dom! { <row gap=1><text bold fg=accent>{label}</text></row> }.into_component()
			},
			Item::Row(index) => {
				let row = &self.rows[*index];
				let marker = if row.changed() { "●" } else { " " };
				let label = pad(&row.label, label_width);
				let value = row.display();
				let id = sf!("setting-item-{item_index}");
				if selected {
					dom! { <row id={id} focus gap=1 bg=surface><text fg=accent>{marker}</text><pre bold fg=accent>{label}</pre><text fg=accent truncate>{value}</text></row> }.into_component()
				} else {
					dom! { <row id={id} focus gap=1><text fg=accent>{marker}</text><pre>{label}</pre><text fg=muted truncate>{value}</text></row> }.into_component()
				}
			},
		}
	}
}

fn pad(label: &str, width: usize) -> Str {
	let used = usize::from(cell_width(label));
	if used >= width {
		return Str::new(label);
	}
	let mut text = String::with_capacity(width);
	text.push_str(label);
	text.extend(std::iter::repeat_n(' ', width - used));
	Str::new(text)
}

impl Panel for SettingsPanel {
	fn id(&self) -> &'static str {
		"settings"
	}

	fn anchor(&self) -> PanelAnchor {
		PanelAnchor::Full
	}

	fn set_context(&mut self, ctx: &UiContext) {
		self.ctx = ctx.clone();
		self.ui.set_context(ctx.clone());
		let has_image_protocol = !matches!(ctx.graphics, omp_tui::Graphics::Cells);
		if self.has_image_protocol != has_image_protocol {
			self.has_image_protocol = has_image_protocol;
			self.reflow_items();
			self.rebuild();
		}
	}

	fn key(&mut self, key: Key) -> PanelEvent {
		if self.editor.is_some() {
			return self.editor_key(key);
		}
		match key {
			Key::Esc if self.query.is_empty() => PanelEvent::Close,
			Key::Esc => {
				self.end_search(true);
				self.rebuild();
				PanelEvent::Consumed
			},
			Key::Tab | Key::BackTab if self.query.is_empty() && self.visible_groups().len() > 1 => {
				self.section_focus = !self.section_focus;
				self.sync_section_to_selection();
				self.rebuild();
				PanelEvent::Consumed
			},
			Key::Tab => {
				self.switch_tab(1);
				self.rebuild();
				PanelEvent::Consumed
			},
			Key::BackTab => {
				self.switch_tab(-1);
				self.rebuild();
				PanelEvent::Consumed
			},
			Key::Right if !self.query.is_empty() => {
				self.query_right();
				self.rebuild();
				PanelEvent::Consumed
			},
			Key::Left if !self.query.is_empty() => {
				self.query_left();
				self.rebuild();
				PanelEvent::Consumed
			},
			Key::Right => {
				self.switch_tab(1);
				self.rebuild();
				PanelEvent::Consumed
			},
			Key::Left => {
				self.switch_tab(-1);
				self.rebuild();
				PanelEvent::Consumed
			},
			Key::Up if self.section_focus => {
				self.move_section(-1);
				self.rebuild();
				PanelEvent::Consumed
			},
			Key::Down if self.section_focus => {
				self.move_section(1);
				self.rebuild();
				PanelEvent::Consumed
			},
			Key::Enter if self.section_focus => {
				self.section_focus = false;
				self.rebuild();
				PanelEvent::Consumed
			},
			Key::Up => {
				if self.move_selection(-1) {
					self.sync_tab_to_selection();
					self.rebuild();
				}
				PanelEvent::Consumed
			},
			Key::Down => {
				if self.move_selection(1) {
					self.sync_tab_to_selection();
					self.rebuild();
				}
				PanelEvent::Consumed
			},
			Key::PageUp => {
				if self.move_selection(-(self.list_rows as isize)) {
					self.sync_tab_to_selection();
					self.rebuild();
				}
				PanelEvent::Consumed
			},
			Key::PageDown => {
				if self.move_selection(self.list_rows as isize) {
					self.sync_tab_to_selection();
					self.rebuild();
				}
				PanelEvent::Consumed
			},
			Key::Home if !self.query.is_empty() => {
				self.query_cursor = 0;
				self.rebuild();
				PanelEvent::Consumed
			},
			Key::End if !self.query.is_empty() => {
				self.query_cursor = self.query.len();
				self.rebuild();
				PanelEvent::Consumed
			},
			Key::Home => {
				if self.move_selection(-(self.items.len() as isize)) {
					self.sync_tab_to_selection();
					self.rebuild();
				}
				PanelEvent::Consumed
			},
			Key::End => {
				if self.move_selection(self.items.len() as isize) {
					self.sync_tab_to_selection();
					self.rebuild();
				}
				PanelEvent::Consumed
			},
			Key::Enter => self.activate(),
			Key::Space
				if self.query.is_empty()
					&& matches!(self.selected().map(|row| &row.widget), Some(RowWidget::Boolean)) =>
			{
				self.activate()
			},
			Key::Space => {
				self.insert_query(" ");
				self.rebuild();
				PanelEvent::Consumed
			},
			Key::Backspace => {
				self.query_backspace();
				self.rebuild();
				PanelEvent::Consumed
			},
			Key::Ctrl('u') if !self.query.is_empty() => {
				self.query.clear();
				self.query_cursor = 0;
				self.end_search(false);
				self.rebuild();
				PanelEvent::Consumed
			},
			Key::Ctrl('w') if !self.query.is_empty() => {
				self.query_word_backspace();
				self.rebuild();
				PanelEvent::Consumed
			},
			Key::Ctrl('a') if !self.query.is_empty() => {
				self.query_cursor = 0;
				self.rebuild();
				PanelEvent::Consumed
			},
			Key::Ctrl('e') if !self.query.is_empty() => {
				self.query_cursor = self.query.len();
				self.rebuild();
				PanelEvent::Consumed
			},
			Key::Char(character) if !character.is_control() => {
				let mut encoded = [0; 4];
				self.insert_query(character.encode_utf8(&mut encoded));
				self.rebuild();
				PanelEvent::Consumed
			},
			_ => PanelEvent::Consumed,
		}
	}

	fn paste(&mut self, text: &str) -> PanelEvent {
		let clean = text.replace(['\n', '\r', '\t'], " ");
		if matches!(self.editor.as_ref(), Some(Editor::Text { .. } | Editor::ProviderValue { .. })) {
			let event = self.ui.handle_paste(&clean);
			return self.apply_editor_event(event);
		}
		if self.editor.is_none() {
			self.insert_query(clean.trim());
			self.rebuild();
		}
		PanelEvent::Consumed
	}

	fn mouse(&mut self, report: MouseReport) -> PanelEvent {
		if matches!(report.kind, omp_tui::Mouse::WheelUp | omp_tui::Mouse::WheelDown) {
			let key = if report.kind == omp_tui::Mouse::WheelUp {
				Key::Up
			} else {
				Key::Down
			};
			if self.editor.is_some() {
				return self.editor_key(key);
			}
			if self.section_focus {
				self.move_section(if key == Key::Up { -1 } else { 1 });
				self.rebuild();
				return PanelEvent::Consumed;
			}
			if self.move_selection(if key == Key::Up { -1 } else { 1 }) {
				self.sync_tab_to_selection();
				self.rebuild();
			}
			return PanelEvent::Consumed;
		}
		let ordered_choice = self.ordered_multi_choice_at(report.col, report.row);
		let pointed = self.ui.id_at(report.col, report.row).map(String::from);
		let event = self
			.ui
			.handle_mouse_with_mods(report.col, report.row, report.kind, report.mods);
		let focused = self.ui.focused_id().map(String::from);
		let choice_target = if matches!(report.kind, omp_tui::Mouse::Drag | omp_tui::Mouse::Release) {
			pointed.as_deref()
		} else {
			focused.as_deref()
		};
		let choice_index = ordered_choice.or_else(|| {
			choice_target
				.and_then(|id| id.strip_prefix("setting-choice-"))
				.and_then(|index| index.parse::<usize>().ok())
		});
		if let Some(event) = self.ordered_multi_pointer(choice_index, report) {
			return event;
		}
		if let Some(index) = focused
			.as_deref()
			.and_then(|id| id.strip_prefix("setting-choice-"))
			.and_then(|index| index.parse::<usize>().ok())
		{
			match self.editor.as_mut() {
				Some(Editor::Submenu { cursor })
				| Some(Editor::Multi { cursor, .. })
				| Some(Editor::ProviderList { cursor }) => *cursor = index,
				Some(Editor::Text { .. } | Editor::ProviderValue { .. }) | None => {},
			}
			if report.kind == omp_tui::Mouse::Click {
				return self.editor_key(Key::Enter);
			}
			self.rebuild();
			return PanelEvent::Consumed;
		}
		if let Some(index) = focused
			.as_deref()
			.and_then(|id| id.strip_prefix("setting-group-"))
			.and_then(|index| index.parse::<usize>().ok())
			.filter(|index| *index < self.visible_groups().len())
		{
			self.section_cursor = index;
			self.section_focus = true;
			self.move_section(0);
			if report.kind == omp_tui::Mouse::Click {
				self.section_focus = false;
			}
			self.rebuild();
			return PanelEvent::Consumed;
		}
		if let Some(index) = focused
			.as_deref()
			.and_then(|id| id.strip_prefix("setting-item-"))
			.and_then(|index| index.parse::<usize>().ok())
			.filter(|index| matches!(self.items.get(*index), Some(Item::Row(_))))
		{
			let repeated = self.selected == index;
			self.selected = index;
			self.sync_tab_to_selection();
			self.clamp_scroll();
			if report.kind == omp_tui::Mouse::Click && repeated {
				return self.activate();
			}
			self.rebuild();
			return PanelEvent::Consumed;
		}
		self.sync_pointer_tab();
		match event {
			UiEvent::Cancel => PanelEvent::Close,
			_ => PanelEvent::Consumed,
		}
	}

	fn notify(&mut self, note: PanelNote<'_>) -> PanelEvent {
		match note {
			PanelNote::SettingResult { convar, error } => self.settle_setting(convar, error),
			_ => PanelEvent::Ignored,
		}
	}

	fn frame(&mut self, viewport: Size) -> &Frame {
		if viewport.width != self.width || viewport.height != self.height {
			self.width = viewport.width;
			self.height = viewport.height;
			if matches!(self.editor.as_ref(), Some(Editor::Text { .. } | Editor::ProviderValue { .. }))
			{
				self.ui.resize(self.width);
			} else {
				self.rebuild();
			}
		}
		self.ui.frame()
	}
}

#[cfg(test)]
mod tests {
	use std::sync::Arc;

	use omp_con::{DynamicVarSpec, TypeSpec, VarFlags};
	use omp_tui::{Mods, Mouse, MouseButton, frame_text};

	use super::*;

	fn choice(value: &'static str, label: &'static str) -> Choice {
		Choice {
			value:       Str::new_static(value),
			label:       Str::new_static(label),
			description: Str::default(),
		}
	}

	fn row(
		label: &'static str,
		tab: SettingTab,
		group: &'static str,
		widget: RowWidget,
		value: RowValue,
	) -> SettingRow {
		SettingRow {
			convar: sf!("internal_{}", label.to_ascii_lowercase().replace(' ', "_")),
			label: Str::new_static(label),
			description: sf!("Human description for {label}"),
			warning: None,
			unit: None,
			tab,
			group: Str::new_static(group),
			widget,
			value: value.clone(),
			default: value,
			value_kind: ValueKind::Str,
			visibility: None,
		}
	}

	fn fixture() -> Vec<SettingRow> {
		vec![
			row(
				"Thinking Level",
				SettingTab::Model,
				"Thinking",
				RowWidget::Submenu(vec![choice("low", "Low"), choice("high", "High")]),
				RowValue::Scalar(Str::new_static("low")),
			),
			row(
				"Show Details",
				SettingTab::Appearance,
				"Display",
				RowWidget::Boolean,
				RowValue::Boolean(true),
			),
			row(
				"Profile Name",
				SettingTab::Interaction,
				"Input",
				RowWidget::Text { secret: false },
				RowValue::Text(Str::new_static("Ada")),
			),
			row(
				"Search Engines",
				SettingTab::Providers,
				"Services",
				RowWidget::MultiSelect {
					options: vec![choice("a", "Alpha"), choice("b", "Beta")],
					ordered: true,
				},
				RowValue::Multi(vec![Str::new_static("a")]),
			),
		]
	}

	fn text(panel: &mut SettingsPanel) -> String {
		frame_text(panel.frame(Size { width: 140, height: 32 }))
	}

	fn accept_setting(panel: &mut SettingsPanel, event: &PanelEvent) {
		let PanelEvent::RunSetting { convar, .. } = event else {
			return;
		};
		assert_eq!(
			panel.notify(PanelNote::SettingResult { convar, error: None }),
			PanelEvent::Consumed
		);
	}

	#[test]
	fn all_ten_tabs_are_present_and_rows_use_human_labels() {
		let mut panel = SettingsPanel::from_rows(fixture(), &UiContext::default());
		assert_eq!(SETTING_TABS.len(), 10);
		let screen = text(&mut panel);
		for label in [
			"Appearance",
			"Model",
			"Interaction",
			"Context",
			"Memory",
			"Files",
			"Shell",
			"Tools",
			"Tasks",
			"Providers",
		] {
			assert!(screen.contains(label), "missing tab {label}:\n{screen}");
		}
		assert!(screen.contains("Show Details"), "{screen}");
		assert!(!screen.contains("internal_show_details"), "{screen}");
	}

	#[test]
	fn search_uses_human_label_and_description_not_internal_name() {
		let mut panel = SettingsPanel::from_rows(fixture(), &UiContext::default());
		for character in "thinking".chars() {
			panel.key(Key::Char(character));
		}
		assert_eq!(panel.selected().map(|row| row.label.as_str()), Some("Thinking Level"));
		assert!(text(&mut panel).contains("Thinking Level"));
		panel.query.clear();
		panel.reflow_items();
		for character in "internal_profile".chars() {
			panel.key(Key::Char(character));
		}
		assert!(panel.selected().is_none());
	}

	#[test]
	fn archive_without_metadata_is_absent_and_dynamic_metadata_is_opt_in() {
		static STRING_LIST: TypeSpec = TypeSpec {
			kind:        ValueKind::List,
			elem:        Some(TypeSpec::STR),
			variants:    &[],
			finite_only: false,
		};

		let ctx = Ctx::new();
		ctx.register_dynamic_var(DynamicVarSpec {
			name:    Str::new_static("ext::demo::hidden"),
			desc:    Str::new_static("hidden"),
			ty:      TypeSpec::BOOL,
			flags:   VarFlags::ARCHIVE,
			default: Value::Bool(false),
			meta:    Arc::from([]),
		})
		.unwrap();
		ctx.register_dynamic_var(DynamicVarSpec {
			name:    Str::new_static("ext::demo::visible"),
			desc:    Str::new_static("Fallback description"),
			ty:      &STRING_LIST,
			flags:   VarFlags::ARCHIVE,
			default: Value::List(vec![Value::Str(Str::new_static("fast"))]),
			meta:    Arc::from([
				(Str::new_static("ui.tab"), Str::new_static("tools")),
				(Str::new_static("ui.group"), Str::new_static("Extensions")),
				(Str::new_static("ui.label"), Str::new_static("Demo Extension")),
				(Str::new_static("ui.warning"), Str::new_static("Use carefully")),
				(Str::new_static("ui.option.fast"), Str::new_static("Fast")),
				(Str::new_static("ui.option.fast.desc"), Str::new_static("Lower latency")),
				(Str::new_static("ui.option.safe"), Str::new_static("Safe")),
				(Str::new_static("ui.ordered"), Str::new_static("true")),
			]),
		})
		.unwrap();
		let rows = settings_rows(&ctx);
		assert!(rows.iter().all(|row| row.convar != "ext::demo::hidden"));
		let row = rows
			.into_iter()
			.find(|row| row.label == "Demo Extension")
			.expect("metadata opts the extension into settings");
		assert_eq!(row.description, "Fallback description");
		assert_eq!(row.warning.as_deref(), Some("Use carefully"));

		let mut panel = SettingsPanel::from_rows(vec![row], &UiContext::default());
		panel.tab = SETTING_TABS
			.iter()
			.position(|tab| tab.tab == SettingTab::Tools)
			.expect("tools tab");
		panel.reflow_items();
		panel.rebuild();
		let screen = text(&mut panel);
		assert!(screen.contains("Demo Extension"));
		assert!(screen.contains("Use carefully"));
		panel.key(Key::Enter);
		let editor = text(&mut panel);
		assert!(editor.contains("Fast — Lower latency"));
		assert!(editor.contains("Safe"));
	}

	#[test]
	fn steering_enum_projects_declaration_metadata() {
		let _ = omp_agent::AI_STEERING_MODE.spec();
		let ctx = Ctx::new();
		let row = settings_rows(&ctx)
			.into_iter()
			.find(|row| row.convar == "ai_steering_mode")
			.expect("steering declaration is curated");
		assert_eq!(row.tab, SettingTab::Interaction);
		assert_eq!(row.group, "Input");
		assert_eq!(row.label, "Steering Mode");

		let mut panel = SettingsPanel::from_rows(vec![row], &UiContext::default());
		panel.tab = SETTING_TABS
			.iter()
			.position(|tab| tab.tab == SettingTab::Interaction)
			.expect("interaction tab");
		panel.reflow_items();
		panel.rebuild();
		assert!(text(&mut panel).contains("Steering Mode"));
		panel.key(Key::Enter);
		let editor = text(&mut panel);
		assert!(editor.contains("one-at-a-time"));
		assert!(editor.contains("all"));
	}

	#[test]
	fn bool_submenu_text_and_multiselect_emit_typed_commands() {
		let mut panel = SettingsPanel::from_rows(fixture(), &UiContext::default());
		let event = panel.key(Key::Enter);
		assert!(matches!(event, PanelEvent::RunSetting { .. }));
		accept_setting(&mut panel, &event);
		panel.key(Key::Right);
		assert_eq!(panel.selected().map(|row| row.label.as_str()), Some("Thinking Level"));
		assert_eq!(panel.key(Key::Enter), PanelEvent::Consumed);
		panel.key(Key::Down);
		let event = panel.key(Key::Enter);
		assert!(
			matches!(&event, PanelEvent::RunSetting { line, .. } if line.contains(" high; writecfg"))
		);
		accept_setting(&mut panel, &event);
		panel.key(Key::Right);
		assert_eq!(panel.selected().map(|row| row.label.as_str()), Some("Profile Name"));
		panel.key(Key::Enter);
		panel.key(Key::Ctrl('u'));
		panel.key(Key::Char('B'));
		panel.key(Key::Space);
		panel.key(Key::Char('C'));
		let event = panel.key(Key::Enter);
		assert!(
			matches!(&event, PanelEvent::RunSetting { line, .. } if line.contains(" \"B C\"; writecfg"))
		);
		accept_setting(&mut panel, &event);
		while panel.tab() != SettingTab::Providers {
			panel.key(Key::Right);
		}
		panel.key(Key::Enter);
		panel.key(Key::Down);
		assert!(
			matches!(&panel.key(Key::Space), PanelEvent::RunSetting { line, .. } if line.contains("[a b]; writecfg"))
		);
	}

	#[test]
	fn edited_values_are_written_in_their_raw_convar_representation() {
		let mut setting = row(
			"Raw",
			SettingTab::Appearance,
			"Display",
			RowWidget::Submenu(vec![choice("hl.1", "Hashline")]),
			RowValue::Scalar(Str::new_static("hl.1")),
		);
		assert_eq!(SettingsPanel::command_value(&setting, &setting.value).unwrap(), "hl.1");
		assert_eq!(
			project_value(&setting.widget, &Value::Str(Str::new_static("hl.1"))),
			RowValue::Scalar(Str::new_static("hl.1"))
		);

		setting.widget = RowWidget::Text { secret: false };
		setting.value_kind = ValueKind::Duration;
		assert_eq!(
			SettingsPanel::command_value(&setting, &RowValue::Text(Str::new_static("30s"))).unwrap(),
			"30s"
		);
		assert_eq!(SettingsPanel::command_value(&setting, &RowValue::Boolean(true)).unwrap(), "true");
	}

	#[test]
	fn unicode_search_and_stale_cursor_are_char_boundary_safe() {
		let mut unicode = row(
			"Café Theme",
			SettingTab::Appearance,
			"Display",
			RowWidget::Boolean,
			RowValue::Boolean(false),
		);
		unicode.description = Str::new_static("日本語の説明");
		let mut panel = SettingsPanel::from_rows(vec![unicode], &UiContext::default());
		for character in "日本".chars() {
			panel.key(Key::Char(character));
		}
		assert_eq!(panel.selected().map(|row| row.label.as_str()), Some("Café Theme"));

		panel.query = "界".to_owned();
		panel.query_cursor = 1;
		panel.insert_query("é");
		assert_eq!(panel.query, "é界");
		assert!(panel.query.is_char_boundary(panel.query_cursor));
	}

	#[test]
	fn zero_match_search_tabs_paint_with_the_dim_token() {
		let mut panel = SettingsPanel::from_rows(fixture(), &UiContext::default());
		for character in "thinking".chars() {
			panel.key(Key::Char(character));
		}
		let frame = panel.frame(Size { width: 140, height: 32 });
		let lines = frame_text(frame);
		let (row, line) = lines
			.lines()
			.enumerate()
			.find(|(_, line)| line.contains("Appearance") && line.contains("Model"))
			.expect("wide tab strip");
		let appearance = line.find("Appearance").expect("appearance tab");
		let column = cell_width(&line[..appearance]);
		assert_eq!(
			frame
				.cell(column, u16::try_from(row).expect("row fits"))
				.style()
				.foreground_color(),
			UiContext::default().theme.dim
		);
	}

	#[test]
	fn text_editor_uses_input_cursor_word_undo_and_kill_ring() {
		let setting = row(
			"Profile Name",
			SettingTab::Appearance,
			"Display",
			RowWidget::Text { secret: false },
			RowValue::Text(Str::new_static("Ada Lovelace")),
		);
		let mut panel = SettingsPanel::from_rows(vec![setting], &UiContext::default());
		panel.key(Key::Enter);
		panel.key(Key::WordLeft);
		panel.key(Key::Ctrl('k'));
		assert!(matches!(
			&panel.editor,
			Some(Editor::Text { buffer, .. }) if buffer == "Ada "
		));
		panel.key(Key::Ctrl('y'));
		assert!(matches!(
			&panel.editor,
			Some(Editor::Text { buffer, .. }) if buffer == "Ada Lovelace"
		));
		panel.key(Key::Ctrl('_'));
		assert!(matches!(
			&panel.editor,
			Some(Editor::Text { buffer, .. }) if buffer == "Ada "
		));
		panel.key(Key::Char('界'));
		panel.key(Key::Left);
		panel.key(Key::Char('é'));
		assert!(matches!(
			&panel.editor,
			Some(Editor::Text { buffer, .. }) if buffer == "Ada é界"
		));
	}

	#[test]
	fn typed_setting_rejection_stays_inline_with_the_edited_text() {
		let mut setting = row(
			"Retry Count",
			SettingTab::Appearance,
			"Display",
			RowWidget::Text { secret: false },
			RowValue::Text(Str::new_static("1")),
		);
		setting.value_kind = ValueKind::Int;
		let mut panel = SettingsPanel::from_rows(vec![setting], &UiContext::default());
		panel.key(Key::Enter);
		panel.key(Key::Ctrl('u'));
		panel.paste("not-a-number");
		let event = panel.key(Key::Enter);
		let PanelEvent::RunSetting { convar, .. } = &event else {
			panic!("text submission must reach typed con validation");
		};
		assert_eq!(
			panel.notify(PanelNote::SettingResult { convar, error: Some("expected an integer") }),
			PanelEvent::Consumed
		);
		assert!(matches!(
			&panel.editor,
			Some(Editor::Text { buffer, error: Some(error) })
				if buffer == "not-a-number" && error == "expected an integer"
		));
		assert!(text(&mut panel).contains("expected an integer"));
	}

	#[test]
	fn provider_limit_validation_is_inline_and_retains_input() {
		let setting = row(
			"Provider Limits",
			SettingTab::Appearance,
			"Display",
			RowWidget::ProviderLimits,
			RowValue::ProviderLimits(Vec::new()),
		);
		let inventory = SettingsInventory {
			providers: vec![Str::new_static("openai")],
			..SettingsInventory::default()
		};
		let mut panel =
			SettingsPanel::from_rows_with_inventory(vec![setting], inventory, &UiContext::default());
		panel.key(Key::Enter);
		panel.key(Key::Enter);
		panel.paste("many");
		assert_eq!(panel.key(Key::Enter), PanelEvent::Consumed);
		assert!(matches!(
			&panel.editor,
			Some(Editor::ProviderValue { buffer, error: Some(error), .. })
				if buffer == "many" && error == "Limit must be a positive number."
		));
		assert!(text(&mut panel).contains("Limit must be a positive number."));
	}

	#[test]
	fn ordered_multiselect_drag_reorders_and_release_without_drag_toggles() {
		let mut setting = row(
			"Search Engines",
			SettingTab::Appearance,
			"Display",
			RowWidget::MultiSelect {
				options: vec![choice("a", "Alpha"), choice("b", "Beta")],
				ordered: true,
			},
			RowValue::Multi(vec![Str::new_static("a"), Str::new_static("b")]),
		);
		setting.value_kind = ValueKind::List;
		let mut panel = SettingsPanel::from_rows(vec![setting], &UiContext::default());
		panel.key(Key::Enter);
		let _ = panel.frame(Size { width: 100, height: 24 });
		let alpha = panel.ui.rect("setting-choice-0").expect("alpha row");
		let beta = panel.ui.rect("setting-choice-1").expect("beta row");
		let report = |kind, rect: omp_tui::Rect, pressed| MouseReport {
			kind,
			col: rect.x,
			row: rect.y,
			button: MouseButton::Left,
			mods: Mods::default(),
			pressed,
		};
		let list_selection = panel.selected;
		let list_scroll = panel.scroll;
		assert_eq!(panel.mouse(report(Mouse::Click, beta, true)), PanelEvent::Consumed);
		assert!(panel.pending.is_none(), "pointer press must not write the convar");
		assert_eq!(panel.ui.focused_id().as_deref(), Some("setting-choice-1"));
		assert_eq!(panel.mouse(report(Mouse::Drag, alpha, true)), PanelEvent::Consumed);
		assert!(panel.pending.is_none(), "pointer move must not write the convar");
		assert!(matches!(
			&panel.editor,
			Some(Editor::Multi { cursor: 1, selected, .. })
				if selected.iter().map(Str::as_str).eq(["a", "b"])
		));
		let event = panel.mouse(report(Mouse::Release, alpha, false));
		assert!(matches!(
			&event,
			PanelEvent::RunSetting { convar, line }
				if convar.as_str() == "internal_search_engines"
					&& line.as_str() == "internal_search_engines [b a]; writecfg"
		));
		assert_eq!(panel.selected, list_selection);
		assert_eq!(panel.scroll, list_scroll);
		assert_eq!(panel.ui.focused_id().as_deref(), Some("setting-choice-1"));
		assert!(matches!(
			&panel.editor,
			Some(Editor::Multi { cursor: 1, selected, .. })
				if selected.iter().map(Str::as_str).eq(["b", "a"])
		));
		accept_setting(&mut panel, &event);

		let _ = panel.frame(Size { width: 100, height: 24 });
		let beta = panel.ui.rect("setting-choice-1").expect("beta row");
		assert_eq!(panel.mouse(report(Mouse::Click, beta, true)), PanelEvent::Consumed);
		assert!(panel.pending.is_none(), "pointer press must not write the convar");
		let event = panel.mouse(report(Mouse::Release, beta, false));
		assert!(matches!(
			&event,
			PanelEvent::RunSetting { convar, line }
				if convar.as_str() == "internal_search_engines"
					&& line.as_str() == "internal_search_engines [a]; writecfg"
		));
		assert_eq!(panel.selected, list_selection);
		assert_eq!(panel.scroll, list_scroll);
		assert_eq!(panel.ui.focused_id().as_deref(), Some("setting-choice-1"));
	}

	#[test]
	fn generic_visibility_follows_live_declared_control() {
		let ctx = Ctx::new();
		ctx.register_dynamic_var(DynamicVarSpec {
			name:    Str::new_static("ext::demo::driver"),
			desc:    Str::new_static("Controls the dependent setting."),
			ty:      TypeSpec::BOOL,
			flags:   VarFlags::ARCHIVE,
			default: Value::Bool(false),
			meta:    Arc::from([
				(Str::new_static("ui.tab"), Str::new_static("appearance")),
				(Str::new_static("ui.group"), Str::new_static("Display")),
				(Str::new_static("ui.label"), Str::new_static("Driver")),
			]),
		})
		.unwrap();
		ctx.register_dynamic_var(DynamicVarSpec {
			name:    Str::new_static("ext::demo::dependent"),
			desc:    Str::new_static("Visible only while Driver is enabled."),
			ty:      TypeSpec::BOOL,
			flags:   VarFlags::ARCHIVE,
			default: Value::Bool(false),
			meta:    Arc::from([
				(Str::new_static("ui.tab"), Str::new_static("appearance")),
				(Str::new_static("ui.group"), Str::new_static("Display")),
				(Str::new_static("ui.label"), Str::new_static("Dependent")),
				(Str::new_static("ui.when"), Str::new_static("ext::demo::driver=true")),
			]),
		})
		.unwrap();

		let rows = settings_rows(&ctx)
			.into_iter()
			.filter(|row| row.convar.starts_with("ext::demo::"))
			.collect();
		let mut panel = SettingsPanel::from_rows(rows, &UiContext::default());
		let visible_rows = |panel: &SettingsPanel| {
			panel
				.items
				.iter()
				.filter(|item| matches!(item, Item::Row(_)))
				.count()
		};
		assert_eq!(visible_rows(&panel), 1);
		assert_eq!(panel.selected().map(|row| row.label.as_str()), Some("Driver"));

		let event = panel.key(Key::Enter);
		assert!(matches!(event, PanelEvent::RunSetting { .. }));
		assert_eq!(visible_rows(&panel), 2);
		assert!(text(&mut panel).contains("Dependent"));
	}
}
