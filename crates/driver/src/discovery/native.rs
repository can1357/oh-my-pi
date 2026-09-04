//! Typed discovery and admission for local Python extensions.
//!
//! Discovery is intentionally narrow: an extension is a Python distribution
//! root with `omp.toml`, a wheel-style `*.dist-info/omp.toml`, or a
//! `pyproject.toml` containing `[tool.omp]`. JavaScript and TypeScript files
//! are never inspected or inferred as extensions.

use std::{
	collections::{BTreeMap, BTreeSet},
	fs, io,
	path::{Path, PathBuf},
	str::FromStr as _,
};

use omp_agent::HookPhase;
use omp_core::{ArtifactDigest, Hash32, Provenance, Str, sf};
use omp_envd::{
	exthost::{
		DeclarationSet, ExtensionManifest, HookDeclarationKey, ServiceManifest, ToolDeclarationKey,
	},
	policy::Grants,
	worker::{ExtHostSpec, HostKey},
};
use omp_ext::config::{
	CliSettingOverride, DeploymentManifest, StaticDeclarations, resolve_extension_settings,
};
use thiserror::Error;

/// How invocation roots compose with automatic user and workspace roots.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum NativeLoadMode {
	/// Explicit roots precede automatic roots.
	#[default]
	Merge,
	/// Only explicit roots are loaded.
	ExplicitOnly,
	/// No native extension roots are loaded.
	Disabled,
}

/// Inputs to one native extension discovery pass.
#[derive(Clone, Debug)]
pub struct NativeAdmissionOptions<'a> {
	/// Ordered invocation-local extension roots.
	pub explicit_roots:    &'a [PathBuf],
	/// Explicit/automatic root composition.
	pub mode:              NativeLoadMode,
	/// Whether `<project>/.omp/extensions` participates.
	pub include_workspace: bool,
	/// Typed setting overrides applied before environment attachment.
	pub setting_overrides: &'a [CliSettingOverride],
	/// Manifest ids never loaded (`cl_disabled_extensions`,
	/// [`super::CL_DISABLED_EXTENSIONS`]); explicit roots are still honored
	/// because the operator named them on this invocation.
	pub disabled:          &'a [Str],
}

/// An admitted extension and the source root that produced it.
#[derive(Clone, Debug)]
pub struct AdmittedNativeExtension {
	/// Canonical Python distribution root.
	pub root: PathBuf,
	/// Complete environment-host launch contract.
	pub spec: ExtHostSpec,
}

impl AdmittedNativeExtension {
	/// Returns contained generated-skill roots declared by this distribution.
	///
	/// Runtime `@omp.skill` registration must exactly match these manifest
	/// rows; discovery can therefore expose their materialized files without
	/// importing Python in the engine process.
	#[must_use]
	pub fn skill_roots(&self) -> Vec<PathBuf> {
		let site = self.spec.python_site.as_deref().unwrap_or(&self.root);
		let mut roots = self
			.spec
			.manifest
			.static_declarations()
			.ordered
			.iter()
			.filter(|row| row.kind == "skills")
			.filter_map(|row| row.path.as_deref())
			.filter_map(|path| fs::canonicalize(site.join(path)).ok())
			.filter(|path| {
				path.starts_with(&self.root) && path.file_name().is_some_and(|name| name == "SKILL.md")
			})
			.filter_map(|path| path.parent()?.parent().map(Path::to_path_buf))
			.collect::<Vec<_>>();
		roots.sort_unstable();
		roots.dedup();
		roots
	}
}

/// One contained native-extension discovery pass.
///
/// A malformed or unreadable package contributes one typed diagnostic without
/// suppressing unrelated extensions discovered later in precedence order.
#[derive(Debug, Default)]
pub struct NativeAdmissionReport {
	/// Successfully admitted extensions.
	pub extensions: Vec<AdmittedNativeExtension>,
	/// Per-root discovery, manifest, and lowering failures.
	pub errors:     Vec<NativeExtensionError>,
}

/// Failure while discovering or admitting a local Python extension.
#[derive(Debug, Error)]
pub enum NativeExtensionError {
	/// Selected user profile was invalid.
	#[error("user profile could not be resolved")]
	Profile(#[from] omp_core::dirs::ProfileNameError),
	/// An explicit root could not be resolved.
	#[error("explicit extension root does not exist: {path}")]
	MissingExplicitRoot {
		/// Requested path.
		path:   PathBuf,
		/// Filesystem failure.
		#[source]
		source: io::Error,
	},
	/// An explicit root was neither a directory nor a supported manifest file.
	#[error("explicit extension root is not a directory or Python extension manifest: {path}")]
	InvalidExplicitRoot {
		/// Requested path.
		path: PathBuf,
	},
	/// An explicit root contained no accepted Python extension manifest.
	#[error("explicit extension root contains no omp.toml or [tool.omp] pyproject.toml: {path}")]
	MissingManifest {
		/// Canonical root.
		path: PathBuf,
	},
	/// An automatic root escaped its owner-controlled directory.
	#[error("automatic extension root is outside its trusted container: {path}")]
	UntrustedAutomaticRoot {
		/// Escaping extension path.
		path:      PathBuf,
		/// User or project container which was being scanned.
		container: PathBuf,
	},
	/// A directory could not be enumerated.
	#[error("failed to scan extension directory {path}")]
	Scan {
		/// Directory being scanned.
		path:   PathBuf,
		/// Filesystem failure.
		#[source]
		source: io::Error,
	},
	/// A manifest could not be read.
	#[error("failed to read extension manifest {path}")]
	ReadManifest {
		/// Manifest path.
		path:   PathBuf,
		/// Filesystem failure.
		#[source]
		source: io::Error,
	},
	/// A projected `omp.toml` manifest was invalid.
	#[error("invalid extension manifest {path}")]
	Manifest {
		/// Manifest path.
		path:   PathBuf,
		/// Typed manifest failure.
		#[source]
		source: omp_ext::ExtensionError,
	},
	/// A source `pyproject.toml` was malformed.
	#[error("invalid Python project manifest {path}")]
	PyProject {
		/// Manifest path.
		path:   PathBuf,
		/// TOML decoding failure.
		#[source]
		source: toml::de::Error,
	},
	/// The manifest did not provide a usable identity or Python entry module.
	#[error("extension manifest {path} must declare non-empty id and entry fields")]
	MissingIdentity {
		/// Manifest path.
		path: PathBuf,
	},
	/// The declared Python entry module is absent from the distribution root.
	#[error("extension {extension} entry module {module} was not found below {root}")]
	MissingEntryModule {
		/// Extension identity.
		extension: Str,
		/// Declared import module.
		module:    Str,
		/// Canonical distribution root.
		root:      PathBuf,
	},
	/// Static declarations could not be lowered to the environment-host schema.
	#[error("extension manifest declarations are invalid: {path}")]
	Declarations {
		/// Manifest path.
		path:   PathBuf,
		/// Typed JSON projection failure.
		#[source]
		source: serde_json::Error,
	},
	/// Manifest settings or invocation overrides were invalid.
	#[error("extension settings are invalid: {path}")]
	Settings {
		/// Manifest path.
		path:   PathBuf,
		/// Typed setting failure.
		#[source]
		source: omp_ext::ExtensionError,
	},
}

#[derive(Clone, Copy)]
enum RootOrigin {
	Explicit,
	User,
	Workspace,
}

impl RootOrigin {
	const fn layer(self) -> &'static str {
		match self {
			Self::Explicit => "invocation",
			Self::User => "user",
			Self::Workspace => "project",
		}
	}
}

struct LoadedManifest {
	root:     PathBuf,
	path:     PathBuf,
	text:     String,
	manifest: DeploymentManifest,
}

/// Discovers and admits the effective local Python extension set.
///
/// This compatibility entry point preserves fail-fast callers. Production
/// composition uses [`admit_native_extensions_contained`] so one broken
/// package cannot suppress independent extensions.
pub fn admit_native_extensions(
	project_root: &Path,
	home: &Path,
	options: NativeAdmissionOptions<'_>,
) -> Result<Vec<AdmittedNativeExtension>, NativeExtensionError> {
	let mut report = admit_native_extensions_contained(project_root, home, options);
	if report.errors.is_empty() {
		Ok(report.extensions)
	} else {
		Err(report.errors.remove(0))
	}
}

/// Discovers extensions while containing every package-local failure.
///
/// Explicit roots retain precedence over user and workspace roots. Automatic
/// symlink escapes are reported and skipped rather than allowing one hostile
/// directory entry to hide the remaining trusted children.
pub fn admit_native_extensions_contained(
	project_root: &Path,
	home: &Path,
	options: NativeAdmissionOptions<'_>,
) -> NativeAdmissionReport {
	if options.mode == NativeLoadMode::Disabled {
		return NativeAdmissionReport::default();
	}

	let mut report = NativeAdmissionReport::default();
	let mut candidates = Vec::new();
	for root in options.explicit_roots {
		collect_explicit_contained(root, &mut candidates, &mut report.errors);
	}
	if options.mode == NativeLoadMode::Merge {
		match omp_core::dirs::profile_config_dir(home) {
			Ok(config) => collect_automatic_contained(
				&config.join("agent/extensions"),
				RootOrigin::User,
				&mut candidates,
				&mut report.errors,
			),
			Err(error) => report.errors.push(NativeExtensionError::Profile(error)),
		}
		if options.include_workspace {
			collect_automatic_contained(
				&project_root.join(".omp/extensions"),
				RootOrigin::Workspace,
				&mut candidates,
				&mut report.errors,
			);
		}
	}

	let mut seen = BTreeSet::new();
	for (loaded, origin) in candidates {
		if !seen.insert(loaded.manifest.id.clone()) {
			continue;
		}
		if !matches!(origin, RootOrigin::Explicit)
			&& options.disabled.iter().any(|id| *id == loaded.manifest.id)
		{
			tracing::debug!(id = %loaded.manifest.id, "extension disabled by cl_disabled_extensions");
			continue;
		}
		match lower_manifest(loaded, origin, options.setting_overrides) {
			Ok(extension) => report.extensions.push(extension),
			Err(error) => report.errors.push(error),
		}
	}
	report
}

fn collect_explicit_contained(
	requested: &Path,
	out: &mut Vec<(LoadedManifest, RootOrigin)>,
	errors: &mut Vec<NativeExtensionError>,
) {
	let canonical = match fs::canonicalize(requested) {
		Ok(path) => path,
		Err(source) => {
			errors.push(NativeExtensionError::MissingExplicitRoot {
				path: requested.to_path_buf(),
				source,
			});
			return;
		},
	};
	let root = if canonical.is_dir() {
		canonical
	} else if canonical.is_file()
		&& matches!(
			canonical.file_name().and_then(|name| name.to_str()),
			Some("omp.toml" | "pyproject.toml")
		) {
		canonical
			.parent()
			.expect("a canonical manifest path has a parent")
			.to_path_buf()
	} else {
		errors.push(NativeExtensionError::InvalidExplicitRoot { path: canonical });
		return;
	};
	match load_manifest(&root) {
		Ok(Some(manifest)) => {
			out.push((manifest, RootOrigin::Explicit));
			return;
		},
		Err(error) => {
			errors.push(error);
			return;
		},
		Ok(None) => {},
	}
	// Agent Plugins packages contribute data-only skills/MCP resources. They
	// are deliberately not admitted to the locked CPython extension runtime.
	if super::skills::is_agent_plugin_root(&root) {
		return;
	}
	let before = out.len();
	let errors_before = errors.len();
	let children = match sorted_children(&root) {
		Ok(children) => children,
		Err(error) => {
			errors.push(error);
			return;
		},
	};
	for child in children {
		if !child.is_dir() {
			continue;
		}
		match load_manifest(&child) {
			Ok(Some(manifest)) => out.push((manifest, RootOrigin::Explicit)),
			Ok(None) => {},
			Err(error) => errors.push(error),
		}
	}
	if out.len() == before && errors.len() == errors_before {
		errors.push(NativeExtensionError::MissingManifest { path: root });
	}
}

fn collect_automatic_contained(
	container: &Path,
	origin: RootOrigin,
	out: &mut Vec<(LoadedManifest, RootOrigin)>,
	errors: &mut Vec<NativeExtensionError>,
) {
	if !container.exists() {
		return;
	}
	let trusted = match fs::canonicalize(container) {
		Ok(path) => path,
		Err(source) => {
			errors.push(NativeExtensionError::Scan { path: container.to_path_buf(), source });
			return;
		},
	};
	let children = match sorted_children(container) {
		Ok(children) => children,
		Err(error) => {
			errors.push(error);
			return;
		},
	};
	for child in children {
		if !child.is_dir() {
			continue;
		}
		let canonical = match fs::canonicalize(&child) {
			Ok(path) => path,
			Err(source) => {
				errors.push(NativeExtensionError::Scan { path: child, source });
				continue;
			},
		};
		if !canonical.starts_with(&trusted) {
			errors.push(NativeExtensionError::UntrustedAutomaticRoot {
				path:      canonical,
				container: trusted.clone(),
			});
			continue;
		}
		match load_manifest(&canonical) {
			Ok(Some(manifest)) => out.push((manifest, origin)),
			Ok(None) => {},
			Err(error) => errors.push(error),
		}
	}
}

fn sorted_children(root: &Path) -> Result<Vec<PathBuf>, NativeExtensionError> {
	let mut children = fs::read_dir(root)
		.map_err(|source| NativeExtensionError::Scan { path: root.to_path_buf(), source })?
		.map(|entry| entry.map(|entry| entry.path()))
		.collect::<Result<Vec<_>, _>>()
		.map_err(|source| NativeExtensionError::Scan { path: root.to_path_buf(), source })?;
	children.sort_unstable();
	Ok(children)
}

fn load_manifest(root: &Path) -> Result<Option<LoadedManifest>, NativeExtensionError> {
	let direct = root.join("omp.toml");
	if direct.is_file() {
		return read_projected_manifest(root, direct).map(Some);
	}
	for child in sorted_children(root)? {
		if child.is_dir()
			&& child
				.file_name()
				.and_then(|name| name.to_str())
				.is_some_and(|name| name.ends_with(".dist-info"))
		{
			let projected = child.join("omp.toml");
			if projected.is_file() {
				return read_projected_manifest(root, projected).map(Some);
			}
		}
	}
	let pyproject = root.join("pyproject.toml");
	if !pyproject.is_file() {
		return Ok(None);
	}
	let text = fs::read_to_string(&pyproject)
		.map_err(|source| NativeExtensionError::ReadManifest { path: pyproject.clone(), source })?;
	let document = toml::from_str::<toml::Value>(&text)
		.map_err(|source| NativeExtensionError::PyProject { path: pyproject.clone(), source })?;
	let Some(projected) = document
		.get("tool")
		.and_then(|tool| tool.get("omp"))
		.cloned()
	else {
		return Ok(None);
	};
	let manifest = projected
		.try_into::<DeploymentManifest>()
		.map_err(|source| NativeExtensionError::PyProject { path: pyproject.clone(), source })?;
	validate_manifest(&pyproject, &manifest)?;
	Ok(Some(LoadedManifest { root: root.to_path_buf(), path: pyproject, text, manifest }))
}

fn read_projected_manifest(
	root: &Path,
	path: PathBuf,
) -> Result<LoadedManifest, NativeExtensionError> {
	let text = fs::read_to_string(&path)
		.map_err(|source| NativeExtensionError::ReadManifest { path: path.clone(), source })?;
	let manifest = DeploymentManifest::parse(&text)
		.map_err(|source| NativeExtensionError::Manifest { path: path.clone(), source })?;
	validate_manifest(&path, &manifest)?;
	Ok(LoadedManifest { root: root.to_path_buf(), path, text, manifest })
}

fn validate_manifest(
	path: &Path,
	manifest: &DeploymentManifest,
) -> Result<(), NativeExtensionError> {
	manifest
		.validate()
		.map_err(|source| NativeExtensionError::Manifest { path: path.to_path_buf(), source })?;
	if manifest.id.is_empty() || manifest.entry.is_empty() {
		return Err(NativeExtensionError::MissingIdentity { path: path.to_path_buf() });
	}
	Ok(())
}

fn lower_manifest(
	loaded: LoadedManifest,
	origin: RootOrigin,
	overrides: &[CliSettingOverride],
) -> Result<AdmittedNativeExtension, NativeExtensionError> {
	let LoadedManifest { root, path, text, manifest } = loaded;
	let selected = manifest
		.features
		.iter()
		.filter_map(|(name, feature)| feature.default.then(|| name.clone()))
		.collect::<Vec<_>>();
	let projection = manifest
		.project(&selected)
		.map_err(|source| NativeExtensionError::Manifest { path: path.clone(), source })?;
	let mut properties = BTreeMap::new();
	properties.insert(
		Str::new_static("declarations"),
		serde_json::to_value(&projection.declarations)
			.map_err(|source| NativeExtensionError::Declarations { path: path.clone(), source })?,
	);
	properties.insert(
		Str::new_static("capabilities"),
		serde_json::json!({ "data": projection.capabilities }),
	);
	let declarations = StaticDeclarations::from_properties(&properties)
		.map_err(|source| NativeExtensionError::Declarations { path: path.clone(), source })?;
	let (python_site, entry_path) = resolve_entry(&root, &manifest.id, &manifest.entry)?;
	if !matches!(origin, RootOrigin::Explicit) {
		let canonical_entry = fs::canonicalize(&entry_path).map_err(|source| {
			NativeExtensionError::ReadManifest { path: entry_path.clone(), source }
		})?;
		if !canonical_entry.starts_with(&root) {
			return Err(NativeExtensionError::UntrustedAutomaticRoot {
				path:      canonical_entry,
				container: root.clone(),
			});
		}
	}
	let tools = declarations.tools.iter().filter_map(|row| {
		let rev = u16::try_from(row.api.max(1)).ok()?;
		Some(ToolDeclarationKey::new(
			if row.key.is_empty() {
				row.id.clone()
			} else {
				row.key.clone()
			},
			row.properties
				.get("family")
				.and_then(serde_json::Value::as_str)
				.map(Str::new)
				.unwrap_or_default(),
			rev,
		))
	});
	let hooks = declarations.hooks.iter().filter_map(|row| {
		let (event, phase) = row
			.key
			.rsplit_once('/')
			.map_or((row.id.as_str(), "precheck"), |(event, phase)| (event, phase));
		HookPhase::from_str(&phase.to_ascii_lowercase())
			.ok()
			.map(|phase| HookDeclarationKey::new(event, phase))
	});
	let runtime_declarations = DeclarationSet::new(tools, hooks);
	let digest = ArtifactDigest::new(Hash32::sum(text.as_bytes()).into_bytes());
	let publisher = sf!("unsigned:path:{}", Hash32::sum(root.to_string_lossy().as_bytes()).to_hex());
	let layer = origin.layer();
	let provenance = Provenance::new(
		publisher,
		manifest.id.clone(),
		Str::new_static("local"),
		digest,
		Str::new_static(layer),
		Str::new_static("sandboxed"),
		1,
	);
	let runtime_manifest = ExtensionManifest::new_with_static(
		provenance,
		manifest.entry.clone(),
		[],
		runtime_declarations,
		ServiceManifest::default(),
		declarations,
		[],
		[],
	)
	.with_setting_schemas(manifest.settings.clone());
	let settings = resolve_extension_settings(&manifest, &BTreeMap::new(), overrides)
		.map_err(|source| NativeExtensionError::Settings { path: path.clone(), source })?;
	let key = HostKey::new(layer, "sandboxed", manifest.id.clone());
	let mut spec = ExtHostSpec::new(key, runtime_manifest);
	spec.data_grants = Grants::supported(projection.capabilities);
	spec.python_site = Some(python_site);
	spec.entry_path = Some(entry_path);
	spec.settings = settings;
	spec.watch_root = Some(root.clone());
	Ok(AdmittedNativeExtension { root, spec })
}

fn resolve_entry(
	root: &Path,
	extension: &Str,
	module: &Str,
) -> Result<(PathBuf, PathBuf), NativeExtensionError> {
	let relative = module.as_str().replace('.', "/");
	for site in [root.join("src"), root.to_path_buf()] {
		for entry in [site.join(format!("{relative}.py")), site.join(&relative).join("__init__.py")] {
			if entry.is_file() {
				return Ok((site, entry));
			}
		}
	}
	Err(NativeExtensionError::MissingEntryModule {
		extension: extension.clone(),
		module:    module.clone(),
		root:      root.to_path_buf(),
	})
}

#[cfg(test)]
mod tests {
	use std::fs;

	use omp_con::Value as ConValue;

	use super::*;

	fn extension(root: &Path, id: &str, default: bool) {
		fs::create_dir_all(root.join("src/demo")).expect("module directory");
		fs::write(root.join("src/demo/__init__.py"), "# inert test extension\n").expect("module");
		fs::write(
			root.join("omp.toml"),
			format!(
				r#"id = "{id}"
entry = "demo"

[settings.enabled]
type = "boolean"
default = {default}
"#
			),
		)
		.expect("manifest");
	}

	#[test]
	fn explicit_extension_reaches_registration_set_and_excludes_configured_extension() {
		let tree = tempfile::tempdir().expect("tree");
		let home = tree.path().join("home");
		let project = tree.path().join("project");
		let explicit = tree.path().join("explicit");
		let configured = home.join(".o2/agent/extensions/configured");
		extension(&explicit, "test.explicit", false);
		extension(&configured, "test.configured", false);
		fs::create_dir_all(&project).expect("project");
		let admitted = admit_native_extensions(&project, &home, NativeAdmissionOptions {
			explicit_roots:    &[explicit],
			mode:              NativeLoadMode::ExplicitOnly,
			include_workspace: true,
			setting_overrides: &[],
			disabled:          &[],
		})
		.expect("admission");
		assert_eq!(admitted.len(), 1);
		assert_eq!(admitted[0].spec.key.extension().as_str(), "test.explicit");
	}

	#[test]
	fn explicit_root_outranks_automatic_root_with_the_same_identity() {
		let tree = tempfile::tempdir().expect("tree");
		let home = tree.path().join("home");
		let project = tree.path().join("project");
		let explicit = tree.path().join("explicit");
		let automatic = home.join(".o2/agent/extensions/automatic");
		extension(&explicit, "test.priority", false);
		extension(&automatic, "test.priority", true);
		fs::create_dir_all(&project).expect("project");

		let admitted = admit_native_extensions(&project, &home, NativeAdmissionOptions {
			explicit_roots:    &[explicit],
			mode:              NativeLoadMode::Merge,
			include_workspace: true,
			setting_overrides: &[],
			disabled:          &[],
		})
		.expect("admission");
		assert_eq!(admitted.len(), 1);
		assert_eq!(admitted[0].root.file_name().and_then(|name| name.to_str()), Some("explicit"));
		assert_eq!(admitted[0].spec.settings["enabled"], serde_json::json!(false));
	}

	/// `cl_disabled_extensions` is the control
	/// plane's only enablement knob: a listed manifest id is never loaded from
	/// an automatic root, while an explicitly requested root still is.
	#[test]
	fn disabled_extension_ids_are_not_admitted_from_automatic_roots() {
		let tree = tempfile::tempdir().expect("tree");
		let home = tree.path().join("home");
		let project = tree.path().join("project");
		let explicit = tree.path().join("explicit");
		extension(&home.join(".o2/agent/extensions/off"), "test.off", false);
		extension(&project.join(".omp/extensions/on"), "test.on", false);
		extension(&explicit, "test.explicit", false);
		let disabled = [Str::new_static("test.off"), Str::new_static("test.explicit")];
		let admitted = admit_native_extensions(&project, &home, NativeAdmissionOptions {
			explicit_roots:    &[explicit],
			mode:              NativeLoadMode::Merge,
			include_workspace: true,
			setting_overrides: &[],
			disabled:          &disabled,
		})
		.expect("admission");
		let ids = admitted
			.iter()
			.map(|extension| extension.spec.key.extension().as_str().to_owned())
			.collect::<Vec<_>>();
		assert_eq!(ids, ["test.explicit", "test.on"]);
	}

	#[test]
	fn no_workspace_suppresses_project_roots() {
		let tree = tempfile::tempdir().expect("tree");
		let home = tree.path().join("home");
		let project = tree.path().join("project");
		extension(&project.join(".omp/extensions/project-ext"), "test.project", false);
		let admitted = admit_native_extensions(&project, &home, NativeAdmissionOptions {
			explicit_roots:    &[],
			mode:              NativeLoadMode::Merge,
			include_workspace: false,
			setting_overrides: &[],
			disabled:          &[],
		})
		.expect("admission");
		assert!(admitted.is_empty());
	}

	#[cfg(unix)]
	#[test]
	fn automatic_symlink_escape_is_rejected_as_untrusted() {
		use std::os::unix::fs::symlink;

		let tree = tempfile::tempdir().expect("tree");
		let home = tree.path().join("home");
		let project = tree.path().join("project");
		let outside = tree.path().join("outside");
		extension(&outside, "test.escape", false);
		let container = project.join(".omp/extensions");
		fs::create_dir_all(&container).expect("container");
		symlink(&outside, container.join("escape")).expect("symlink");
		let error = admit_native_extensions(&project, &home, NativeAdmissionOptions {
			explicit_roots:    &[],
			mode:              NativeLoadMode::Merge,
			include_workspace: true,
			setting_overrides: &[],
			disabled:          &[],
		})
		.expect_err("escape rejected");
		assert!(matches!(error, NativeExtensionError::UntrustedAutomaticRoot { .. }));
	}

	#[test]
	fn contributed_settings_are_ready_for_convar_registration_before_activation() {
		let tree = tempfile::tempdir().expect("tree");
		let project = tree.path().join("project");
		let root = tree.path().join("extension");
		extension(&root, "test.settings", false);
		let override_value =
			CliSettingOverride::parse("test.settings.enabled=true").expect("override");
		let admitted = admit_native_extensions(&project, tree.path(), NativeAdmissionOptions {
			explicit_roots:    &[root],
			mode:              NativeLoadMode::ExplicitOnly,
			include_workspace: false,
			setting_overrides: &[override_value],
			disabled:          &[],
		})
		.expect("admission");
		let spec = &admitted[0].spec;
		let con = omp_con::Ctx::new();
		omp_envd::exthost::register_extension_setting_convars(
			&con,
			spec.key.extension().as_str(),
			&spec.manifest.setting_schemas,
			&spec.settings,
		)
		.expect("register before activation");
		assert_eq!(con.get("ext::test.settings::enabled").expect("convar"), ConValue::Bool(true));
	}

	#[test]
	fn pyproject_tool_omp_is_the_only_source_manifest_projection() {
		let tree = tempfile::tempdir().expect("tree");
		let project = tree.path().join("project");
		let root = tree.path().join("source");
		fs::create_dir_all(root.join("src/demo")).expect("module directory");
		fs::write(root.join("src/demo/__init__.py"), "# inert test extension\n").expect("module");
		fs::write(
			root.join("pyproject.toml"),
			r#"[project]
name = "ordinary-python-package"
version = "1.0.0"

[tool.omp]
id = "test.pyproject"
entry = "demo"
"#,
		)
		.expect("pyproject");
		fs::write(root.join("package.json"), r#"{"main":"extension.js"}"#).expect("JS metadata");
		fs::write(root.join("extension.ts"), "throw new Error('must never load');")
			.expect("TS source");

		let admitted = admit_native_extensions(&project, tree.path(), NativeAdmissionOptions {
			explicit_roots:    &[root],
			mode:              NativeLoadMode::ExplicitOnly,
			include_workspace: false,
			setting_overrides: &[],
			disabled:          &[],
		})
		.expect("Python manifest admission");
		assert_eq!(admitted.len(), 1);
		assert_eq!(admitted[0].spec.manifest.entry, "demo");
	}

	#[test]
	fn manifest_sealed_generated_skills_publish_contained_discovery_roots() {
		let tree = tempfile::tempdir().expect("tree");
		let root = tree.path().join("extension");
		let module = root.join("src/demo");
		let skill_root = module.join(".omp-generated/skills/review");
		fs::create_dir_all(&skill_root).expect("skill root");
		fs::write(module.join("__init__.py"), "# extension\n").expect("module");
		fs::write(
			skill_root.join("SKILL.md"),
			"---\nname: review\ndescription: Review changes\n---\n\nReview the change.\n",
		)
		.expect("skill");
		fs::write(
			root.join("omp.toml"),
			r#"id = "test.skills"
entry = "demo"

[[declarations]]
kind = "skills"
path = "demo/.omp-generated/skills/review/SKILL.md"
"#,
		)
		.expect("manifest");

		let admitted = admit_native_extensions(tree.path(), tree.path(), NativeAdmissionOptions {
			explicit_roots:    &[root],
			mode:              NativeLoadMode::ExplicitOnly,
			include_workspace: false,
			setting_overrides: &[],
			disabled:          &[],
		})
		.expect("admission");
		assert_eq!(admitted[0].skill_roots(), [fs::canonicalize(
			skill_root.parent().expect("skills root")
		)
		.expect("canonical skill root")]);
		assert_eq!(
			admitted[0].spec.manifest.activation_triggers,
			[omp_envd::exthost::ActivationTrigger::Static]
				.into_iter()
				.collect(),
		);
	}

	#[test]
	fn contained_discovery_keeps_valid_siblings_after_a_manifest_error() {
		let tree = tempfile::tempdir().expect("tree");
		let project = tree.path().join("project");
		let container = project.join(".omp/extensions");
		extension(&container.join("good"), "test.good", false);
		let broken = container.join("broken");
		fs::create_dir_all(&broken).expect("broken extension root");
		fs::write(broken.join("omp.toml"), "id = [not-valid").expect("broken manifest");

		let report =
			admit_native_extensions_contained(&project, tree.path(), NativeAdmissionOptions {
				explicit_roots:    &[],
				mode:              NativeLoadMode::Merge,
				include_workspace: true,
				setting_overrides: &[],
				disabled:          &[],
			});
		assert_eq!(report.extensions.len(), 1);
		assert_eq!(report.extensions[0].spec.key.extension().as_str(), "test.good");
		assert_eq!(report.errors.len(), 1);
		assert!(matches!(&report.errors[0], NativeExtensionError::Manifest { .. }));
	}

	#[test]
	fn missing_explicit_root_is_a_typed_error() {
		let tree = tempfile::tempdir().expect("tree");
		let missing = tree.path().join("missing");
		let error = admit_native_extensions(tree.path(), tree.path(), NativeAdmissionOptions {
			explicit_roots:    &[missing],
			mode:              NativeLoadMode::ExplicitOnly,
			include_workspace: false,
			setting_overrides: &[],
			disabled:          &[],
		})
		.expect_err("missing root");
		assert!(matches!(error, NativeExtensionError::MissingExplicitRoot { .. }));
	}
}
