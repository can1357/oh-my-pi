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
	exec_settings::ExecSandboxMode,
	exthost::{
		DeclarationSet, ExtensionManifest, HookDeclarationKey, ServiceManifest, ToolDeclarationKey,
	},
	policy::{CONTROL_CAPABILITIES, Grants},
	worker::{ExtHostSpec, HostKey},
};
use omp_ext::{
	Layer, TrustTier,
	config::{
		CliSettingOverride, DeploymentManifest, StaticDeclarations, resolve_extension_settings,
	},
	trust::{GrantsFile, grant_covers, grants_path, native_path_publisher, path_grant_digest},
	workspace_trust::inventory::EXTENSIONS_DIR,
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

/// Host facts required before an operator path grant can admit CONTROL.
#[derive(Clone, Copy, Debug)]
pub struct NativeControlGrantOptions<'a> {
	/// The host data directory containing the ext/grants.toml path.
	pub data_dir:          &'a Path,
	/// The effective command sandbox posture.
	pub sandbox_mode:      ExecSandboxMode,
	/// Additional exec-writable roots from the effective sandbox settings.
	pub writable_roots:    &'a [PathBuf],
	/// Whether this host can enforce a kernel-backed exec sandbox.
	pub sandbox_available: bool,
}

/// Rechecks the sandbox facts after journaled class convars are applied.
pub(crate) fn control_grant_sandbox_matches(
	admitted: &NativeControlGrantOptions<'_>,
	ctx: &omp_con::Ctx,
	workspace_root: &Path,
) -> bool {
	let writable_roots = omp_envd::exec_settings::SV_SANDBOX_WRITABLE_ROOTS
		.get(ctx)
		.into_iter()
		.map(|path| PathBuf::from(path.as_str()))
		.collect::<Vec<_>>();
	let mode = omp_envd::exec_settings::SV_SANDBOX_MODE.get(ctx);
	let sandbox_available = omp_envd::admission::probe_sandbox(ctx, workspace_root).confines();
	admitted.sandbox_mode == mode
		&& admitted.writable_roots == writable_roots.as_slice()
		&& admitted.sandbox_available == sandbox_available
}

/// Drops every CONTROL grant from `specs`. A grant holds only under the sandbox
/// facts it was admitted under, and a spec the caller supplied never carries
/// one.
pub(crate) fn withhold_control_grants(specs: &mut [ExtHostSpec]) {
	for spec in specs {
		spec.control_grants.clear();
	}
}

/// Builds the specs the kernel launches: the caller's specs never carry a
/// CONTROL grant, the natively admitted specs are appended with the grants
/// admission applied, and when the journaled class changed the exec sandbox
/// (`sandbox_matches` is false) no spec keeps one.
pub(crate) fn assemble_trusted_specs(
	mut caller: Vec<ExtHostSpec>,
	native: Vec<ExtHostSpec>,
	sandbox_matches: bool,
) -> Vec<ExtHostSpec> {
	withhold_control_grants(&mut caller);
	caller.extend(native);
	if !sandbox_matches {
		withhold_control_grants(&mut caller);
	}
	caller
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
	/// A tool declaration's key was not the canonical `name@family.rev`.
	#[error(
		"tool declaration {id} in {path} has key `{key}`; a tool key must have the form \
		 `name@family.rev`"
	)]
	ToolKey {
		/// Manifest path.
		path: PathBuf,
		/// Declaration identity.
		id:   Str,
		/// The key, or the identity when the declaration has none, that was
		/// refused.
		key:  Str,
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

/// Test-only compatibility admission helper; production uses host-verified
/// control grants.
#[cfg(test)]
fn admit_native_extensions(
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

/// Fail-fast native admission with host-verified operator path grants.
pub fn admit_native_extensions_with_control(
	project_root: &Path,
	home: &Path,
	options: NativeAdmissionOptions<'_>,
	control: &NativeControlGrantOptions<'_>,
) -> Result<Vec<AdmittedNativeExtension>, NativeExtensionError> {
	let mut report =
		admit_native_extensions_contained_with_control(project_root, home, options, control);
	if report.errors.is_empty() {
		Ok(report.extensions)
	} else {
		Err(report.errors.remove(0))
	}
}

/// Test-only contained discovery without control grants.
#[cfg(test)]
fn admit_native_extensions_contained(
	project_root: &Path,
	home: &Path,
	options: NativeAdmissionOptions<'_>,
) -> NativeAdmissionReport {
	admit_native_extensions_inner(project_root, home, options, None)
}

/// Discovers extensions and admits CONTROL only when a matching operator grant
/// is safe under this host's effective exec sandbox.
pub fn admit_native_extensions_contained_with_control(
	project_root: &Path,
	home: &Path,
	options: NativeAdmissionOptions<'_>,
	control: &NativeControlGrantOptions<'_>,
) -> NativeAdmissionReport {
	admit_native_extensions_inner(project_root, home, options, Some(control))
}

fn admit_native_extensions_inner(
	project_root: &Path,
	home: &Path,
	options: NativeAdmissionOptions<'_>,
	control: Option<&NativeControlGrantOptions<'_>>,
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
				&project_root.join(EXTENSIONS_DIR),
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
		match lower_manifest(loaded, origin, options.setting_overrides, project_root, home, control) {
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

/// Splits a canonical tool key `name@family.rev` (the family may be empty, as
/// in `ci@.1`) into the identity the Python worker registers. The revision is
/// the tool's own, never the declaration's API level. Any other shape is not a
/// tool key and admission refuses it.
fn parse_tool_key(key: &str) -> Option<(&str, &str, u16)> {
	let (name, tail) = key.rsplit_once('@')?;
	let (family, rev) = tail.rsplit_once('.')?;
	// Same grammar as the Python host: the revision is ASCII digits only.
	if name.is_empty() || rev.is_empty() || !rev.bytes().all(|byte| byte.is_ascii_digit()) {
		return None;
	}
	Some((name, family, rev.parse().ok()?))
}

fn lower_manifest(
	loaded: LoadedManifest,
	origin: RootOrigin,
	overrides: &[CliSettingOverride],
	project_root: &Path,
	home: &Path,
	control: Option<&NativeControlGrantOptions<'_>>,
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
	let declared_capabilities = projection.capabilities.iter().cloned().collect::<Vec<_>>();
	let control_grants = control.map_or_else(BTreeSet::new, |control| {
		admitted_control_grants(
			&manifest.id,
			&root,
			&text,
			&declared_capabilities,
			origin,
			project_root,
			home,
			control,
		)
	});
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
	let tools = declarations
		.tools
		.iter()
		.map(|row| {
			let key = if row.key.is_empty() {
				&row.id
			} else {
				&row.key
			};
			let (name, family, rev) =
				parse_tool_key(key.as_str()).ok_or_else(|| NativeExtensionError::ToolKey {
					path: path.clone(),
					id:   row.id.clone(),
					key:  key.clone(),
				})?;
			Ok(ToolDeclarationKey::new(Str::new(name), Str::new(family), rev))
		})
		.collect::<Result<Vec<_>, NativeExtensionError>>()?;
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
	let publisher = native_path_publisher(&root);
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
	.with_setting_schemas(manifest.settings.clone())
	.with_schemes(manifest.schemes.clone());
	let settings = resolve_extension_settings(&manifest, &BTreeMap::new(), overrides)
		.map_err(|source| NativeExtensionError::Settings { path: path.clone(), source })?;
	let key = HostKey::new(layer, "sandboxed", manifest.id.clone());
	let mut spec = ExtHostSpec::new(key, runtime_manifest);
	spec.data_grants = Grants::supported(projection.capabilities);
	spec.control_grants = control_grants;
	spec.python_site = Some(python_site);
	spec.entry_path = Some(entry_path);
	spec.settings = settings;
	spec.watch_root = Some(root.clone());
	Ok(AdmittedNativeExtension { root, spec })
}
/// Checks the protected grant store and extension root before admitting any
/// CONTROL.
fn admitted_control_grants(
	id: &Str,
	canonical_root: &Path,
	manifest_text: &str,
	declared_capabilities: &[Str],
	origin: RootOrigin,
	workspace_root: &Path,
	home: &Path,
	options: &NativeControlGrantOptions<'_>,
) -> BTreeSet<Str> {
	if !matches!(origin, RootOrigin::User) {
		return BTreeSet::new();
	}
	let wanted = declared_capabilities
		.iter()
		.filter(|capability| CONTROL_CAPABILITIES.contains(&capability.as_str()))
		.cloned()
		.collect::<BTreeSet<_>>();
	if wanted.is_empty() {
		return wanted;
	}
	if options.sandbox_mode == ExecSandboxMode::Off || !options.sandbox_available {
		tracing::warn!(
			extension = %id,
			mode = %options.sandbox_mode,
			sandbox_available = options.sandbox_available,
			"withholding extension CONTROL grants because no kernel-enforced exec sandbox is active"
		);
		return BTreeSet::new();
	}

	let extension_root = match user_extension_root(home) {
		Ok(path) => path,
		Err(error) => {
			tracing::warn!(extension = %id, path = %home.display(), reason = %error, "withholding extension CONTROL grants");
			return BTreeSet::new();
		},
	};
	if let Err(error) = check_grant_locations(
		options.data_dir,
		&extension_root,
		workspace_root,
		options.writable_roots,
	) {
		tracing::warn!(
			extension = %id,
			reason = %error,
			"withholding extension CONTROL grants because a protected location is unsafe"
		);
		return BTreeSet::new();
	}
	let grants_file = grants_path(options.data_dir);
	let grants = match GrantsFile::read(&grants_file) {
		Ok(grants) => grants,
		Err(error) => {
			tracing::warn!(
				extension = %id,
				path = %grants_file.display(),
				reason = %error,
				"withholding extension CONTROL grants because the grant store is unreadable"
			);
			return BTreeSet::new();
		},
	};
	let identity = path_grant_identity(id, canonical_root, manifest_text, declared_capabilities);
	if grant_covers(
		&grants,
		id,
		&identity.publisher,
		Layer::Client,
		None,
		&identity.capability_digest,
		TrustTier::Sandboxed,
		&Str::new_static(PATH_GRANT_SHIP),
	) {
		wanted
	} else {
		BTreeSet::new()
	}
}

/// `ship` recorded on every operator path grant for an unsigned native
/// extension.
pub const PATH_GRANT_SHIP: &str = "path";

/// Exact operator path-grant identity that admission matches for one
/// user-layer extension. `omp ext grant` writes a record built from it, so the
/// issued grant and the admitted one cannot drift.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PathGrantIdentity {
	/// Extension manifest id.
	pub id:                Str,
	/// Canonical extension root.
	pub root:              PathBuf,
	/// Path publisher derived from the canonical root.
	pub publisher:         Str,
	/// Path-grant digest over the full declared set and the manifest text.
	pub capability_digest: Str,
	/// The CONTROL subset of the declared capabilities.
	pub control:           BTreeSet<Str>,
}

fn path_grant_identity(
	id: &Str,
	canonical_root: &Path,
	manifest_text: &str,
	declared_capabilities: &[Str],
) -> PathGrantIdentity {
	let manifest_digest = Hash32::sum(manifest_text.as_bytes()).into_bytes();
	PathGrantIdentity {
		id:                id.clone(),
		root:              canonical_root.to_path_buf(),
		publisher:         native_path_publisher(canonical_root),
		capability_digest: path_grant_digest(declared_capabilities.iter().cloned(), &manifest_digest),
		control:           declared_capabilities
			.iter()
			.filter(|capability| CONTROL_CAPABILITIES.contains(&capability.as_str()))
			.cloned()
			.collect(),
	}
}

/// The automatic user-layer extension root, `<config>/agent/extensions`.
///
/// # Errors
///
/// [`NativeExtensionError::Profile`] when the profile config dir is invalid.
pub fn user_extension_root(home: &Path) -> Result<PathBuf, NativeExtensionError> {
	Ok(omp_core::dirs::profile_config_dir(home)?.join("agent/extensions"))
}

/// Store checks shared by admission and `omp ext grant`: `<data>/ext`, its
/// grant file and the user extension root must not be symlinks, must be owned
/// by the effective user, and must not overlap an exec-writable root.
///
/// # Errors
///
/// The first [`ProtectedLocationError`] found.
pub fn check_grant_locations(
	data_dir: &Path,
	extension_root: &Path,
	workspace_root: &Path,
	configured_writable_roots: &[PathBuf],
) -> Result<(), super::protected::ProtectedLocationError> {
	let writable = super::protected::exec_writable_roots(workspace_root, configured_writable_roots);
	for location in [data_dir.join("ext"), grants_path(data_dir), extension_root.to_path_buf()] {
		super::protected::check_protected_location(&location, &writable)?;
	}
	Ok(())
}

/// Finds the extension `id` installed under the user extension root and
/// returns the grant identity admission would match. `Ok(None)` means `id` is
/// not a user-layer extension.
///
/// # Errors
///
/// A profile, scan or manifest failure for the user root or the named package.
pub fn user_extension_grant_identity(
	home: &Path,
	id: &str,
) -> Result<Option<PathGrantIdentity>, NativeExtensionError> {
	let root = user_extension_root(home)?;
	let mut found = Vec::new();
	let mut errors = Vec::new();
	collect_automatic_contained(&root, RootOrigin::User, &mut found, &mut errors);
	for (loaded, _) in found {
		if loaded.manifest.id.as_str() == id {
			let declared = default_declared_capabilities(&loaded.manifest, &loaded.path)?;
			return Ok(Some(path_grant_identity(
				&loaded.manifest.id,
				&loaded.root,
				&loaded.text,
				&declared,
			)));
		}
	}
	errors.into_iter().next().map_or(Ok(None), Err)
}

fn default_declared_capabilities(
	manifest: &DeploymentManifest,
	path: &Path,
) -> Result<Vec<Str>, NativeExtensionError> {
	let selected = manifest
		.features
		.iter()
		.filter_map(|(name, feature)| feature.default.then(|| name.clone()))
		.collect::<Vec<_>>();
	let projection = manifest
		.project(&selected)
		.map_err(|source| NativeExtensionError::Manifest { path: path.to_path_buf(), source })?;
	Ok(projection.capabilities.iter().cloned().collect())
}

/// Protected path spellings used by the environment exec sandbox.
pub fn protected_write_paths(data_dir: &Path, home: &Path) -> Vec<PathBuf> {
	omp_envd::exec_settings::protected_write_paths(data_dir, home)
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

	fn security_test_tree() -> tempfile::TempDir {
		let home = std::env::var_os("HOME")
			.map(PathBuf::from)
			.expect("test home");
		tempfile::tempdir_in(home).expect("temporary tree outside TMPDIR")
	}

	fn control_extension(root: &Path, id: &str) {
		extension(root, id, false);
		fs::write(
			root.join("omp.toml"),
			format!(
				r#"id = "{id}"
entry = "demo"
capabilities = ["agents.continuation", "policy.write"]

[settings.enabled]
type = "boolean"
default = false
"#
			),
		)
		.expect("control manifest");
	}

	fn persist_control_grant(data_dir: &Path, root: &Path, id: &Str) {
		use omp_ext::trust::{Grant, GrantDuration, GrantScope};

		let manifest = fs::read_to_string(root.join("omp.toml")).expect("manifest");
		let declared = [sf!("agents.continuation"), sf!("policy.write")];
		let manifest_digest = Hash32::sum(manifest.as_bytes()).into_bytes();
		let capability_digest = path_grant_digest(declared, &manifest_digest);
		let canonical_root = fs::canonicalize(root).expect("canonical extension root");
		let grant = Grant {
			id: id.clone(),
			publisher: native_path_publisher(&canonical_root),
			layer: Layer::Client,
			workspace: None,
			scope: GrantScope::Exact,
			capability_digest,
			tier: TrustTier::Sandboxed,
			ship: sf!("path"),
			granted_at: sf!("2026-11-17T00:00:00Z"),
			granted_by: sf!("explicit-grant"),
			duration: GrantDuration::Persistent,
		};
		let file = grants_path(data_dir);
		fs::create_dir_all(file.parent().expect("grant parent")).expect("grant directory");
		GrantsFile::update(&file, |store| store.grants.push(grant)).expect("persist grant");
	}

	fn user_control_admission(
		project: &Path,
		home: &Path,
		data_dir: &Path,
		mode: ExecSandboxMode,
		sandbox_available: bool,
		writable_roots: &[PathBuf],
	) -> NativeAdmissionReport {
		admit_native_extensions_contained_with_control(
			project,
			home,
			NativeAdmissionOptions {
				explicit_roots:    &[],
				mode:              NativeLoadMode::Merge,
				include_workspace: true,
				setting_overrides: &[],
				disabled:          &[],
			},
			&NativeControlGrantOptions {
				data_dir,
				sandbox_mode: mode,
				writable_roots,
				sandbox_available,
			},
		)
	}

	fn user_fixture(tree: &Path, id: &str) -> (PathBuf, PathBuf, PathBuf, PathBuf) {
		let home = tree.join("home");
		let project = tree.join("workspace");
		let data_dir = tree.join("data");
		let extension_root = home.join(".o2/agent/extensions").join(id);
		fs::create_dir_all(&project).expect("workspace");
		fs::create_dir_all(&data_dir).expect("data dir");
		control_extension(&extension_root, id);
		(home, project, data_dir, extension_root)
	}

	fn assert_no_control_grant(report: &NativeAdmissionReport, id: &str) {
		let extension = report
			.extensions
			.iter()
			.find(|item| item.spec.key.extension().as_str() == id)
			.expect("extension admitted");
		assert!(extension.spec.control_grants.is_empty());
	}

	#[test]
	fn tool_keys_parse_as_name_family_rev() {
		assert_eq!(parse_tool_key("set_policy@grantproof.1"), Some(("set_policy", "grantproof", 1)));
		assert_eq!(parse_tool_key("ci@.1"), Some(("ci", "", 1)));
		assert_eq!(parse_tool_key("hello@qaext-id.2"), Some(("hello", "qaext-id", 2)));
		assert_eq!(parse_tool_key("a@b.+1"), None, "a sign is not a revision");
		assert_eq!(parse_tool_key("a@b."), None, "an empty revision is refused");
		assert_eq!(parse_tool_key("a@b. 1"), None, "whitespace is not a revision");
		assert_eq!(parse_tool_key("legacy_tool"), None);
		assert_eq!(parse_tool_key("a@b"), None);
		assert_eq!(parse_tool_key("a@b.x"), None);
		assert_eq!(parse_tool_key("a@b.70000"), None);
		assert_eq!(parse_tool_key("@b.1"), None);
	}

	fn admit_demo_rows(rows: &str) -> Result<Vec<AdmittedNativeExtension>, NativeExtensionError> {
		let tree = tempfile::tempdir().expect("tree");
		let root = tree.path().join("ext");
		fs::create_dir_all(root.join("src/demo")).expect("module directory");
		fs::write(root.join("src/demo/__init__.py"), "# inert test extension\n").expect("module");
		fs::write(root.join("omp.toml"), format!("id = \"demo\"\nentry = \"demo\"\n\n{rows}"))
			.expect("manifest");
		admit_native_extensions(tree.path(), tree.path(), NativeAdmissionOptions {
			explicit_roots:    &[root],
			mode:              NativeLoadMode::ExplicitOnly,
			include_workspace: false,
			setting_overrides: &[],
			disabled:          &[],
		})
	}

	#[test]
	fn native_tool_declarations_lower_as_name_family_rev() {
		let admitted = admit_demo_rows(
			r#"[[declarations]]
id = "set_policy"
kind = "soft"
module = "demo"
key = "set_policy@grantproof.1"
trigger = "lazy"
api = 1
failure = "fault"

[[declarations]]
id = "ci"
kind = "soft"
module = "demo"
key = "ci@.1"
trigger = "lazy"
api = 3
failure = "fault"

[[declarations]]
id = "hello"
kind = "hard"
module = "demo"
key = "hello@qaext.1"
trigger = "lazy"
api = 1
failure = "fail-closed"

[[declarations]]
id = "review"
kind = "soft"
module = "demo"
key = "review@rv.2"
trigger = "lazy"
api = 1
failure = "fault"

[[declarations]]
id = "moonshot"
kind = "provider"
module = "demo"
key = "moonshot@0"
trigger = "lazy"
api = 1
failure = "fault"
"#,
		)
		.expect("admitted");
		let tools = admitted[0]
			.spec
			.manifest
			.declarations
			.tools()
			.map(|tool| (tool.name.as_str().to_owned(), tool.family.as_str().to_owned(), tool.rev))
			.collect::<BTreeSet<_>>();
		assert_eq!(
			tools,
			BTreeSet::from([
				("set_policy".to_owned(), "grantproof".to_owned(), 1),
				("ci".to_owned(), String::new(), 1),
				("hello".to_owned(), "qaext".to_owned(), 1),
				("review".to_owned(), "rv".to_owned(), 2),
			]),
			"the worker registers (name, family, rev); a canonical name@family.rev key must lower to \
			 exactly that, with the revision taken from the key and never from the manifest API \
			 level; a provider row keeps its own key and is not a tool"
		);
	}

	#[test]
	fn non_canonical_tool_keys_are_refused_with_a_typed_error() {
		for (key, refused) in [
			("legacy_tool", "legacy_tool"),
			("", "legacy_tool"),
			("review@rv", "review@rv"),
			("review@rv.x", "review@rv.x"),
			("@rv.1", "@rv.1"),
			("review@rv.70000", "review@rv.70000"),
		] {
			let rows = format!(
				"[[declarations]]\nid = \"legacy_tool\"\nkind = \"soft\"\nmodule = \"demo\"\nkey = \
				 \"{key}\"\ntrigger = \"lazy\"\napi = 1\nfailure = \"fault\"\n"
			);
			let Err(error) = admit_demo_rows(&rows) else {
				panic!("a tool key of {key:?} must be refused");
			};
			assert!(
				matches!(
					&error,
					NativeExtensionError::ToolKey { id, key: refused_key, .. }
						if id.as_str() == "legacy_tool" && refused_key.as_str() == refused
				),
				"{key:?} must be refused as ToolKey({refused:?}), got {error:?}"
			);
		}
	}

	#[test]
	fn bundled_and_fixture_tool_rows_have_canonical_keys() {
		fn manifests_below(dir: &Path, depth: usize) -> Vec<PathBuf> {
			let mut found = Vec::new();
			for entry in fs::read_dir(dir).expect("manifest directory") {
				let path = entry.expect("directory entry").path();
				if depth > 0 && path.is_dir() {
					found.extend(manifests_below(&path, depth - 1));
				} else if path.file_name().is_some_and(|name| name == "omp.toml") {
					found.push(path);
				}
			}
			found
		}
		let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
		for (root, depth) in [("extensions", 1), ("scripts/qa/fixtures/extensions", 2)] {
			let mut checked = 0;
			for path in manifests_below(&repo.join(root), depth) {
				let manifest =
					toml::from_str::<toml::Table>(&fs::read_to_string(&path).expect("manifest text"))
						.expect("manifest toml");
				let features = manifest.get("features").and_then(toml::Value::as_table);
				let rows = manifest
					.get("declarations")
					.into_iter()
					.chain(features.into_iter().flat_map(|features| {
						features
							.values()
							.filter_map(|feature| feature.get("declarations"))
					}))
					.filter_map(toml::Value::as_array)
					.flatten()
					.filter_map(toml::Value::as_table);
				for row in rows {
					let text = |field: &str| {
						row.get(field)
							.and_then(toml::Value::as_str)
							.unwrap_or_default()
					};
					if !matches!(text("kind"), "soft" | "hard" | "tool") {
						continue;
					}
					let key = if text("key").is_empty() {
						text("id")
					} else {
						text("key")
					};
					assert!(
						parse_tool_key(key).is_some(),
						"{}: tool declaration {:?} has key {key:?}, which admission refuses",
						path.display(),
						text("id"),
					);
					checked += 1;
				}
			}
			assert!(checked > 0, "no tool declarations found below {root}");
		}
	}

	#[test]
	fn class_sandbox_off_invalidates_admission_context() {
		let ctx = omp_con::Ctx::new();
		let tree = security_test_tree();
		let workspace = tree.path().join("workspace");
		fs::create_dir_all(&workspace).expect("workspace");
		let data_dir = tree.path().join("data");
		let writable_roots = Vec::new();
		let admitted = NativeControlGrantOptions {
			data_dir:          &data_dir,
			sandbox_mode:      omp_envd::exec_settings::SV_SANDBOX_MODE.get(&ctx),
			writable_roots:    &writable_roots,
			sandbox_available: omp_envd::admission::probe_sandbox(&ctx, &workspace).confines(),
		};
		assert!(control_grant_sandbox_matches(&admitted, &ctx, &workspace));
		omp_envd::exec_settings::SV_SANDBOX_MODE
			.set(&ctx, ExecSandboxMode::Off)
			.expect("class sandbox override");
		assert!(!control_grant_sandbox_matches(&admitted, &ctx, &workspace));
	}

	#[test]
	fn user_layer_declared_without_grant_gets_none() {
		let tree = security_test_tree();
		let (home, project, data_dir, root) = user_fixture(tree.path(), "test.user");
		let report = user_control_admission(
			&project,
			&home,
			&data_dir,
			ExecSandboxMode::WorkspaceWrite,
			true,
			&[],
		);
		let extension = report
			.extensions
			.iter()
			.find(|item| item.spec.key.extension().as_str() == "test.user")
			.expect("user extension admitted");
		assert!(extension.spec.control_grants.is_empty());
		assert!(root.exists());
	}

	#[test]
	fn user_layer_matching_grant_yields_control_grant() {
		let tree = security_test_tree();
		let (home, project, data_dir, root) = user_fixture(tree.path(), "test.user");
		persist_control_grant(&data_dir, &root, &sf!("test.user"));
		let report = user_control_admission(
			&project,
			&home,
			&data_dir,
			ExecSandboxMode::WorkspaceWrite,
			true,
			&[],
		);
		let extension = report
			.extensions
			.iter()
			.find(|item| item.spec.key.extension().as_str() == "test.user")
			.expect("user extension admitted");
		assert_eq!(
			extension.spec.control_grants,
			BTreeSet::from([sf!("agents.continuation"), sf!("policy.write")])
		);
	}

	#[test]
	fn withhold_control_grants_clears_every_spec_and_changes_nothing_else() {
		let tree = security_test_tree();
		let (home, project, data_dir, root) = user_fixture(tree.path(), "test.user");
		persist_control_grant(&data_dir, &root, &sf!("test.user"));
		let report = user_control_admission(
			&project,
			&home,
			&data_dir,
			ExecSandboxMode::WorkspaceWrite,
			true,
			&[],
		);
		let granted = report
			.extensions
			.into_iter()
			.find(|item| item.spec.key.extension().as_str() == "test.user")
			.expect("user extension admitted")
			.spec;
		assert!(!granted.control_grants.is_empty(), "the fixture starts with a grant");
		let mut ungranted = granted.clone();
		ungranted.control_grants.clear();
		let mut specs = vec![granted.clone(), ungranted, granted.clone()];

		withhold_control_grants(&mut specs);

		for spec in &specs {
			assert!(spec.control_grants.is_empty());
			assert_eq!(spec.key.layer(), granted.key.layer());
			assert_eq!(spec.key.tier(), granted.key.tier());
			assert_eq!(spec.key.extension(), granted.key.extension());
		}
		withhold_control_grants(&mut []);
	}

	fn granted_spec() -> ExtHostSpec {
		let tree = security_test_tree();
		let (home, project, data_dir, root) = user_fixture(tree.path(), "test.user");
		persist_control_grant(&data_dir, &root, &sf!("test.user"));
		let report = user_control_admission(
			&project,
			&home,
			&data_dir,
			ExecSandboxMode::WorkspaceWrite,
			true,
			&[],
		);
		let spec = report
			.extensions
			.into_iter()
			.find(|item| item.spec.key.extension().as_str() == "test.user")
			.expect("user extension admitted")
			.spec;
		assert!(!spec.control_grants.is_empty(), "the fixture starts with a grant");
		spec
	}

	#[test]
	fn assemble_trusted_specs_drops_caller_grants_and_keeps_native_ones() {
		let granted = granted_spec();

		let specs = assemble_trusted_specs(vec![granted.clone()], vec![granted.clone()], true);

		assert_eq!(specs.len(), 2);
		assert!(specs[0].control_grants.is_empty(), "a caller spec must never carry a grant");
		assert_eq!(specs[1].control_grants, granted.control_grants);
	}

	#[test]
	fn assemble_trusted_specs_drops_every_grant_when_the_sandbox_changed() {
		let granted = granted_spec();

		let specs = assemble_trusted_specs(vec![granted.clone()], vec![granted], false);

		assert_eq!(specs.len(), 2);
		assert!(specs.iter().all(|spec| spec.control_grants.is_empty()));
	}

	#[test]
	fn changed_manifest_voids_grant() {
		let tree = security_test_tree();
		let (home, project, data_dir, root) = user_fixture(tree.path(), "test.user");
		persist_control_grant(&data_dir, &root, &sf!("test.user"));
		let mut manifest = fs::read_to_string(root.join("omp.toml")).expect("manifest");
		manifest.push_str("# changed after approval\n");
		fs::write(root.join("omp.toml"), manifest).expect("change manifest");
		let report = user_control_admission(
			&project,
			&home,
			&data_dir,
			ExecSandboxMode::WorkspaceWrite,
			true,
			&[],
		);
		let extension = report
			.extensions
			.iter()
			.find(|item| item.spec.key.extension().as_str() == "test.user")
			.expect("user extension admitted");
		assert!(extension.spec.control_grants.is_empty());
	}

	#[test]
	fn grant_for_other_root_does_not_cover() {
		let tree = security_test_tree();
		let (home, project, data_dir, root) = user_fixture(tree.path(), "test.user");
		let other = tree.path().join("other-root");
		fs::create_dir_all(&other).expect("other root");
		control_extension(&other, "test.user");
		persist_control_grant(&data_dir, &other, &sf!("test.user"));
		let report = user_control_admission(
			&project,
			&home,
			&data_dir,
			ExecSandboxMode::WorkspaceWrite,
			true,
			&[],
		);
		let extension = report
			.extensions
			.iter()
			.find(|item| item.spec.key.extension().as_str() == "test.user")
			.expect("user extension admitted");
		assert!(extension.spec.control_grants.is_empty());
		assert!(root.exists());
	}

	#[test]
	fn workspace_layer_never_gets_control_grant() {
		let tree = security_test_tree();
		let home = tree.path().join("home");
		let project = tree.path().join("workspace");
		let data_dir = tree.path().join("data");
		let root = project.join(EXTENSIONS_DIR).join("test.workspace");
		fs::create_dir_all(&project).expect("workspace");
		fs::create_dir_all(&data_dir).expect("data dir");
		control_extension(&root, "test.workspace");
		persist_control_grant(&data_dir, &root, &sf!("test.workspace"));
		let report = user_control_admission(
			&project,
			&home,
			&data_dir,
			ExecSandboxMode::WorkspaceWrite,
			true,
			&[],
		);
		let extension = report
			.extensions
			.iter()
			.find(|item| item.spec.key.extension().as_str() == "test.workspace")
			.expect("workspace extension admitted");
		assert!(extension.spec.control_grants.is_empty());
	}

	#[test]
	fn explicit_root_never_gets_control_grant() {
		let tree = security_test_tree();
		let home = tree.path().join("home");
		let project = tree.path().join("workspace");
		let data_dir = tree.path().join("data");
		let root = tree.path().join("explicit");
		fs::create_dir_all(&project).expect("workspace");
		fs::create_dir_all(&data_dir).expect("data dir");
		control_extension(&root, "test.explicit");
		persist_control_grant(&data_dir, &root, &sf!("test.explicit"));
		let report = admit_native_extensions_contained_with_control(
			&project,
			&home,
			NativeAdmissionOptions {
				explicit_roots:    std::slice::from_ref(&root),
				mode:              NativeLoadMode::ExplicitOnly,
				include_workspace: false,
				setting_overrides: &[],
				disabled:          &[],
			},
			&NativeControlGrantOptions {
				data_dir:          &data_dir,
				sandbox_mode:      ExecSandboxMode::WorkspaceWrite,
				writable_roots:    &[],
				sandbox_available: true,
			},
		);
		let extension = report
			.extensions
			.iter()
			.find(|item| item.spec.key.extension().as_str() == "test.explicit")
			.expect("explicit extension admitted");
		assert!(extension.spec.control_grants.is_empty());
	}

	#[test]
	fn sandbox_off_yields_no_control_grants() {
		let tree = security_test_tree();
		let (home, project, data_dir, root) = user_fixture(tree.path(), "test.user");
		persist_control_grant(&data_dir, &root, &sf!("test.user"));
		let report =
			user_control_admission(&project, &home, &data_dir, ExecSandboxMode::Off, true, &[]);
		let extension = report
			.extensions
			.iter()
			.find(|item| item.spec.key.extension().as_str() == "test.user")
			.expect("user extension admitted");
		assert!(extension.spec.control_grants.is_empty());
	}

	#[test]
	fn no_sandbox_backend_yields_no_control_grants() {
		let tree = security_test_tree();
		let (home, project, data_dir, root) = user_fixture(tree.path(), "test.user");
		persist_control_grant(&data_dir, &root, &sf!("test.user"));
		let report = user_control_admission(
			&project,
			&home,
			&data_dir,
			ExecSandboxMode::WorkspaceWrite,
			false,
			&[],
		);
		let extension = report
			.extensions
			.iter()
			.find(|item| item.spec.key.extension().as_str() == "test.user")
			.expect("user extension admitted");
		assert!(extension.spec.control_grants.is_empty());
	}

	#[test]
	fn unreadable_store_fails_closed() {
		let tree = security_test_tree();
		let (home, project, data_dir, root) = user_fixture(tree.path(), "test.user");
		persist_control_grant(&data_dir, &root, &sf!("test.user"));
		let grants_file = grants_path(&data_dir);
		let admit = || {
			user_control_admission(
				&project,
				&home,
				&data_dir,
				ExecSandboxMode::WorkspaceWrite,
				true,
				&[],
			)
		};

		// The grant is valid: only an unreadable store may withhold it.
		let granted = admit();
		let extension = granted
			.extensions
			.iter()
			.find(|item| item.spec.key.extension().as_str() == "test.user")
			.expect("user extension admitted");
		assert_eq!(
			extension.spec.control_grants,
			BTreeSet::from([sf!("agents.continuation"), sf!("policy.write")])
		);

		#[cfg(unix)]
		{
			use std::os::unix::fs::PermissionsExt as _;

			// SAFETY: geteuid has no preconditions and cannot fail.
			if unsafe { libc::geteuid() } == 0 {
				eprintln!("skip: root reads a mode-000 grants file");
			} else {
				fs::set_permissions(&grants_file, fs::Permissions::from_mode(0o000))
					.expect("make the grants file unreadable");
				assert_no_control_grant(&admit(), "test.user");
				fs::set_permissions(&grants_file, fs::Permissions::from_mode(0o600))
					.expect("restore the grants file");
			}
		}

		// A grants path that cannot be read as a file fails closed for every user,
		// root included.
		fs::remove_file(&grants_file).expect("remove the grants file");
		fs::create_dir(&grants_file).expect("grants path as a directory");
		assert_no_control_grant(&admit(), "test.user");
		assert!(root.exists());
	}

	#[cfg(unix)]
	#[test]
	fn symlinked_store_is_denied_during_admission() {
		use std::os::unix::fs::symlink;

		let tree = security_test_tree();
		let (home, project, data_dir, root) = user_fixture(tree.path(), "test.user");
		persist_control_grant(&data_dir, &root, &sf!("test.user"));
		let store = data_dir.join("ext");
		let target = tree.path().join("store-target");
		fs::rename(&store, &target).expect("move store");
		symlink(&target, &store).expect("store symlink");
		let report = user_control_admission(
			&project,
			&home,
			&data_dir,
			ExecSandboxMode::WorkspaceWrite,
			true,
			&[],
		);
		assert_no_control_grant(&report, "test.user");
	}

	#[cfg(unix)]
	#[test]
	fn symlinked_grant_file_is_denied_during_admission() {
		use std::os::unix::fs::symlink;

		let tree = security_test_tree();
		let (home, project, data_dir, root) = user_fixture(tree.path(), "test.user");
		persist_control_grant(&data_dir, &root, &sf!("test.user"));
		let file = grants_path(&data_dir);
		let target = tree.path().join("grants-target.toml");
		fs::rename(&file, &target).expect("move grants file");
		symlink(&target, &file).expect("grant-file symlink");
		let report = user_control_admission(
			&project,
			&home,
			&data_dir,
			ExecSandboxMode::WorkspaceWrite,
			true,
			&[],
		);
		assert_no_control_grant(&report, "test.user");
	}

	#[test]
	fn store_inside_workspace_is_denied_during_admission() {
		let tree = security_test_tree();
		let (home, project, _, root) = user_fixture(tree.path(), "test.user");
		let data_dir = project.join(".o2/data");
		fs::create_dir_all(&data_dir).expect("workspace data dir");
		persist_control_grant(&data_dir, &root, &sf!("test.user"));
		let report = user_control_admission(
			&project,
			&home,
			&data_dir,
			ExecSandboxMode::WorkspaceWrite,
			true,
			&[],
		);
		assert_no_control_grant(&report, "test.user");
	}

	#[test]
	fn extension_root_inside_writable_root_is_denied_during_admission() {
		let tree = security_test_tree();
		let (home, project, data_dir, root) = user_fixture(tree.path(), "test.user");
		persist_control_grant(&data_dir, &root, &sf!("test.user"));
		let report = user_control_admission(
			&project,
			&home,
			&data_dir,
			ExecSandboxMode::WorkspaceWrite,
			true,
			std::slice::from_ref(&home),
		);
		assert_no_control_grant(&report, "test.user");
	}

	#[test]
	fn writable_root_inside_store_is_denied_during_admission() {
		let tree = security_test_tree();
		let (home, project, data_dir, root) = user_fixture(tree.path(), "test.user");
		persist_control_grant(&data_dir, &root, &sf!("test.user"));
		let writable = grants_path(&data_dir)
			.parent()
			.expect("store root")
			.join("scratch");
		fs::create_dir_all(&writable).expect("writable child");
		let report = user_control_admission(
			&project,
			&home,
			&data_dir,
			ExecSandboxMode::WorkspaceWrite,
			true,
			std::slice::from_ref(&writable),
		);
		assert_no_control_grant(&report, "test.user");
	}

	#[cfg(unix)]
	#[test]
	fn foreign_owned_extension_root_is_denied_during_admission() {
		use std::{ffi::CString, os::unix::ffi::OsStrExt as _};

		// SAFETY: geteuid has no preconditions.
		if unsafe { libc::geteuid() } != 0 {
			// Only root can give the extension root to another user, and no symlink-free
			// root-owned path can stand in for it, so assert the ownership check admission
			// relies on against a root-owned system directory instead.
			assert!(matches!(
				crate::discovery::protected::check_protected_location(Path::new("/usr"), &[]),
				Err(crate::discovery::protected::ProtectedLocationError::ForeignOwner { .. })
			));
			return;
		}

		let tree = security_test_tree();
		let (home, project, data_dir, root) = user_fixture(tree.path(), "test.user");
		persist_control_grant(&data_dir, &root, &sf!("test.user"));
		let extension_root = home.join(".o2/agent/extensions");
		let c_path = CString::new(extension_root.as_os_str().as_bytes()).expect("path has no nul");
		let foreign_uid = 1;
		// SAFETY: c_path is NUL-terminated and both ids are plain integers.
		if unsafe { libc::chown(c_path.as_ptr(), foreign_uid, u32::MAX) } != 0 {
			eprintln!("skip: cannot create a foreign-owned extension root on this host");
			return;
		}
		let report = user_control_admission(
			&project,
			&home,
			&data_dir,
			ExecSandboxMode::WorkspaceWrite,
			true,
			&[],
		);
		assert_no_control_grant(&report, "test.user");
	}

	#[cfg(unix)]
	#[test]
	fn symlinked_extension_root_is_denied_during_admission() {
		use std::os::unix::fs::symlink;

		let tree = security_test_tree();
		let (home, project, data_dir, root) = user_fixture(tree.path(), "test.user");
		let extension_base = home.join(".o2/agent/extensions");
		let target = tree.path().join("extension-base-target");
		fs::rename(&extension_base, &target).expect("move extension root");
		symlink(&target, &extension_base).expect("extension-root symlink");
		persist_control_grant(&data_dir, &root, &sf!("test.user"));
		let report = user_control_admission(
			&project,
			&home,
			&data_dir,
			ExecSandboxMode::WorkspaceWrite,
			true,
			&[],
		);
		if let Some(extension) = report
			.extensions
			.iter()
			.find(|item| item.spec.key.extension().as_str() == "test.user")
		{
			assert!(extension.spec.control_grants.is_empty());
		} else {
			assert!(!report.errors.is_empty(), "symlinked extension root was silently admitted");
		}
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
