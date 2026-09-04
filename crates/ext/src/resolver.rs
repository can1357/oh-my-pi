//! `uv` resolver driver and deterministic resolution-policy checks.

use std::{
	collections::BTreeSet,
	ffi::OsString,
	fs, io,
	path::PathBuf,
	process::{Command, Output},
	str::FromStr as _,
};

use omp_core::Str;
use pep440_rs::{Version, VersionSpecifiers};

use super::{ExtensionCode, ExtensionError};
use crate::config::FeatureManifest;

/// The `CPython` ABI tags allowed by R3.
pub const ACCEPTED_ABIS: [&str; 3] = ["cp314t", "abi3t", "none"];

/// One enabled extension requirement participating in a host-child unit.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResolveRequirement {
	/// Owning extension id, used in unsat explanations.
	pub extension_id: Str,
	/// Hash-pinned requirement text supplied to uv.
	pub requirement:  Str,
}

/// Pure data used to construct one reproducible `uv` invocation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UvRequest {
	/// `uv` executable, ordinarily from `OMP_EXT_UV` or PATH.
	pub executable:        PathBuf,
	/// Target triple for R4/R12.
	pub target:            Str,
	/// Ordered first-index sources.
	pub indexes:           Vec<String>,
	/// Optional R9 timestamp clamp.
	pub exclude_newer:     Option<Str>,
	/// Forbid all network access and require uv's local cache.
	pub offline:           bool,
	/// Resolver input containing the root requirements and any pinned closure.
	pub requirements_file: PathBuf,
	/// PEP 751 output written by uv and returned through [`ResolveOutcome`].
	pub output_file:       PathBuf,
	/// Root requirements used for frozen-conflict checks and diagnostics.
	pub requirements:      Vec<ResolveRequirement>,
}

impl UvRequest {
	/// Constructs the exact argv passed to `uv`. This stays pure so callers can
	/// show `resolve --explain` without touching the network.
	pub fn argv(&self) -> Vec<OsString> {
		let mut argv = vec![
			OsString::from("pip"),
			OsString::from("compile"),
			OsString::from("--format"),
			OsString::from("pylock.toml"),
			OsString::from("--output-file"),
			self.output_file.clone().into_os_string(),
			OsString::from("--only-binary"),
			OsString::from(":all:"),
			OsString::from("--python-platform"),
			OsString::from(self.target.as_str()),
			OsString::from("--python-version"),
			OsString::from("3.14"),
			OsString::from("--index-strategy"),
			OsString::from("first-index"),
		];
		for index in &self.indexes {
			argv.push(OsString::from("--index-url"));
			argv.push(OsString::from(index));
		}
		if let Some(exclude_newer) = &self.exclude_newer {
			argv.push(OsString::from("--exclude-newer"));
			argv.push(OsString::from(exclude_newer.as_str()));
		}
		if self.offline {
			argv.push(OsString::from("--offline"));
		}
		argv.push(self.requirements_file.clone().into_os_string());
		argv
	}

	/// R7 checks PEP 508 requirements against actual frozen runtime metadata
	/// before invoking uv, preventing a silently shadowed site copy.
	pub fn reject_frozen_conflicts(&self, frozen: &[(&str, &str)]) -> Result<(), ExtensionError> {
		let target = TargetEnvironment::from_triple(self.target.as_str());
		for requirement in &self.requirements {
			let Some(parsed) = FrozenRequirement::parse(requirement.requirement.as_str(), &target)?
			else {
				continue;
			};
			if parsed.direct_url {
				return Err(ExtensionError::new(
					ExtensionCode::EUrlRequire,
					format!(
						"{} declares a direct URL; extension requirements must resolve through a \
						 configured index",
						requirement.requirement
					),
				));
			}
			if !parsed.marker_applies {
				continue;
			}
			let Some((frozen_name, frozen_version)) = frozen
				.iter()
				.find(|(name, _)| normalize_distribution_name(name) == parsed.name)
			else {
				continue;
			};
			let satisfied = match parsed.specifiers {
				Some(specifiers) => version_satisfies(frozen_version, &specifiers)?,
				None => !parsed.direct_url,
			};
			if !satisfied {
				return Err(ExtensionError::new(
					ExtensionCode::EFrozenConflict,
					format!(
						"{} conflicts with frozen {}=={}",
						requirement.requirement, frozen_name, frozen_version
					),
				));
			}
		}
		Ok(())
	}
}

/// Returns a PEP 503-normalized distribution name.
pub fn normalize_distribution_name(name: &str) -> String {
	let mut normalized = String::with_capacity(name.len());
	let mut separator = false;
	for character in name.chars() {
		if matches!(character, '-' | '_' | '.') {
			if !separator {
				normalized.push('-');
				separator = true;
			}
		} else {
			normalized.extend(character.to_lowercase());
			separator = false;
		}
	}
	normalized
}

/// Evaluates a PEP 440 specifier set against one exact version.
pub fn version_satisfies(version: &str, specifiers: &str) -> Result<bool, ExtensionError> {
	let version = Version::from_str(version).map_err(|error| {
		ExtensionError::new(
			ExtensionCode::EManifestParse,
			format!("invalid PEP 440 version {version:?}: {error}"),
		)
	})?;
	let specifiers = VersionSpecifiers::from_str(specifiers).map_err(|error| {
		ExtensionError::new(
			ExtensionCode::EManifestParse,
			format!("invalid PEP 440 specifier {specifiers:?}: {error}"),
		)
	})?;
	Ok(specifiers.contains(&version))
}

/// Compares two exact PEP 440 versions.
pub fn compare_versions(left: &str, right: &str) -> Result<std::cmp::Ordering, ExtensionError> {
	let left = Version::from_str(left).map_err(|error| {
		ExtensionError::new(
			ExtensionCode::EManifestParse,
			format!("invalid PEP 440 version {left:?}: {error}"),
		)
	})?;
	let right = Version::from_str(right).map_err(|error| {
		ExtensionError::new(
			ExtensionCode::EManifestParse,
			format!("invalid PEP 440 version {right:?}: {error}"),
		)
	})?;
	Ok(left.cmp(&right))
}

struct FrozenRequirement {
	name:           String,
	specifiers:     Option<String>,
	direct_url:     bool,
	marker_applies: bool,
}

#[derive(Clone, Copy)]
struct TargetEnvironment<'a> {
	sys_platform:     &'a str,
	platform_machine: &'a str,
	os_name:          &'a str,
}

impl<'a> TargetEnvironment<'a> {
	fn from_triple(target: &'a str) -> Self {
		let sys_platform = if target.contains("windows") {
			"win32"
		} else if target.contains("darwin") || target.contains("apple") {
			"darwin"
		} else {
			"linux"
		};
		let platform_machine = if target.starts_with("aarch64") {
			if sys_platform == "darwin" {
				"arm64"
			} else {
				"aarch64"
			}
		} else if target.starts_with("x86_64") {
			if sys_platform == "win32" {
				"AMD64"
			} else {
				"x86_64"
			}
		} else if target.starts_with("i686") || target.starts_with("i386") {
			"x86"
		} else {
			target.split('-').next().unwrap_or(target)
		};
		let os_name = if sys_platform == "win32" {
			"nt"
		} else {
			"posix"
		};
		TargetEnvironment { sys_platform, platform_machine, os_name }
	}
}

impl FrozenRequirement {
	fn parse(
		requirement: &str,
		target: &TargetEnvironment<'_>,
	) -> Result<Option<Self>, ExtensionError> {
		let (requirement, marker) = requirement
			.split_once(';')
			.map_or((requirement, None), |(requirement, marker)| (requirement, Some(marker)));
		let requirement = requirement.trim();
		if requirement.is_empty() {
			return Err(ExtensionError::new(
				ExtensionCode::EFrozenConflict,
				"empty PEP 508 requirement",
			));
		}
		if requirement.starts_with("git+")
			|| requirement.starts_with("https://")
			|| requirement.starts_with("http://")
			|| requirement.starts_with('/')
			|| requirement.starts_with("./")
			|| requirement.starts_with("../")
		{
			return Ok(None);
		}
		let name_len = requirement
			.bytes()
			.take_while(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
			.count();
		if name_len == 0 {
			// Top-level git/archive/path sources are parsed by `SourceSpec`
			// before becoming resolver roots. They are not manifest `requires`
			// entries and therefore are outside E-URL-REQUIRE.
			return Ok(None);
		}
		let name = normalize_distribution_name(&requirement[..name_len]);
		let mut remainder = requirement[name_len..].trim_start();
		if let Some(extras) = remainder.strip_prefix('[') {
			let Some(end) = extras.find(']') else {
				return Err(ExtensionError::new(
					ExtensionCode::EFrozenConflict,
					format!("unterminated extras in {requirement:?}"),
				));
			};
			remainder = extras[end + 1..].trim_start();
		}
		let direct_url = remainder.starts_with('@');
		let specifiers = if remainder.is_empty() || direct_url {
			None
		} else {
			VersionSpecifiers::from_str(remainder).map_err(|error| {
				ExtensionError::new(
					ExtensionCode::EFrozenConflict,
					format!("invalid PEP 508 requirement {requirement:?}: {error}"),
				)
			})?;
			Some(remainder.to_owned())
		};
		Ok(Some(Self {
			name,
			specifiers,
			direct_url,
			marker_applies: marker.is_none_or(|marker| marker_applies(marker, target)),
		}))
	}
}

fn marker_applies(marker: &str, target: &TargetEnvironment<'_>) -> bool {
	marker.split(" or ").any(|disjunction| {
		disjunction
			.split(" and ")
			.all(|expression| marker_atom_applies(expression.trim(), target))
	})
}

fn marker_atom_applies(expression: &str, target: &TargetEnvironment<'_>) -> bool {
	for operator in [" not in ", " in ", "==", "!=", ">=", "<=", ">", "<"] {
		let Some((variable, expected)) = expression.split_once(operator) else {
			continue;
		};
		let actual = match variable.trim() {
			"python_version" => "3.14",
			"python_full_version" => "3.14.0",
			"implementation_name" => "cpython",
			"platform_python_implementation" => "CPython",
			"sys_platform" => target.sys_platform,
			"platform_machine" => target.platform_machine,
			"os_name" => target.os_name,
			"extra" => "",
			_ => return true,
		};
		let expected = expected.trim().trim_matches(['\'', '"']);
		return match operator.trim() {
			"==" => actual == expected,
			"!=" => actual != expected,
			"in" => expected.split(',').any(|value| value.trim() == actual),
			"not in" => !expected.split(',').any(|value| value.trim() == actual),
			">=" | "<=" | ">" | "<"
				if matches!(variable.trim(), "python_version" | "python_full_version") =>
			{
				let ordering = compare_versions(actual, expected).unwrap_or(std::cmp::Ordering::Equal);
				match operator.trim() {
					">=" => ordering.is_ge(),
					"<=" => ordering.is_le(),
					">" => ordering.is_gt(),
					"<" => ordering.is_lt(),
					_ => unreachable!(),
				}
			},
			_ => true,
		};
	}
	true
}
/// A declared enabled extension root. It is an alias that makes the
/// host-child resolution boundary explicit at CLI call sites.
pub type EnabledExtension = ResolveRequirement;

/// A per-target resolution plan for one enabled host-child unit.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResolvePlan {
	/// Exactly one `uv` request per materializing target.
	pub requests: Vec<UvRequest>,
}

/// Returns base requirements plus requirements owned by selected features.
///
/// Unknown features fail before a resolver process is constructed.
pub fn selected_requirements(
	base: &[Str],
	features: &std::collections::BTreeMap<Str, FeatureManifest>,
	selected: &[Str],
) -> Result<Vec<Str>, ExtensionError> {
	let mut requirements = base.to_vec();
	for name in selected {
		let feature = features.get(name).ok_or_else(|| {
			ExtensionError::new(ExtensionCode::EFeature, format!("unknown feature {name}"))
		})?;
		requirements.extend(feature.requires.iter().cloned());
	}
	requirements.sort();
	requirements.dedup();
	Ok(requirements)
}

impl ResolvePlan {
	/// Builds per-target invocations without spawning `uv`.
	///
	/// `requirements_file` is the complete resolver input emitted by the
	/// install backend from the manifest or durable lock.
	pub fn build(
		executable: PathBuf,
		enabled: &[EnabledExtension],
		targets: &[Str],
		indexes: Vec<String>,
		exclude_newer: Option<Str>,
		offline: bool,
		requirements_file: PathBuf,
	) -> Result<Self, ExtensionError> {
		if targets.is_empty() {
			return Err(ExtensionError::new(
				ExtensionCode::ETargetMissing,
				"at least one target is required",
			));
		}
		let mut ids = BTreeSet::new();
		for extension in enabled {
			if !ids.insert(&extension.extension_id) {
				return Err(ExtensionError::new(
					ExtensionCode::EDupId,
					format!("duplicate enabled extension {}", extension.extension_id),
				));
			}
		}
		Ok(Self {
			requests: targets
				.iter()
				.enumerate()
				.map(|(ordinal, target)| {
					let stem = requirements_file
						.file_stem()
						.and_then(|stem| stem.to_str())
						.unwrap_or("resolve");
					let output_file =
						requirements_file.with_file_name(format!("pylock.{stem}-{ordinal}.toml"));
					UvRequest {
						executable: executable.clone(),
						target: target.clone(),
						indexes: indexes.clone(),
						exclude_newer: exclude_newer.clone(),
						offline,
						requirements_file: requirements_file.clone(),
						output_file,
						requirements: enabled.to_vec(),
					}
				})
				.collect(),
		})
	}

	/// Returns the exact `uv` argv for every target, for `resolve --explain`.
	pub fn explain(&self) -> Vec<Vec<OsString>> {
		self.requests.iter().map(UvRequest::argv).collect()
	}

	/// Executes each target through a kill-on-drop Tokio child. Cancelling this
	/// future therefore cancels the active resolver process rather than merely
	/// abandoning its output future.
	pub async fn run_system(
		&self,
		frozen: &[(&str, &str)],
	) -> Result<Vec<ResolveOutcome>, ExtensionError> {
		let mut outcomes = Vec::with_capacity(self.requests.len());
		for request in &self.requests {
			outcomes.push(resolve_system_with(request, frozen).await?);
		}
		Ok(outcomes)
	}

	/// Executes every planned target and preserves each exact invocation.
	#[tracing::instrument(
		name = "extension_resolve",
		level = "debug",
		skip_all,
		fields(target_count = self.requests.len(), frozen_count = frozen.len())
	)]
	pub fn run<R: UvRunner>(
		&self,
		runner: &R,
		frozen: &[(&str, &str)],
	) -> Result<Vec<ResolveOutcome>, ExtensionError> {
		let result = self
			.requests
			.iter()
			.map(|request| resolve_with(runner, request, frozen))
			.collect::<Result<Vec<_>, _>>();
		if let Ok(outcomes) = &result {
			tracing::debug!(outcome_count = outcomes.len(), "extension resolution completed");
		}
		result
	}
}

/// Process boundary for `uv`; production uses [`SystemUv`] while tests inject
/// a deterministic resolver without a network or executable.
pub trait UvRunner {
	/// Executes an argv prepared by [`UvRequest::argv`].
	fn run(&self, request: &UvRequest) -> io::Result<Output>;
}

/// The production `uv` process runner.
#[derive(Clone, Copy, Debug, Default)]
pub struct SystemUv;

impl UvRunner for SystemUv {
	fn run(&self, request: &UvRequest) -> io::Result<Output> {
		let mut output = Command::new(&request.executable)
			.args(request.argv())
			.output()?;
		if output.status.success() {
			output.stdout = fs::read(&request.output_file)?;
			let _ = fs::remove_file(&request.output_file);
		}
		Ok(output)
	}
}

/// An explainable result of resolving one host-child unit.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResolveOutcome {
	/// Exact equivalent command line.
	pub argv:   Vec<OsString>,
	/// Captured uv standard output.
	pub stdout: Vec<u8>,
	/// Captured uv standard error.
	pub stderr: Vec<u8>,
}

/// Resolves one host-child unit asynchronously through the production process
/// boundary. The child is killed when this future is dropped.
pub async fn resolve_system_with(
	request: &UvRequest,
	frozen: &[(&str, &str)],
) -> Result<ResolveOutcome, ExtensionError> {
	request.reject_frozen_conflicts(frozen)?;
	let argv = request.argv();
	let mut command = tokio::process::Command::new(&request.executable);
	command.args(&argv).kill_on_drop(true);
	let output = command
		.output()
		.await
		.map_err(|error| ExtensionError::new(ExtensionCode::EUnsat, error.to_string()))?;
	if !output.status.success() {
		return Err(ExtensionError::new(
			ExtensionCode::EUnsat,
			String::from_utf8_lossy(&output.stderr),
		));
	}
	let stdout = tokio::fs::read(&request.output_file)
		.await
		.map_err(|error| ExtensionError::new(ExtensionCode::EUnsat, error.to_string()))?;
	let _ = tokio::fs::remove_file(&request.output_file).await;
	Ok(ResolveOutcome { argv, stdout, stderr: output.stderr })
}

/// Resolves one host-child unit after all pure R1–R12 inputs have been checked.
pub fn resolve_with<R: UvRunner>(
	runner: &R,
	request: &UvRequest,
	frozen: &[(&str, &str)],
) -> Result<ResolveOutcome, ExtensionError> {
	request.reject_frozen_conflicts(frozen)?;
	let argv = request.argv();
	let output = runner
		.run(request)
		.map_err(|error| ExtensionError::new(ExtensionCode::EUnsat, error.to_string()))?;
	if !output.status.success() {
		return Err(ExtensionError::new(
			ExtensionCode::EUnsat,
			String::from_utf8_lossy(&output.stderr),
		));
	}
	Ok(ResolveOutcome { argv, stdout: output.stdout, stderr: output.stderr })
}

/// Returns the minimal enabled-extension subset still unsatisfiable. The first
/// phase bisects to remove independent halves; bounded deletion then makes the
/// result subset-minimal even when the conflict spans a bisection boundary.
pub fn minimal_unsat_core<T: Clone>(
	requirements: &[T],
	max_probes: usize,
	mut unsatisfiable: impl FnMut(&[T]) -> bool,
) -> Vec<T> {
	if requirements.is_empty() || !unsatisfiable(requirements) {
		return Vec::new();
	}
	let mut probes = 1;
	let mut core = requirements.to_vec();
	let mut width = core.len() / 2;
	while width > 0 && probes < max_probes {
		let mut reduced = false;
		let mut start = 0;
		while start < core.len() && probes < max_probes {
			let end = (start + width).min(core.len());
			let mut candidate = core.clone();
			candidate.drain(start..end);
			probes += 1;
			if !candidate.is_empty() && unsatisfiable(&candidate) {
				core = candidate;
				reduced = true;
				break;
			}
			start = end;
		}
		if !reduced {
			width /= 2;
		}
	}
	let mut index = 0;
	while index < core.len() && probes < max_probes {
		let mut candidate = core.clone();
		candidate.remove(index);
		probes += 1;
		if !candidate.is_empty() && unsatisfiable(&candidate) {
			core = candidate;
		} else {
			index += 1;
		}
	}
	core
}

/// Validates an observed wheel ABI against R3.
pub fn validate_abi(tag: &str) -> Result<(), ExtensionError> {
	let abi = tag.split('-').nth(1).unwrap_or_default();
	if ACCEPTED_ABIS.contains(&abi) {
		Ok(())
	} else {
		Err(ExtensionError::new(
			ExtensionCode::EAbiRejected,
			format!("wheel ABI {abi:?}; accepted: cp314t, abi3t, none"),
		))
	}
}

/// R4 requires every materializing target to have a target-specific wheel.
pub fn validate_target(target: &Str, available_targets: &[Str]) -> Result<(), ExtensionError> {
	if available_targets.contains(target) {
		Ok(())
	} else {
		Err(ExtensionError::new(
			ExtensionCode::ETargetMissing,
			format!("no wheel for target {target}"),
		))
	}
}

#[cfg(test)]
mod tests {
	use omp_core::sf;

	use super::*;

	#[test]
	fn uv_argv_enforces_nonnegotiable_flags() {
		let request = UvRequest {
			executable:        PathBuf::from("uv"),
			target:            sf!("aarch64-apple-darwin"),
			indexes:           vec!["https://ext.omp.dev/simple".to_owned()],
			exclude_newer:     Some(sf!("2026-08-20T00:00:00Z")),
			offline:           false,
			requirements_file: PathBuf::from("requirements.txt"),
			output_file:       PathBuf::from("pylock.test.toml"),
			requirements:      vec![],
		};
		let argv = request
			.argv()
			.into_iter()
			.map(|argument| argument.into_string().expect("utf8 argv"))
			.collect::<Vec<_>>();
		assert_eq!(argv, [
			"pip",
			"compile",
			"--format",
			"pylock.toml",
			"--output-file",
			"pylock.test.toml",
			"--only-binary",
			":all:",
			"--python-platform",
			"aarch64-apple-darwin",
			"--python-version",
			"3.14",
			"--index-strategy",
			"first-index",
			"--index-url",
			"https://ext.omp.dev/simple",
			"--exclude-newer",
			"2026-08-20T00:00:00Z",
			"requirements.txt"
		]);
	}
	#[test]
	fn frozen_conflicts_parse_pep_508_names_extras_markers_and_specifiers() {
		let request = |requirement: &'static str| UvRequest {
			executable:        PathBuf::from("uv"),
			target:            sf!("aarch64-apple-darwin"),
			indexes:           Vec::new(),
			exclude_newer:     None,
			offline:           false,
			requirements_file: PathBuf::from("requirements.txt"),
			output_file:       PathBuf::from("pylock.test.toml"),
			requirements:      vec![ResolveRequirement {
				extension_id: sf!("example"),
				requirement:  sf!("{requirement}"),
			}],
		};
		let frozen = [("cloudpickle", "4.0.0")];

		assert!(
			request("Cloud_Pickle[remote]>=4,<5; python_version >= '3.14'")
				.reject_frozen_conflicts(&frozen)
				.is_ok()
		);
		assert_eq!(
			request("cloudpickle~=3.1")
				.reject_frozen_conflicts(&frozen)
				.unwrap_err()
				.code,
			ExtensionCode::EFrozenConflict
		);
		assert!(
			request("cloudpickle<4; python_version < '3.14'")
				.reject_frozen_conflicts(&frozen)
				.is_ok()
		);
		assert_eq!(
			request("cloudpickle @ https://example.invalid/cloudpickle.whl")
				.reject_frozen_conflicts(&frozen)
				.unwrap_err()
				.code,
			ExtensionCode::EUrlRequire
		);
	}

	#[test]
	fn frozen_markers_are_evaluated_for_the_materializing_target() {
		let request = |target: &'static str, requirement: &'static str| UvRequest {
			executable:        PathBuf::from("uv"),
			target:            sf!("{target}"),
			indexes:           Vec::new(),
			exclude_newer:     None,
			offline:           false,
			requirements_file: PathBuf::from("requirements.txt"),
			output_file:       PathBuf::from("pylock.test.toml"),
			requirements:      vec![ResolveRequirement {
				extension_id: sf!("example"),
				requirement:  sf!("{requirement}"),
			}],
		};
		let frozen = [("cloudpickle", "4.0.0")];

		assert!(
			request(
				"aarch64-apple-darwin",
				"cloudpickle<4; sys_platform == 'linux' and platform_machine == 'aarch64'",
			)
			.reject_frozen_conflicts(&frozen)
			.is_ok()
		);
		assert_eq!(
			request(
				"aarch64-unknown-linux-gnu",
				"cloudpickle<4; sys_platform == 'linux' and platform_machine == 'aarch64'",
			)
			.reject_frozen_conflicts(&frozen)
			.unwrap_err()
			.code,
			ExtensionCode::EFrozenConflict
		);
	}
}
