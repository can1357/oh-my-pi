//! Interactive terminal and native hosts for the journal-first agent kernel.

use std::{
	env, fs,
	path::{Path, PathBuf},
	sync::Arc,
	time::Duration,
};

use miette::{IntoDiagnostic as _, miette};
use omp_catalog::{settings::ModelSettings, snapshot::Catalog};
use omp_core::Str;
use omp_driver::{
	discovery::{prompts::PromptTemplates, roles},
	headless::kernel::KernelOptions,
};

use crate::cli::{ChatArgs, InvocationExtensionMode, LaunchExtensions, PromptArgs};

pub(crate) mod launch_input;

omp_con::var! {
	/// Model selector prewalk hands off to at the first edit (`--prewalk-into`);
	/// empty selects the `smol` role. Journaled with the session so a resumed
	/// prewalk keeps its target.
	pub static AI_PREWALK_MODEL = ai_prewalk_model: Str {
		default: Str::new_static(""),
		flags: session,
	};
}

/// Default model role for prewalk and `--plan-yolo-into`.
const SMOL_ROLE: &str = "@smol";
/// Sandbox root allow-lists `--add-dir` extends (envd `exec_settings`).
const SANDBOX_READABLE_ROOTS: &str = "sv_sandbox_readable_roots";
const SANDBOX_WRITABLE_ROOTS: &str = "sv_sandbox_writable_roots";

/// Waits for the first process-termination signal the session owner can
/// journal before teardown.
#[cfg(unix)]
pub(crate) async fn process_signal() -> std::io::Result<omp_session::ExitSignal> {
	use tokio::signal::unix::{SignalKind, signal};

	let mut interrupt = signal(SignalKind::interrupt())?;
	let mut terminate = signal(SignalKind::terminate())?;
	let mut hangup = signal(SignalKind::hangup())?;
	let mut quit = signal(SignalKind::quit())?;
	tokio::select! {
		_ = interrupt.recv() => Ok(omp_session::ExitSignal::new("SIGINT", Some(libc::SIGINT))),
		_ = terminate.recv() => Ok(omp_session::ExitSignal::new("SIGTERM", Some(libc::SIGTERM))),
		_ = hangup.recv() => Ok(omp_session::ExitSignal::new("SIGHUP", Some(libc::SIGHUP))),
		_ = quit.recv() => Ok(omp_session::ExitSignal::new("SIGQUIT", Some(libc::SIGQUIT))),
	}
}

/// Waits for the first console interrupt the session owner can journal before
/// teardown.
#[cfg(windows)]
pub(crate) async fn process_signal() -> std::io::Result<omp_session::ExitSignal> {
	tokio::signal::ctrl_c().await?;
	Ok(omp_session::ExitSignal::new("CTRL_C", None))
}

/// No process signal integration is available on this target.
#[cfg(not(any(unix, windows)))]
pub(crate) async fn process_signal() -> std::io::Result<omp_session::ExitSignal> {
	std::future::pending().await
}

/// Initial surface selected by the command boundary.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ChatStart {
	/// Open the transcript and composer immediately.
	Session,
	/// Open the session index before the transcript.
	///
	/// The journal-first host currently resolves `--continue`/`--resume` at the
	/// controller boundary, so this selection opens that resolved session.
	SessionIndex,
}

/// Presentation selected for the interactive project-chat session.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ChatPresentation {
	/// Render through the inline terminal host.
	Terminal,
	/// Render through the native GPU window host.
	Gui,
}

/// Lowers application launch-extension controls into the driver composition
/// contract shared by chat, print, RPC, and ACP.
pub(crate) fn driver_extension_policy(
	launch: &LaunchExtensions,
) -> omp_driver::headless::kernel::LaunchExtensionPolicy {
	omp_driver::headless::kernel::LaunchExtensionPolicy {
		native_roots:      launch.native_roots.clone(),
		native_mode:       match launch.mode {
			InvocationExtensionMode::Merge => omp_driver::headless::kernel::NativeExtensionMode::Merge,
			InvocationExtensionMode::ExplicitOnly => {
				omp_driver::headless::kernel::NativeExtensionMode::ExplicitOnly
			},
			InvocationExtensionMode::Disabled => {
				omp_driver::headless::kernel::NativeExtensionMode::Disabled
			},
		},
		include_workspace: !launch.no_workspace,
		trusted:           launch.trusted.clone(),
		contributed:       launch.contributed.clone(),
		setting_overrides: launch.settings.clone(),
	}
}

/// Resolves the prompt flags once at the command boundary.
pub(crate) fn prompt_overrides(
	project: &std::path::Path,
	home: &std::path::Path,
	args: &PromptArgs,
) -> miette::Result<omp_driver::headless::kernel::PromptOverrides> {
	let slots = crate::spec::resolve_prompt_slots(
		project,
		home,
		args.custom_prompt.as_deref(),
		args.append_prompt.as_deref(),
	)?;
	Ok(omp_driver::headless::kernel::PromptOverrides {
		custom_prompt:          slots.system,
		append_prompt:          slots.append,
		personality:            args.personality.clone(),
		include_model:          args.include_model_in_prompt,
		include_workstation:    args.include_workstation,
		include_workspace_tree: args.include_workspace_tree,
		render_mermaid:         args.render_mermaid,
		include_skills:         args.skills_enabled,
		null_prompt:            args.null_prompt,
		include_context_files:  true,
		include_rules:          true,
		additional_roots:       Vec::new(),
	})
}

/// Process facts a launch resolves before lowering its arguments: the data
/// directory, the operator's home, and the catalog authority. Tests supply
/// scratch directories and the embedded catalog.
pub(crate) struct LaunchEnv {
	pub data_dir: PathBuf,
	pub home:     PathBuf,
	pub catalog:  Arc<Catalog>,
}

impl LaunchEnv {
	/// Resolves the production environment: the project catalog snapshot, or
	/// the embedded one when inference runs behind a gateway.
	pub(crate) fn production(project: &Path, gateway: bool) -> miette::Result<Self> {
		let data_dir = omp_core::dirs::data_dir(None).into_diagnostic()?;
		let catalog = if gateway {
			Arc::new(Catalog::embedded().clone())
		} else {
			omp_driver::registry::production_catalog(&data_dir).map_err(|source| miette!(source))?
		};
		Ok(Self {
			data_dir,
			home: env::var_os("HOME").map_or_else(|| project.to_path_buf(), PathBuf::from),
			catalog,
		})
	}
}

/// One `--models` roster entry: the pattern it came from, the admitted model
/// key, and the pattern's explicit thinking suffix.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ScopedModel {
	pub pattern:  Str,
	pub key:      Str,
	pub thinking: Option<Str>,
}

/// A resolved model hand-off target (`--plan-yolo-into`, `--prewalk-into`).
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct HandoffTarget {
	pub model:    Str,
	pub thinking: Option<Str>,
}

/// Everything the chat, print, RPC, and ACP modes derive from [`ChatArgs`]
/// before the kernel is composed.
///
/// [`Launch::prepare`] destructures every parsed field exhaustively (no
/// `..`): a flag clap accepts is lowered into a convar, a [`KernelOptions`]
/// field, or a launch fact here, or the crate does not compile.
pub(crate) struct Launch {
	pub data_dir:      PathBuf,
	pub project:       PathBuf,
	pub ctx:           Arc<omp_con::Ctx>,
	pub catalog:       Arc<Catalog>,
	/// Configured model policy after `--config` overlays.
	pub settings:      ModelSettings,
	/// `settings` narrowed to the `--models` roster; identical to `settings`
	/// without the flag.
	pub scoped:        ModelSettings,
	pub roles:         roles::LaunchRoles,
	/// Primary model selector handed to the kernel.
	pub model:         Str,
	/// `--models` roster in flag order; the interactive cycle when non-empty.
	pub scope:         Vec<ScopedModel>,
	/// Reasoning level applied after the session opened: `--thinking`, else the
	/// first scoped pattern's explicit suffix on a fresh session.
	pub thinking:      Option<Str>,
	/// `--plan-mode` / `--plan-yolo`: engage the plan Director at launch.
	pub plan_mode:     bool,
	/// `--plan-yolo`: the target the plan Director hands off to on approval.
	pub plan_yolo:     Option<HandoffTarget>,
	/// Armed prewalk hand-off target; `None` when prewalk is off or disarmed.
	pub prewalk:       Option<HandoffTarget>,
	pub sessions_dir:  Option<PathBuf>,
	/// The launch reopens an existing session.
	pub resuming:      bool,
	pub ephemeral:     bool,
	pub max_time:      Option<Duration>,
	/// Ordered positional launch messages and `@file` references.
	pub prompt:        Vec<Str>,
	/// Prompt templates (`/name` slash commands): the discovered directories
	/// unless `--no-prompt-templates`, plus every `--prompt-template` path.
	pub templates:     Arc<PromptTemplates>,
	/// Discovered skill declarations shared with the kernel and slash console.
	pub skills:        Arc<omp_driver::discovery::skills::ActiveSkills>,
	/// The named dark-appearance theme the interactive host paints with:
	/// `cl_theme_dark` resolved against `--theme` paths and the theme
	/// directories; `None` is the stock dark palette.
	pub theme:         Option<Arc<omp_tui::JsonTheme>>,
	/// The independently persisted named light-appearance theme. An explicit
	/// `cl_theme`/`--use-theme` override fills both fields with the same fixed
	/// named theme.
	pub light_theme:   Option<Arc<omp_tui::JsonTheme>>,
	/// Every discovered named palette, retained for `/settings` runtime choices
	/// and observer-local preview.
	pub theme_catalog: Arc<omp_tui::ThemeCatalog>,
	pub live_sessions: Arc<omp_driver::sessions::SessionRegistry>,
	pub options:       KernelOptions,
}

impl Launch {
	/// Lowers every parsed launch argument onto its seam. Foreign-session
	/// imports (`--from-claude`/`--from-codex`) must already have rewritten the
	/// arguments into a `--resume`.
	pub(crate) async fn prepare(
		args: ChatArgs,
		ctx: Arc<omp_con::Ctx>,
		env: LaunchEnv,
	) -> miette::Result<Self> {
		let approval = args.effective_approval();
		let ChatArgs {
			// Resolved into `extension_launch` at the CLI boundary
			// (`cli.rs` dispatch) before any mode runs.
			extensions: _,
			model,
			provider,
			smol,
			slow,
			plan,
			models,
			provider_session,
			project,
			gateway,
			resume,
			continue_session,
			fork,
			from_claude,
			from_codex,
			no_session,
			session_dir,
			thinking,
			service_tier,
			// Folded into `approval` above (`--approval-mode` outranks `--yolo`).
			approval_mode: _,
			yolo: _,
			max_time,
			tools,
			no_tools,
			no_lsp,
			no_pty,
			plan_mode,
			plan_yolo,
			plan_yolo_into,
			prewalk,
			no_prewalk,
			prewalk_into,
			config,
			add_dir,
			skills,
			skill,
			no_skills,
			prompt_template,
			no_prompt_templates,
			theme,
			use_theme,
			no_context_files,
			no_rules,
			no_title,
			advisor,
			api_key,
			prompt_cache_key,
			py_eval,
			envd_idle_timeout,
			hide_thinking,
			external_thinking,
			extension_launch,
			prompt_settings,
			prompt,
		} = args;
		let session_dir = session_dir.or_else(|| {
			env::var_os("OMP_CODING_AGENT_SESSION_DIR")
				.filter(|value| !value.is_empty())
				.map(PathBuf::from)
		});
		let no_pty = no_pty || env::var_os("OMP_NO_PTY").is_some_and(|value| value == "1");
		if from_claude || from_codex {
			return Err(miette!(
				"foreign session imports must be resolved before launch (interactive chat only)"
			));
		}
		let LaunchEnv { data_dir, home, catalog } = env;
		let project = fs::canonicalize(&project).into_diagnostic()?;
		let environment_config = env::var_os("OMP_CONFIG_FILES")
			.filter(|value| !value.is_empty())
			.map(|value| env::split_paths(&value).collect::<Vec<_>>())
			.unwrap_or_default();
		for overlay in environment_config.iter().chain(&config) {
			let script = fs::read_to_string(overlay).into_diagnostic()?;
			ctx.exec(&script, omp_con::Source::Config(Str::new(overlay.to_string_lossy())))
				.into_diagnostic()?;
		}
		let add_dir = add_dir
			.iter()
			.map(|root| fs::canonicalize(root).into_diagnostic())
			.collect::<miette::Result<Vec<_>>>()?;
		apply_launch_convars(&ctx, &LaunchConvars {
			hide_thinking,
			service_tier,
			external_thinking,
			advisor,
			prewalk: if no_prewalk {
				Some(false)
			} else if prewalk || prewalk_into.is_some() {
				Some(true)
			} else {
				None
			},
			no_lsp,
			no_skills,
			skills: skills
				.as_ref()
				.map(|list| list.0.clone())
				.unwrap_or_default(),
			skill: &skill,
			use_theme,
			no_title,
			add_dir: &add_dir,
		})
		.into_diagnostic()?;
		let config_root = omp_core::dirs::profile_config_dir(&home).into_diagnostic()?;
		let templates =
			PromptTemplates::discover(&project, &config_root, &prompt_template, !no_prompt_templates);
		for warning in &templates.warnings {
			eprintln!("warning: {}: {}", warning.path.display(), warning.message);
		}
		let active_skills = Arc::new(
			omp_driver::discovery::skills::ActiveSkills::discover(&ctx, &project).into_diagnostic()?,
		);
		for warning in &active_skills.warnings {
			eprintln!("warning: {}: {}", warning.path.display(), warning.message);
		}
		let (theme, light_theme, theme_catalog) =
			resolve_theme(&ctx, &theme, &config_root, &project)?;

		let resuming = continue_session || resume.is_some() || fork.is_some();
		let settings = ModelSettings::from_con(&ctx).resolve_path_scopes(&project, &home);
		let roles = roles::resolve_launch_roles(
			catalog.as_ref(),
			&settings,
			None,
			smol.as_deref(),
			slow.as_deref(),
			plan.as_deref(),
		)
		.map_err(|source| miette!(source))?;
		let (scoped, scope) = match models.as_ref() {
			Some(patterns) => model_scope(catalog.as_ref(), &settings, &patterns.0),
			None => (settings.clone(), Vec::new()),
		};
		if models.is_some() && scope.is_empty() {
			return Err(miette!("--models matched no catalog model"));
		}
		let model_override = model.is_some();
		let model = model
			.or_else(|| {
				// A `--models` scope pins the first scoped model
				// unless the remembered default role resolves inside it.
				let first = scope.first()?;
				let remembered = roles.primary.as_ref().filter(|remembered| {
					roles::model_selector_allowed(catalog.as_ref(), &scoped, remembered.as_str())
				});
				Some(remembered.map_or_else(|| first.key.clone(), |key| Str::new(key.as_str())))
			})
			.or_else(|| roles.primary.as_ref().map(|value| Str::new(value.as_str())))
			.ok_or_else(|| miette!("launch requires a configured default model role"))?;
		if api_key.is_some() && !model_override && models.is_none() {
			return Err(miette!("--api-key requires a model to be specified via --model or --models"));
		}
		let thinking = thinking
			.map(|level| Str::new_static(<&'static str>::from(level)))
			.or_else(|| {
				(!resuming && !model_override)
					.then(|| scope.first().and_then(|first| first.thinking.clone()))
					.flatten()
			});
		let handoff = |selector: &str| {
			roles::resolve_role_selector(catalog.as_ref(), &settings, selector).map(|selected| {
				HandoffTarget {
					model:    Str::new(selected.model.as_str()),
					thinking: selected.thinking,
				}
			})
		};
		let plan_yolo_target = plan_yolo
			.then(|| {
				let selector = plan_yolo_into.as_deref().unwrap_or(SMOL_ROLE);
				handoff(selector)
					.map_err(|source| miette!("--plan-yolo-into: {selector} did not resolve: {source}"))
			})
			.transpose()?;
		let prewalk_target = if omp_ai::settings::AI_PREWALK_ENABLED.get(&ctx)
			&& (prewalk || prewalk_into.is_some() || !resuming)
		{
			// An unresolvable prewalk target warns and disarms rather than
			// locking the operator out of the app (issue #6064).
			let selector = prewalk_into.as_deref().unwrap_or(SMOL_ROLE);
			match handoff(selector) {
				Ok(target) => Some(target),
				Err(source) => {
					eprintln!("warning: prewalk disabled: {selector} did not resolve: {source}");
					omp_ai::settings::AI_PREWALK_ENABLED
						.set(&ctx, false)
						.into_diagnostic()?;
					None
				},
			}
		} else {
			None
		};

		let gateway = match gateway.as_ref() {
			Some(endpoint) => Some(endpoint.connect().await.into_diagnostic()?),
			None => None,
		};
		let live_sessions = Arc::new(omp_driver::sessions::SessionRegistry::new());
		let mut prompt_policy = prompt_overrides(&project, &home, &prompt_settings)?;
		prompt_policy.include_context_files = !no_context_files;
		prompt_policy.include_rules = !no_rules;
		prompt_policy.additional_roots = add_dir;
		let options = KernelOptions {
			continue_session,
			session: resume.as_ref().map(|value| PathBuf::from(value.as_str())),
			fork: fork.as_ref().map(|value| PathBuf::from(value.as_str())),
			sessions_dir: session_dir.clone(),
			ephemeral: no_session,
			no_tools,
			tools: tools.map(|tools| tools.0),
			no_pty,
			py_eval,
			spawn_idle_timeout: envd_idle_timeout,
			api_key: api_key.clone(),
			approval_mode: approval.map(Into::into),
			model_override,
			prompt: prompt_policy,
			discovered_skills: Some(Arc::clone(&active_skills)),
			extensions: driver_extension_policy(&extension_launch),
			provider: provider
				.as_ref()
				.map(|value| omp_catalog::ProviderId::from(value.as_str()))
				.or_else(|| {
					api_key.as_ref().and_then(|_| {
						model
							.split_once('/')
							.map(|(provider, _)| omp_catalog::ProviderId::from(provider))
					})
				}),
			gateway,
			sessions: Some(Arc::clone(&live_sessions)),
			session_name: None,
			parent_session: None,
			tool_registry: None,
			output_schema: None,
			schema_mode: None,
			prompt_cache_key,
			provider_session,
		};
		Ok(Self {
			data_dir,
			project,
			ctx,
			catalog,
			settings,
			scoped,
			roles,
			model,
			scope,
			thinking,
			plan_mode: plan_mode || plan_yolo,
			plan_yolo: plan_yolo_target,
			prewalk: prewalk_target,
			sessions_dir: session_dir,
			resuming,
			ephemeral: no_session,
			max_time: max_time.map(|duration| duration.0),
			prompt,
			templates: Arc::new(templates),
			skills: active_skills,
			theme,
			light_theme,
			theme_catalog,
			live_sessions,
			options,
		})
	}

	/// A leading `/skill:<name>` positional message expanded through the same
	/// discovered skill snapshot as the interactive console.
	pub(crate) fn initial_skill_prompt(&self) -> Option<omp_journal::data::SkillPrompt> {
		let command = self
			.prompt
			.iter()
			.find(|argument| !argument.starts_with('@'))?
			.strip_prefix("/skill:")?;
		if command.is_empty() {
			return None;
		}
		self.skills.prompt(command.as_str(), &[])
	}

	/// Expands one positional message through the invocation's prompt-template
	/// snapshot. Positional boundaries remain turn boundaries.
	pub(crate) fn expand_prompt(&self, text: &str) -> Str {
		self
			.templates
			.expand_line(text)
			.unwrap_or_else(|| Str::new(text))
	}

	/// Composes the kernel and applies the session-scoped launch overrides
	/// (`--thinking`, plan mode, prewalk target) after the journal opened, so
	/// an explicit flag outranks a resumed session's journaled values.
	pub(crate) async fn compose(
		&self,
	) -> miette::Result<(
		omp_agent::Kernel<omp_driver::headless::kernel::ComposedInference>,
		omp_session::Session,
	)> {
		let (kernel, mut session, _) = omp_driver::headless::kernel::compose_kernel(
			&self.data_dir,
			&self.project,
			self.model.as_str(),
			Arc::clone(&self.ctx),
			self.options.clone(),
		)
		.await
		.into_diagnostic()?;
		apply_launch_session(&self.ctx, &mut session, self)?;
		Ok((kernel, session))
	}

	/// The `--models` roster as the interactive cycle: `(name, key, thinking)`
	/// rows in flag order, or the role cycle when no scope was given.
	pub(crate) fn cycle(&self) -> Vec<(Str, Str, Option<Str>)> {
		if !self.scope.is_empty() {
			return self
				.scope
				.iter()
				.map(|entry| (entry.key.clone(), entry.key.clone(), entry.thinking.clone()))
				.collect();
		}
		let key_of =
			|key: &Option<omp_catalog::ModelKey>| key.as_ref().map(|key| Str::new(key.as_str()));
		let by_role = [
			("smol", key_of(&self.roles.smol), self.roles.smol_thinking.clone()),
			("default", Some(self.model.clone()), self.roles.primary_thinking.clone()),
			("slow", key_of(&self.roles.slow), self.roles.slow_thinking.clone()),
			("plan", key_of(&self.roles.plan), self.roles.plan_thinking.clone()),
		];
		self
			.settings
			.cycle_order
			.iter()
			.filter_map(|role| {
				by_role
					.iter()
					.find(|(name, ..)| *name == role.as_str())
					.and_then(|(name, key, thinking)| {
						key.clone()
							.map(|key| (Str::new_static(name), key, thinking.clone()))
					})
			})
			.collect()
	}
}

/// Stock palette name: `cl_theme`'s default, meaning "follow the terminal".
const STOCK_THEME: &str = "default";

/// Resolves the interactive dark and light palettes from their archived
/// `cl_theme_dark` / `cl_theme_light` profile choices against `--theme` paths,
/// then `<config root>/agent/themes`, then `<project>/.omp/themes`.
/// `cl_theme` (`--use-theme`) remains an explicit fixed
/// override and therefore fills both appearance slots with the same theme.
///
/// With the stock override name, the first `--theme` file is a fixed theme; an
/// unknown named choice warns and keeps that appearance's stock palette. A
/// broken explicit path is an error: the operator asked for it.
fn resolve_theme(
	ctx: &omp_con::Ctx,
	explicit: &[PathBuf],
	config_root: &Path,
	project: &Path,
) -> miette::Result<(
	Option<Arc<omp_tui::JsonTheme>>,
	Option<Arc<omp_tui::JsonTheme>>,
	Arc<omp_tui::ThemeCatalog>,
)> {
	let override_name = omp_chat::settings::CL_THEME.get(ctx);
	let automatic = override_name.is_empty() || override_name == STOCK_THEME;
	let catalog = omp_tui::ThemeCatalog::load(explicit, &[
		config_root.join("agent/themes"),
		project.join(".omp/themes"),
	])
	.into_diagnostic()?;
	for warning in &catalog.warnings {
		eprintln!("warning: {}: {}", warning.path.display(), warning.message);
	}
	let (dark, light) = if automatic && explicit.is_empty() {
		(
			resolve_named_theme(&catalog, &omp_chat::settings::CL_THEME_DARK.get(ctx), "titanium"),
			resolve_named_theme(&catalog, &omp_chat::settings::CL_THEME_LIGHT.get(ctx), "light"),
		)
	} else {
		let selected = if automatic {
			catalog.first_explicit()
		} else {
			resolve_named_theme(&catalog, &override_name, STOCK_THEME)
				.or_else(|| catalog.first_explicit())
		};
		(selected.clone(), selected)
	};
	Ok((dark, light, Arc::new(catalog)))
}

fn resolve_named_theme(
	catalog: &omp_tui::ThemeCatalog,
	name: &str,
	stock_name: &str,
) -> Option<Arc<omp_tui::JsonTheme>> {
	match catalog.get(name) {
		Some(theme) => Some(theme),
		None => {
			if !name.is_empty() && name != STOCK_THEME && name != stock_name {
				eprintln!("warning: theme `{name}` not found; using the stock palette");
			}
			None
		},
	}
}

/// The launch's prompt templates and skills as the chat console sees them.
struct InteractivePrompts {
	templates: Arc<PromptTemplates>,
	skills:    Arc<omp_driver::discovery::skills::ActiveSkills>,
}

impl omp_chat::commands::prompts::PromptExpander for InteractivePrompts {
	fn templates(&self) -> Vec<(Str, Str)> {
		self
			.templates
			.templates
			.iter()
			.map(|template| (template.name.clone(), template.description.clone()))
			.collect()
	}

	fn expand(&self, name: &str, args: &[Str]) -> Option<Str> {
		self.templates.expand(name, args)
	}
}

impl omp_chat::commands::prompts::SkillExpander for InteractivePrompts {
	fn skills(&self) -> Vec<(Str, Str)> {
		self
			.skills
			.skills
			.iter()
			.map(|skill| (skill.name.clone(), skill.description.clone()))
			.collect()
	}

	fn expand_skill(&self, name: &str, args: &[Str]) -> Option<omp_journal::data::SkillPrompt> {
		self.skills.prompt(name, args)
	}
}

/// Console values a launch commits before the kernel composes: the
/// invocation's archive-layer overrides (ADR 0012: the convar is the live
/// setting; the kernel and every projection read it from here).
pub(crate) struct LaunchConvars<'a> {
	pub hide_thinking:     bool,
	pub service_tier:      Option<omp_catalog::settings::TierSetting>,
	pub external_thinking: bool,
	pub advisor:           bool,
	/// `Some(true)` arms prewalk, `Some(false)` disables a configured prewalk,
	/// `None` leaves `ai_prewalk_enabled` alone.
	pub prewalk:           Option<bool>,
	pub no_lsp:            bool,
	pub no_skills:         bool,
	pub skills:            Vec<Str>,
	pub skill:             &'a [PathBuf],
	pub use_theme:         Option<Str>,
	pub no_title:          bool,
	/// Canonical additional workspace roots.
	pub add_dir:           &'a [PathBuf],
}

pub(crate) fn apply_launch_convars(
	ctx: &omp_con::Ctx,
	flags: &LaunchConvars<'_>,
) -> omp_con::ConResult<()> {
	if flags.hide_thinking {
		omp_chat::settings::CL_SHOWTHINKING.set(ctx, false)?;
	}
	if let Some(tier) = flags.service_tier.clone() {
		// `--service-tier` sets the OpenAI-family session tier.
		omp_catalog::settings::AI_TIER_OPENAI.set(ctx, tier)?;
	}
	if flags.external_thinking {
		omp_ai::settings::AI_EXTERNAL_THINKING.set(ctx, true)?;
	}
	if flags.advisor {
		omp_ai::settings::AI_ADVISOR_ENABLED.set(ctx, true)?;
	}
	if let Some(enabled) = flags.prewalk {
		omp_ai::settings::AI_PREWALK_ENABLED.set(ctx, enabled)?;
	}
	if flags.no_lsp {
		omp_envd::lsp_settings::SV_LSP_ENABLED.set(ctx, false)?;
	}
	if flags.no_skills {
		omp_envd::SV_SKILLS_ENABLED.set(ctx, false)?;
	}
	if !flags.skills.is_empty() {
		omp_envd::SV_SKILLS_INCLUDE.set(ctx, flags.skills.clone())?;
	}
	if !flags.skill.is_empty() {
		let mut roots = omp_envd::SV_SKILLS_CUSTOM_DIRECTORIES.get(ctx);
		roots.extend(
			flags
				.skill
				.iter()
				.map(|root| Str::new(root.to_string_lossy())),
		);
		omp_envd::SV_SKILLS_CUSTOM_DIRECTORIES.set(ctx, roots)?;
	}
	if let Some(theme) = flags.use_theme.clone() {
		omp_chat::settings::CL_THEME.set(ctx, theme)?;
	}
	if flags.no_title {
		omp_chat::chrome::CL_TITLE_STATE.set(ctx, false)?;
	}
	if !flags.add_dir.is_empty() {
		let extra = flags
			.add_dir
			.iter()
			.map(|root| Str::new(root.to_string_lossy()))
			.collect::<Vec<_>>();
		// `sv_sandbox_*_roots` are envd-private statics; the console addresses
		// them by name.
		for name in [SANDBOX_READABLE_ROOTS, SANDBOX_WRITABLE_ROOTS] {
			let mut roots = ctx.get_typed::<Vec<Str>>(name)?;
			for root in &extra {
				if !roots.contains(root) {
					roots.push(root.clone());
				}
			}
			ctx.set_typed(name, roots)?;
		}
	}
	Ok(())
}

/// Narrows `settings` to the `--models` patterns and lists the admitted
/// models in pattern order: each pattern contributes the catalog models it
/// admits once, carrying its explicit `:effort` suffix.
pub(crate) fn model_scope(
	catalog: &Catalog,
	settings: &ModelSettings,
	patterns: &[Str],
) -> (ModelSettings, Vec<ScopedModel>) {
	use omp_catalog::settings::{PathScopedStringEntry, model_pattern_matches};
	let mut scoped = settings.clone();
	scoped.enabled_models = patterns
		.iter()
		.map(|pattern| PathScopedStringEntry::Bare(pattern.clone()))
		.collect::<Vec<_>>()
		.into();
	let mut scope = Vec::<ScopedModel>::new();
	for pattern in patterns {
		let thinking = pattern
			.rsplit_once(':')
			.filter(|(_, suffix)| suffix.parse::<omp_catalog::ThinkingEffort>().is_ok())
			.map(|(_, suffix)| Str::new(suffix));
		for model in catalog.models() {
			let key = model.key.as_str();
			if scope.iter().any(|entry| entry.key == key) {
				continue;
			}
			let Some((provider, _)) = key.split_once('/') else {
				continue;
			};
			if model_pattern_matches(pattern, provider, key)
				&& roles::model_selector_allowed(catalog, &scoped, key)
			{
				scope.push(ScopedModel {
					pattern:  pattern.clone(),
					key:      Str::new(key),
					thinking: thinking.clone(),
				});
			}
		}
	}
	(scoped, scope)
}

/// Session-scoped launch overrides, applied after the journal opened.
fn apply_launch_session(
	ctx: &omp_con::Ctx,
	session: &mut omp_session::Session,
	launch: &Launch,
) -> miette::Result<()> {
	if let Some(level) = launch.thinking.clone() {
		omp_agent::AI_THINKING.set(ctx, level).into_diagnostic()?;
	}
	if let Some(target) = &launch.prewalk {
		AI_PREWALK_MODEL
			.set(ctx, selector_with_thinking(target))
			.into_diagnostic()?;
		let configured_model = omp_agent::AI_MODEL.get(ctx);
		let current_model = if configured_model.is_empty() {
			launch.model.as_str()
		} else {
			configured_model.as_str()
		};
		let current_thinking = omp_agent::AI_THINKING.get(ctx);
		let changes_model = current_model != target.model.as_str();
		let changes_thinking = target
			.thinking
			.as_ref()
			.is_some_and(|thinking| thinking.as_str() != current_thinking.as_str());
		if (changes_model || changes_thinking)
			&& omp_agent::find_director(session.dom(), "prewalk").is_none()
		{
			let registry = omp_agent::DirectorRegistry::standard();
			let mut stack = omp_agent::DirectorStack::from_dom(session.dom(), &registry);
			stack
				.engage(
					session,
					Box::new(omp_agent::directors::prewalk::Prewalk::new(
						target.model.clone(),
						target.thinking.clone(),
					)),
				)
				.into_diagnostic()?;
		}
	}
	apply_launch_plan(session, launch.plan_mode, launch.plan_yolo.as_ref()).into_diagnostic()?;
	omp_agent::directors::advisor::apply_launch(session, ctx).into_diagnostic()?;
	Ok(())
}

fn selector_with_thinking(target: &HandoffTarget) -> Str {
	match &target.thinking {
		Some(thinking) => Str::new(format!("{}:{thinking}", target.model)),
		None => target.model.clone(),
	}
}

/// Runs one interactive durable project-chat session.
#[cfg(any(unix, windows))]
#[expect(
	clippy::future_not_send,
	reason = "interactive hosts own thread-confined terminal or window scenes"
)]
pub(crate) async fn run(
	mut args: ChatArgs,
	start: ChatStart,
	presentation: ChatPresentation,
) -> miette::Result<()> {
	let imported = args.from_claude || args.from_codex;
	if imported {
		crate::session_import::prepare(&mut args)?;
	}

	let project = fs::canonicalize(&args.project).into_diagnostic()?;
	// The host's one console mailbox: bound `cl_*` commands and reply lines
	// reach the actor through it (ADR 0014).
	let ctx = Arc::new(crate::process_ctx_with(
		&project,
		omp_chat::HostMailbox::new().attach(omp_con::Ctx::builder()),
	)?);
	// Observer-only, due-coalesced, and intentionally outside every launch
	// dependency: the first frame and first prompt never await the network.
	let _startup_update = crate::startup_update::schedule(Arc::clone(&ctx));
	let env = LaunchEnv::production(&project, args.gateway.is_some())?;
	let launch = Launch::prepare(args, ctx, env).await?;
	let Launch {
		data_dir,
		project,
		ctx,
		catalog,
		model,
		live_sessions,
		sessions_dir,
		ephemeral,
		prompt: initial_prompt,
		..
	} = &launch;
	let resuming = launch.resuming || imported;
	// Prompt templates are `/name` console commands; a template named like a
	// built-in command is dropped.
	let interactive_prompts = Arc::new(InteractivePrompts {
		templates: Arc::clone(&launch.templates),
		skills:    Arc::clone(&launch.skills),
	});
	for reserved in omp_chat::commands::prompts::register(ctx, interactive_prompts.clone()) {
		eprintln!("warning: prompt template `{reserved}` shadows a built-in command; skipped");
	}
	if omp_driver::settings::SV_SKILLS_ENABLE_SKILL_COMMANDS.get(ctx) {
		for reserved in omp_chat::commands::prompts::register_skills(ctx, interactive_prompts) {
			eprintln!("warning: skill command `{reserved}` shadows a built-in command; skipped");
		}
	}
	let launch_inputs = launch_input::prepare(&launch, None, Vec::new())?;
	let (mut kernel, session) = launch.compose().await?;
	let live_auth = kernel
		.inference()
		.production_stack()
		.map(|stack| stack.auth_manager.clone());
	let ephemeral_path = ephemeral.then(|| session.journal_path().to_path_buf());
	// The host's one DOM channel: the controller relays every live session's
	// subscription onto it and publishes one `Reset` per session switch.
	let (relay_tx, dom_events) = flume::unbounded();
	let kernel_events = kernel.subscribe();
	// The interactive `ask` presenter: the tool waits on the host, which
	// answers the call identity through the controller.
	let ask_route = omp_driver::headless::AskRoute::new();
	// `/trace` reads the notifications the journal never carries.
	let trace = crate::chat_services::trace::TraceLog::record(
		kernel.subscribe(),
		&tokio::runtime::Handle::current(),
	);
	let up = kernel.mailbox();
	let (commands, command_rx) = flume::unbounded();
	let resize_policy = match omp_chat::settings::CL_RESIZE_POLICY.get(&ctx) {
		omp_chat::settings::ResizePolicy::Preserve => omp_tui::slots::ResizePolicy::Preserve,
		omp_chat::settings::ResizePolicy::Append => omp_tui::slots::ResizePolicy::Append,
		omp_chat::settings::ResizePolicy::Rebuild => omp_tui::slots::ResizePolicy::Rebuild,
	};
	let model_badge = {
		// A resumed session restores its journaled `ai_model` route; the
		// badge follows it rather than the launch default.
		let route = Some(omp_agent::AI_MODEL.get(&ctx))
			.filter(|route| !route.is_empty())
			.unwrap_or_else(|| model.clone());
		let spec = catalog
			.model(&omp_catalog::ModelKey::from(route.as_str()))
			.or_else(|| catalog.resolve_alias(route.as_str()));
		let mut badge = omp_chat::ModelBadge::from_identifier(
			spec.map_or(route.as_str(), |spec| spec.key.as_str()),
		);
		if let Some(spec) = spec {
			badge.name = spec.display_name.clone();
			badge.context_window = spec.limits.context_window;
			badge.reasoning = spec.thinking.is_some();
		}
		badge
	};
	// Picker roster and cycle for the model keybindings (alt+p/alt+m,
	// ctrl+p): catalog facts projected once at launch, never journaled. A
	// `--models` scope narrows the picker and becomes the cycle.
	let models = crate::pickers::model_rows(catalog.as_ref(), &launch.scoped);
	let cycle = launch.cycle();
	// Welcome-box facts: the previous sessions of this project (same
	// directory the kernel opened its journal in) and the language-server
	// roster the Environment discovers for it. Observer-local, never journaled.
	let welcome = {
		let sessions_dir = match sessions_dir.clone() {
			Some(dir) => dir,
			None => omp_env::project_state::directory(data_dir, project)
				.into_diagnostic()?
				.join("sessions"),
		};
		let recent = crate::welcome_facts::recent_sessions(&sessions_dir, session.journal_path());
		// The Environment's supervisor owns the live roster; a slow or absent
		// daemon degrades to the configuration projection rather than
		// delaying the first frame.
		let lsp = if omp_envd::lsp_settings::SV_LSP_ENABLED.get(&ctx) {
			let live = tokio::time::timeout(
				crate::welcome_facts::LSP_STATUS_BUDGET,
				kernel.inference().environment_client().lsp_status(false),
			)
			.await;
			match live {
				Ok(Ok(status)) => crate::welcome_facts::lsp_from_status(&status),
				Ok(Err(error)) => {
					tracing::debug!(%error, "lsp roster unavailable; projecting configuration");
					crate::welcome_facts::lsp_servers(project, Some(data_dir))
				},
				Err(_) => {
					tracing::debug!("lsp roster timed out; projecting configuration");
					crate::welcome_facts::lsp_servers(project, Some(data_dir))
				},
			}
		} else {
			Vec::new()
		};
		omp_chat::welcome::WelcomeFacts { recent, lsp }
	};
	// Application feeds behind the dashboards and account commands: engines
	// stay here, the actor only reads rows (ADR 0005).
	let live_journal = Arc::new(parking_lot::RwLock::new(session.journal_path().to_path_buf()));
	let (collab_authority, collab) = omp_driver::collab::session::CollabSessionAuthority::new();
	let _collab_owner = omp_driver::collab::session::spawn_session_owner(collab_authority);
	let (services, mutations): (
		Arc<dyn omp_chat::overlays::Services>,
		Arc<dyn omp_chat::overlays::services::Mutations>,
	) = {
		let composed = kernel.inference();
		let environment = composed.environment();
		let state_dir = omp_env::project_state::directory(data_dir, project).into_diagnostic()?;
		let services =
			Arc::new(crate::chat_services::AppServices::new(crate::chat_services::ServiceState {
				data_dir: data_dir.clone(),
				project: project.clone(),
				sessions_dir: sessions_dir
					.clone()
					.unwrap_or_else(|| state_dir.join("sessions")),
				state_dir,
				journal: session.journal_path().to_path_buf(),
				live_journal: Arc::clone(&live_journal),
				model: model.clone(),
				catalog: composed.catalog().cloned(),
				registry: Arc::clone(kernel.tool_registry()),
				con: Arc::clone(ctx),
				sessions: Arc::clone(live_sessions),
				collab: collab.clone(),
				env: composed.environment_client().clone(),
				mcp: environment.mcp_inspector(),
				reload: environment.extension_reload_handle(),
				memory: environment.memory_runtime(),
				stack: composed
					.production_stack()
					.map(crate::chat_services::StackHandles::from_stack),
				trace,
				theme_catalog: Arc::clone(&launch.theme_catalog),
				runtime: tokio::runtime::Handle::current(),
			}));
		(
			Arc::clone(&services) as Arc<dyn omp_chat::overlays::Services>,
			services as Arc<dyn omp_chat::overlays::services::Mutations>,
		)
	};
	// The vocalizer synthesizes through the Environment's media bridge; the
	// mode itself (`cl_speech_mode`) is read by the host per event.
	let speech: Option<Arc<dyn omp_chat::notices::voice::SpeechSynth>> =
		Some(Arc::new(crate::voice::synth::EnvSpeechSynth::new(
			kernel.inference().environment().search_bridge(),
			Arc::clone(ctx),
			kernel.inference().speech_rewriter(),
		)));
	let home = omp_driver::headless::kernel::SessionHome::new(
		data_dir,
		project,
		&omp_driver::headless::kernel::KernelOptions {
			sessions_dir: sessions_dir.clone(),
			sessions: Some(Arc::clone(live_sessions)),
			..omp_driver::headless::kernel::KernelOptions::default()
		},
		model.clone(),
		up.clone(),
	)
	.into_diagnostic()?
	.with_facts_of(&session);
	let env = kernel.inference().environment_client().clone();
	// Extension `omp.ui.*` requests (dialogs, presentation facts) and dynamic
	// `ask` invocations are owned by this chat for its lifetime. Direct ask
	// slots still project from their journaled element; nested `dyn ask`
	// requests open through the same typed owner.
	let chat_ui_owner = Arc::new(crate::chat_services::extension_ui::ChatUiOwner::new(
		Arc::clone(ctx),
		ask_route.clone(),
		Some(collab.clone()),
	));
	kernel
		.inference()
		.environment()
		.bind_ask_presenter(Arc::clone(&chat_ui_owner) as Arc<dyn omp_tools::ask::AskPresenter>);
	let _extension_ui = kernel
		.inference()
		.environment()
		.bind_domain_control_factories(omp_envd::exthost::ExternalDomainControlFactories {
			ui: Some(chat_ui_owner.factory()),
			..omp_envd::exthost::ExternalDomainControlFactories::default()
		});
	let (controller, snapshot) = crate::chat_control::Controller::new(
		kernel,
		session,
		home,
		relay_tx,
		Arc::clone(ctx),
		mutations,
		Arc::clone(&services),
		collab,
		Some(Arc::clone(catalog)),
		env,
		Arc::clone(&live_journal),
		data_dir.clone(),
		live_auth,
		ephemeral_path.clone(),
		ask_route,
	);
	let options = omp_chat::HostOptions {
		snapshot,
		dom_events,
		kernel_events,
		commands: commands.clone(),
		up: up.clone(),
		con: Arc::clone(ctx),
		models,
		cycle,
		resize_policy,
		model: model_badge,
		resuming,
		initial_panel: (start == ChatStart::SessionIndex).then_some(omp_chat::InitialPanel::Sessions),
		project: project.clone(),
		welcome,
		services,
		ui: omp_tui::UiContext::default()
			.with_appearance_palettes(launch.theme.clone(), launch.light_theme.clone()),
		speech,
	};
	let skill_prompt = (!launch_inputs.has_files)
		.then(|| launch.initial_skill_prompt())
		.flatten();
	if let Some(prompt) = skill_prompt {
		commands
			.send(omp_chat::HostCommand::SkillPrompt(prompt))
			.into_diagnostic()?;
	} else if let Some(first) = launch_inputs.first {
		let command = if first.attachments.is_empty() {
			omp_chat::HostCommand::Submit(first.text)
		} else {
			omp_chat::HostCommand::SubmitWithAttachments {
				text:        first.text,
				attachments: first.attachments,
			}
		};
		commands.send(command).into_diagnostic()?;
	}
	for follow_up in launch_inputs.follow_ups {
		commands
			.send(omp_chat::HostCommand::Queue { prompt: follow_up, attachments: Vec::new() })
			.into_diagnostic()?;
	}

	let controller = controller.run(command_rx);

	#[cfg(feature = "gui")]
	if presentation == ChatPresentation::Gui {
		let controller = tokio::spawn(controller);
		// The native actor owns exactly one controller shutdown request on
		// window/debug close; awaiting it here must not emit a second quit.
		crate::gui::run(options)?;
		controller.await.into_diagnostic()??;
		if let Some(path) = ephemeral_path {
			let _ = fs::remove_file(path);
		}
		return Ok(());
	}
	#[cfg(not(feature = "gui"))]
	if presentation == ChatPresentation::Gui {
		return Err(miette!("native GUI support was not included in this build"));
	}

	let signal_commands = commands.clone();
	let signal_task = tokio::spawn(async move {
		if let Ok(signal) = process_signal().await {
			let _ = signal_commands.send(omp_chat::HostCommand::ProcessSignal(signal));
		}
	});
	let host = omp_chat::Host::new(options).run();
	tokio::pin!(host);
	tokio::pin!(controller);
	let terminal_result: miette::Result<()> = tokio::select! {
		host_result = &mut host => match host_result.into_diagnostic() {
			Ok(()) => {
				let _ = commands.send(omp_chat::HostCommand::Quit);
				controller.await
			},
			Err(error) => Err(error),
		},
		controller_result = &mut controller => {
			// Dropping the controller closes the DOM/kernel feeds. Always let
			// the host observe that edge and restore the tty before propagating
			// a typed signal status.
			let host_result = host.await.into_diagnostic();
			controller_result.and(host_result)
		},
	};
	signal_task.abort();
	if let Some(path) = ephemeral_path {
		let _ = fs::remove_file(path);
	}
	terminal_result?;
	// `/restart`: the terminal is
	// restored and the session journaled its exit, so replace the process
	// image with the launch argv resuming this session. Returns only on
	// exec failure.
	if crate::chat_services::control::take_restart_request() {
		let prompts = initial_prompt.iter().map(Str::as_str).collect::<Vec<_>>();
		let journal = live_journal.read().clone();
		let resume = (!ephemeral).then_some(journal.as_path());
		let error = crate::chat_services::control::exec_restart(&prompts, resume);
		return Err(miette!("Restart exec failed: {error}"));
	}
	Ok(())
}

#[cfg(test)]
mod tests {
	use omp_catalog::settings::TierSetting;

	use super::*;
	use crate::cli::{SelectorList, ThinkingLevel};

	fn embedded() -> Arc<Catalog> {
		Arc::new(Catalog::embedded().clone())
	}

	fn test_env(root: &Path) -> LaunchEnv {
		LaunchEnv { data_dir: root.join("data"), home: root.join("home"), catalog: embedded() }
	}

	/// Every parsed `ChatArgs` field is consumed: the lowering destructures
	/// the struct exhaustively (compile-time), and this launch sets every
	/// launch-shaped flag and checks it reached its convar, `KernelOptions`
	/// field, or launch fact.
	#[tokio::test]
	async fn every_parsed_chat_arg_reaches_its_seam() {
		let dir = tempfile::tempdir().unwrap();
		let extra = dir.path().join("extra");
		fs::create_dir_all(&extra).unwrap();
		let overlay = dir.path().join("overlay.cfg");
		fs::write(&overlay, "ai_compact_threshold 0.5\n").unwrap();
		let mut args = ChatArgs::default_interactive();
		args.model = Some(Str::new_static("openai/gpt-5"));
		args.provider = Some(Str::new_static("openai"));
		args.models = Some(SelectorList(vec![Str::new_static("openai/gpt-5:low")]));
		args.provider_session = Some(Str::new_static("psid"));
		args.project = dir.path().to_path_buf();
		args.continue_session = true;
		args.session_dir = Some(dir.path().join("sessions"));
		args.thinking = Some(ThinkingLevel::High);
		args.service_tier = Some(TierSetting::Priority);
		args.yolo = true;
		args.max_time = Some(crate::cli::CliDuration(Duration::from_secs(7)));
		args.tools = Some(crate::cli::ToolNames(vec![Str::new_static("read")]));
		args.no_lsp = true;
		args.no_pty = true;
		args.plan_yolo = true;
		args.plan_yolo_into = Some(Str::new_static("openai/gpt-5:minimal"));
		args.prewalk_into = Some(Str::new_static("openai/gpt-5"));
		args.config = vec![overlay];
		args.add_dir = vec![extra.clone()];
		args.skills = Some(SelectorList(vec![Str::new_static("rust*")]));
		args.skill = vec![extra.clone()];
		fs::write(extra.join("review.md"), "---\ndescription: Review\n---\nReview $1 closely.\n")
			.unwrap();
		fs::write(extra.join("ocean.json"), r##"{"name":"Ocean","dark":{"accent":"#0000ff"}}"##)
			.unwrap();
		fs::create_dir_all(dir.path().join("home/.o2/agent/prompts")).unwrap();
		fs::write(dir.path().join("home/.o2/agent/prompts/discovered.md"), "Discovered $ARGUMENTS")
			.unwrap();
		args.prompt_template = vec![extra.clone()];
		args.no_prompt_templates = true;
		args.theme = vec![extra.clone()];
		args.use_theme = Some(Str::new_static("ocean"));
		args.no_context_files = true;
		args.no_rules = true;
		args.no_title = true;
		args.advisor = true;
		args.api_key = Some(omp_core::SecretString::from("k"));
		args.prompt_cache_key = Some(Str::new_static("cache"));
		args.py_eval = true;
		args.envd_idle_timeout = Some(3);
		args.hide_thinking = true;
		args.external_thinking = true;
		args.prompt = vec![Str::new_static("hello")];
		let ctx = Arc::new(omp_con::Ctx::new());
		let launch = Launch::prepare(args, Arc::clone(&ctx), test_env(dir.path()))
			.await
			.expect("launch lowers");
		let mut session = omp_session::Session::create(
			dir.path().join("launch.oms"),
			omp_session::ComponentRegistry::standard(),
		)
		.expect("launch session");
		apply_launch_session(&ctx, &mut session, &launch).expect("session launch applies");
		assert_eq!(
			session
				.dom()
				.count("directors director[family=advisor]")
				.expect("advisor selector"),
			1,
			"--advisor engages the journal-backed Director exactly once"
		);

		assert_eq!(omp_agent::AI_COMPACT_THRESHOLD.get(&ctx), 0.5, "--config overlay ran");
		assert_eq!(omp_catalog::settings::AI_TIER_OPENAI.get(&ctx), TierSetting::Priority);
		assert!(omp_ai::settings::AI_EXTERNAL_THINKING.get(&ctx));
		assert!(omp_ai::settings::AI_ADVISOR_ENABLED.get(&ctx));
		assert!(omp_ai::settings::AI_PREWALK_ENABLED.get(&ctx));
		assert!(!omp_envd::lsp_settings::SV_LSP_ENABLED.get(&ctx));
		assert!(!omp_chat::settings::CL_SHOWTHINKING.get(&ctx));
		assert!(!omp_chat::chrome::CL_TITLE_STATE.get(&ctx));
		assert_eq!(omp_chat::settings::CL_THEME.get(&ctx), "ocean");
		assert_eq!(
			launch.theme.as_ref().map(|theme| theme.name.as_str()),
			Some("Ocean"),
			"the explicit theme fills the dark appearance slot",
		);
		assert_eq!(
			launch.light_theme.as_ref().map(|theme| theme.name.as_str()),
			Some("Ocean"),
			"the explicit theme remains fixed across appearance changes",
		);
		assert_eq!(omp_envd::SV_SKILLS_INCLUDE.get(&ctx), vec![Str::new_static("rust*")]);
		let canonical = Str::new(fs::canonicalize(&extra).unwrap().to_string_lossy());
		assert!(
			omp_envd::SV_SKILLS_CUSTOM_DIRECTORIES
				.get(&ctx)
				.contains(&canonical)
				|| omp_envd::SV_SKILLS_CUSTOM_DIRECTORIES
					.get(&ctx)
					.contains(&Str::new(extra.to_string_lossy()))
		);
		for name in [SANDBOX_READABLE_ROOTS, SANDBOX_WRITABLE_ROOTS] {
			assert!(
				ctx.get_typed::<Vec<Str>>(name)
					.unwrap()
					.contains(&canonical),
				"{name}"
			);
		}

		assert_eq!(launch.model, "openai/gpt-5");
		assert_eq!(launch.scope.len(), 1);
		assert_eq!(launch.scope[0].thinking.as_deref(), Some("low"));
		assert_eq!(launch.thinking.as_deref(), Some("high"), "--thinking outranks the scope suffix");
		assert!(launch.plan_mode);
		assert_eq!(
			launch.plan_yolo,
			Some(HandoffTarget {
				model:    Str::new_static("openai/gpt-5"),
				thinking: Some(Str::new_static("minimal")),
			})
		);
		assert_eq!(launch.prewalk.as_ref().map(|target| target.model.as_str()), Some("openai/gpt-5"));
		assert!(launch.resuming);
		assert_eq!(launch.max_time, Some(Duration::from_secs(7)));
		assert_eq!(launch.prompt, vec![Str::new_static("hello")]);
		assert_eq!(launch.sessions_dir, Some(dir.path().join("sessions")));
		let templates = launch
			.templates
			.templates
			.iter()
			.map(|template| template.name.as_str())
			.collect::<Vec<_>>();
		assert_eq!(
			templates,
			["review"],
			"--prompt-template loads; --no-prompt-templates suppresses discovery"
		);
		assert_eq!(
			launch
				.templates
				.expand_line("/review src/lib.rs")
				.as_deref(),
			Some("Review src/lib.rs closely.")
		);
		let theme = launch
			.theme
			.as_ref()
			.expect("--theme file selected by cl_theme");
		assert_eq!(theme.name, "Ocean");
		assert_eq!(
			theme.for_appearance(omp_tui::Appearance::Dark).accent,
			omp_tui::Color::Rgb(0, 0, 255)
		);

		let options = &launch.options;
		assert!(options.continue_session);
		assert_eq!(options.sessions_dir, Some(dir.path().join("sessions")));
		assert_eq!(options.tools.as_deref(), Some(&[Str::new_static("read")][..]));
		assert!(options.no_pty);
		assert!(options.py_eval);
		assert_eq!(options.spawn_idle_timeout, Some(3));
		assert!(options.api_key.is_some());
		assert_eq!(options.approval_mode, Some(omp_envd::tool_settings::ApprovalMode::Yolo));
		assert!(options.model_override);
		assert_eq!(options.provider.as_ref().map(|provider| provider.as_str()), Some("openai"));
		assert_eq!(options.prompt_cache_key.as_deref(), Some("cache"));
		assert_eq!(options.provider_session.as_deref(), Some("psid"));
		assert!(!options.prompt.include_context_files);
		assert!(!options.prompt.include_rules, "--no-rules reaches the prompt policy");
		assert_eq!(options.prompt.additional_roots, vec![fs::canonicalize(&extra).unwrap()]);
	}

	#[tokio::test]
	async fn launch_inputs_keep_positional_turns_and_context_boundaries() {
		let dir = tempfile::tempdir().unwrap();
		fs::write(dir.path().join("note.txt"), "file body").unwrap();
		let mut args = ChatArgs::default_interactive();
		args.model = Some(Str::new_static("openai/gpt-5"));
		args.project = dir.path().to_path_buf();
		args.prompt =
			vec![Str::new_static("@note.txt"), Str::new_static("first"), Str::new_static("second")];
		let launch = Launch::prepare(args, Arc::new(omp_con::Ctx::new()), test_env(dir.path()))
			.await
			.expect("launch lowers");
		let inputs =
			launch_input::prepare(&launch, Some(Str::new_static("pipe body")), vec![Str::new_static(
				"third",
			)])
			.expect("launch inputs");
		let path = fs::canonicalize(dir.path().join("note.txt")).unwrap();
		assert_eq!(
			inputs.first.expect("first").text,
			Str::new(format!(
				"pipe body\n<file name=\"{}\">\nfile body\n</file>\nfirst",
				path.display()
			))
		);
		assert_eq!(inputs.follow_ups, [Str::new_static("second"), Str::new_static("third")]);
	}

	#[tokio::test]
	async fn prompt_templates_are_discovered_and_expand_the_initial_prompt() {
		let dir = tempfile::tempdir().unwrap();
		fs::create_dir_all(dir.path().join("home/.o2/agent/prompts")).unwrap();
		fs::write(dir.path().join("home/.o2/agent/prompts/fix.md"), "Fix $1 then run $2\n").unwrap();
		fs::create_dir_all(dir.path().join(".omp/prompts")).unwrap();
		fs::write(dir.path().join(".omp/prompts/plain.md"), "Plain body\n").unwrap();
		let mut args = ChatArgs::default_interactive();
		args.model = Some(Str::new_static("openai/gpt-5"));
		args.project = dir.path().to_path_buf();
		args.prompt = vec![Str::new_static("/fix lib.rs tests"), Str::new_static("follow-up")];
		let launch = Launch::prepare(args, Arc::new(omp_con::Ctx::new()), test_env(dir.path()))
			.await
			.expect("launch lowers");
		let inputs = launch_input::prepare(&launch, None, Vec::new()).expect("launch inputs");
		assert_eq!(
			inputs.first.as_ref().map(|input| input.text.as_str()),
			Some("Fix lib.rs then run tests")
		);
		assert_eq!(inputs.follow_ups, [Str::new_static("follow-up")]);
		assert_eq!(
			launch
				.templates
				.expand_line("/plain extra words")
				.as_deref(),
			Some("Plain body\n\nextra words"),
			"unreferenced words are appended"
		);
		assert!(launch.theme.is_none(), "stock dark palette without --theme or cl_theme");
		assert!(launch.light_theme.is_none(), "stock light palette without --theme or cl_theme");

		let ctx = omp_chat::HostMailbox::new()
			.attach(omp_con::Ctx::builder())
			.build();
		let reserved = omp_chat::commands::prompts::register(
			&ctx,
			Arc::new(InteractivePrompts {
				templates: Arc::clone(&launch.templates),
				skills:    Arc::clone(&launch.skills),
			}),
		);
		assert!(reserved.is_empty(), "{reserved:?}");
		ctx.run("fix a b").unwrap();
		let posted = ctx
			.user::<omp_chat::HostMailbox>()
			.unwrap()
			.drain()
			.find_map(|action| match action {
				omp_chat::HostAction::Command(omp_chat::commands::CommandAction::Prompt { text }) => {
					Some(text)
				},
				_ => None,
			});
		assert_eq!(posted.as_deref(), Some("Fix a then run b"));
	}

	#[test]
	fn archived_dark_and_light_names_resolve_independently() {
		let dir = tempfile::tempdir().unwrap();
		let themes = dir.path().join("home/.o2/agent/themes");
		fs::create_dir_all(&themes).unwrap();
		fs::write(
			themes.join("night.json"),
			r##"{"name":"Night","dark":{"accent":"#111111"},"light":{"accent":"#121212"}}"##,
		)
		.unwrap();
		fs::write(
			themes.join("day.json"),
			r##"{"name":"Day","dark":{"accent":"#dddddd"},"light":{"accent":"#eeeeee"}}"##,
		)
		.unwrap();
		let ctx = omp_con::Ctx::new();
		omp_chat::settings::CL_THEME_DARK
			.set(&ctx, Str::new_static("night"))
			.unwrap();
		omp_chat::settings::CL_THEME_LIGHT
			.set(&ctx, Str::new_static("day"))
			.unwrap();

		let (dark, light, _) =
			resolve_theme(&ctx, &[], &dir.path().join("home/.o2"), dir.path()).unwrap();
		let mut ui = omp_tui::UiContext::default().with_appearance_palettes(dark, light);
		assert_eq!(ui.theme.accent, omp_tui::Color::Rgb(0x11, 0x11, 0x11));
		assert!(ui.apply_appearance(omp_tui::Appearance::Light));
		assert_eq!(
			ui.theme.accent,
			omp_tui::Color::Rgb(0xee, 0xee, 0xee),
			"the persisted light name selects a different palette",
		);
		assert!(ui.apply_appearance(omp_tui::Appearance::Dark));
		assert_eq!(
			ui.theme.accent,
			omp_tui::Color::Rgb(0x11, 0x11, 0x11),
			"the persisted dark name survives a terminal appearance round trip",
		);
	}

	#[tokio::test]
	async fn unknown_theme_name_keeps_the_stock_palette_and_broken_theme_file_fails() {
		let dir = tempfile::tempdir().unwrap();
		let mut args = ChatArgs::default_interactive();
		args.model = Some(Str::new_static("openai/gpt-5"));
		args.project = dir.path().to_path_buf();
		args.use_theme = Some(Str::new_static("nope"));
		let launch =
			Launch::prepare(args.clone(), Arc::new(omp_con::Ctx::new()), test_env(dir.path()))
				.await
				.expect("launch lowers");
		assert!(launch.theme.is_none());
		assert!(launch.light_theme.is_none());

		let broken = dir.path().join("broken.json");
		fs::write(&broken, "{").unwrap();
		args.use_theme = None;
		args.theme = vec![broken];
		let error =
			match Launch::prepare(args, Arc::new(omp_con::Ctx::new()), test_env(dir.path())).await {
				Ok(_) => panic!("a broken explicit theme is an error"),
				Err(error) => error,
			};
		assert!(error.to_string().contains("invalid theme"), "{error}");
	}

	#[test]
	fn no_prewalk_disables_a_configured_prewalk() {
		let ctx = omp_con::Ctx::new();
		omp_ai::settings::AI_PREWALK_ENABLED
			.set(&ctx, true)
			.unwrap();
		apply_launch_convars(&ctx, &LaunchConvars {
			hide_thinking:     false,
			service_tier:      None,
			external_thinking: false,
			advisor:           false,
			prewalk:           Some(false),
			no_lsp:            false,
			no_skills:         true,
			skills:            Vec::new(),
			skill:             &[],
			use_theme:         None,
			no_title:          false,
			add_dir:           &[],
		})
		.unwrap();
		assert!(!omp_ai::settings::AI_PREWALK_ENABLED.get(&ctx));
		assert!(!omp_envd::SV_SKILLS_ENABLED.get(&ctx));
	}

	#[test]
	fn models_scope_orders_by_pattern_and_keeps_the_thinking_suffix() {
		let catalog = embedded();
		let settings = ModelSettings::default();
		let (scoped, scope) = model_scope(catalog.as_ref(), &settings, &[
			Str::new_static("openai/gpt-5:low"),
			Str::new_static("openai/gpt-5*"),
		]);
		assert_eq!(scope[0].key, "openai/gpt-5");
		assert_eq!(scope[0].thinking.as_deref(), Some("low"));
		assert!(scope.len() > 1, "the glob admits the gpt-5 family");
		assert!(
			scope
				.iter()
				.all(|entry| entry.key.starts_with("openai/gpt-5"))
		);
		assert!(!roles::model_selector_allowed(
			catalog.as_ref(),
			&scoped,
			"anthropic/claude-sonnet-4-5"
		));
	}

	#[tokio::test]
	async fn models_scope_pins_the_first_scoped_model_and_its_thinking_without_model() {
		let dir = tempfile::tempdir().unwrap();
		let mut args = ChatArgs::default_interactive();
		args.project = dir.path().to_path_buf();
		args.models = Some(SelectorList(vec![Str::new_static("openai/gpt-5:minimal")]));
		let launch = Launch::prepare(args, Arc::new(omp_con::Ctx::new()), test_env(dir.path()))
			.await
			.unwrap();
		assert_eq!(launch.model, "openai/gpt-5");
		assert!(!launch.options.model_override);
		assert_eq!(launch.thinking.as_deref(), Some("minimal"));
		assert_eq!(launch.cycle(), vec![(
			Str::new_static("openai/gpt-5"),
			Str::new_static("openai/gpt-5"),
			Some(Str::new_static("minimal"))
		)]);
	}

	#[tokio::test]
	async fn unresolvable_plan_yolo_target_fails_and_prewalk_target_disarms() {
		let dir = tempfile::tempdir().unwrap();
		let mut args = ChatArgs::default_interactive();
		args.project = dir.path().to_path_buf();
		args.model = Some(Str::new_static("openai/gpt-5"));
		args.plan_yolo = true;
		args.plan_yolo_into = Some(Str::new_static("nope/none"));
		let error = Launch::prepare(args, Arc::new(omp_con::Ctx::new()), test_env(dir.path()))
			.await
			.err()
			.expect("plan-yolo target must resolve");
		assert!(error.to_string().contains("--plan-yolo-into"));

		let mut args = ChatArgs::default_interactive();
		args.project = dir.path().to_path_buf();
		args.model = Some(Str::new_static("openai/gpt-5"));
		args.prewalk_into = Some(Str::new_static("nope/none"));
		let ctx = Arc::new(omp_con::Ctx::new());
		let launch = Launch::prepare(args, Arc::clone(&ctx), test_env(dir.path()))
			.await
			.unwrap();
		assert!(launch.prewalk.is_none());
		assert!(!omp_ai::settings::AI_PREWALK_ENABLED.get(&ctx), "disarmed, not armed blind");
	}

	#[test]
	fn plan_yolo_engages_the_plan_director_with_its_handoff_target() {
		let dir = tempfile::tempdir().unwrap();
		let path = dir.path().join("session.oms");
		let mut session =
			omp_session::Session::create(&path, omp_session::ComponentRegistry::standard()).unwrap();
		let target = HandoffTarget { model: Str::new_static("openai/gpt-5"), thinking: None };
		apply_launch_plan(&mut session, true, Some(&target)).unwrap();
		let dom = session.dom();
		let handle = dom
			.select("directors director[family=plan]")
			.unwrap()
			.next()
			.expect("plan engaged");
		let node = dom.get(handle).unwrap();
		assert_eq!(
			omp_agent::state_str(node, "yolo_into").as_deref(),
			Some("openai/gpt-5"),
			"the Plan director restores its hand-off target from this prop (plan.rs from_node)"
		);
		// Idempotent: a second engage keeps the single frame.
		apply_launch_plan(&mut session, true, None).unwrap();
		assert_eq!(
			session
				.dom()
				.select("directors director[family=plan]")
				.unwrap()
				.count(),
			1
		);
	}
}

/// `--plan-mode` / `--plan-yolo`: engages the plan Director before the first
/// turn; `--plan-yolo` arms its approval hand-off to `yolo`: plan,
/// auto-approve the proposal, switch to the target, and keep going.
pub(crate) fn apply_launch_plan(
	session: &mut omp_session::Session,
	plan_mode: bool,
	yolo: Option<&HandoffTarget>,
) -> Result<(), omp_agent::DirectorError> {
	if !plan_mode {
		return Ok(());
	}
	let mut plan = omp_agent::directors::plan::Plan::new(omp_chat::commands::plan::DEFAULT_PLAN);
	if let Some(target) = yolo {
		plan = plan.with_yolo(target.model.clone(), target.thinking.clone());
	}
	engage_plan(session, plan)
}

fn engage_plan(
	session: &mut omp_session::Session,
	plan: omp_agent::directors::plan::Plan,
) -> Result<(), omp_agent::DirectorError> {
	const PLAN: &str = "plan";
	let registry = omp_agent::DirectorRegistry::standard();
	let mut stack = omp_agent::DirectorStack::from_dom(session.dom(), &registry);
	if let Some((_, node)) = omp_agent::find_director(session.dom(), PLAN) {
		if omp_agent::director_status(node) == Some("paused") {
			stack.resume(session, PLAN)?;
		}
		return Ok(());
	}
	stack.engage(session, Box::new(plan)).map(drop)
}

/// Engages or resumes the plan Director, or pauses its journaled subtree
/// between turns. Approval exits it through the generic
/// Director command; a pause deliberately preserves plan and child state.
pub(crate) fn set_plan_mode(
	session: &mut omp_session::Session,
	engage: bool,
) -> Result<(), omp_agent::DirectorError> {
	const PLAN: &str = "plan";
	let registry = omp_agent::DirectorRegistry::standard();
	let mut stack = omp_agent::DirectorStack::from_dom(session.dom(), &registry);
	if engage {
		return engage_plan(
			session,
			omp_agent::directors::plan::Plan::new(omp_chat::commands::plan::DEFAULT_PLAN),
		);
	}
	stack.pause(session, PLAN)?;
	Ok(())
}

/// Guarantees a failed turn leaves a visible `<notice kind=error>` in its
/// turn: a no-op when the kernel already journaled one, otherwise the error
/// chain is appended and any open assistant is closed.
#[cfg(any(unix, windows))]
pub(crate) fn record_turn_failure(
	session: &mut omp_session::Session,
	error: &omp_agent::KernelError,
) -> Result<(), omp_session::SessionError> {
	use omp_dom::{KnownTag, NodeSpec, Op, PropId, Tag, Value};
	tracing::warn!(%error, "turn failed");
	let dom = session.dom();
	let Some(turn) = dom.children(dom.body()).last().copied() else {
		return Ok(());
	};
	let already = dom
		.children(turn)
		.last()
		.and_then(|handle| dom.get(*handle))
		.is_some_and(|node| {
			node.tag == Tag::Known(KnownTag::Notice)
				&& node.prop(&PropId::Kind.into()).and_then(Value::as_str) == Some("error")
		});
	if already {
		return Ok(());
	}
	let _ = session.assistant_end("error");
	let mut text = error.to_string();
	let mut source = std::error::Error::source(error);
	while let Some(cause) = source {
		text.push_str("\n  caused by: ");
		text.push_str(&cause.to_string());
		source = cause.source();
	}
	let Some(cause) = session.head() else {
		return Ok(());
	};
	session.patch(omp_dom::Txn {
		cause,
		label: Some(Str::new_static("chat.turn-failure")),
		ops: vec![Op::Ins {
			parent: turn,
			after:  session.dom().children(turn).last().copied(),
			node:   NodeSpec::new(KnownTag::Notice)
				.with_prop(PropId::Kind, Value::Str(Str::new_static("error")))
				.with_content(Str::new(text)),
		}],
	})?;
	Ok(())
}

/// Reports the platform limitation before touching project state.
#[cfg(not(any(unix, windows)))]
pub(crate) async fn run(
	_args: ChatArgs,
	_start: ChatStart,
	_presentation: ChatPresentation,
) -> miette::Result<()> {
	Err(miette!("interactive chat is not supported on this platform"))
}
