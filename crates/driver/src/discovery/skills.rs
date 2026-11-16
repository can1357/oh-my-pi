//! Skill discovery: `SKILL.md` declarations the runtime lists in the system
//! prompt (`<skills>`) and serves as `skill://<name>`.
//!
//! Sources: native `.omp/skills` (project walk-up) and
//! `<config root>/agent/skills`, then `.claude/skills`, Agent Plugins
//! packages, installed marketplace plugins (`installed_plugins.json`, enabled
//! installs only), `.agent[s]/skills`, opted-in user/project `.codex/skills`,
//! project `OpenCode` skills, then `sv_skills_custom_directories`, then the
//! isolated managed-skills root dead last. Within a name, the first source in
//! that order wins; a custom directory beats a default-path provider. Every
//! knob is a convar (`sv_skills_*`, `cl_disabled_extensions`), never a second
//! schema.

use std::{
	collections::{BTreeMap, BTreeSet},
	fs,
	path::{Component, Path, PathBuf},
	sync::Arc,
};

use omp_core::{CowBytes, Str};
use omp_envd::{self as envd_settings, ContentResolver};
use omp_ext::{
	claude_plugin::{ClaudePlugins, PluginLayout, PluginScope},
	workspace_trust::inventory::AGENT_PLUGIN_DIRS,
};
use omp_tools::read::{
	Fault,
	resolver::{
		LineOffsetCache, ResourceCompletion, ResourceEntry, ResourceList, Scheme, SchemeEntry,
		fuzzy_score,
	},
	selector::ParsedSelector,
};
use serde::Deserialize;

use crate::settings as driver_settings;

/// Where a skill source sits in the precedence ladder.
#[derive(Clone, Copy, Debug, Eq, PartialEq, strum::IntoStaticStr)]
#[strum(serialize_all = "lowercase")]
pub enum SkillLevel {
	/// Project walk-up roots.
	Project,
	/// Home/config-root roots.
	User,
}

/// One directory of `<name>/SKILL.md` declarations.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SkillSource {
	/// Provider identity (`native`, `claude`, `agents`, `codex`, `custom`,
	/// `omp-managed`).
	pub provider: Str,
	/// Directory holding named skill directories.
	pub root:     PathBuf,
	/// Precedence level.
	pub level:    SkillLevel,
}

/// One admitted skill.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Skill {
	/// Unique name (frontmatter `name`, else the directory name).
	pub name:        Str,
	/// Frontmatter description shown in the system prompt.
	pub description: Str,
	/// Canonical `SKILL.md` path.
	pub path:        PathBuf,
	/// Canonical directory `skill://<name>/<path>` resolves under.
	pub base_dir:    PathBuf,
	/// Provider identity of the winning source.
	pub provider:    Str,
	/// Precedence level of the winning source.
	pub level:       SkillLevel,
	/// Loaded and readable but omitted from the `<skills>` listing
	/// (frontmatter `hide` / `disable-model-invocation`).
	pub hidden:      bool,
	/// Skill instructions after frontmatter, retained for `/skill:<name>`.
	pub body:        Str,
}

/// Non-fatal discovery diagnostic.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SkillWarning {
	/// Source or declaration the warning is about.
	pub path:    PathBuf,
	/// Stable diagnostic text.
	pub message: Str,
}

/// Skill admission policy projected from the control plane.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SkillPolicy {
	/// `sv_skills_enabled`.
	pub enabled:            bool,
	/// `sv_skills_include` name globs; empty admits every name.
	pub include:            Vec<Str>,
	/// `sv_skills_ignore` name globs.
	pub ignore:             Vec<Str>,
	/// `skill:<name>` entries of `cl_disabled_extensions`.
	pub disabled:           BTreeSet<Str>,
	/// `sv_skills_custom_directories`.
	pub custom_directories: Vec<PathBuf>,
	/// `sv_skills_enable_pi_user`.
	pub native_user:        bool,
	/// `sv_skills_enable_pi_project`.
	pub native_project:     bool,
	/// `sv_skills_enable_claude_user`.
	pub claude_user:        bool,
	/// `sv_skills_enable_claude_project`.
	pub claude_project:     bool,
	/// `sv_skills_enable_agents_user`.
	pub agents_user:        bool,
	/// `sv_skills_enable_agents_project`.
	pub agents_project:     bool,
	/// `sv_skills_enable_codex_user`.
	pub codex_user:         bool,
}

impl Default for SkillPolicy {
	fn default() -> Self {
		Self {
			enabled:            true,
			include:            Vec::new(),
			ignore:             Vec::new(),
			disabled:           BTreeSet::new(),
			custom_directories: Vec::new(),
			native_user:        true,
			native_project:     true,
			claude_user:        false,
			claude_project:     true,
			agents_user:        true,
			agents_project:     true,
			codex_user:         false,
		}
	}
}

/// `cl_disabled_extensions` prefix naming one skill.
pub const SKILL_ID_PREFIX: &str = "skill:";

impl SkillPolicy {
	/// Projects the policy from the process console context.
	#[must_use]
	pub fn from_con(ctx: &omp_con::Ctx) -> Self {
		let home = omp_core::dirs::home_dir();
		Self {
			enabled:            envd_settings::SV_SKILLS_ENABLED.get(ctx),
			include:            envd_settings::SV_SKILLS_INCLUDE.get(ctx),
			ignore:             envd_settings::SV_SKILLS_IGNORE.get(ctx),
			disabled:           super::CL_DISABLED_EXTENSIONS
				.get(ctx)
				.iter()
				.filter_map(|id| id.strip_prefix(SKILL_ID_PREFIX))
				.map(Str::new)
				.collect(),
			custom_directories: envd_settings::SV_SKILLS_CUSTOM_DIRECTORIES
				.get(ctx)
				.iter()
				.map(|dir| expand_tilde(dir.as_str(), home.as_deref()))
				.collect(),
			native_user:        driver_settings::SV_SKILLS_ENABLE_PI_USER.get(ctx),
			native_project:     driver_settings::SV_SKILLS_ENABLE_PI_PROJECT.get(ctx),
			claude_user:        driver_settings::SV_SKILLS_ENABLE_CLAUDE_USER.get(ctx),
			claude_project:     driver_settings::SV_SKILLS_ENABLE_CLAUDE_PROJECT.get(ctx),
			agents_user:        driver_settings::SV_SKILLS_ENABLE_AGENTS_USER.get(ctx),
			agents_project:     driver_settings::SV_SKILLS_ENABLE_AGENTS_PROJECT.get(ctx),
			codex_user:         driver_settings::SV_SKILLS_ENABLE_CODEX_USER.get(ctx),
		}
	}

	fn admits_name(&self, name: &str) -> bool {
		!self.disabled.contains(name)
			&& !self
				.ignore
				.iter()
				.any(|pattern| glob_matches(pattern, name))
			&& (self.include.is_empty()
				|| self
					.include
					.iter()
					.any(|pattern| glob_matches(pattern, name)))
	}
}

/// The skills one session admitted, in name order.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ActiveSkills {
	/// Winning declarations, case-insensitively ordered by name.
	pub skills:   Vec<Skill>,
	/// Malformed, duplicate, and collision diagnostics.
	pub warnings: Vec<SkillWarning>,
}

impl ActiveSkills {
	/// Discovers skills for `project_root` under the process policy: the
	/// production entry `compose_kernel` calls once per session. `plugins`
	/// is the installed marketplace plugin set
	/// ([`omp_ext::claude_plugin::ClaudePlugins::resolve`]).
	///
	/// # Errors
	///
	/// [`omp_core::dirs::DataDirError::HomeUnset`] when no home is set.
	pub fn discover(
		ctx: &omp_con::Ctx,
		project_root: &Path,
		plugins: &ClaudePlugins,
	) -> Result<Self, omp_core::dirs::DataDirError> {
		Self::discover_with_sources(ctx, project_root, plugins, &[])
	}

	/// Discovers the ordinary skill roots plus installed marketplace plugins
	/// and manifest-sealed extension roots.
	///
	/// Extension skills sit below authored/custom roots and above the isolated
	/// managed-skills fallback. Their Python decorators are verified separately
	/// during extension FREEZE; this pass reads only already-materialized files.
	pub fn discover_with_sources(
		ctx: &omp_con::Ctx,
		project_root: &Path,
		plugins: &ClaudePlugins,
		extension_sources: &[SkillSource],
	) -> Result<Self, omp_core::dirs::DataDirError> {
		let home = omp_core::dirs::home_dir().ok_or(omp_core::dirs::DataDirError::HomeUnset)?;
		let config_root = omp_core::dirs::user_config_root()?;
		let policy = SkillPolicy::from_con(ctx);
		let all = ordered_sources(
			sources(project_root, &home, &config_root, &policy),
			plugins,
			extension_sources,
		);
		Ok(discover(&all, &policy))
	}

	/// Adds extension-owned sources below every skill already in this snapshot.
	///
	/// Interactive hosts may pre-discover authored skills before kernel
	/// composition. This merge preserves that precedence while still
	/// registering manifest-sealed extension skills in the shared resolver.
	pub fn merge_extension_sources(&mut self, sources: &[SkillSource], policy: &SkillPolicy) {
		let mut discovered = discover(sources, policy);
		self.warnings.append(&mut discovered.warnings);
		for skill in discovered.skills {
			if let Some(index) = self
				.skills
				.iter()
				.position(|existing| existing.name == skill.name)
			{
				let existing = &self.skills[index];
				let plugin_wins = skill.provider.as_str() == "agent-plugins"
					&& ["agents", "codex", "opencode", omp_contract::managed_skills::PROVIDER_ID]
						.contains(&existing.provider.as_str());
				if plugin_wins {
					self.skills[index] = skill;
				} else {
					self.warnings.push(SkillWarning {
						path:    skill.path,
						message: Str::new(format!(
							"name collision: \"{}\" already loaded from {}, skipping this one",
							skill.name,
							existing.path.display()
						)),
					});
				}
			} else {
				self.skills.push(skill);
			}
		}
		self.skills.sort_by(|left, right| {
			left
				.name
				.as_str()
				.to_ascii_lowercase()
				.cmp(&right.name.as_str().to_ascii_lowercase())
				.then_with(|| left.name.cmp(&right.name))
				.then_with(|| left.path.cmp(&right.path))
		});
	}

	/// The skill named `name`, when admitted.
	#[must_use]
	pub fn get(&self, name: &str) -> Option<&Skill> {
		self.skills.iter().find(|skill| skill.name.as_str() == name)
	}

	/// Every admitted name (the authored roster managed skills may never
	/// claim).
	#[must_use]
	pub fn names(&self) -> BTreeSet<Str> {
		self.skills.iter().map(|skill| skill.name.clone()).collect()
	}

	/// `{name, description}` rows for the system prompt's `<skills>` list;
	/// hidden skills stay reachable through `skill://` but are not listed.
	#[must_use]
	pub fn prompt_facts(&self) -> Vec<serde_json::Value> {
		self
			.skills
			.iter()
			.filter(|skill| !skill.hidden)
			.map(|skill| {
				serde_json::json!({ "name": skill.name.as_str(), "description": skill.description.as_str() })
			})
			.collect()
	}

	/// Builds the exact model-facing prompt for `/skill:<name> [args]`.
	///
	/// The canonical declaration path is retained as the source identity and
	/// the skill directory is embedded so relative assets resolve correctly.
	#[must_use]
	pub fn prompt(&self, name: &str, args: &[Str]) -> Option<omp_journal::data::SkillPrompt> {
		let skill = self.get(name)?;
		let joined = args.join(" ");
		let args = joined.trim();
		let body = skill.body.trim();
		let mut prompt = String::new();
		use std::fmt::Write as _;
		let _ = write!(
			prompt,
			"[IMPORTANT: User invoked the \"{}\" skill; follow its instructions. Full skill \
			 below.]\n\n{}\n\n---\n\n[Skill directory: {}]\nResolve relative paths in this skill \
			 (e.g. `scripts/foo.js`, `templates/config.yaml`) against this absolute directory; read \
			 referenced assets and templates; run scripts with the terminal tool when skill \
			 instructions call for it.",
			skill.name,
			body,
			skill.base_dir.display(),
		);
		if !args.is_empty() {
			let _ = write!(prompt, "\nUser: {args}");
		}
		Some(omp_journal::data::SkillPrompt {
			name:        skill.name.clone(),
			args:        (!args.is_empty()).then(|| Str::new(args)),
			path:        Str::new(skill.path.to_string_lossy()),
			prompt_body: Str::new(prompt.trim()),
			line_count:  if body.is_empty() {
				0
			} else {
				body.lines().count() as u64
			},
		})
	}

	/// The `skill://` resolver over this snapshot, installed through
	/// [`omp_envd::RegistryBridges::url_resolvers`].
	#[must_use]
	pub fn resolver(self: &Arc<Self>) -> Arc<dyn ContentResolver> {
		Arc::new(SkillResolver { skills: Arc::clone(self), lines: LineOffsetCache::default() })
	}
}

/// The isolated managed-skills root beneath the configuration root
/// ([`omp_contract::managed_skills`]); dead last in discovery.
#[must_use]
pub fn managed_skills_root(config_root: &Path) -> PathBuf {
	config_root.join("agent/managed-skills")
}

/// Splices installed-plugin and extension sources into the [`sources`] ladder.
///
/// Explicit `--ext` Agent Plugins, then installed marketplace plugins, sit
/// just above the `.agent[s]/skills` providers; other extension roots sit
/// below every authored root and above the isolated managed-skills fallback,
/// which stays dead last.
#[must_use]
pub fn ordered_sources(
	mut all: Vec<SkillSource>,
	plugins: &ClaudePlugins,
	extension_sources: &[SkillSource],
) -> Vec<SkillSource> {
	let managed = all.pop();
	let insertion = all
		.iter()
		.position(|source| source.provider.as_str() == "agents")
		.unwrap_or(all.len());
	let plugin_sources = extension_sources
		.iter()
		.filter(|source| source.provider.as_str() == "agent-plugins")
		.cloned()
		.chain(installed_plugin_skill_sources(plugins))
		.collect::<Vec<_>>();
	all.splice(insertion..insertion, plugin_sources);
	all.extend(
		extension_sources
			.iter()
			.filter(|source| source.provider.as_str() != "agent-plugins")
			.cloned(),
	);
	all.extend(managed);
	all
}

/// Provider identity of skills contributed by installed Claude-format
/// marketplace plugins.
pub const CLAUDE_PLUGINS_PROVIDER: &str = "claude-plugins";

/// Skill sources of installed, enabled marketplace plugins, project installs
/// first: each Claude-layout skills directory, or the Agent Plugins 1.0
/// source of an install packaged in that format.
#[must_use]
pub fn installed_plugin_skill_sources(plugins: &ClaudePlugins) -> Vec<SkillSource> {
	let mut out = Vec::new();
	for plugin in &plugins.plugins {
		let level = match plugin.scope {
			PluginScope::Project => SkillLevel::Project,
			PluginScope::User => SkillLevel::User,
		};
		match &plugin.layout {
			PluginLayout::Claude(components) => {
				out.extend(components.skills.iter().map(|root| SkillSource {
					provider: Str::new_static(CLAUDE_PLUGINS_PROVIDER),
					root: root.clone(),
					level,
				}));
			},
			PluginLayout::AgentPlugins => out.extend(agent_plugin_skill_source(&plugin.root, level)),
		}
	}
	out
}

/// The policy flag that admits one [`SKILL_SOURCES`] rule.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum SkillGate {
	/// Always admitted.
	Always,
	/// `sv_skills_enable_pi_project`.
	NativeProject,
	/// `sv_skills_enable_pi_user`.
	NativeUser,
	/// `sv_skills_enable_claude_user`.
	ClaudeUser,
	/// `sv_skills_enable_claude_project`.
	ClaudeProject,
	/// `sv_skills_enable_agents_project`.
	AgentsProject,
	/// `sv_skills_enable_agents_user`.
	AgentsUser,
	/// `sv_skills_enable_codex_user`.
	CodexUser,
}

impl SkillGate {
	fn admits(self, policy: &SkillPolicy) -> bool {
		match self {
			Self::Always => true,
			Self::NativeProject => policy.native_project,
			Self::NativeUser => policy.native_user,
			Self::ClaudeUser => policy.claude_user,
			Self::ClaudeProject => policy.claude_project,
			Self::AgentsProject => policy.agents_project,
			Self::AgentsUser => policy.agents_user,
			Self::CodexUser => policy.codex_user,
		}
	}
}

/// Where the directories of one [`SKILL_SOURCES`] rule come from. Every
/// variant names a data directory of `<name>/SKILL.md` declarations: discovery
/// reads files and never loads or runs foreign code (ADR 0036; ADR 0046
/// item 5).
#[derive(Clone, Copy, Debug)]
enum SkillRoot {
	/// Each relative path under every project walk-up root, closest root first.
	Ancestors(&'static [&'static str]),
	/// Each relative path under the home directory.
	Home(&'static [&'static str]),
	/// One relative path under the configuration root.
	Config(&'static str),
	/// One relative path under the project root.
	ProjectRoot(&'static str),
	/// The contained `skills` directory of every Agent Plugins package directly
	/// under each project container of [`AGENT_PLUGIN_DIRS`], in that order.
	ProjectPlugins,
	/// The same under one relative path of the configuration root.
	ConfigPlugins(&'static str),
	/// `sv_skills_custom_directories`, in order.
	Custom,
	/// The isolated managed-skills root ([`managed_skills_root`]).
	Managed,
}

/// One provider of [`SKILL_SOURCES`].
#[derive(Clone, Copy, Debug)]
struct SkillSourceRule {
	/// Provider identity of every source the rule produces.
	provider: &'static str,
	/// Where its directories come from.
	root:     SkillRoot,
	/// Precedence level of every source the rule produces.
	level:    SkillLevel,
	/// The policy flag that admits the rule.
	gate:     SkillGate,
}

/// Skill providers in precedence order: the table order is the vector order
/// of [`sources`], and [`ordered_sources`] relies on the first `agents` rule
/// and the final managed rule keeping their places. Claude and Codex
/// enumerate their opted-in user source before the project source; native and
/// `.agent[s]` retain project-first order.
const SKILL_SOURCES: [SkillSourceRule; 14] = [
	SkillSourceRule {
		provider: "native",
		root:     SkillRoot::Ancestors(&[".omp/skills"]),
		level:    SkillLevel::Project,
		gate:     SkillGate::NativeProject,
	},
	SkillSourceRule {
		provider: "native",
		root:     SkillRoot::Config("agent/skills"),
		level:    SkillLevel::User,
		gate:     SkillGate::NativeUser,
	},
	SkillSourceRule {
		provider: "claude",
		root:     SkillRoot::Home(&[".claude/skills"]),
		level:    SkillLevel::User,
		gate:     SkillGate::ClaudeUser,
	},
	SkillSourceRule {
		provider: "claude",
		root:     SkillRoot::Ancestors(&[".claude/skills"]),
		level:    SkillLevel::Project,
		gate:     SkillGate::ClaudeProject,
	},
	SkillSourceRule {
		provider: "agent-plugins",
		root:     SkillRoot::ProjectPlugins,
		level:    SkillLevel::Project,
		gate:     SkillGate::Always,
	},
	SkillSourceRule {
		provider: "agent-plugins",
		root:     SkillRoot::ConfigPlugins("extensions"),
		level:    SkillLevel::User,
		gate:     SkillGate::Always,
	},
	SkillSourceRule {
		provider: "agent-plugins",
		root:     SkillRoot::ConfigPlugins("agent/plugins"),
		level:    SkillLevel::User,
		gate:     SkillGate::Always,
	},
	SkillSourceRule {
		provider: "agents",
		root:     SkillRoot::Ancestors(&[".agent/skills", ".agents/skills"]),
		level:    SkillLevel::Project,
		gate:     SkillGate::AgentsProject,
	},
	SkillSourceRule {
		provider: "agents",
		root:     SkillRoot::Home(&[".agent/skills", ".agents/skills"]),
		level:    SkillLevel::User,
		gate:     SkillGate::AgentsUser,
	},
	SkillSourceRule {
		provider: "codex",
		root:     SkillRoot::Home(&[".codex/skills"]),
		level:    SkillLevel::User,
		gate:     SkillGate::CodexUser,
	},
	SkillSourceRule {
		provider: "codex",
		root:     SkillRoot::ProjectRoot(".codex/skills"),
		level:    SkillLevel::Project,
		gate:     SkillGate::Always,
	},
	SkillSourceRule {
		provider: "opencode",
		root:     SkillRoot::ProjectRoot(".opencode/skills"),
		level:    SkillLevel::Project,
		gate:     SkillGate::Always,
	},
	SkillSourceRule {
		provider: "custom",
		root:     SkillRoot::Custom,
		level:    SkillLevel::User,
		gate:     SkillGate::Always,
	},
	SkillSourceRule {
		provider: omp_contract::managed_skills::PROVIDER_ID,
		root:     SkillRoot::Managed,
		level:    SkillLevel::User,
		gate:     SkillGate::Always,
	},
];

impl SkillSourceRule {
	/// The directories the rule contributes, in precedence order.
	fn roots(
		&self,
		project_root: &Path,
		home: &Path,
		config_root: &Path,
		ancestors: &[PathBuf],
		policy: &SkillPolicy,
	) -> Vec<(PathBuf, SkillLevel)> {
		let level = self.level;
		match self.root {
			SkillRoot::Ancestors(relatives) => ancestors
				.iter()
				.flat_map(|dir| {
					relatives
						.iter()
						.map(move |relative| (dir.join(relative), level))
				})
				.collect(),
			SkillRoot::Home(relatives) => relatives
				.iter()
				.map(|relative| (home.join(relative), level))
				.collect(),
			SkillRoot::Config(relative) => vec![(config_root.join(relative), level)],
			SkillRoot::ProjectRoot(relative) => vec![(project_root.join(relative), level)],
			SkillRoot::ProjectPlugins => {
				let containers = AGENT_PLUGIN_DIRS
					.iter()
					.map(|relative| (project_root.join(relative), level))
					.collect::<Vec<_>>();
				agent_plugin_skill_roots(&containers)
			},
			SkillRoot::ConfigPlugins(relative) => {
				agent_plugin_skill_roots(&[(config_root.join(relative), level)])
			},
			SkillRoot::Custom => policy
				.custom_directories
				.iter()
				.map(|dir| (dir.clone(), level))
				.collect(),
			SkillRoot::Managed => vec![(managed_skills_root(config_root), level)],
		}
	}
}

/// Ordered skill sources for one project: precedence is the vector order.
#[must_use]
pub fn sources(
	project_root: &Path,
	home: &Path,
	config_root: &Path,
	policy: &SkillPolicy,
) -> Vec<SkillSource> {
	let ancestors = ancestors(project_root, home);
	let mut out = Vec::new();
	for rule in &SKILL_SOURCES {
		if !rule.gate.admits(policy) {
			continue;
		}
		out.extend(
			rule
				.roots(project_root, home, config_root, &ancestors, policy)
				.into_iter()
				.map(|(root, level)| SkillSource {
					provider: Str::new_static(rule.provider),
					root,
					level,
				}),
		);
	}
	out
}

const AGENT_PLUGIN_SCHEMA: &str = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";

#[derive(Deserialize)]
struct AgentPluginHeader {
	#[serde(rename = "$schema")]
	schema: Str,
	name:   Str,
}

fn agent_plugin_skill_roots(containers: &[(PathBuf, SkillLevel)]) -> Vec<(PathBuf, SkillLevel)> {
	let mut roots = Vec::new();
	for (container, level) in containers {
		let Ok(container_root) = fs::canonicalize(container) else {
			continue;
		};
		let Ok(entries) = fs::read_dir(container) else {
			continue;
		};
		let mut entries = entries.filter_map(Result::ok).collect::<Vec<_>>();
		entries.sort_by_key(std::fs::DirEntry::file_name);
		for entry in entries {
			let Ok(root) = fs::canonicalize(entry.path()) else {
				continue;
			};
			if !root.starts_with(&container_root) || !root.is_dir() {
				continue;
			}
			if let Some(source) = agent_plugin_skill_source(&root, *level) {
				roots.push((source.root, source.level));
			}
		}
	}
	roots
}

/// Reports whether `root` is a supported, contained Agent Plugins package.
#[must_use]
pub fn is_agent_plugin_root(root: &Path) -> bool {
	let Ok(root) = fs::canonicalize(root) else {
		return false;
	};
	let Ok(manifest) = fs::canonicalize(root.join("plugin.json")) else {
		return false;
	};
	if !manifest.starts_with(&root) {
		return false;
	}
	let Ok(body) = fs::read_to_string(manifest) else {
		return false;
	};
	let Ok(header) = serde_json::from_str::<AgentPluginHeader>(&body) else {
		return false;
	};
	header.schema == AGENT_PLUGIN_SCHEMA && safe_skill_name(&header.name)
}

/// Returns the contained skills source of one Agent Plugins 1.0 package.
///
/// A missing, malformed, unsupported, or symlink-escaping component is not a
/// Python extension and contributes no source.
#[must_use]
pub fn agent_plugin_skill_source(root: &Path, level: SkillLevel) -> Option<SkillSource> {
	let root = fs::canonicalize(root).ok()?;
	if !is_agent_plugin_root(&root) {
		return None;
	}
	let skills = fs::canonicalize(root.join("skills")).ok()?;
	if !skills.starts_with(&root) || !skills.is_dir() {
		return None;
	}
	Some(SkillSource { provider: Str::new_static("agent-plugins"), root: skills, level })
}

/// Scans `sources` in precedence order, admits each declaration through
/// `policy`, and resolves name collisions first-wins (a `custom` source
/// displaces a default-path provider; symlinked duplicates of one file are
/// dropped silently).
#[must_use]
pub fn discover(sources: &[SkillSource], policy: &SkillPolicy) -> ActiveSkills {
	let mut out = ActiveSkills::default();
	if !policy.enabled {
		return out;
	}
	let mut by_name = BTreeMap::<Str, usize>::new();
	let mut realpaths = BTreeSet::<PathBuf>::new();
	for source in sources {
		let managed = source.provider.as_str() == omp_contract::managed_skills::PROVIDER_ID;
		if managed && !managed_root_safe(&source.root) {
			continue;
		}
		for path in skill_files(&source.root, &mut out.warnings) {
			let Some(skill) = load_skill(source, &path, managed, &mut out.warnings) else {
				continue;
			};
			if !policy.admits_name(&skill.name) {
				continue;
			}
			if !realpaths.insert(skill.path.clone()) {
				continue;
			}
			match by_name.get(&skill.name) {
				Some(&index) => {
					let existing = &out.skills[index];
					if source.provider.as_str() == "custom" && existing.provider.as_str() != "custom" {
						out.skills[index] = skill;
					} else {
						out.warnings.push(SkillWarning {
							path:    skill.path,
							message: Str::new(format!(
								"name collision: \"{}\" already loaded from {}, skipping this one",
								skill.name,
								existing.path.display()
							)),
						});
					}
				},
				None => {
					by_name.insert(skill.name.clone(), out.skills.len());
					out.skills.push(skill);
				},
			}
		}
	}
	out.skills.sort_by(|left, right| {
		left
			.name
			.as_str()
			.to_ascii_lowercase()
			.cmp(&right.name.as_str().to_ascii_lowercase())
			.then_with(|| left.name.cmp(&right.name))
			.then_with(|| left.path.cmp(&right.path))
	});
	out
}

/// Project walk-up roots from `project_root` to its repository root (the
/// nearest ancestor holding `.git`), never crossing into or above the home
/// directory, closest first.
fn ancestors(project_root: &Path, home: &Path) -> Vec<PathBuf> {
	let mut out = Vec::new();
	let mut current = Some(project_root);
	while let Some(dir) = current {
		if dir == home {
			break;
		}
		out.push(dir.to_path_buf());
		if dir.join(".git").exists() {
			break;
		}
		current = dir.parent();
	}
	out
}

/// Direct `<child>/SKILL.md` declarations below `root`, sorted; hidden
/// children are skipped.
fn skill_files(root: &Path, warnings: &mut Vec<SkillWarning>) -> Vec<PathBuf> {
	let entries = match fs::read_dir(root) {
		Ok(entries) => entries,
		Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Vec::new(),
		Err(error) => {
			warnings.push(SkillWarning {
				path:    root.to_path_buf(),
				message: crate::fault_in("Failed to read skills directory", error),
			});
			return Vec::new();
		},
	};
	let mut files = entries
		.filter_map(Result::ok)
		.filter(|entry| !entry.file_name().to_string_lossy().starts_with('.'))
		.map(|entry| entry.path().join("SKILL.md"))
		.filter(|path| path.is_file())
		.collect::<Vec<_>>();
	files.sort();
	files
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SkillHeader {
	name:                     Option<String>,
	description:              Option<String>,
	#[serde(default)]
	enabled:                  Option<bool>,
	#[serde(default, alias = "hidden")]
	hide:                     bool,
	#[serde(default, alias = "disable-model-invocation")]
	disable_model_invocation: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AgentPluginSkillHeader {
	name:          String,
	description:   String,
	#[serde(default)]
	license:       Option<String>,
	#[serde(default, rename = "allowed-tools")]
	allowed_tools: Option<String>,
	#[serde(default)]
	metadata:      BTreeMap<String, String>,
	#[serde(default)]
	compatibility: Option<String>,
}

fn load_skill(
	source: &SkillSource,
	path: &Path,
	managed: bool,
	warnings: &mut Vec<SkillWarning>,
) -> Option<Skill> {
	let canonical = match fs::canonicalize(path) {
		Ok(canonical) => canonical,
		Err(error) => {
			warnings.push(SkillWarning {
				path:    path.to_path_buf(),
				message: crate::fault_in("Failed to read skill file", error),
			});
			return None;
		},
	};
	let contained = fs::canonicalize(&source.root).is_ok_and(|root| canonical.starts_with(root));
	if !contained {
		warnings.push(SkillWarning {
			path:    path.to_path_buf(),
			message: Str::new_static("skill declaration resolves outside its discovery root"),
		});
		return None;
	}
	if managed && !managed_file_safe(path) {
		warnings.push(SkillWarning {
			path:    path.to_path_buf(),
			message: Str::new_static("managed skill path is linked, oversized, or not a regular file"),
		});
		return None;
	}
	let text = match fs::read_to_string(&canonical) {
		Ok(text) => text,
		Err(error) => {
			warnings.push(SkillWarning {
				path:    canonical,
				message: crate::fault_in("Failed to read skill file", error),
			});
			return None;
		},
	};
	let header = if source.provider.as_str() == "agent-plugins" {
		let (Some(frontmatter), _) = super::rules::split_frontmatter(&text) else {
			warnings.push(SkillWarning {
				path:    canonical,
				message: Str::new_static("Agent Plugin skill requires YAML frontmatter"),
			});
			return None;
		};
		match serde_yaml::from_str::<AgentPluginSkillHeader>(frontmatter) {
			Ok(header) => {
				if header.license.as_deref().is_some_and(str::is_empty)
					|| header.allowed_tools.as_deref().is_some_and(str::is_empty)
					|| header
						.compatibility
						.as_deref()
						.is_some_and(|value| value.len() > 500)
					|| header.metadata.keys().any(String::is_empty)
				{
					warnings.push(SkillWarning {
						path:    canonical,
						message: Str::new_static("Agent Plugin skill frontmatter is invalid"),
					});
					return None;
				}
				SkillHeader {
					name: Some(header.name),
					description: Some(header.description),
					..SkillHeader::default()
				}
			},
			Err(error) => {
				warnings.push(SkillWarning {
					path:    canonical,
					message: crate::fault_in("failed to parse Agent Plugin skill frontmatter", error),
				});
				return None;
			},
		}
	} else {
		match parse_frontmatter(&text) {
			Ok(header) => header,
			Err(error) => {
				warnings.push(SkillWarning {
					path:    canonical,
					message: crate::fault_in("failed to parse SKILL.md frontmatter", error),
				});
				return None;
			},
		}
	};
	if header.enabled == Some(false) {
		return None;
	}
	let directory = canonical
		.parent()
		.and_then(Path::file_name)
		.and_then(|name| name.to_str())
		.unwrap_or("skill");
	let name = header
		.name
		.as_deref()
		.map(str::trim)
		.filter(|name| !name.is_empty())
		.unwrap_or(directory);
	if source.provider.as_str() == "agent-plugins"
		&& (name != directory
			|| name != name.to_ascii_lowercase()
			|| name.starts_with('-')
			|| name.ends_with('-')
			|| name.contains("--")
			|| name.len() > 64)
	{
		warnings.push(SkillWarning {
			path:    canonical,
			message: Str::new_static("Agent Plugin skill name must match its lowercase directory"),
		});
		return None;
	}
	if !safe_skill_name(name) {
		warnings.push(SkillWarning {
			path:    canonical,
			message: Str::new_static("skill name is not a safe directory-style identifier"),
		});
		return None;
	}
	if managed && !omp_contract::managed_skills::is_valid_name(name) {
		warnings.push(SkillWarning {
			path:    canonical,
			message: Str::new_static("managed skill name is not exact kebab-case"),
		});
		return None;
	}
	let description = header
		.description
		.as_deref()
		.map(str::trim)
		.unwrap_or_default();
	let description = if managed {
		omp_contract::managed_skills::sanitize_description(description)
	} else {
		Str::new(description)
	};
	if description.is_empty() {
		return None;
	}
	let base_dir = canonical
		.parent()
		.map(Path::to_path_buf)
		.unwrap_or_else(|| source.root.clone());
	let body = super::rules::split_frontmatter(&text).1.trim();
	Some(Skill {
		name: Str::new(name),
		description,
		path: canonical,
		base_dir,
		provider: source.provider.clone(),
		level: source.level,
		hidden: header.hide || header.disable_model_invocation,
		body: Str::new(body),
	})
}

fn parse_frontmatter(source: &str) -> Result<SkillHeader, serde_yaml::Error> {
	let Some(rest) = source.strip_prefix("---\n") else {
		return Ok(SkillHeader::default());
	};
	let Some((header, _)) = rest.split_once("\n---") else {
		return Ok(SkillHeader::default());
	};
	serde_yaml::from_str(header)
}

/// Returns whether a skill name is a safe, URL-addressable identifier.
#[must_use]
pub fn safe_skill_name(name: &str) -> bool {
	!name.is_empty()
		&& name != "."
		&& name != ".."
		&& name
			.bytes()
			.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

fn managed_root_safe(root: &Path) -> bool {
	fs::symlink_metadata(root)
		.is_ok_and(|metadata| !metadata.file_type().is_symlink() && metadata.is_dir())
}

fn managed_file_safe(path: &Path) -> bool {
	let Ok(file) = fs::symlink_metadata(path) else {
		return false;
	};
	let Some(directory) = path.parent() else {
		return false;
	};
	let Ok(directory) = fs::symlink_metadata(directory) else {
		return false;
	};
	!file.file_type().is_symlink()
		&& file.is_file()
		&& file.len() <= omp_contract::managed_skills::MAX_SKILL_BYTES as u64
		&& !directory.file_type().is_symlink()
		&& directory.is_dir()
}

fn expand_tilde(path: &str, home: Option<&Path>) -> PathBuf {
	match (path.strip_prefix("~/"), home) {
		(Some(rest), Some(home)) => home.join(rest),
		_ if path == "~" => home.map_or_else(|| PathBuf::from(path), Path::to_path_buf),
		_ => PathBuf::from(path),
	}
}

/// Small allocation-free wildcard matcher for configuration globs: `*`
/// spans any bytes and `?` one byte; repeated stars cover `**`.
#[must_use]
pub fn glob_matches(pattern: &str, candidate: &str) -> bool {
	let pattern = pattern.as_bytes();
	let candidate = candidate.as_bytes();
	let (mut p, mut c, mut star, mut retry) = (0, 0, None, 0);
	while c < candidate.len() {
		if p < pattern.len() && (pattern[p] == b'?' || pattern[p] == candidate[c]) {
			p += 1;
			c += 1;
		} else if p < pattern.len() && pattern[p] == b'*' {
			star = Some(p);
			p += 1;
			retry = c;
		} else if let Some(index) = star {
			p = index + 1;
			retry += 1;
			c = retry;
		} else {
			return false;
		}
	}
	while p < pattern.len() && pattern[p] == b'*' {
		p += 1;
	}
	p == pattern.len()
}

/// `skill://<name>` reads `SKILL.md`; `skill://<name>/<path>` reads a file
/// or lists a directory inside the skill's base directory, realpath-contained.
struct SkillResolver {
	skills: Arc<ActiveSkills>,
	lines:  LineOffsetCache,
}

impl SkillResolver {
	fn unknown(&self, name: &str) -> Fault {
		let available = self
			.skills
			.skills
			.iter()
			.map(|skill| skill.name.as_str())
			.collect::<Vec<_>>();
		let available = if available.is_empty() {
			"none".to_owned()
		} else {
			available.join(", ")
		};
		Fault::Source { message: Str::new(format!("Unknown skill: {name}\nAvailable: {available}")) }
	}

	/// Resolves `resource` to a contained filesystem target.
	fn target(&self, resource: &str) -> Result<(&Skill, PathBuf), Fault> {
		let (name, relative) = resource
			.split_once('/')
			.map_or((resource, ""), |(name, rest)| (name, rest.trim_start_matches('/')));
		if name.is_empty() {
			return Err(Fault::Invalid {
				message: Str::new_static("skill:// URL requires a skill name: skill://<name>"),
			});
		}
		let skill = self.skills.get(name).ok_or_else(|| self.unknown(name))?;
		if relative.is_empty() {
			return Ok((skill, skill.path.clone()));
		}
		let relative = Path::new(relative);
		if relative.is_absolute()
			|| relative.components().any(|component| {
				matches!(component, Component::ParentDir | Component::RootDir | Component::Prefix(_))
			}) {
			return Err(Fault::Invalid {
				message: Str::new_static("Path traversal (..) is not allowed in skill:// URLs"),
			});
		}
		let joined = skill.base_dir.join(relative);
		let resolved = fs::canonicalize(&joined).map_err(|_| Fault::Source {
			message: Str::new(format!("File not found: {}", joined.display())),
		})?;
		if !resolved.starts_with(&skill.base_dir) {
			return Err(Fault::Invalid {
				message: Str::new(format!(
					"skill:// path resolves outside the skill directory: skill://{resource}"
				)),
			});
		}
		Ok((skill, resolved))
	}

	fn index(&self) -> Vec<u8> {
		let mut text = String::from("# Skills\n\n");
		for skill in &self.skills.skills {
			text.push_str("- skill://");
			text.push_str(&skill.name);
			text.push_str(": ");
			text.push_str(&skill.description);
			text.push('\n');
		}
		text.into_bytes()
	}
}

#[async_trait::async_trait]
impl ContentResolver for SkillResolver {
	fn entry(&self) -> SchemeEntry {
		SchemeEntry::new(Scheme::Skill, true, false, "admitted SKILL.md documents and their files")
			.with_capabilities(true, true, true)
			.with_whole_body(true)
	}

	async fn read(
		&self,
		resource: &str,
		selector: &ParsedSelector,
	) -> Result<CowBytes<'static>, Fault> {
		if resource.is_empty() {
			return Ok(CowBytes::from(self.index()));
		}
		let (_, target) = self.target(resource)?;
		let bytes = if target.is_dir() {
			let listing = self.list(resource, usize::MAX, usize::MAX).await?;
			let mut text = String::new();
			for entry in listing.entries {
				text.push_str(&entry.uri);
				text.push('\n');
			}
			CowBytes::from(text.into_bytes())
		} else {
			CowBytes::from(fs::read(&target).map_err(|error| Fault::Source {
				message: crate::fault_in(format_args!("File not found: {}", target.display()), error),
			})?)
		};
		let ParsedSelector::Lines { ranges, .. } = selector else {
			return Ok(bytes);
		};
		let mut output = Vec::new();
		for range in ranges {
			let piece = self
				.lines
				.slice(resource, &bytes, *range)
				.map_err(|error| Fault::Invalid { message: crate::fault(error) })?;
			output.extend_from_slice(&piece);
		}
		Ok(CowBytes::from(output))
	}

	async fn list(
		&self,
		resource: &str,
		max_entries: usize,
		max_bytes: usize,
	) -> Result<ResourceList, Fault> {
		if resource.is_empty() {
			let mut entries = Vec::new();
			let mut truncated = false;
			for skill in &self.skills.skills {
				if entries.len() == max_entries {
					truncated = true;
					break;
				}
				entries.push(ResourceEntry {
					uri:       Str::new(format!("skill://{}", skill.name)),
					name:      skill.name.clone(),
					directory: true,
					size:      0,
				});
			}
			return Ok(ResourceList { entries, truncated });
		}
		let (skill, target) = self.target(resource)?;
		let directory = if !resource.contains('/') {
			skill.base_dir.clone()
		} else if target.is_dir() {
			target
		} else {
			return Err(Fault::Invalid {
				message: Str::new(format!("skill://{resource} is a file and cannot be listed.")),
			});
		};
		let prefix = resource.trim_end_matches('/');
		let mut children = fs::read_dir(&directory)
			.map_err(|error| Fault::Source {
				message: crate::fault_in(format_args!("Failed to list {}", directory.display()), error),
			})?
			.filter_map(Result::ok)
			.map(|entry| {
				let metadata = entry.metadata().ok();
				let is_dir = metadata.as_ref().is_some_and(fs::Metadata::is_dir);
				let size = metadata.map_or(0, |metadata| metadata.len());
				(entry.file_name().to_string_lossy().into_owned(), is_dir, size)
			})
			.collect::<Vec<_>>();
		children.sort();
		let mut entries = Vec::new();
		let mut bytes = 0usize;
		let mut truncated = false;
		for (name, is_dir, size) in children {
			let suffix = if is_dir { "/" } else { "" };
			let uri = format!("skill://{prefix}/{name}{suffix}");
			if entries.len() == max_entries || bytes.saturating_add(uri.len()) > max_bytes {
				truncated = true;
				break;
			}
			bytes += uri.len();
			entries.push(ResourceEntry {
				uri: Str::new(uri),
				name: Str::new(format!("{name}{suffix}")),
				directory: is_dir,
				size,
			});
		}
		Ok(ResourceList { entries, truncated })
	}

	async fn path(&self, resource: &str) -> Result<Option<Str>, Fault> {
		if resource.is_empty() {
			return Ok(None);
		}
		let (skill, target) = self.target(resource)?;
		let target = if resource.contains('/') {
			target
		} else {
			skill.base_dir.clone()
		};
		Ok(Some(Str::new(format!("file://{}", target.display()))))
	}

	async fn complete(
		&self,
		query: &str,
		max_results: usize,
	) -> Result<Vec<ResourceCompletion>, Fault> {
		let mut matches = self
			.skills
			.skills
			.iter()
			.filter_map(|skill| {
				fuzzy_score(query, &skill.name).map(|score| ResourceCompletion {
					value: Str::new(format!("skill://{}", skill.name)),
					description: skill.description.clone(),
					score,
				})
			})
			.collect::<Vec<_>>();
		matches.sort_by(|left, right| {
			right
				.score
				.cmp(&left.score)
				.then_with(|| left.value.cmp(&right.value))
		});
		matches.truncate(max_results);
		Ok(matches)
	}
}

#[cfg(test)]
mod tests {
	use std::fs;

	use omp_con::Value;
	use omp_ext::workspace_trust::WorkspaceTrust;

	use super::*;

	fn write_skill(root: &Path, dir: &str, frontmatter: &str, body: &str) -> PathBuf {
		let path = root.join(dir).join("SKILL.md");
		fs::create_dir_all(path.parent().unwrap()).unwrap();
		fs::write(&path, format!("---\n{frontmatter}\n---\n{body}")).unwrap();
		path
	}

	fn source(root: &Path, provider: &'static str, level: SkillLevel) -> SkillSource {
		SkillSource { provider: Str::new_static(provider), root: root.to_path_buf(), level }
	}

	fn install(registry: &Path, entries: &[(&str, &Path, bool)]) {
		let mut installed = omp_ext::claude_plugin::InstalledPluginsRegistry::default();
		for (id, path, enabled) in entries {
			installed.plugins.insert(Str::new(id), vec![
				omp_ext::claude_plugin::InstalledPluginEntry {
					scope:          omp_ext::claude_plugin::InstallScope::User,
					install_path:   path.to_path_buf(),
					version:        Str::new_static("1.0.0"),
					installed_at:   Str::new_static("2026-01-01T00:00:00Z"),
					last_updated:   Str::new_static("2026-01-01T00:00:00Z"),
					git_commit_sha: None,
					enabled:        *enabled,
				},
			]);
		}
		fs::create_dir_all(registry.parent().unwrap()).unwrap();
		fs::write(registry, serde_json::to_vec(&installed).unwrap()).unwrap();
	}

	#[test]
	fn installed_marketplace_plugin_skills_load_unless_disabled() {
		let tree = tempfile::tempdir().unwrap();
		let root = tree.path().canonicalize().unwrap();
		let (home, data, project) = (root.join("home"), root.join("data"), root.join("project"));
		fs::create_dir_all(&project).unwrap();
		let cache = data.join("plugins/cache/plugins");
		let enabled = cache.join("market___helper___1.0.0");
		let disabled = cache.join("market___quiet___1.0.0");
		let scoped = root.join("project-copy");
		write_skill(&enabled.join("skills"), "review", "description: plugin review", "b");
		write_skill(&disabled.join("skills"), "hush", "description: disabled plugin", "b");
		write_skill(&scoped.join("skills"), "local", "description: project plugin", "b");
		install(&data.join("plugins/installed_plugins.json"), &[
			("helper@market", &enabled, true),
			("quiet@market", &disabled, false),
		]);
		install(&project.join(".omp/plugins/installed_plugins.json"), &[(
			"scoped@market",
			&scoped,
			true,
		)]);

		let plugins = ClaudePlugins::resolve(&data, &project, None, WorkspaceTrust::Trusted);
		assert!(plugins.diagnostics.is_empty(), "{:?}", plugins.diagnostics);
		let policy = SkillPolicy::default();
		let all =
			ordered_sources(sources(&project, &home, &home.join(".o2"), &policy), &plugins, &[]);
		let plugin_at = all
			.iter()
			.position(|source| source.provider.as_str() == CLAUDE_PLUGINS_PROVIDER)
			.expect("plugin source");
		let agents_at = all
			.iter()
			.position(|source| source.provider.as_str() == "agents")
			.unwrap();
		assert!(plugin_at < agents_at);
		let active = discover(&all, &policy);
		let found = active
			.skills
			.iter()
			.map(|skill| (skill.name.as_str(), skill.provider.as_str(), skill.level))
			.collect::<Vec<_>>();
		assert_eq!(found, [
			("local", CLAUDE_PLUGINS_PROVIDER, SkillLevel::Project),
			("review", CLAUDE_PLUGINS_PROVIDER, SkillLevel::User),
		]);
		assert_eq!(active.get("review").unwrap().base_dir, enabled.join("skills/review"));
	}

	#[test]
	fn skills_are_admitted_from_ordered_sources_with_first_wins_and_custom_override() {
		let tree = tempfile::tempdir().unwrap();
		let project = tree.path().join("project");
		let user = tree.path().join("user");
		let custom = tree.path().join("custom");
		write_skill(&project, "review", "description: project review", "project body");
		write_skill(&user, "review", "description: user review", "user body");
		write_skill(&user, "debug", "name: Debug-It\ndescription: debug things", "debug body");
		write_skill(&user, "nodesc", "name: nodesc", "no description");
		write_skill(&user, "off", "description: disabled\nenabled: false", "off");
		write_skill(&custom, "debug", "description: custom debug", "custom body");
		let sources = [
			source(&project, "native", SkillLevel::Project),
			source(&user, "native", SkillLevel::User),
			source(&custom, "custom", SkillLevel::User),
		];
		let active = discover(&sources, &SkillPolicy::default());
		let names = active
			.skills
			.iter()
			.map(|skill| (skill.name.as_str(), skill.description.as_str()))
			.collect::<Vec<_>>();
		assert_eq!(names, [
			("debug", "custom debug"),
			("Debug-It", "debug things"),
			("review", "project review")
		]);
		assert_eq!(active.get("review").unwrap().level, SkillLevel::Project);
		assert_eq!(active.warnings.len(), 1, "{:?}", active.warnings);
		assert!(active.warnings[0].message.contains("name collision"));
	}

	#[test]
	fn codex_and_opencode_project_sources_follow_agents_precedence() {
		let tree = tempfile::tempdir().unwrap();
		let home = tree.path().join("home");
		let project = home.join("work/project");
		let config = home.join(".o2");
		fs::create_dir_all(&project).unwrap();
		let plugin = project.join(".agent/plugins/portable");
		fs::create_dir_all(plugin.join("skills")).unwrap();
		fs::write(
			plugin.join("plugin.json"),
			r#"{"$schema":"https://agent-plugins.org/schemas/1.0.0/plugin.schema.json","name":"portable"}"#,
		)
		.unwrap();
		let sources = sources(&project, &home, &config, &SkillPolicy::default());
		let providers = sources
			.iter()
			.map(|source| (source.provider.as_str(), source.root.clone()))
			.collect::<Vec<_>>();
		let codex = providers
			.iter()
			.position(|(provider, path)| {
				provider == &"codex" && path == &project.join(".codex/skills")
			})
			.expect("Codex project source");
		let opencode = providers
			.iter()
			.position(|(provider, path)| {
				provider == &"opencode" && path == &project.join(".opencode/skills")
			})
			.expect("OpenCode project source");
		let plugin = providers
			.iter()
			.position(|(provider, _)| provider == &"agent-plugins")
			.expect("Agent Plugin source");
		let agents = providers
			.iter()
			.position(|(provider, _)| provider == &"agents")
			.expect("agents source");
		assert!(plugin < agents);
		assert!(agents < codex);
		assert!(codex < opencode);
	}

	#[cfg(unix)]
	#[test]
	fn linked_skill_outside_provider_root_is_rejected_without_hiding_siblings() {
		use std::os::unix::fs::symlink;

		let tree = tempfile::tempdir().unwrap();
		let root = tree.path().join("skills");
		let outside = tree.path().join("outside");
		write_skill(&root, "inside", "name: inside\ndescription: inside", "inside");
		write_skill(&outside, "escape", "name: escape\ndescription: escape", "escape");
		fs::create_dir_all(&root).unwrap();
		symlink(outside.join("escape"), root.join("escape")).unwrap();
		let active =
			discover(&[source(&root, "agent-plugins", SkillLevel::Project)], &SkillPolicy::default());
		assert!(active.get("inside").is_some());
		assert!(active.get("escape").is_none());
		assert!(
			active
				.warnings
				.iter()
				.any(|warning| warning.message.contains("outside its discovery root"))
		);
	}

	#[test]
	fn extension_skill_sources_merge_below_pre_discovered_authored_skills() {
		let tree = tempfile::tempdir().unwrap();
		let authored = tree.path().join("authored");
		let extension = tree.path().join("extension");
		write_skill(&authored, "review", "description: authored", "authored");
		write_skill(&extension, "review", "description: extension", "extension");
		write_skill(&extension, "deploy", "description: deploy", "deploy");
		let mut active =
			discover(&[source(&authored, "native", SkillLevel::Project)], &SkillPolicy::default());
		active.merge_extension_sources(
			&[source(&extension, "extension:test", SkillLevel::Project)],
			&SkillPolicy::default(),
		);

		assert_eq!(active.get("review").unwrap().body, "authored");
		assert_eq!(active.get("deploy").unwrap().provider, "extension:test");
		assert_eq!(active.warnings.len(), 1);
		assert!(active.warnings[0].message.contains("name collision"));
	}

	#[test]
	fn skill_command_prompt_preserves_source_args_and_exact_model_body() {
		let tree = tempfile::tempdir().unwrap();
		let root = tree.path().join("skills");
		let path =
			write_skill(&root, "review", "description: review code", "First line.\nSecond line.");
		let active =
			discover(&[source(&root, "native", SkillLevel::Project)], &SkillPolicy::default());
		let prompt = active
			.prompt("review", &[Str::new_static("src/lib.rs"), Str::new_static("carefully")])
			.expect("skill prompt");
		assert_eq!(prompt.name, "review");
		assert_eq!(prompt.path.as_str(), fs::canonicalize(path).unwrap().to_string_lossy().as_ref());
		assert_eq!(prompt.args.as_deref(), Some("src/lib.rs carefully"));
		assert_eq!(prompt.line_count, 2);
		assert_eq!(
			prompt.prompt_body,
			format!(
				"[IMPORTANT: User invoked the \"review\" skill; follow its instructions. Full skill \
				 below.]\n\nFirst line.\nSecond line.\n\n---\n\n[Skill directory: {}]\nResolve \
				 relative paths in this skill (e.g. `scripts/foo.js`, `templates/config.yaml`) \
				 against this absolute directory; read referenced assets and templates; run scripts \
				 with the terminal tool when skill instructions call for it.\nUser: src/lib.rs \
				 carefully",
				fs::canonicalize(root.join("review")).unwrap().display()
			)
		);
	}

	#[test]
	fn policy_filters_ignore_include_disabled_and_master_switch() {
		let tree = tempfile::tempdir().unwrap();
		let root = tree.path().join("skills");
		for name in ["alpha", "beta", "gamma"] {
			write_skill(&root, name, &format!("description: {name}"), name);
		}
		let sources = [source(&root, "native", SkillLevel::User)];
		let names = |policy: &SkillPolicy| {
			discover(&sources, policy)
				.skills
				.into_iter()
				.map(|skill| skill.name)
				.collect::<Vec<_>>()
		};
		let policy = SkillPolicy { ignore: vec![Str::new_static("be*")], ..SkillPolicy::default() };
		assert_eq!(names(&policy), ["alpha", "gamma"]);
		let policy =
			SkillPolicy { include: vec![Str::new_static("g?mma")], ..SkillPolicy::default() };
		assert_eq!(names(&policy), ["gamma"]);
		let policy = SkillPolicy {
			disabled: [Str::new_static("alpha")].into_iter().collect(),
			..SkillPolicy::default()
		};
		assert_eq!(names(&policy), ["beta", "gamma"]);
		let policy = SkillPolicy { enabled: false, ..SkillPolicy::default() };
		assert!(names(&policy).is_empty());
	}

	#[test]
	fn hidden_skills_are_readable_but_not_listed_in_prompt_facts() {
		let tree = tempfile::tempdir().unwrap();
		let root = tree.path().join("skills");
		write_skill(&root, "shown", "description: shown", "s");
		write_skill(&root, "hidden", "description: hidden\nhide: true", "h");
		write_skill(&root, "manual", "description: manual\ndisable-model-invocation: true", "m");
		let active = discover(&[source(&root, "native", SkillLevel::User)], &SkillPolicy::default());
		assert_eq!(active.skills.len(), 3);
		let facts = active.prompt_facts();
		assert_eq!(facts.len(), 1);
		assert_eq!(facts[0]["name"], "shown");
		assert_eq!(facts[0]["description"], "shown");
	}

	#[test]
	fn policy_projects_convars_including_disabled_skill_ids() {
		let ctx = omp_con::Ctx::new();
		ctx.set(
			"cl_disabled_extensions",
			Value::List(vec![
				Value::Str(Str::new_static("skill:review")),
				Value::Str(Str::new_static("acme.reviewer")),
			]),
			omp_con::Origin::Host,
		)
		.unwrap();
		ctx.set(
			"sv_skills_ignore",
			Value::List(vec![Value::Str(Str::new_static("tmp-*"))]),
			omp_con::Origin::Host,
		)
		.unwrap();
		ctx.set("sv_skills_enable_claude_user", Value::Bool(true), omp_con::Origin::Host)
			.unwrap();
		let policy = SkillPolicy::from_con(&ctx);
		assert_eq!(policy.disabled, [Str::new_static("review")].into_iter().collect());
		assert_eq!(policy.ignore, [Str::new_static("tmp-*")]);
		assert!(policy.claude_user);
		assert!(!policy.codex_user);
		assert!(policy.enabled);
	}

	#[test]
	fn sources_follow_pi_precedence_and_walk_up_to_the_repo_root() {
		let tree = tempfile::tempdir().unwrap();
		let home = tree.path().join("home");
		let repo = home.join("work/repo");
		let nested = repo.join("crates/app");
		fs::create_dir_all(repo.join(".git")).unwrap();
		fs::create_dir_all(&nested).unwrap();
		let config = home.join(".o2");
		let policy = SkillPolicy {
			custom_directories: vec![PathBuf::from("/opt/skills")],
			..SkillPolicy::default()
		};
		let roots = sources(&nested, &home, &config, &policy)
			.into_iter()
			.map(|source| (source.provider, source.root, source.level))
			.collect::<Vec<_>>();
		let expect =
			|provider: &str, root: PathBuf, level: SkillLevel| (Str::new(provider), root, level);
		assert_eq!(roots, [
			expect("native", nested.join(".omp/skills"), SkillLevel::Project),
			expect("native", repo.join("crates/.omp/skills"), SkillLevel::Project),
			expect("native", repo.join(".omp/skills"), SkillLevel::Project),
			expect("native", config.join("agent/skills"), SkillLevel::User),
			expect("claude", nested.join(".claude/skills"), SkillLevel::Project),
			expect("claude", repo.join("crates/.claude/skills"), SkillLevel::Project),
			expect("claude", repo.join(".claude/skills"), SkillLevel::Project),
			expect("agents", nested.join(".agent/skills"), SkillLevel::Project),
			expect("agents", nested.join(".agents/skills"), SkillLevel::Project),
			expect("agents", repo.join("crates/.agent/skills"), SkillLevel::Project),
			expect("agents", repo.join("crates/.agents/skills"), SkillLevel::Project),
			expect("agents", repo.join(".agent/skills"), SkillLevel::Project),
			expect("agents", repo.join(".agents/skills"), SkillLevel::Project),
			expect("agents", home.join(".agent/skills"), SkillLevel::User),
			expect("agents", home.join(".agents/skills"), SkillLevel::User),
			expect("codex", nested.join(".codex/skills"), SkillLevel::Project),
			expect("opencode", nested.join(".opencode/skills"), SkillLevel::Project),
			expect("custom", PathBuf::from("/opt/skills"), SkillLevel::User),
			expect("omp-managed", config.join("agent/managed-skills"), SkillLevel::User),
		]);
	}

	#[tokio::test]
	async fn skill_uri_reads_skill_md_and_contained_files_only() {
		let tree = tempfile::tempdir().unwrap();
		let root = tree.path().join("skills");
		write_skill(&root, "review", "description: review code", "Review body");
		fs::create_dir_all(root.join("review/refs")).unwrap();
		fs::write(root.join("review/refs/checklist.md"), "- check\n").unwrap();
		fs::write(tree.path().join("secret.txt"), "secret").unwrap();
		#[cfg(unix)]
		std::os::unix::fs::symlink(tree.path().join("secret.txt"), root.join("review/leak.txt"))
			.unwrap();
		let active =
			Arc::new(discover(&[source(&root, "native", SkillLevel::User)], &SkillPolicy::default()));
		let resolver = active.resolver();
		assert_eq!(resolver.entry().scheme, Scheme::Skill);
		let body = resolver
			.read("review", &ParsedSelector::None)
			.await
			.unwrap();
		assert!(std::str::from_utf8(&body).unwrap().ends_with("Review body"));
		let nested = resolver
			.read("review/refs/checklist.md", &ParsedSelector::None)
			.await
			.unwrap();
		assert_eq!(&*nested, b"- check\n");
		let index = resolver.read("", &ParsedSelector::None).await.unwrap();
		assert!(
			std::str::from_utf8(&index)
				.unwrap()
				.contains("skill://review: review code")
		);
		let missing = resolver
			.read("nope", &ParsedSelector::None)
			.await
			.unwrap_err();
		assert_eq!(missing.message().as_str(), "Unknown skill: nope\nAvailable: review");
		let traversal = resolver
			.read("review/../secret.txt", &ParsedSelector::None)
			.await
			.unwrap_err();
		assert!(traversal.message().contains("traversal"));
		#[cfg(unix)]
		{
			let leak = resolver
				.read("review/leak.txt", &ParsedSelector::None)
				.await
				.unwrap_err();
			assert!(leak.message().contains("outside the skill directory"), "{leak:?}");
		}
		let listing = resolver.list("review", 16, 4096).await.unwrap();
		let names = listing
			.entries
			.iter()
			.map(|entry| entry.name.as_str())
			.collect::<Vec<_>>();
		assert!(names.contains(&"SKILL.md") && names.contains(&"refs/"), "{names:?}");
		let completions = resolver.complete("rev", 5).await.unwrap();
		assert_eq!(completions[0].value.as_str(), "skill://review");
	}

	/// One rung of the full ladder with every policy flag on: the bit of the
	/// flag that admits it (`None` = always), provider, directory and level.
	type Rung = (Option<u32>, &'static str, PathBuf, SkillLevel);

	const NATIVE_PROJECT: Option<u32> = Some(0);
	const NATIVE_USER: Option<u32> = Some(1);
	const CLAUDE_USER: Option<u32> = Some(2);
	const CLAUDE_PROJECT: Option<u32> = Some(3);
	const AGENTS_PROJECT: Option<u32> = Some(4);
	const AGENTS_USER: Option<u32> = Some(5);
	const CODEX_USER: Option<u32> = Some(6);

	struct Ladder {
		home:    PathBuf,
		project: PathBuf,
		config:  PathBuf,
		custom:  Vec<PathBuf>,
		rungs:   Vec<Rung>,
	}

	/// The expected precedence, written out by hand from the pre-table
	/// `sources()` so the table is checked against an independent oracle. The
	/// project sits one level below its repository root, so every walk-up rung
	/// appears twice, closest first.
	fn ladder(root: &Path) -> Ladder {
		let (home, config) = (root.join("home"), root.join("config"));
		let repo = home.join("work/repo");
		let project = repo.join("pkg");
		fs::create_dir_all(repo.join(".git")).unwrap();
		fs::create_dir_all(&project).unwrap();
		let (project_level, user_level) = (SkillLevel::Project, SkillLevel::User);
		// Package containers in discovery order with their packages in creation
		// order; the sources of one container are expected sorted by name.
		let containers: [(PathBuf, SkillLevel, &[&str]); 5] = [
			(project.join(".omp/extensions"), project_level, &["ext"]),
			(project.join(".agent/plugins"), project_level, &["zeta", "alpha"]),
			(project.join(".agents/plugins"), project_level, &["mid", "beta"]),
			(config.join("extensions"), user_level, &["cfgext"]),
			(config.join("agent/plugins"), user_level, &["shared"]),
		];
		let mut plugin_rungs: Vec<Rung> = Vec::new();
		for (container, level, names) in &containers {
			for name in *names {
				let plugin = container.join(name);
				fs::create_dir_all(plugin.join("skills")).unwrap();
				fs::write(
					plugin.join("plugin.json"),
					format!(
						r#"{{"$schema":"https://agent-plugins.org/schemas/1.0.0/plugin.schema.json","name":"{name}"}}"#
					),
				)
				.unwrap();
			}
			let mut sorted = names.to_vec();
			sorted.sort_unstable();
			plugin_rungs.extend(
				sorted
					.into_iter()
					.map(|name| (None, "agent-plugins", container.join(name).join("skills"), *level)),
			);
		}
		let custom = vec![root.join("custom-a"), root.join("custom-b")];
		let mut rungs: Vec<Rung> = vec![
			(NATIVE_PROJECT, "native", project.join(".omp/skills"), project_level),
			(NATIVE_PROJECT, "native", repo.join(".omp/skills"), project_level),
			(NATIVE_USER, "native", config.join("agent/skills"), user_level),
			(CLAUDE_USER, "claude", home.join(".claude/skills"), user_level),
			(CLAUDE_PROJECT, "claude", project.join(".claude/skills"), project_level),
			(CLAUDE_PROJECT, "claude", repo.join(".claude/skills"), project_level),
		];
		rungs.extend(plugin_rungs);
		for dir in [&project, &repo] {
			rungs.push((AGENTS_PROJECT, "agents", dir.join(".agent/skills"), project_level));
			rungs.push((AGENTS_PROJECT, "agents", dir.join(".agents/skills"), project_level));
		}
		rungs.extend([
			(AGENTS_USER, "agents", home.join(".agent/skills"), user_level),
			(AGENTS_USER, "agents", home.join(".agents/skills"), user_level),
			(CODEX_USER, "codex", home.join(".codex/skills"), user_level),
			(None, "codex", project.join(".codex/skills"), project_level),
			(None, "opencode", project.join(".opencode/skills"), project_level),
		]);
		rungs.extend(
			custom
				.iter()
				.map(|dir| (None, "custom", dir.clone(), user_level)),
		);
		rungs.push((
			None,
			omp_contract::managed_skills::PROVIDER_ID,
			config.join("agent/managed-skills"),
			user_level,
		));
		Ladder { home, project, config, custom, rungs }
	}

	fn policy_for(mask: u32, custom: &[PathBuf]) -> SkillPolicy {
		let on = |bit: u32| (mask >> bit) & 1 == 1;
		SkillPolicy {
			native_project: on(0),
			native_user: on(1),
			claude_user: on(2),
			claude_project: on(3),
			agents_project: on(4),
			agents_user: on(5),
			codex_user: on(6),
			custom_directories: custom.to_vec(),
			..SkillPolicy::default()
		}
	}

	#[test]
	fn skill_source_precedence_is_pinned_for_every_policy_flag_combination() {
		let tree = tempfile::tempdir().unwrap();
		let ladder = ladder(&tree.path().canonicalize().unwrap());
		// Seven independent flags gate `sources()`: 2^7 combinations.
		// Seven independent flags gate `sources()`: 2^7 combinations, with and
		// without custom directories.
		for custom in [ladder.custom.clone(), Vec::new()] {
			for mask in 0..128_u32 {
				let policy = policy_for(mask, &custom);
				let produced = sources(&ladder.project, &ladder.home, &ladder.config, &policy)
					.into_iter()
					.map(|source| (source.provider.as_str().to_owned(), source.root, source.level))
					.collect::<Vec<_>>();
				let expected = ladder
					.rungs
					.iter()
					.filter(|(gate, provider, ..)| {
						(*provider != "custom" || !custom.is_empty())
							&& gate.is_none_or(|bit| (mask >> bit) & 1 == 1)
					})
					.map(|(_, provider, root, level)| ((*provider).to_owned(), root.clone(), *level))
					.collect::<Vec<_>>();
				assert_eq!(produced, expected, "policy mask {mask:#09b}, {} custom", custom.len());
				// Marketplace plugin sources are spliced in by `ordered_sources`,
				// never produced by the provider table.
				assert!(
					produced
						.iter()
						.all(|(provider, ..)| provider != CLAUDE_PLUGINS_PROVIDER)
				);
			}
		}
	}

	#[test]
	fn default_skill_frontmatter_drops_agentskills_optional_fields() {
		let tree = tempfile::tempdir().unwrap();
		let root = tree.path().join("skills");
		write_skill(
			&root,
			"portable",
			concat!(
				"name: portable\n",
				"description: keeps loading\n",
				"license: MIT\n",
				"compatibility: linux\n",
				"metadata:\n",
				"  omp/models: unused\n",
				"allowed-tools: bash read\n",
				"enabled: true",
			),
			"body",
		);
		let active =
			discover(&[source(&root, "native", SkillLevel::Project)], &SkillPolicy::default());
		let skill = active.get("portable").expect("optional Agent Skills fields must not reject");
		assert_eq!(skill.description.as_str(), "keeps loading");
		assert_eq!(skill.body.as_str(), "body");
		assert!(!skill.hidden);
	}

	#[test]
	fn agent_plugin_skill_discards_optional_fields_after_validation() {
		let tree = tempfile::tempdir().unwrap();
		let root = tree.path().join("skills");
		write_skill(
			&root,
			"portable",
			concat!(
				"name: portable\n",
				"description: plugin portable\n",
				"license: MIT\n",
				"compatibility: os\n",
				"metadata:\n",
				"  key: value\n",
				"allowed-tools: Read",
			),
			"plugin body",
		);
		let active = discover(
			&[source(&root, "agent-plugins", SkillLevel::Project)],
			&SkillPolicy::default(),
		);
		let skill = active.get("portable").expect("validated optional fields are discarded, not fatal");
		assert_eq!(skill.description.as_str(), "plugin portable");
		assert_eq!(skill.body.as_str(), "plugin body");
		assert_eq!(skill.provider.as_str(), "agent-plugins");
	}

	#[test]
	fn agent_plugin_skill_rejects_empty_allowed_tools() {
		let tree = tempfile::tempdir().unwrap();
		let root = tree.path().join("skills");
		write_skill(
			&root,
			"broken",
			concat!("name: broken\n", "description: empty tools\n", "allowed-tools: \"\""),
			"body",
		);
		let active = discover(
			&[source(&root, "agent-plugins", SkillLevel::Project)],
			&SkillPolicy::default(),
		);
		assert!(active.get("broken").is_none());
		assert!(
			active
				.warnings
				.iter()
				.any(|warning| warning.message.contains("frontmatter is invalid")),
			"{:?}",
			active.warnings
		);
	}

	#[test]
	fn agent_plugin_skill_rejects_omp_enabled_as_unknown_field() {
		let tree = tempfile::tempdir().unwrap();
		let root = tree.path().join("skills");
		write_skill(
			&root,
			"native-only",
			concat!(
				"name: native-only\n",
				"description: omp enabled is unknown here\n",
				"enabled: false",
			),
			"body",
		);
		let active = discover(
			&[source(&root, "agent-plugins", SkillLevel::Project)],
			&SkillPolicy::default(),
		);
		assert!(active.get("native-only").is_none());
		assert!(
			active
				.warnings
				.iter()
				.any(|warning| warning.message.contains("failed to parse Agent Plugin skill frontmatter")),
			"{:?}",
			active.warnings
		);
	}

	#[test]
	fn skill_source_table_names_data_directories_only() {
		let known = [
			"native",
			"claude",
			"agent-plugins",
			"agents",
			"codex",
			"opencode",
			"custom",
			omp_contract::managed_skills::PROVIDER_ID,
		];
		let contained = |relative: &str| {
			let path = Path::new(relative);
			path.is_relative()
				&& !path
					.components()
					.any(|part| matches!(part, Component::ParentDir))
		};
		let skills_dir = |relative: &str| {
			Path::new(relative)
				.file_name()
				.and_then(|name| name.to_str())
				== Some("skills")
		};
		for rule in &SKILL_SOURCES {
			assert!(known.contains(&rule.provider), "unknown provider {}", rule.provider);
			match rule.root {
				SkillRoot::Ancestors(relatives) | SkillRoot::Home(relatives) => {
					for relative in relatives {
						assert!(contained(relative), "{relative}");
						assert!(skills_dir(relative), "{relative}");
					}
				},
				SkillRoot::Config(relative) | SkillRoot::ProjectRoot(relative) => {
					assert!(contained(relative), "{relative}");
					assert!(skills_dir(relative), "{relative}");
				},
				// A package container yields only the contained `skills` directory
				// of a manifest-checked Agent Plugins package.
				SkillRoot::ProjectPlugins => {
					assert_eq!(rule.provider, "agent-plugins");
					for relative in AGENT_PLUGIN_DIRS {
						assert!(contained(relative), "{relative}");
					}
				},
				SkillRoot::ConfigPlugins(relative) => {
					assert!(contained(relative), "{relative}");
					assert_eq!(rule.provider, "agent-plugins");
				},
				SkillRoot::Custom => assert_eq!(rule.provider, "custom"),
				SkillRoot::Managed => {
					assert_eq!(rule.provider, omp_contract::managed_skills::PROVIDER_ID);
				},
			}
		}
		// ADR 0036 and ADR 0046 item 5: discovery reads data and never loads or
		// runs foreign code, so the production half of this module holds no
		// process-spawn or dynamic-load API. The test module is cut at its exact
		// opening, and comment lines are skipped.
		let (production, _) = include_str!("skills.rs")
			.split_once("\n#[cfg(test)]\nmod tests {")
			.expect("test module marker");
		let code = production
			.lines()
			.filter(|line| !line.trim_start().starts_with("//"))
			.collect::<Vec<_>>()
			.join("\n");
		let forbidden = [
			"std::process",
			"tokio::process",
			"Command::new",
			"CommandExt",
			"libloading",
			"dlopen",
			"dlsym",
			"libc::exec",
		];
		for needle in forbidden {
			assert!(!code.contains(needle), "skills discovery must not use {needle}");
		}
	}
}
