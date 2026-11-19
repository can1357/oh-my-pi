//! Interactive extension and skill enablement.
//!
//! The selector edits one convar, `cl_disabled_extensions` (declared in
//! `omp_driver::discovery`): native extension manifest ids disable a whole
//! extension, `skill:<name>` drops one skill. The list is user-only: it
//! persists to `~/.o2/config.cfg` through the same lenient load and dump
//! `omp config set` uses (ADR 0012: one currency; ADR 0014: no second
//! customization schema). A project `.omp/config.cfg` cannot set it (owner
//! decision Q8: a repository must not be able to switch off a guard
//! extension), so there is no workspace scope to edit.

use std::{
	collections::BTreeSet,
	path::{Path, PathBuf},
};

use clap::Args;
use miette::{IntoDiagnostic as _, miette};
use omp_con::{Ctx, Origin, Value};
use omp_core::{Str, sf};
use omp_driver::discovery::{
	CL_DISABLED_EXTENSIONS,
	native::{
		NativeAdmissionOptions, NativeControlGrantOptions, NativeLoadMode,
		admit_native_extensions_with_control,
	},
	skills::{ActiveSkills, SKILL_ID_PREFIX},
};
use omp_tui::{
	AppEvent, AppOptions, Dim, Key, OverlayAnchor, OverlayMargin, OverlayOptions, Prop, Size, Ui,
	components::{Boxed, Button, Col, Row, Select, SelectOption, Shader, TextLeaf},
	shader::Eclipse,
};

const RESOURCE_LIST: &str = "extension-config-resources";
const ACCEPT: &str = "extension-config-accept";
const CANCEL: &str = "extension-config-cancel";

/// Options for the interactive extension selector.
#[derive(Clone, Debug, Default, Args)]
pub struct ExtConfigArgs {}

/// One toggleable row: an extension manifest id or a `skill:<name>` id.
#[derive(Clone, Debug, Eq, PartialEq)]
struct SelectorItem {
	/// `cl_disabled_extensions` entry.
	id:     Str,
	/// Row label.
	label:  Str,
	/// Provenance shown next to the state.
	origin: Str,
}

/// The persisted list plus the cursor; pure so tests drive it directly.
#[derive(Clone, Debug, Eq, PartialEq)]
struct SelectorModel {
	items:    Vec<SelectorItem>,
	selected: usize,
	/// `cl_disabled_extensions` in the user cfg.
	disabled: BTreeSet<Str>,
	dirty:    bool,
}

impl SelectorModel {
	fn new(items: Vec<SelectorItem>, disabled: BTreeSet<Str>) -> Self {
		Self { items, selected: 0, disabled, dirty: false }
	}

	fn enabled(&self, item: &SelectorItem) -> bool {
		!self.disabled.contains(&item.id)
	}

	fn select(&mut self, index: usize) {
		if index < self.items.len() {
			self.selected = index;
		}
	}

	/// Flips the selected row.
	fn toggle_selected(&mut self) {
		let Some(id) = self.items.get(self.selected).map(|item| item.id.clone()) else {
			return;
		};
		self.dirty = true;
		if !self.disabled.remove(&id) {
			self.disabled.insert(id);
		}
	}

	fn detail(&self, item: &SelectorItem) -> Str {
		let state = if self.enabled(item) {
			"enabled"
		} else {
			"disabled"
		};
		sf!("{state} · {}", item.origin)
	}
}

/// Opens the alternate-buffer selector and persists staged changes only after
/// acceptance.
#[expect(clippy::future_not_send, reason = "the selector owns a thread-confined omp_tui::App")]
pub async fn run(project: &Path, _args: ExtConfigArgs) -> miette::Result<()> {
	let user_path = crate::config_path().into_diagnostic()?;
	let user_cfg = crate::config_cmd::load_cfg(&user_path)?;
	let mut model = SelectorModel::new(load_items(project)?, disabled_list(&user_cfg));

	let mut app = AppOptions::new()
		.hold_alt()
		.keep_on_cancel()
		.mouse()
		.hotkeys([Key::Space])
		.start(|env: omp_tui::AppEnv| {
			Ui::from_root(
				Shader::new(Eclipse::default()).size(env.viewport.width, env.viewport.height),
				env.viewport.width,
				env.ctx,
			)
		})
		.await
		.into_diagnostic()?;
	show_selector(app.ui_mut(), &model, false);
	let accepted = loop {
		match app.next().await.into_diagnostic()? {
			Some(AppEvent::Highlighted { id, value }) if id.as_str() == RESOURCE_LIST => {
				if let Ok(index) = value.parse::<usize>() {
					model.select(index);
				}
			},
			Some(AppEvent::Changed { id, value }) if id.as_str() == RESOURCE_LIST => {
				if let Ok(index) = value.parse::<usize>() {
					model.select(index);
					model.toggle_selected();
					show_selector(app.ui_mut(), &model, true);
				}
			},
			Some(AppEvent::Key(Key::Space)) => {
				model.toggle_selected();
				show_selector(app.ui_mut(), &model, true);
			},
			Some(AppEvent::Submitted) => break true,
			Some(AppEvent::Pressed(id)) if id.as_str() == ACCEPT => break true,
			Some(AppEvent::Pressed(id)) if id.as_str() == CANCEL => break false,
			Some(AppEvent::OverlayClosed(_)) | None => break false,
			_ => {},
		}
	};
	if accepted && model.dirty {
		persist(&user_path, &model.disabled)?;
	}
	Ok(())
}

/// Writes `list` into the latest on-disk user cfg's `cl_disabled_extensions`
/// (an empty list resets it to the default). The fresh read and replacement
/// share the config transaction, so changes made while the selector was open
/// survive.
fn persist(path: &Path, list: &BTreeSet<Str>) -> miette::Result<()> {
	crate::config_cmd::update_cfg(path, |cfg: &Ctx| {
		let (value, origin) = if list.is_empty() {
			((CL_DISABLED_EXTENSIONS.spec().default)(), Origin::Default)
		} else {
			(Value::List(list.iter().cloned().map(Value::Str).collect()), Origin::Archive)
		};
		cfg.set(CL_DISABLED_EXTENSIONS.name(), value, origin)
			.map(drop)
			.into_diagnostic()
	})
}

fn disabled_list(cfg: &Ctx) -> BTreeSet<Str> {
	CL_DISABLED_EXTENSIONS.get(cfg).into_iter().collect()
}

/// Rows in runtime order: every native extension the runtime would admit
/// (disabled ones included, so they can be re-enabled) followed by every
/// admitted skill.
fn load_items(project: &Path) -> miette::Result<Vec<SelectorItem>> {
	let home = omp_core::dirs::home_dir()
		.ok_or(omp_core::dirs::DataDirError::HomeUnset)
		.into_diagnostic()?;
	let ctx = crate::process_ctx(project)?;
	let data_dir = omp_core::dirs::data_dir(None).into_diagnostic()?;
	let writable_roots = omp_envd::exec_settings::SV_SANDBOX_WRITABLE_ROOTS
		.get(&ctx)
		.into_iter()
		.map(|path| PathBuf::from(path.as_str()))
		.collect::<Vec<_>>();
	let control = NativeControlGrantOptions {
		data_dir:          &data_dir,
		sandbox_mode:      omp_envd::exec_settings::SV_SANDBOX_MODE.get(&ctx),
		writable_roots:    &writable_roots,
		sandbox_available: omp_envd::admission::probe_sandbox(&ctx, project).confines(),
	};
	let extensions = admit_native_extensions_with_control(
		project,
		&home,
		NativeAdmissionOptions {
			explicit_roots:    &[],
			mode:              NativeLoadMode::Merge,
			include_workspace: true,
			setting_overrides: &[],
			disabled:          &[],
		},
		&control,
	)
	.map_err(|error| miette!("{error}"))?;
	let mut items = extensions
		.into_iter()
		.map(|extension| {
			let id = Str::new(extension.spec.key.extension().as_str());
			SelectorItem {
				label: sf!("extension {id}"),
				origin: Str::new(extension.root.to_string_lossy()),
				id,
			}
		})
		.collect::<Vec<_>>();
	let plugins = omp_ext::claude_plugin::ClaudePlugins::resolve(
		&data_dir,
		project,
		omp_ext::claude_plugin::ClaudeCodeHome::detect().as_ref(),
		omp_driver::workspace_trust::evaluate_workspace(&data_dir, project).trust(),
	);
	let mut skills = ActiveSkills::discover(&ctx, project, &plugins).into_diagnostic()?;
	// Disabled skills are absent from discovery; list them from the cfg so
	// they can be switched back on.
	let known = skills.names();
	for id in CL_DISABLED_EXTENSIONS.get(&ctx) {
		if let Some(name) = id.strip_prefix(SKILL_ID_PREFIX)
			&& !known.iter().any(|known| known.as_str() == name)
		{
			items.push(SelectorItem {
				id:     id.clone(),
				label:  sf!("skill {name}"),
				origin: Str::new_static("disabled"),
			});
		}
	}
	items.extend(skills.skills.drain(..).map(|skill| SelectorItem {
		id:     sf!("{SKILL_ID_PREFIX}{}", skill.name),
		label:  sf!("skill {}", skill.name),
		origin: sf!("{}:{} {}", skill.provider, <&str>::from(skill.level), skill.path.display()),
	}));
	Ok(items)
}

fn show_selector(ui: &mut Ui, model: &SelectorModel, replace: bool) {
	if replace {
		let _ = ui.close_top_overlay();
	}
	let mut select = Select::new()
		.with(Prop::Id, RESOURCE_LIST)
		.with(Prop::Multi, true)
		.with(Prop::Filter, true)
		.with(Prop::MaxRows, 18_u16);
	for (index, item) in model.items.iter().enumerate() {
		select = select.option(
			SelectOption::new()
				.label(item.label.clone())
				.with(Prop::Value, sf!("{index}"))
				.with(Prop::Desc, model.detail(item))
				.with(Prop::Selected, model.enabled(item))
				.with(Prop::Active, index == model.selected),
		);
	}
	let actions = Row::new()
		.with(Prop::Gap, 1_u16)
		.child(Button::new().with(Prop::Id, ACCEPT).child("Apply"))
		.child(Button::new().with(Prop::Id, CANCEL).child("Cancel"));
	let content = Col::new()
		.with(Prop::Gap, 1_u16)
		.child(TextLeaf::new().text("user scope · cl_disabled_extensions"))
		.child(select)
		.child(actions)
		.child(
			TextLeaf::new()
				.with(Prop::Dim, true)
				.text("Space toggles | Enter applies | Esc cancels"),
		);
	ui.show_overlay(
		Boxed::new().child(
			Col::new()
				.with(Prop::Gap, 1_u16)
				.child(
					TextLeaf::new()
						.with(Prop::Bold, true)
						.text("Extensions and skills"),
				)
				.child(content),
		),
		OverlayOptions::default()
			.anchor(OverlayAnchor::Center)
			.width(Dim::Pct(72))
			.min_width(52)
			.max_height(Dim::Pct(86))
			.margin(OverlayMargin::uniform(1))
			.min_viewport(Size::new(30, 10)),
	);
	ui.focus_first();
}

#[cfg(test)]
mod tests {
	use super::*;

	fn item(id: &str) -> SelectorItem {
		SelectorItem { id: Str::new(id), label: Str::new(id), origin: Str::new_static("test") }
	}

	fn set(ids: &[&str]) -> BTreeSet<Str> {
		ids.iter().map(|id| Str::new(*id)).collect()
	}

	#[test]
	fn toggle_flips_the_selected_row_and_marks_the_list_dirty() {
		let mut model =
			SelectorModel::new(vec![item("acme.reviewer"), item("skill:review")], set(&[]));
		assert!(model.enabled(&model.items[0]));
		assert!(!model.dirty);
		model.select(1);
		model.toggle_selected();
		assert_eq!(model.disabled, set(&["skill:review"]));
		assert!(model.dirty);
		assert!(model.detail(&model.items[1]).starts_with("disabled"));
		model.toggle_selected();
		assert!(model.disabled.is_empty());
	}

	/// The selector writes the convar the runtime reads: after persisting,
	/// re-loading the cfg through the production loader yields the list, and
	/// an empty list drops the line again.
	#[test]
	fn persisted_list_round_trips_through_the_cfg_loader() {
		let tree = tempfile::tempdir().unwrap();
		let path = tree.path().join("config.cfg");
		persist(&path, &set(&["skill:review", "acme.reviewer"])).unwrap();
		let script = std::fs::read_to_string(&path).unwrap();
		assert!(script.contains("cl_disabled_extensions"), "{script}");
		let reloaded = crate::config_cmd::load_cfg(&path).unwrap();
		assert_eq!(disabled_list(&reloaded), set(&["acme.reviewer", "skill:review"]));
		let policy = omp_driver::discovery::skills::SkillPolicy::from_con(&reloaded);
		assert_eq!(policy.disabled, set(&["review"]));
		persist(&path, &set(&[])).unwrap();
		let cleared = crate::config_cmd::load_cfg(&path).unwrap();
		assert!(disabled_list(&cleared).is_empty());
	}

	/// A project overlay naming the convar is refused by the project loader,
	/// so a repository's `.omp/config.cfg` never feeds the selector or the
	/// runtime a disabled set.
	#[test]
	fn a_project_overlay_cannot_carry_the_list() {
		let tree = tempfile::tempdir().unwrap();
		let path = tree.path().join("config.cfg");
		std::fs::write(&path, "cl_disabled_extensions [acme.reviewer]\n").unwrap();
		let reloaded = crate::config_cmd::load_project_cfg(&path).unwrap();
		assert!(disabled_list(&reloaded).is_empty());
	}
}
