//! Interactive extension and skill enablement.
//!
//! The selector edits one convar, `cl_disabled_extensions` (declared in
//! `omp_driver::discovery`): native
//! extension manifest ids disable a whole extension, `skill:<name>` drops one
//! skill. The user scope persists to `~/.o2/config.cfg`, the workspace scope
//! to `<project>/.omp/config.cfg`, through the same lenient load and dump
//! `omp config set` uses (ADR 0012: one currency; ADR 0014: no second
//! customization schema). A workspace list replaces the user list when the
//! project cfg runs after the user cfg, so the first workspace edit starts
//! from the effective user list; `Delete` drops the override again. A cfg
//! dump only carries values diverging from the default, so an empty
//! workspace list cannot be persisted and always means "inherit".

use std::{collections::BTreeSet, path::Path};

use clap::Args;
use miette::{IntoDiagnostic as _, miette};
use omp_con::{Ctx, Origin, Value};
use omp_core::{Str, sf};
use omp_driver::discovery::{
	CL_DISABLED_EXTENSIONS,
	native::{NativeAdmissionOptions, NativeLoadMode, admit_native_extensions},
	skills::{ActiveSkills, SKILL_ID_PREFIX},
};
use omp_tui::{
	AppEvent, AppOptions, Dim, Key, OverlayAnchor, OverlayMargin, OverlayOptions, Prop, Size, Ui,
	components::{Boxed, Button, Col, Row, Select, SelectOption, Shader, TextLeaf},
	shader::Eclipse,
};
use strum::Display;

use super::Layer;

const RESOURCE_LIST: &str = "extension-config-resources";
const ACCEPT: &str = "extension-config-accept";
const CANCEL: &str = "extension-config-cancel";

/// Options for the interactive extension selector.
#[derive(Clone, Debug, Default, Args)]
pub struct ExtConfigArgs {}

/// Which cfg file a toggle edits.
#[derive(Clone, Copy, Debug, Default, Display, Eq, PartialEq)]
#[strum(serialize_all = "lowercase")]
enum WriteScope {
	/// `~/.o2/config.cfg`.
	#[default]
	User,
	/// `<project>/.omp/config.cfg`.
	Workspace,
}

impl WriteScope {
	const fn switched(self) -> Self {
		match self {
			Self::User => Self::Workspace,
			Self::Workspace => Self::User,
		}
	}
}

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

/// The two persisted lists plus the cursor; pure so tests drive it directly.
#[derive(Clone, Debug, Eq, PartialEq)]
struct SelectorModel {
	scope:           WriteScope,
	items:           Vec<SelectorItem>,
	selected:        usize,
	/// `cl_disabled_extensions` in the user cfg.
	user:            BTreeSet<Str>,
	/// `cl_disabled_extensions` in the workspace cfg; `None` inherits the
	/// user list.
	workspace:       Option<BTreeSet<Str>>,
	dirty_user:      bool,
	dirty_workspace: bool,
}

impl SelectorModel {
	fn new(items: Vec<SelectorItem>, user: BTreeSet<Str>, workspace: Option<BTreeSet<Str>>) -> Self {
		Self {
			scope: WriteScope::User,
			items,
			selected: 0,
			user,
			workspace,
			dirty_user: false,
			dirty_workspace: false,
		}
	}

	/// The list the selected scope applies at runtime.
	fn effective(&self) -> &BTreeSet<Str> {
		match self.scope {
			WriteScope::User => &self.user,
			WriteScope::Workspace => self.workspace.as_ref().unwrap_or(&self.user),
		}
	}

	fn enabled(&self, item: &SelectorItem) -> bool {
		!self.effective().contains(&item.id)
	}

	fn switch_scope(&mut self) {
		self.scope = self.scope.switched();
	}

	fn select(&mut self, index: usize) {
		if index < self.items.len() {
			self.selected = index;
		}
	}

	/// Flips the selected row in the selected scope. The first workspace
	/// toggle materializes the override from the effective user list so the
	/// project keeps every user decision it did not change.
	fn toggle_selected(&mut self) {
		let Some(id) = self.items.get(self.selected).map(|item| item.id.clone()) else {
			return;
		};
		let list = match self.scope {
			WriteScope::User => {
				self.dirty_user = true;
				&mut self.user
			},
			WriteScope::Workspace => {
				self.dirty_workspace = true;
				let user = &self.user;
				self.workspace.get_or_insert_with(|| user.clone())
			},
		};
		if !list.remove(&id) {
			list.insert(id);
		}
		if self.workspace.as_ref().is_some_and(BTreeSet::is_empty) {
			self.workspace = None;
		}
	}

	/// Drops the workspace override so the project inherits the user list.
	fn inherit_workspace(&mut self) {
		if self.scope == WriteScope::Workspace && self.workspace.take().is_some() {
			self.dirty_workspace = true;
		}
	}

	fn detail(&self, item: &SelectorItem) -> Str {
		let state = if self.enabled(item) {
			"enabled"
		} else {
			"disabled"
		};
		match self.scope {
			WriteScope::Workspace if self.workspace.is_none() => {
				sf!("{state} (inherited from user scope) · {}", item.origin)
			},
			_ => sf!("{state} · {}", item.origin),
		}
	}
}

/// Opens the alternate-buffer selector and persists staged changes only after
/// acceptance.
#[expect(clippy::future_not_send, reason = "the selector owns a thread-confined omp_tui::App")]
pub async fn run(project: &Path, layer: Option<Layer>, _args: ExtConfigArgs) -> miette::Result<()> {
	let user_path = crate::config_path().into_diagnostic()?;
	let workspace_path = crate::config_cmd::path(project, crate::cli::ConfigScope::Project)?;
	let user_cfg = crate::config_cmd::load_cfg(&user_path)?;
	let workspace_cfg = crate::config_cmd::load_cfg(&workspace_path)?;
	let mut model = SelectorModel::new(
		load_items(project)?,
		disabled_list(&user_cfg),
		Some(disabled_list(&workspace_cfg)).filter(|list| !list.is_empty()),
	);
	if layer == Some(Layer::Workspace) {
		model.switch_scope();
	}

	let mut app = AppOptions::new()
		.hold_alt()
		.keep_on_cancel()
		.mouse()
		.hotkeys([Key::Tab, Key::Space, Key::Delete])
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
			Some(AppEvent::Key(Key::Tab)) => {
				model.switch_scope();
				show_selector(app.ui_mut(), &model, true);
			},
			Some(AppEvent::Key(Key::Delete)) => {
				model.inherit_workspace();
				show_selector(app.ui_mut(), &model, true);
			},
			Some(AppEvent::Submitted) => break true,
			Some(AppEvent::Pressed(id)) if id.as_str() == ACCEPT => break true,
			Some(AppEvent::Pressed(id)) if id.as_str() == CANCEL => break false,
			Some(AppEvent::OverlayClosed(_)) | None => break false,
			_ => {},
		}
	};
	if accepted {
		if model.dirty_user {
			persist(&user_path, Some(&model.user))?;
		}
		if model.dirty_workspace {
			persist(&workspace_path, model.workspace.as_ref())?;
		}
	}
	Ok(())
}

/// Writes `list` into the latest on-disk cfg's `cl_disabled_extensions` (or
/// resets it to the default when `None`). The fresh read and replacement share
/// the config transaction, so changes made while the selector was open survive.
fn persist(path: &Path, list: Option<&BTreeSet<Str>>) -> miette::Result<()> {
	crate::config_cmd::update_cfg(path, |cfg| {
		let value = list.map_or_else(
			|| (CL_DISABLED_EXTENSIONS.spec().default)(),
			|list| Value::List(list.iter().cloned().map(Value::Str).collect()),
		);
		let origin = if list.is_some() {
			Origin::Archive
		} else {
			Origin::Default
		};
		cfg.set(CL_DISABLED_EXTENSIONS.name(), value, origin)
			.map_err(|error| miette!("{error}"))?;
		Ok(())
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
	let extensions = admit_native_extensions(project, &home, NativeAdmissionOptions {
		explicit_roots:    &[],
		mode:              NativeLoadMode::Merge,
		include_workspace: true,
		setting_overrides: &[],
		disabled:          &[],
	})
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
	let ctx = crate::process_ctx(project)?;
	let mut skills = ActiveSkills::discover(&ctx, project).into_diagnostic()?;
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
		.child(TextLeaf::new().text(sf!("{} scope · cl_disabled_extensions", model.scope)))
		.child(select)
		.child(actions)
		.child(TextLeaf::new().with(Prop::Dim, true).text(
			"Tab switches scope | Space toggles | Delete makes the workspace inherit | Enter applies \
			 | Esc cancels",
		));
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
	fn user_toggle_edits_the_user_list_only() {
		let mut model =
			SelectorModel::new(vec![item("acme.reviewer"), item("skill:review")], set(&[]), None);
		assert!(model.enabled(&model.items[0]));
		model.select(1);
		model.toggle_selected();
		assert_eq!(model.user, set(&["skill:review"]));
		assert!(model.workspace.is_none());
		assert!(model.dirty_user && !model.dirty_workspace);
		model.toggle_selected();
		assert!(model.user.is_empty());
	}

	#[test]
	fn workspace_toggle_materializes_from_the_user_list_and_delete_inherits_again() {
		let mut model = SelectorModel::new(
			vec![item("acme.reviewer"), item("skill:review")],
			set(&["acme.reviewer"]),
			None,
		);
		model.switch_scope();
		assert_eq!(model.scope, WriteScope::Workspace);
		// Inherited picture before any workspace edit.
		assert!(!model.enabled(&model.items[0]));
		assert!(model.detail(&model.items[0]).contains("inherited"));
		model.select(1);
		model.toggle_selected();
		assert_eq!(model.workspace, Some(set(&["acme.reviewer", "skill:review"])));
		assert_eq!(model.user, set(&["acme.reviewer"]), "user list untouched");
		assert!(model.dirty_workspace && !model.dirty_user);
		model.inherit_workspace();
		assert!(model.workspace.is_none());
		assert!(model.enabled(&model.items[1]));
	}

	/// The selector writes the convar the runtime reads: after persisting,
	/// re-loading the cfg through the production loader yields the list.
	#[test]
	fn persisted_list_round_trips_through_the_cfg_loader() {
		let tree = tempfile::tempdir().unwrap();
		let path = tree.path().join("config.cfg");
		persist(&path, Some(&set(&["skill:review", "acme.reviewer"]))).unwrap();
		let script = std::fs::read_to_string(&path).unwrap();
		assert!(script.contains("cl_disabled_extensions"), "{script}");
		let reloaded = crate::config_cmd::load_cfg(&path).unwrap();
		assert_eq!(disabled_list(&reloaded), set(&["acme.reviewer", "skill:review"]));
		let policy = omp_driver::discovery::skills::SkillPolicy::from_con(&reloaded);
		assert_eq!(policy.disabled, set(&["review"]));
		persist(&path, None).unwrap();
		let cleared = crate::config_cmd::load_cfg(&path).unwrap();
		assert!(disabled_list(&cleared).is_empty());
	}
}
