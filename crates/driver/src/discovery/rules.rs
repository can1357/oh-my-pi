//! Context files and rules: the standing project guidance the system prompt
//! carries (`<repo-rules>`, `<generic-rules>`, `<domain-rules>`) and serves
//! as `rule://<name>`.
//!
//! The runtime discovers two capabilities:
//!
//! * **Context files**: `AGENTS.md`, `CLAUDE.md` and friends walked up from the
//!   project root — one file per directory depth, the highest-priority provider
//!   winning a tie (`.omp/AGENTS.md`, Claude, Gemini, then standalone
//!   `AGENTS.md` / `CLAUDE.md`) — plus one user-level winner from native,
//!   Claude, Codex, Gemini, and OpenCode. Injected whole, farthest first so the
//!   closest file reads last.
//! * **Rules**: Markdown documents with optional frontmatter (`description`,
//!   `globs`, `alwaysApply`, `condition`, `scope`, `agents`) from `.omp/rules`,
//!   `<config root>/agent/rules`, the sticky `RULES.md`, `.agent[s]/rules`,
//!   `.cursor/rules`, `.windsurf/rules`, `.clinerules`, and the legacy
//!   `.cursorrules` / `.windsurfrules` files. Name conflicts resolve
//!   first-source-wins in that order. `alwaysApply` rules are injected in full;
//!   described rules are listed by name and globs for the model to read through
//!   `rule://<name>`.

use std::{
	collections::BTreeSet,
	fs,
	path::{Path, PathBuf},
	sync::Arc,
};

use omp_core::{CowBytes, Str};
use omp_envd::ContentResolver;
use omp_tools::read::{
	Fault,
	resolver::{
		LineOffsetCache, ResourceCompletion, ResourceEntry, ResourceList, Scheme, SchemeEntry,
		fuzzy_score,
	},
	selector::ParsedSelector,
};
use serde::Deserialize;

/// Where a discovered document sits in the precedence ladder.
#[derive(Clone, Copy, Debug, Eq, PartialEq, strum::IntoStaticStr)]
#[strum(serialize_all = "lowercase")]
pub enum Level {
	/// Project walk-up roots.
	Project,
	/// The configuration root.
	User,
}

/// Non-fatal discovery diagnostic.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Warning {
	/// Offending file or directory.
	pub path:    PathBuf,
	/// Human-readable reason.
	pub message: Str,
}

/// One persistent-instruction file.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ContextFile {
	/// Canonical path.
	pub path:     PathBuf,
	/// Whole file body.
	pub content:  Str,
	/// User or project level.
	pub level:    Level,
	/// Directories between the project root and the file (`0` = in the
	/// project root); `0` for user-level files.
	pub depth:    usize,
	/// Provider identity (`native`, `claude`, `agents-md`, `claude-md`).
	pub provider: Str,
}

/// The context files one session injects, user level first, then project
/// files farthest first.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ContextFiles {
	/// Winning files in injection order.
	pub files:    Vec<ContextFile>,
	/// Unreadable files.
	pub warnings: Vec<Warning>,
}

/// Project context candidates in provider-priority order. Native context is
/// admitted from the nearest `.omp` root, Claude/Gemini only from the active
/// project root, and the standalone files walk every project depth.
const PROJECT_CONTEXT_PROVIDERS: [(&str, &str); 5] = [
	("native", ".omp/AGENTS.md"),
	("claude", ".claude/CLAUDE.md"),
	("gemini", ".gemini/GEMINI.md"),
	("agents-md", "AGENTS.md"),
	("claude-md", "CLAUDE.md"),
];

/// User context candidates in provider-priority order. The capability admits
/// one user context file, so a higher-priority ecosystem owns the scope even
/// when lower-priority files also exist.
const USER_CONTEXT_PROVIDERS: [(&str, &str); 5] = [
	("native", "agent/AGENTS.md"),
	("claude", ".claude/CLAUDE.md"),
	("codex", ".codex/AGENTS.md"),
	("gemini", ".gemini/GEMINI.md"),
	("opencode", ".config/opencode/AGENTS.md"),
];

impl ContextFiles {
	/// Discovers context files for `project_root`.
	#[must_use]
	pub fn discover(project_root: &Path, home: &Path, config_root: &Path) -> Self {
		let mut out = Self::default();
		for (provider, relative) in USER_CONTEXT_PROVIDERS {
			let path = if provider == "native" {
				config_root.join(relative)
			} else {
				home.join(relative)
			};
			let Some(content) = read_non_empty(&path, &mut out.warnings) else {
				continue;
			};
			out.files.push(ContextFile {
				path,
				content,
				level: Level::User,
				depth: 0,
				provider: Str::new_static(provider),
			});
			break;
		}
		let mut project = Vec::new();
		let ancestors = walk_up(project_root, home);
		// `.omp/AGENTS.md` is read from the
		// nearest `.omp/` directory only; the standalone files walk every
		// level.
		let nearest_config = ancestors.iter().position(|dir| dir.join(".omp").is_dir());
		for (depth, dir) in ancestors.iter().enumerate() {
			for (provider, relative) in PROJECT_CONTEXT_PROVIDERS {
				if provider == "native" && nearest_config != Some(depth) {
					continue;
				}
				if matches!(provider, "claude" | "gemini") && depth != 0 {
					continue;
				}
				let path = dir.join(relative);
				let Some(content) = read_non_empty(&path, &mut out.warnings) else {
					continue;
				};
				project.push(ContextFile {
					path,
					content,
					level: Level::Project,
					depth,
					provider: Str::new_static(provider),
				});
				// One file per depth: the first provider to claim it wins.
				break;
			}
		}
		project.reverse();
		out.files.extend(project);
		out
	}

	/// `{origin, content}` rows for the prompt's `<repo-rules>` block.
	#[must_use]
	pub fn prompt_facts(&self) -> Vec<serde_json::Value> {
		self
			.files
			.iter()
			.map(|file| {
				serde_json::json!({
					"origin": file.path.to_string_lossy(),
					"content": file.content.as_str(),
					"level": <&'static str>::from(file.level),
					"depth": file.depth,
				})
			})
			.collect()
	}
}

/// One rule document.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Rule {
	/// Unique name: the file stem, or a provider-fixed name for whole-file
	/// rules (`RULES`, `RULES@project`, `cursorrules`, `clinerules`,
	/// `windsurfrules`, `global_rules`).
	pub name:         Str,
	/// Canonical path.
	pub path:         PathBuf,
	/// Body after the frontmatter.
	pub content:      Str,
	/// Frontmatter `description`.
	pub description:  Option<Str>,
	/// Frontmatter `globs` this rule applies to.
	pub globs:        Vec<Str>,
	/// Frontmatter `alwaysApply`: injected in full every turn.
	pub always_apply: bool,
	/// Frontmatter `condition`: regex triggers for the TTSR director.
	pub condition:    Vec<Str>,
	/// Frontmatter `scope`: TTSR stream scope tokens.
	pub scope:        Vec<Str>,
	/// Frontmatter `agents`: lowercased agent-name globs (empty = all).
	pub agents:       Vec<Str>,
	/// Provider identity.
	pub provider:     Str,
	/// User or project level.
	pub level:        Level,
}

/// The rules one session admitted, in discovery order.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ActiveRules {
	/// Winning rules, name-unique.
	pub rules:    Vec<Rule>,
	/// Malformed and colliding documents.
	pub warnings: Vec<Warning>,
}

/// Agent name the top-level session evaluates `agents:` scopes with.
pub const MAIN_AGENT: &str = "main";

impl ActiveRules {
	/// Discovers rules for `project_root` from the native, agents, cursor,
	/// windsurf, and cline providers in priority order.
	#[must_use]
	pub fn discover(project_root: &Path, home: &Path, config_root: &Path) -> Self {
		let mut out = Self::default();
		let mut names = BTreeSet::<Str>::new();
		let mut admit = |rule: Rule, warnings: &mut Vec<Warning>| {
			if names.insert(rule.name.clone()) {
				out.rules.push(rule);
			} else {
				warnings.push(Warning {
					path:    rule.path,
					message: Str::new(format!(
						"rule name collision: \"{}\" already loaded, skipping this one",
						rule.name
					)),
				});
			}
		};
		let mut warnings = Vec::new();
		let ancestors = walk_up(project_root, home);
		let nearest_config = ancestors
			.iter()
			.map(|dir| dir.join(".omp"))
			.find(|dir| dir.is_dir());

		// native (100): project `.omp/rules`, user `agent/rules`, sticky RULES.md.
		if let Some(config) = &nearest_config {
			for rule in rules_in_dir(
				&config.join("rules"),
				"native",
				Level::Project,
				&["md", "mdc"],
				&mut warnings,
			) {
				admit(rule, &mut warnings);
			}
		}
		for rule in rules_in_dir(
			&config_root.join("agent/rules"),
			"native",
			Level::User,
			&["md", "mdc"],
			&mut warnings,
		) {
			admit(rule, &mut warnings);
		}
		if let Some(rule) = whole_file_rule(
			&config_root.join("agent/RULES.md"),
			"RULES",
			"native",
			Level::User,
			&mut warnings,
		) {
			admit(rule, &mut warnings);
		}
		if let Some(config) = &nearest_config
			&& let Some(rule) = whole_file_rule(
				&config.join("RULES.md"),
				"RULES@project",
				"native",
				Level::Project,
				&mut warnings,
			) {
			admit(rule, &mut warnings);
		}
		// agents: `.agent/rules` and `.agents/rules` (project walk-up + home).
		for dir in &ancestors {
			for name in [".agent/rules", ".agents/rules"] {
				for rule in rules_in_dir(
					&dir.join(name),
					"agents",
					Level::Project,
					&["md", "mdc"],
					&mut warnings,
				) {
					admit(rule, &mut warnings);
				}
			}
		}
		for name in [".agent/rules", ".agents/rules"] {
			for rule in
				rules_in_dir(&home.join(name), "agents", Level::User, &["md", "mdc"], &mut warnings)
			{
				admit(rule, &mut warnings);
			}
		}
		// cursor: user rules precede project rules within the provider, then
		// the legacy project `.cursorrules` file.
		for rule in rules_in_dir(
			&home.join(".cursor/rules"),
			"cursor",
			Level::User,
			&["mdc", "md"],
			&mut warnings,
		) {
			admit(rule, &mut warnings);
		}
		for rule in rules_in_dir(
			&project_root.join(".cursor/rules"),
			"cursor",
			Level::Project,
			&["mdc", "md"],
			&mut warnings,
		) {
			admit(rule, &mut warnings);
		}
		if let Some(rule) = whole_file_rule(
			&project_root.join(".cursorrules"),
			"cursorrules",
			"cursor",
			Level::Project,
			&mut warnings,
		) {
			admit(rule, &mut warnings);
		}
		// windsurf: user memories precede project rules within the provider.
		if let Some(rule) = whole_file_rule(
			&home.join(".codeium/windsurf/memories/global_rules.md"),
			"global_rules",
			"windsurf",
			Level::User,
			&mut warnings,
		) {
			admit(rule, &mut warnings);
		}
		for rule in rules_in_dir(
			&project_root.join(".windsurf/rules"),
			"windsurf",
			Level::Project,
			&["md"],
			&mut warnings,
		) {
			admit(rule, &mut warnings);
		}
		if let Some(rule) = whole_file_rule(
			&project_root.join(".windsurfrules"),
			"windsurfrules",
			"windsurf",
			Level::Project,
			&mut warnings,
		) {
			admit(rule, &mut warnings);
		}
		// cline: `.clinerules` file or directory, nearest ancestor.
		if let Some(found) = ancestors
			.iter()
			.map(|dir| dir.join(".clinerules"))
			.find(|path| path.exists())
		{
			if found.is_dir() {
				for rule in rules_in_dir(&found, "cline", Level::Project, &["md"], &mut warnings) {
					admit(rule, &mut warnings);
				}
			} else if let Some(rule) =
				whole_file_rule(&found, "clinerules", "cline", Level::Project, &mut warnings)
			{
				admit(rule, &mut warnings);
			}
		}
		out.warnings = warnings;
		out
	}

	/// The rule named `name`, when admitted.
	#[must_use]
	pub fn get(&self, name: &str) -> Option<&Rule> {
		self.rules.iter().find(|rule| rule.name.as_str() == name)
	}

	/// Rules admitted for `agent`: a rule without `agents:` applies everywhere.
	pub fn for_agent<'a>(&'a self, agent: &'a str) -> impl Iterator<Item = &'a Rule> + 'a {
		let agent = agent.to_ascii_lowercase();
		self.rules.iter().filter(move |rule| {
			rule.agents.is_empty()
				|| rule
					.agents
					.iter()
					.any(|pattern| super::skills::glob_matches(pattern, &agent))
		})
	}

	/// Prompt rows for `agent`: `always_apply_rules` are `{name, content, path}`
	/// injected whole; `rules` are the described
	/// rulebook entries `{name, description, globs, path}` the model reads on
	/// demand. A rule with neither `alwaysApply` nor a description is reachable
	/// only through `rule://`.
	#[must_use]
	pub fn prompt_facts(&self, agent: &str) -> RulePromptFacts {
		let mut facts = RulePromptFacts::default();
		for rule in self.for_agent(agent) {
			if rule.always_apply {
				facts.always_apply.push(serde_json::json!({
					"name": rule.name.as_str(),
					"content": rule.content.as_str(),
					"path": rule.path.to_string_lossy(),
				}));
			} else if let Some(description) = &rule.description {
				facts.rulebook.push(serde_json::json!({
					"name": rule.name.as_str(),
					"description": description.as_str(),
					"globs": rule.globs.iter().map(Str::as_str).collect::<Vec<_>>(),
					"path": rule.path.to_string_lossy(),
				}));
			}
		}
		facts
	}

	/// The `rule://` resolver over this snapshot, installed through
	/// [`omp_envd::RegistryBridges::url_resolvers`].
	#[must_use]
	pub fn resolver(self: &Arc<Self>) -> Arc<dyn ContentResolver> {
		Arc::new(RuleResolver { rules: Arc::clone(self), lines: LineOffsetCache::default() })
	}
}

/// The two prompt buckets of [`ActiveRules::prompt_facts`].
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct RulePromptFacts {
	/// `<generic-rules>` bodies.
	pub always_apply: Vec<serde_json::Value>,
	/// `<domain-rules>` index rows.
	pub rulebook:     Vec<serde_json::Value>,
}

/// Project walk-up directories from `project_root` outward, closest first,
/// with this boundary: stop at the repository root (nearest `.git`), except
/// that a repository nested below the home
/// directory keeps walking up to — but never into — the home directory; a
/// project outside any repository stops at the home directory inclusive when
/// beneath it, and never reaches the filesystem root otherwise.
fn walk_up(project_root: &Path, home: &Path) -> Vec<PathBuf> {
	let repo_root = project_root
		.ancestors()
		.find(|dir| dir.join(".git").exists());
	let under_home = project_root.starts_with(home);
	let repo_is_home = repo_root == Some(home);
	let repo_under_home = repo_root.is_some_and(|root| root.starts_with(home)) && !repo_is_home;
	let scan_to_home = under_home && repo_under_home;
	let boundary = if scan_to_home {
		Some(home)
	} else {
		repo_root.or_else(|| under_home.then_some(home))
	};
	let include_boundary = match repo_root {
		None => under_home,
		Some(_) => boundary != Some(home) || repo_is_home,
	};
	let mut out = Vec::new();
	for dir in project_root.ancestors() {
		let at_boundary = Some(dir) == boundary;
		if at_boundary && !include_boundary {
			break;
		}
		if boundary.is_none() && dir.parent().is_none() {
			// No repository and not beneath home: the filesystem root itself
			// is never project context.
			break;
		}
		out.push(dir.to_path_buf());
		if at_boundary {
			break;
		}
	}
	out
}

/// Reads `path` when it is a non-empty file outside a hidden directory
/// Empty files contribute nothing and must not claim the depth scope.
fn read_non_empty(path: &Path, warnings: &mut Vec<Warning>) -> Option<Str> {
	if !path.is_file() {
		return None;
	}
	match fs::read_to_string(path) {
		Ok(text) if text.trim().is_empty() => None,
		Ok(text) => Some(Str::new(text)),
		Err(error) => {
			warnings.push(Warning {
				path:    path.to_path_buf(),
				message: Str::new(format!("Failed to read context file: {error}")),
			});
			None
		},
	}
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuleHeader {
	description:  Option<String>,
	#[serde(default)]
	globs:        OneOrMany,
	#[serde(default)]
	always_apply: bool,
	#[serde(default)]
	condition:    OneOrMany,
	#[serde(default)]
	scope:        OneOrMany,
	#[serde(default)]
	agents:       OneOrMany,
}

/// A frontmatter field accepts one string, a comma-separated string, or a list.
#[derive(Default, Deserialize)]
#[serde(untagged)]
enum OneOrMany {
	#[default]
	None,
	One(String),
	Many(Vec<String>),
}

impl OneOrMany {
	fn into_vec(self, split_commas: bool) -> Vec<Str> {
		let items = match self {
			Self::None => return Vec::new(),
			Self::One(value) if split_commas => value.split(',').map(str::to_owned).collect(),
			Self::One(value) => vec![value],
			Self::Many(values) => values,
		};
		items
			.iter()
			.map(|item| item.trim())
			.filter(|item| !item.is_empty())
			.map(Str::new)
			.collect()
	}
}

/// Splits `---` frontmatter from a Markdown document.
pub(super) fn split_frontmatter(source: &str) -> (Option<&str>, &str) {
	let Some(rest) = source
		.strip_prefix("---\n")
		.or_else(|| source.strip_prefix("---\r\n"))
	else {
		return (None, source);
	};
	let Some(end) = rest.find("\n---") else {
		return (None, source);
	};
	let header = &rest[..end];
	let body = &rest[end + 4..];
	let body = body
		.strip_prefix("\r\n")
		.or_else(|| body.strip_prefix('\n'))
		.unwrap_or(body);
	(Some(header), body)
}

/// Builds a rule from a Markdown document.
fn load_rule(
	path: &Path,
	name: Str,
	provider: &'static str,
	level: Level,
	warnings: &mut Vec<Warning>,
) -> Option<Rule> {
	let canonical = match fs::canonicalize(path) {
		Ok(canonical) => canonical,
		Err(error) => {
			warnings.push(Warning {
				path:    path.to_path_buf(),
				message: Str::new(format!("Failed to read rule file: {error}")),
			});
			return None;
		},
	};
	let text = match fs::read_to_string(&canonical) {
		Ok(text) => text,
		Err(error) => {
			warnings.push(Warning {
				path:    canonical,
				message: Str::new(format!("Failed to read rule file: {error}")),
			});
			return None;
		},
	};
	let (header, body) = split_frontmatter(&text);
	let header = match header.map(serde_yaml::from_str::<RuleHeader>) {
		None => RuleHeader::default(),
		Some(Ok(header)) => header,
		Some(Err(error)) => {
			warnings.push(Warning {
				path:    canonical,
				message: Str::new(format!("failed to parse rule frontmatter: {error}")),
			});
			return None;
		},
	};
	Some(Rule {
		name,
		path: canonical,
		content: Str::new(body),
		description: header
			.description
			.as_deref()
			.map(str::trim)
			.filter(|description| !description.is_empty())
			.map(Str::new),
		globs: header.globs.into_vec(true),
		always_apply: header.always_apply,
		condition: header.condition.into_vec(false),
		scope: header.scope.into_vec(true),
		agents: header
			.agents
			.into_vec(true)
			.into_iter()
			.map(|agent| Str::new(agent.to_ascii_lowercase()))
			.collect(),
		provider: Str::new_static(provider),
		level,
	})
}

/// Rules from the files directly below `dir` with one of `extensions`, in
/// name order, without recursion.
fn rules_in_dir(
	dir: &Path,
	provider: &'static str,
	level: Level,
	extensions: &[&str],
	warnings: &mut Vec<Warning>,
) -> Vec<Rule> {
	let entries = match fs::read_dir(dir) {
		Ok(entries) => entries,
		Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Vec::new(),
		Err(error) => {
			warnings.push(Warning {
				path:    dir.to_path_buf(),
				message: Str::new(format!("Failed to read rules directory: {error}")),
			});
			return Vec::new();
		},
	};
	let canonical_dir = match fs::canonicalize(dir) {
		Ok(path) => path,
		Err(error) => {
			warnings.push(Warning {
				path:    dir.to_path_buf(),
				message: Str::new(format!("Failed to resolve rules directory: {error}")),
			});
			return Vec::new();
		},
	};
	let mut files = entries
		.filter_map(Result::ok)
		.map(|entry| entry.path())
		.filter(|path| {
			path.is_file()
				&& !path
					.file_name()
					.is_some_and(|name| name.to_string_lossy().starts_with('.'))
				&& path
					.extension()
					.and_then(|extension| extension.to_str())
					.is_some_and(|extension| extensions.contains(&extension))
		})
		.collect::<Vec<_>>();
	files.sort();
	files
		.into_iter()
		.filter_map(|path| {
			let canonical = match fs::canonicalize(&path) {
				Ok(canonical) if canonical.starts_with(&canonical_dir) => canonical,
				Ok(_) => {
					warnings.push(Warning {
						path,
						message: Str::new_static("rule declaration resolves outside its discovery root"),
					});
					return None;
				},
				Err(error) => {
					warnings.push(Warning {
						path,
						message: Str::new(format!("Failed to resolve rule file: {error}")),
					});
					return None;
				},
			};
			let name = Str::new(canonical.file_stem()?.to_string_lossy());
			load_rule(&canonical, name, provider, level, warnings)
		})
		.collect()
}

/// A whole file as one rule under a fixed `name`: the sticky `RULES.md`
/// always applies regardless of frontmatter, and the single-file forms
/// `.clinerules`, `global_rules.md`, and the legacy
/// `.cursorrules` / `.windsurfrules`. Those are project-wide instructions by
/// construction, so they always apply unless their frontmatter opts them into
/// the rulebook with a description.
fn whole_file_rule(
	path: &Path,
	name: &'static str,
	provider: &'static str,
	level: Level,
	warnings: &mut Vec<Warning>,
) -> Option<Rule> {
	if !path.is_file() {
		return None;
	}
	let mut rule = load_rule(path, Str::new_static(name), provider, level, warnings)?;
	if rule.content.trim().is_empty() {
		return None;
	}
	let sticky = name.starts_with("RULES");
	rule.always_apply = sticky || rule.always_apply || rule.description.is_none();
	Some(rule)
}

/// `rule://<name>` reads a rule body; bare `rule://` lists every rule.
struct RuleResolver {
	rules: Arc<ActiveRules>,
	lines: LineOffsetCache,
}

impl RuleResolver {
	fn rule(&self, name: &str) -> Result<&Rule, Fault> {
		self.rules.get(name).ok_or_else(|| {
			let available = self
				.rules
				.rules
				.iter()
				.map(|rule| rule.name.as_str())
				.collect::<Vec<_>>();
			let available = if available.is_empty() {
				"none".to_owned()
			} else {
				available.join(", ")
			};
			Fault::Source {
				message: Str::new(format!("Unknown rule: {name}\nAvailable: {available}")),
			}
		})
	}

	fn index(&self) -> Vec<u8> {
		let mut text = String::from("# Rules\n\n");
		for rule in &self.rules.rules {
			text.push_str("- rule://");
			text.push_str(&rule.name);
			if let Some(description) = &rule.description {
				text.push_str(": ");
				text.push_str(description);
			}
			if !rule.globs.is_empty() {
				text.push_str(" (");
				text.push_str(&rule.globs.join(", "));
				text.push(')');
			}
			text.push('\n');
		}
		text.into_bytes()
	}
}

#[async_trait::async_trait]
impl ContentResolver for RuleResolver {
	fn entry(&self) -> SchemeEntry {
		SchemeEntry::new(Scheme::Rule, true, false, "discovered project and user rules")
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
		let rule = self.rule(resource.trim_end_matches('/'))?;
		let bytes = CowBytes::from(rule.content.as_bytes().to_vec());
		let ParsedSelector::Lines { ranges, .. } = selector else {
			return Ok(bytes);
		};
		let mut output = Vec::new();
		for range in ranges {
			let piece = self
				.lines
				.slice(resource, &bytes, *range)
				.map_err(|error| Fault::Invalid { message: Str::new(error.to_string()) })?;
			output.extend_from_slice(&piece);
		}
		Ok(CowBytes::from(output))
	}

	async fn list(
		&self,
		resource: &str,
		max_entries: usize,
		_max_bytes: usize,
	) -> Result<ResourceList, Fault> {
		if !resource.is_empty() {
			return Err(Fault::Invalid {
				message: Str::new(format!("rule://{resource} is a document and cannot be listed.")),
			});
		}
		let mut entries = Vec::new();
		let mut truncated = false;
		for rule in &self.rules.rules {
			if entries.len() == max_entries {
				truncated = true;
				break;
			}
			entries.push(ResourceEntry {
				uri:       Str::new(format!("rule://{}", rule.name)),
				name:      rule.name.clone(),
				directory: false,
				size:      rule.content.len() as u64,
			});
		}
		Ok(ResourceList { entries, truncated })
	}

	async fn path(&self, resource: &str) -> Result<Option<Str>, Fault> {
		if resource.is_empty() {
			return Ok(None);
		}
		let rule = self.rule(resource.trim_end_matches('/'))?;
		Ok(Some(Str::new(format!("file://{}", rule.path.display()))))
	}

	async fn complete(
		&self,
		query: &str,
		max_results: usize,
	) -> Result<Vec<ResourceCompletion>, Fault> {
		let mut matches = self
			.rules
			.rules
			.iter()
			.filter_map(|rule| {
				fuzzy_score(query, &rule.name).map(|score| ResourceCompletion {
					value: Str::new(format!("rule://{}", rule.name)),
					description: rule.description.clone().unwrap_or_default(),
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
	use super::*;

	fn write(path: &Path, text: &str) {
		fs::create_dir_all(path.parent().unwrap()).unwrap();
		fs::write(path, text).unwrap();
	}

	/// A fake home with a repository two levels down and a project nested
	/// inside it: `home/work/repo/{.git}/crates/app`.
	fn layout() -> (tempfile::TempDir, PathBuf, PathBuf, PathBuf) {
		let temp = tempfile::tempdir().unwrap();
		let home = temp.path().canonicalize().unwrap();
		let repo = home.join("work/repo");
		fs::create_dir_all(repo.join(".git")).unwrap();
		let project = repo.join("crates/app");
		fs::create_dir_all(&project).unwrap();
		(temp, home, repo, project)
	}

	#[test]
	fn context_files_walk_up_with_pi_precedence_and_depth_order() {
		let (_temp, home, repo, project) = layout();
		let config_root = home.join(".o2");
		write(&config_root.join("agent/AGENTS.md"), "user guidance");
		write(&project.join("AGENTS.md"), "app agents");
		write(&project.join("CLAUDE.md"), "app claude (loses the tie)");
		write(&repo.join("crates/CLAUDE.md"), "crates claude");
		write(&repo.join(".omp/AGENTS.md"), "repo native");
		write(&repo.join("AGENTS.md"), "repo standalone (shadowed by .omp)");
		write(&home.join("work/AGENTS.md"), "workspace level");
		write(&home.join("AGENTS.md"), "home copy never loads as project context");
		write(&repo.join("crates/AGENTS.md"), "   \n");

		let files = ContextFiles::discover(&project, &home, &config_root);
		assert!(files.warnings.is_empty(), "{:?}", files.warnings);
		let rows = files
			.files
			.iter()
			.map(|file| (file.provider.as_str(), file.level, file.depth, file.content.as_str()))
			.collect::<Vec<_>>();
		assert_eq!(rows, [
			("native", Level::User, 0, "user guidance"),
			("agents-md", Level::Project, 3, "workspace level"),
			("native", Level::Project, 2, "repo native"),
			("claude-md", Level::Project, 1, "crates claude"),
			("agents-md", Level::Project, 0, "app agents"),
		]);
		let facts = files.prompt_facts();
		assert_eq!(facts[4]["origin"], project.join("AGENTS.md").to_string_lossy().as_ref());
		assert_eq!(facts[4]["content"], "app agents");
	}

	#[test]
	fn context_scope_uses_foreign_provider_precedence() {
		let (_temp, home, _repo, project) = layout();
		let config_root = home.join(".o2");
		write(&home.join(".codex/AGENTS.md"), "codex user");
		write(&home.join(".gemini/GEMINI.md"), "gemini user");
		write(&project.join(".gemini/GEMINI.md"), "gemini project");
		write(&project.join("AGENTS.md"), "standalone loses");
		let files = ContextFiles::discover(&project, &home, &config_root);
		assert_eq!(
			files
				.files
				.iter()
				.map(|file| (file.provider.as_str(), file.content.as_str()))
				.collect::<Vec<_>>(),
			[("codex", "codex user"), ("gemini", "gemini project")]
		);

		write(&home.join(".claude/CLAUDE.md"), "claude user");
		write(&project.join(".claude/CLAUDE.md"), "claude project");
		let files = ContextFiles::discover(&project, &home, &config_root);
		assert_eq!(files.files[0].provider, "claude");
		assert_eq!(files.files.last().unwrap().provider, "claude");
	}

	#[cfg(unix)]
	#[test]
	fn linked_rule_outside_provider_root_is_rejected_without_hiding_siblings() {
		use std::os::unix::fs::symlink;

		let (_temp, home, repo, project) = layout();
		let config_root = home.join(".o2");
		let rules = repo.join(".omp/rules");
		write(&rules.join("inside.md"), "---\nalwaysApply: true\n---\ninside");
		let outside = home.join("outside.md");
		write(&outside, "---\nalwaysApply: true\n---\noutside");
		symlink(&outside, rules.join("escape.md")).unwrap();

		let discovered = ActiveRules::discover(&project, &home, &config_root);
		assert!(discovered.get("inside").is_some());
		assert!(discovered.get("escape").is_none());
		assert!(
			discovered
				.warnings
				.iter()
				.any(|warning| warning.message.contains("outside its discovery root"))
		);
	}

	#[test]
	fn walk_up_stops_at_the_repository_root_outside_home() {
		let temp = tempfile::tempdir().unwrap();
		let root = temp.path().canonicalize().unwrap();
		let home = root.join("home");
		let repo = root.join("srv/repo");
		fs::create_dir_all(repo.join(".git")).unwrap();
		let project = repo.join("pkg");
		fs::create_dir_all(&project).unwrap();
		fs::create_dir_all(&home).unwrap();
		assert_eq!(walk_up(&project, &home), [project.clone(), repo.clone()]);
		// No repository, beneath home: the home directory itself is included.
		let bare = home.join("scratch");
		fs::create_dir_all(&bare).unwrap();
		assert_eq!(walk_up(&bare, &home), [bare.clone(), home.clone()]);
		// A repository rooted at home keeps the home-level file.
		fs::create_dir_all(home.join(".git")).unwrap();
		assert_eq!(walk_up(&bare, &home), [bare, home.clone()]);
	}

	#[test]
	fn rules_bucket_by_frontmatter_and_resolve_name_collisions_first_wins() {
		let (_temp, home, repo, project) = layout();
		let config_root = home.join(".o2");
		write(
			&repo.join(".omp/rules/style.md"),
			"---\ndescription: House style\nglobs: \"*.rs, *.toml\"\n---\nUse tabs.\n",
		);
		write(
			&repo.join(".omp/rules/always.mdc"),
			"---\nalwaysApply: true\n---\nNever force-push.\n",
		);
		write(&repo.join(".omp/rules/hidden.md"), "no frontmatter, only rule:// reaches this\n");
		write(
			&repo.join(".omp/rules/sub-only.md"),
			"---\ndescription: Subagents\nagents: [sub, review-*]\n---\nbody\n",
		);
		write(
			&repo.join(".omp/RULES.md"),
			"---\ndescription: ignored for sticky\n---\nSticky project rules.\n",
		);
		write(
			&config_root.join("agent/rules/style.md"),
			"---\ndescription: shadowed by project\n---\nuser\n",
		);
		write(&config_root.join("agent/RULES.md"), "User sticky.\n");
		write(
			&project.join(".cursor/rules/cursor.mdc"),
			"---\ndescription: Cursor rule\nglobs:\n  - src/**\n---\ncursor body\n",
		);
		write(&project.join(".cursorrules"), "legacy cursor rules\n");
		write(&repo.join(".clinerules"), "legacy cline rules\n");
		write(&repo.join(".omp/rules/broken.md"), "---\ndescription: [unclosed\n---\nbody\n");

		let rules = ActiveRules::discover(&project, &home, &config_root);
		let names = rules
			.rules
			.iter()
			.map(|rule| rule.name.as_str())
			.collect::<Vec<_>>();
		assert_eq!(names, [
			"always",
			"hidden",
			"style",
			"sub-only",
			"RULES",
			"RULES@project",
			"cursor",
			"cursorrules",
			"clinerules"
		]);
		let style = rules.get("style").unwrap();
		assert_eq!(style.provider, "native");
		assert_eq!(style.level, Level::Project);
		assert_eq!(style.globs, [Str::new_static("*.rs"), Str::new_static("*.toml")]);
		assert_eq!(style.content, "Use tabs.\n");
		assert!(rules.get("RULES@project").unwrap().always_apply, "sticky RULES.md always applies");
		assert!(rules.get("cursorrules").unwrap().always_apply);
		assert_eq!(rules.get("sub-only").unwrap().agents, [
			Str::new_static("sub"),
			Str::new_static("review-*")
		]);
		let messages = rules
			.warnings
			.iter()
			.map(|warning| warning.message.as_str())
			.collect::<Vec<_>>();
		assert!(messages.iter().any(|m| m.contains("collision")), "{messages:?}");
		assert!(messages.iter().any(|m| m.contains("frontmatter")), "{messages:?}");

		let facts = rules.prompt_facts(MAIN_AGENT);
		let always = facts
			.always_apply
			.iter()
			.map(|row| row["name"].as_str().unwrap())
			.collect::<Vec<_>>();
		assert_eq!(always, ["always", "RULES", "RULES@project", "cursorrules", "clinerules"]);
		let rulebook = facts
			.rulebook
			.iter()
			.map(|row| (row["name"].as_str().unwrap(), row["globs"].as_array().unwrap().len()))
			.collect::<Vec<_>>();
		assert_eq!(rulebook, [("style", 2), ("cursor", 1)], "hidden and sub-only stay out");
		let sub = rules.prompt_facts("review-bot");
		assert!(sub.rulebook.iter().any(|row| row["name"] == "sub-only"));
	}

	#[tokio::test]
	async fn rule_url_reads_lists_and_completes() {
		let (_temp, home, repo, project) = layout();
		write(
			&repo.join(".omp/rules/style.md"),
			"---\ndescription: House style\n---\nline one\nline two\n",
		);
		let rules = Arc::new(ActiveRules::discover(&project, &home, &home.join(".o2")));
		let resolver = rules.resolver();
		assert_eq!(resolver.entry().scheme, Scheme::Rule);
		let body = resolver.read("style", &ParsedSelector::None).await.unwrap();
		assert_eq!(std::str::from_utf8(&body).unwrap(), "line one\nline two\n");
		let index = resolver.read("", &ParsedSelector::None).await.unwrap();
		assert!(
			std::str::from_utf8(&index)
				.unwrap()
				.contains("- rule://style: House style")
		);
		let listing = resolver.list("", 10, usize::MAX).await.unwrap();
		assert_eq!(listing.entries[0].uri, "rule://style");
		let completions = resolver.complete("sty", 5).await.unwrap();
		assert_eq!(completions[0].value, "rule://style");
		let missing = resolver
			.read("nope", &ParsedSelector::None)
			.await
			.unwrap_err();
		assert!(matches!(missing, Fault::Source { .. }));
	}
}
