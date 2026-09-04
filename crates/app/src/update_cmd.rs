//! Signed native package-registry inspection and rollback-safe self-update.

use std::{
	cmp,
	env::{self, consts},
	fs::{self, OpenOptions},
	io,
	io::Write as _,
	path::{Path, PathBuf},
	process::{self, Command},
	time::{SystemTime, UNIX_EPOCH},
};

use futures::StreamExt as _;
use miette::{IntoDiagnostic as _, miette};
use omp_core::{Str, encoding::hex};
use omp_ext::{
	index::{IndexArtifact, IndexExtension, IndexRelease, SignedIndex},
	trust::{KeysFile, verify_artifact_signature},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};
use thiserror::Error;

use crate::{
	cli::{RegistryArgs, UpdateArgs},
	ext_cli,
	settings::{CL_UPDATE_CHANNEL, UpdateChannel},
};

const CORE_PACKAGE: &str = "omp-cli";
const MAX_ASSET_BYTES: u64 = 256 * 1024 * 1024;
const MAX_MANIFEST_BYTES: usize = 256 * 1024;
const NPM_STABLE_MANIFEST: &str = "https://registry.npmjs.org/@oh-my-pi/pi-coding-agent/latest";
const NPM_CANARY_MANIFEST: &str = "https://registry.npmjs.org/@oh-my-pi/pi-coding-agent/canary";
const GITHUB_RELEASE_BY_TAG: &str = "https://api.github.com/repos/can1357/oh-my-pi/releases/tags";
const GITHUB_DOWNLOAD_ROOT: &str = "https://github.com/can1357/oh-my-pi/releases/download";
const GITHUB_USER_AGENT: &str = concat!("omp/", env!("CARGO_PKG_VERSION"));
const RELEASE_METADATA_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);
#[derive(
	Clone,
	Copy,
	Debug,
	Eq,
	PartialEq,
	Serialize,
	strum::Display,
	strum::EnumString,
	strum::IntoStaticStr,
)]
#[serde(rename_all = "snake_case")]
#[strum(serialize_all = "lowercase", ascii_case_insensitive)]
enum InstallManager {
	Native,
	Npm,
	#[strum(to_string = "homebrew", serialize = "brew")]
	Homebrew,
	Mise,
	Nix,
}

#[derive(Serialize)]
struct RegistryView<'a> {
	package:  &'a str,
	target:   String,
	manager:  InstallManager,
	releases: Vec<ReleaseView<'a>>,
}

#[derive(Serialize)]
struct ReleaseView<'a> {
	version:  &'a str,
	attested: bool,
	yanked:   bool,
	assets:   Vec<AssetView<'a>>,
}

#[derive(Serialize)]
struct AssetView<'a> {
	target: &'a str,
	file:   &'a str,
	size:   u64,
	sha256: &'a str,
}

struct Selected<'a> {
	issued_at: &'a Str,
	extension: &'a IndexExtension,
	release:   &'a IndexRelease,
	artifact:  &'a IndexArtifact,
}

#[derive(Clone, Debug, Deserialize)]
struct ReleaseManifest {
	version: Str,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct GithubRelease {
	tag_name:   Str,
	draft:      bool,
	prerelease: bool,
	assets:     Vec<GithubAsset>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct GithubAsset {
	name:                 Str,
	browser_download_url: String,
	state:                Str,
	size:                 u64,
	digest:               Option<Str>,
}

#[derive(Debug, Error)]
enum UpdateError {
	#[error("--canary and --stable are mutually exclusive")]
	ConflictingChannels,
	#[error(
		"--plugins is exactly `omp ext upgrade` and cannot be combined with core update options"
	)]
	PluginsWithCoreOptions,
	#[error("release channel controls cannot be combined with a signed package-index override")]
	ChannelWithIndex,
	#[error("npm owns this installation; run `npm update -g @oh-my-pi/pi-coding-agent`")]
	NpmManagedInstallation,
	#[error("Homebrew owns this installation; run `brew upgrade can1357/tap/omp`")]
	HomebrewManagedInstallation,
	#[error("Mise owns this installation; run `mise upgrade github:can1357/oh-my-pi --bump`")]
	MiseManagedInstallation,
	#[error("Nix owns this installation; update the pinned Nix input")]
	NixManagedInstallation,
	#[error("timed out fetching the {channel} release manifest")]
	ManifestTimeout { channel: UpdateChannel },
	#[error("failed to fetch the {channel} release manifest")]
	ManifestRequest {
		channel: UpdateChannel,
		#[source]
		source:  reqwest::Error,
	},
	#[error("no canary release has been published yet; try `omp update --stable`")]
	CanaryUnavailable,
	#[error("the {channel} release manifest returned HTTP {status}")]
	ManifestHttp { channel: UpdateChannel, status: reqwest::StatusCode },
	#[error("the {channel} release manifest exceeded the 256 KiB safety ceiling")]
	ManifestTooLarge { channel: UpdateChannel },
	#[error("the {channel} release manifest is malformed")]
	ManifestDecode {
		channel: UpdateChannel,
		#[source]
		source:  serde_json::Error,
	},
	#[error("the {channel} release manifest contains invalid version `{version}`")]
	InvalidManifestVersion { channel: UpdateChannel, version: Str },
	#[error("the stable release manifest selected prerelease version `{version}`")]
	StableManifestPrerelease { version: Str },
	#[error("timed out fetching GitHub metadata for release `{tag}`")]
	GithubTimeout { tag: Str },
	#[error("failed to fetch GitHub metadata for release `{tag}`")]
	GithubRequest {
		tag:    Str,
		#[source]
		source: reqwest::Error,
	},
	#[error("GitHub rate-limited metadata lookup for release `{tag}`; set GITHUB_TOKEN or GH_TOKEN")]
	GithubRateLimited { tag: Str },
	#[error("GitHub metadata lookup for release `{tag}` returned HTTP {status}")]
	GithubHttp { tag: Str, status: reqwest::StatusCode },
	#[error("GitHub metadata for release `{tag}` is malformed")]
	GithubDecode {
		tag:    Str,
		#[source]
		source: reqwest::Error,
	},
	#[error("GitHub release tag mismatch: expected `{expected}`, received `{actual}`")]
	GithubTagMismatch { expected: Str, actual: Str },
	#[error("GitHub release `{tag}` is still a draft")]
	GithubDraft { tag: Str },
	#[error("GitHub release `{tag}` is a prerelease; only the canary channel installs prereleases")]
	StablePrerelease { tag: Str },
	#[error("GitHub release `{tag}` has {count} assets named `{name}`")]
	GithubAssetCount { tag: Str, name: Str, count: usize },
	#[error("GitHub release asset `{name}` is not fully uploaded (state `{state}`)")]
	GithubAssetState { name: Str, state: Str },
	#[error("GitHub release asset `{name}` has an invalid size")]
	GithubAssetSize { name: Str },
	#[error("GitHub release asset `{name}` has no SHA-256 digest")]
	GithubAssetDigestMissing { name: Str },
	#[error("GitHub release asset `{name}` has a malformed SHA-256 digest")]
	GithubAssetDigestMalformed { name: Str },
	#[error(
		"GitHub release asset `{name}` has an unexpected download URL: expected `{expected}`, \
		 received `{actual}`"
	)]
	GithubAssetUrl { name: Str, expected: String, actual: String },
}

#[must_use]
struct UpdateLock(PathBuf);

impl Drop for UpdateLock {
	fn drop(&mut self) {
		let _ = fs::remove_file(&self.0);
	}
}

/// Runs the verified core updater or explicitly delegates extension upgrades.
#[tracing::instrument(
	level = "debug",
	name = "update",
	skip_all,
	fields(
		check = args.check,
		force = args.force,
		plugins = args.plugins,
		canary = args.canary,
		stable = args.stable
	)
)]
pub async fn run(args: UpdateArgs) -> miette::Result<()> {
	let requested_channel = requested_channel(&args).into_diagnostic()?;
	if args.plugins {
		if args.check
			|| args.force
			|| requested_channel.is_some()
			|| args.index.is_some()
			|| args.index_key.is_some()
		{
			return Err(UpdateError::PluginsWithCoreOptions).into_diagnostic();
		}
		return upgrade_extensions().await;
	}
	if !release_override_requested(&args) {
		return run_channel_update(args, requested_channel).await;
	}
	if requested_channel.is_some() {
		return Err(UpdateError::ChannelWithIndex).into_diagnostic();
	}
	let (index, _) = load_index(args.index.as_deref(), args.index_key.as_deref())?;
	let target = platform_target();
	let selected = select(&index, CORE_PACKAGE, &target)?;
	let manager = classify_installation(&env::current_exe().into_diagnostic()?);
	let current = env!("CARGO_PKG_VERSION");
	let newer = compare_versions(selected.release.version.as_str(), current).is_gt();
	tracing::debug!(
		current_version = current,
		latest_version = %selected.release.version,
		%target,
		?manager,
		update_available = newer,
		"verified signed update metadata"
	);
	if args.check || (!newer && !args.force) {
		println!(
			"current={}\tlatest={}\ttarget={}\tmanager={:?}\tupdate_available={}",
			current, selected.release.version, target, manager, newer
		);
		return Ok(());
	}
	ensure_native_installation(manager).into_diagnostic()?;
	let version = selected.release.version.clone();
	install(selected).await?;
	tracing::info!(version = %version, %target, "update installed");
	println!("updated omp to {version} ({target})");
	Ok(())
}
fn release_override_requested(args: &UpdateArgs) -> bool {
	args.index.is_some()
		|| args.index_key.is_some()
		|| env::var_os("OMP_RELEASE_INDEX").is_some()
		|| env::var_os("OMP_RELEASE_INDEX_KEY").is_some()
}

fn requested_channel(args: &UpdateArgs) -> Result<Option<UpdateChannel>, UpdateError> {
	match (args.canary, args.stable) {
		(true, true) => Err(UpdateError::ConflictingChannels),
		(true, false) => Ok(Some(UpdateChannel::Canary)),
		(false, true) => Ok(Some(UpdateChannel::Stable)),
		(false, false) => Ok(None),
	}
}

fn ensure_native_installation(manager: InstallManager) -> Result<(), UpdateError> {
	match manager {
		InstallManager::Native => Ok(()),
		InstallManager::Npm => Err(UpdateError::NpmManagedInstallation),
		InstallManager::Homebrew => Err(UpdateError::HomebrewManagedInstallation),
		InstallManager::Mise => Err(UpdateError::MiseManagedInstallation),
		InstallManager::Nix => Err(UpdateError::NixManagedInstallation),
	}
}

fn read_persisted_channel() -> miette::Result<UpdateChannel> {
	let path = crate::config_path().into_diagnostic()?;
	read_persisted_channel_at(&path)
}

fn read_persisted_channel_at(path: &Path) -> miette::Result<UpdateChannel> {
	let ctx = crate::config_cmd::load_cfg(path)?;
	Ok(CL_UPDATE_CHANNEL.get(&ctx))
}

fn persist_channel(channel: UpdateChannel) -> miette::Result<()> {
	let path = crate::config_path().into_diagnostic()?;
	persist_channel_at(&path, channel)
}

fn persist_channel_at(path: &Path, channel: UpdateChannel) -> miette::Result<()> {
	crate::config_cmd::update_cfg(path, |ctx| CL_UPDATE_CHANNEL.set(ctx, channel).into_diagnostic())
}

#[tracing::instrument(
	level = "debug",
	name = "channel_update",
	skip_all,
	fields(check = args.check, force = args.force)
)]
async fn run_channel_update(
	args: UpdateArgs,
	requested_channel: Option<UpdateChannel>,
) -> miette::Result<()> {
	let persisted_channel = read_persisted_channel()?;
	let channel = requested_channel.unwrap_or(persisted_channel);
	let switching_channel =
		requested_channel.is_some_and(|requested| requested != persisted_channel);
	let version = fetch_release_manifest(channel, RELEASE_METADATA_TIMEOUT)
		.await
		.into_diagnostic()?;
	let release = fetch_github_release(version.as_str(), RELEASE_METADATA_TIMEOUT)
		.await
		.into_diagnostic()?;
	let target = platform_target();
	let asset_name = github_asset_name();
	let (asset, digest) =
		resolve_github_asset(&release, version.as_str(), &asset_name, channel).into_diagnostic()?;
	let manager = classify_installation(&env::current_exe().into_diagnostic()?);
	let current = env!("CARGO_PKG_VERSION");
	let newer = compare_versions(version.as_str(), current).is_gt();
	tracing::debug!(
		current_version = current,
		latest_version = %version,
		%channel,
		%target,
		?manager,
		update_available = newer,
		switching_channel,
		"verified channel update metadata"
	);
	if switching_channel {
		let direction = if newer { "upgrade" } else { "downgrade" };
		if args.check {
			println!("would switch to {channel} {version} ({direction})");
		} else {
			println!("switching to {channel} {version} ({direction})");
		}
	}
	if !should_install(args.check, args.force, newer, switching_channel) {
		println!(
			"current={}\tlatest={}\tchannel={}\ttarget={}\tmanager={:?}\tupdate_available={}",
			current, version, channel, target, manager, newer
		);
		return Ok(());
	}
	ensure_native_installation(manager).into_diagnostic()?;
	install_github_asset(asset, digest, version.as_str()).await?;
	if requested_channel.is_some() {
		persist_channel(channel)?;
	}
	tracing::info!(%version, %channel, %target, "update installed");
	println!("updated omp to {version} on the {channel} channel ({target})");
	Ok(())
}

const fn should_install(check: bool, force: bool, newer: bool, switching_channel: bool) -> bool {
	!check && (force || newer || switching_channel)
}

const fn manifest_url(channel: UpdateChannel) -> &'static str {
	match channel {
		UpdateChannel::Stable => NPM_STABLE_MANIFEST,
		UpdateChannel::Canary => NPM_CANARY_MANIFEST,
	}
}

async fn fetch_release_manifest(
	channel: UpdateChannel,
	timeout: std::time::Duration,
) -> Result<Str, UpdateError> {
	let fetch = async {
		// The endpoint and headers are closed here: startup checks never
		// inherit credentials, registry mirrors, or redirect targets.
		let response = omp_http::no_redirect_client()
			.get(manifest_url(channel))
			.header("User-Agent", GITHUB_USER_AGENT)
			.send()
			.await
			.map_err(|source| UpdateError::ManifestRequest { channel, source })?;
		if response.status() == reqwest::StatusCode::NOT_FOUND && channel == UpdateChannel::Canary {
			return Err(UpdateError::CanaryUnavailable);
		}
		if !response.status().is_success() {
			return Err(UpdateError::ManifestHttp { channel, status: response.status() });
		}
		if response
			.content_length()
			.is_some_and(|length| length > u64::try_from(MAX_MANIFEST_BYTES).unwrap_or(u64::MAX))
		{
			return Err(UpdateError::ManifestTooLarge { channel });
		}
		let mut body = Vec::with_capacity(
			response
				.content_length()
				.and_then(|length| usize::try_from(length).ok())
				.unwrap_or_default()
				.min(MAX_MANIFEST_BYTES),
		);
		let mut stream = response.bytes_stream();
		while let Some(chunk) = stream.next().await {
			let chunk = chunk.map_err(|source| UpdateError::ManifestRequest { channel, source })?;
			if body.len().saturating_add(chunk.len()) > MAX_MANIFEST_BYTES {
				return Err(UpdateError::ManifestTooLarge { channel });
			}
			body.extend_from_slice(&chunk);
		}
		let manifest = serde_json::from_slice::<ReleaseManifest>(&body)
			.map_err(|source| UpdateError::ManifestDecode { channel, source })?;
		validate_manifest_version(channel, manifest.version)
	};
	tokio::time::timeout(timeout, fetch)
		.await
		.map_err(|_| UpdateError::ManifestTimeout { channel })?
}

/// Revalidates a cached startup-check version before it enters presentation.
pub(crate) fn validate_startup_release(channel: UpdateChannel, version: Str) -> Option<Str> {
	validate_manifest_version(channel, version).ok()
}

/// Fetches one validated official channel manifest for the silent startup
/// checker. Failures are intentionally reduced to absence at this boundary:
/// request diagnostics can contain proxy details and never belong in the
/// interactive transcript.
pub(crate) async fn fetch_startup_release_manifest(
	channel: UpdateChannel,
	timeout: std::time::Duration,
) -> Option<Str> {
	match fetch_release_manifest(channel, timeout).await {
		Ok(version) => Some(version),
		Err(_) => {
			tracing::debug!(%channel, "official startup release check unavailable");
			None
		},
	}
}

fn validate_manifest_version(
	channel: UpdateChannel,
	manifest_version: Str,
) -> Result<Str, UpdateError> {
	let version = manifest_version.trim();
	let Some(parsed) = parse_release_version(&version) else {
		return Err(UpdateError::InvalidManifestVersion { channel, version: manifest_version });
	};
	if !version
		.bytes()
		.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'+'))
	{
		return Err(UpdateError::InvalidManifestVersion { channel, version: manifest_version });
	}
	if channel == UpdateChannel::Stable && parsed.prerelease.is_some() {
		return Err(UpdateError::StableManifestPrerelease { version: manifest_version });
	}
	Ok(Str::new(version))
}

async fn fetch_github_release(
	version: &str,
	timeout: std::time::Duration,
) -> Result<GithubRelease, UpdateError> {
	let tag = Str::from(format!("v{version}"));
	let url = format!("{GITHUB_RELEASE_BY_TAG}/{tag}");
	let mut request = omp_http::default_client()
		.get(url)
		.header("User-Agent", GITHUB_USER_AGENT)
		.header("Accept", "application/vnd.github+json")
		.header("X-GitHub-Api-Version", "2022-11-28");
	let github_token = env::var("GITHUB_TOKEN")
		.ok()
		.filter(|token| !token.is_empty())
		.or_else(|| env::var("GH_TOKEN").ok().filter(|token| !token.is_empty()));
	if let Some(token) = &github_token {
		request = request.bearer_auth(token);
	}
	let response = tokio::time::timeout(timeout, request.send())
		.await
		.map_err(|_| UpdateError::GithubTimeout { tag: tag.clone() })?
		.map_err(|source| UpdateError::GithubRequest { tag: tag.clone(), source })?;
	if response.status() == reqwest::StatusCode::TOO_MANY_REQUESTS
		|| (response.status() == reqwest::StatusCode::FORBIDDEN && github_token.is_none())
	{
		return Err(UpdateError::GithubRateLimited { tag });
	}
	if !response.status().is_success() {
		return Err(UpdateError::GithubHttp { tag, status: response.status() });
	}
	response
		.json::<GithubRelease>()
		.await
		.map_err(|source| UpdateError::GithubDecode { tag, source })
}

fn resolve_github_asset<'a>(
	release: &'a GithubRelease,
	version: &str,
	asset_name: &str,
	channel: UpdateChannel,
) -> Result<(&'a GithubAsset, &'a str), UpdateError> {
	let expected_tag = Str::from(format!("v{version}"));
	if release.tag_name != expected_tag {
		return Err(UpdateError::GithubTagMismatch {
			expected: expected_tag,
			actual:   release.tag_name.clone(),
		});
	}
	if release.draft {
		return Err(UpdateError::GithubDraft { tag: expected_tag });
	}
	if release.prerelease && channel != UpdateChannel::Canary {
		return Err(UpdateError::StablePrerelease { tag: expected_tag });
	}
	let count = release
		.assets
		.iter()
		.filter(|asset| asset.name.as_str() == asset_name)
		.count();
	if count != 1 {
		return Err(UpdateError::GithubAssetCount {
			tag: expected_tag,
			name: Str::new(asset_name),
			count,
		});
	}
	let asset = release
		.assets
		.iter()
		.find(|asset| asset.name.as_str() == asset_name)
		.expect("the exact asset count is one");
	if asset.state != "uploaded" {
		return Err(UpdateError::GithubAssetState {
			name:  asset.name.clone(),
			state: asset.state.clone(),
		});
	}
	if asset.size == 0 || asset.size > MAX_ASSET_BYTES {
		return Err(UpdateError::GithubAssetSize { name: asset.name.clone() });
	}
	let Some(digest) = asset.digest.as_deref() else {
		return Err(UpdateError::GithubAssetDigestMissing { name: asset.name.clone() });
	};
	let Some(digest) = digest.strip_prefix("sha256:") else {
		return Err(UpdateError::GithubAssetDigestMalformed { name: asset.name.clone() });
	};
	if digest.len() != 64 || !digest.bytes().all(|byte| byte.is_ascii_hexdigit()) {
		return Err(UpdateError::GithubAssetDigestMalformed { name: asset.name.clone() });
	}
	let expected_url = format!("{GITHUB_DOWNLOAD_ROOT}/{expected_tag}/{asset_name}");
	if asset.browser_download_url != expected_url {
		return Err(UpdateError::GithubAssetUrl {
			name:     asset.name.clone(),
			expected: expected_url,
			actual:   asset.browser_download_url.clone(),
		});
	}
	Ok((asset, digest))
}

#[tracing::instrument(
	level = "debug",
	name = "update_install",
	skip_all,
	fields(source = "github", %version)
)]
async fn install_github_asset(
	asset: &GithubAsset,
	expected_sha256: &str,
	version: &str,
) -> miette::Result<()> {
	if asset.size > MAX_ASSET_BYTES {
		return Err(miette!("GitHub update asset exceeds the 256 MiB safety ceiling"));
	}
	let cache = update_cache_dir()?;
	fs::create_dir_all(&cache).into_diagnostic()?;
	let lock_path = cache.join("update.lock");
	OpenOptions::new()
		.write(true)
		.create_new(true)
		.open(&lock_path)
		.map_err(|error| miette!("another updater owns {}: {error}", lock_path.display()))?;
	let _lock = UpdateLock(lock_path);
	let bytes = fetch_github_asset(asset).await?;
	if u64::try_from(bytes.len()).unwrap_or(u64::MAX) != asset.size {
		return Err(miette!("GitHub update asset size differs from release metadata"));
	}
	let actual = hex::encode(&Sha256::digest(&bytes)).to_string();
	if !actual.eq_ignore_ascii_case(expected_sha256) {
		return Err(miette!("GitHub update asset SHA-256 differs from release metadata"));
	}
	let current = env::current_exe().into_diagnostic()?;
	let destination = renamed_destination(&current);
	let install_dir = destination.parent().unwrap_or_else(|| Path::new("."));
	prune_stale(install_dir)?;
	let timestamp = SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.into_diagnostic()?
		.as_millis();
	let attempt = format!("{timestamp}.{}", process::id());
	let (staged, backup) = update_artifact_paths(&destination, &attempt)?;
	write_executable(&staged, &bytes)?;
	atomic_replace(&staged, &destination, &backup, version)?;
	retire_renamed_source(&current, &destination, &attempt)
}

async fn fetch_github_asset(asset: &GithubAsset) -> miette::Result<Vec<u8>> {
	if !asset.browser_download_url.starts_with("https://") {
		return Err(miette!("GitHub update asset URL must use HTTPS"));
	}
	let response = omp_http::default_client()
		.get(&asset.browser_download_url)
		.header("User-Agent", GITHUB_USER_AGENT)
		.send()
		.await
		.into_diagnostic()?;
	if !response.status().is_success() {
		return Err(miette!("update download returned HTTP {}", response.status()));
	}
	let mut bytes = Vec::with_capacity(usize::try_from(asset.size).unwrap_or_default());
	let mut stream = response.bytes_stream();
	while let Some(chunk) = stream.next().await {
		let chunk = chunk.into_diagnostic()?;
		if bytes.len().saturating_add(chunk.len())
			> usize::try_from(MAX_ASSET_BYTES).unwrap_or(usize::MAX)
		{
			return Err(miette!("update download exceeded the 256 MiB safety ceiling"));
		}
		bytes.extend_from_slice(&chunk);
	}
	Ok(bytes)
}

pub(crate) fn update_cache_dir() -> miette::Result<PathBuf> {
	if let Some(cache) = env::var_os("OMP_CACHE_DIR").filter(|value| !value.is_empty()) {
		return Ok(PathBuf::from(cache).join("updates"));
	}
	let home = env::var_os("HOME")
		.filter(|value| !value.is_empty())
		.map(PathBuf::from)
		.ok_or_else(|| miette!("HOME or OMP_CACHE_DIR must be set for native update staging"))?;
	Ok(omp_core::dirs::native_directories(&home)
		.cache
		.join("updates"))
}

/// Inspects the verified package registry without mutating locks or TOFU pins.
#[tracing::instrument(
	level = "debug",
	name = "update_registry_inspect",
	skip_all,
	fields(package = %args.package, json = args.json)
)]
pub fn registry(args: RegistryArgs) -> miette::Result<()> {
	let (index, _) = load_index(args.index.as_deref(), args.index_key.as_deref())?;
	let target = platform_target();
	let package = index
		.extensions
		.iter()
		.find(|package| package.id == args.package)
		.ok_or_else(|| miette!("signed registry has no package `{}`", args.package))?;
	let manager = classify_installation(&env::current_exe().into_diagnostic()?);
	let view = RegistryView {
		package: package.id.as_str(),
		target,
		manager,
		releases: package
			.releases
			.iter()
			.map(|release| ReleaseView {
				version:  release.version.as_str(),
				attested: release.attested,
				yanked:   release.yanked,
				assets:   release
					.artifacts
					.iter()
					.map(|asset| AssetView {
						target: asset.target.as_str(),
						file:   asset.file.as_str(),
						size:   asset.size,
						sha256: asset.sha256.as_str(),
					})
					.collect(),
			})
			.collect(),
	};
	if args.json {
		println!("{}", serde_json::to_string_pretty(&view).into_diagnostic()?);
	} else {
		println!("package\t{}", view.package);
		println!("target\t{}", view.target);
		println!("manager\t{:?}", view.manager);
		for release in &view.releases {
			for asset in &release.assets {
				println!(
					"{}\t{}\t{}\t{}\tattested={}\tyanked={}",
					release.version,
					asset.target,
					asset.file,
					asset.sha256,
					release.attested,
					release.yanked
				);
			}
		}
	}
	Ok(())
}

fn load_index(index: Option<&Path>, key: Option<&Path>) -> miette::Result<(SignedIndex, String)> {
	let index = configured_path(index, "OMP_RELEASE_INDEX", "signed release index")?;
	let key = configured_path(key, "OMP_RELEASE_INDEX_KEY", "release index key")?;
	let key = fs::read_to_string(key).into_diagnostic()?;
	let key = key.trim().to_owned();
	let index = SignedIndex::read(&index, &key).into_diagnostic()?;
	Ok((index, key))
}

fn configured_path(
	explicit: Option<&Path>,
	variable: &str,
	label: &str,
) -> miette::Result<PathBuf> {
	explicit
		.map(Path::to_path_buf)
		.or_else(|| {
			env::var_os(variable)
				.filter(|value| !value.is_empty())
				.map(PathBuf::from)
		})
		.ok_or_else(|| miette!("{label} is required; pass its option or set {variable}"))
}

fn select<'a>(index: &'a SignedIndex, package: &str, target: &str) -> miette::Result<Selected<'a>> {
	let extension = index
		.extensions
		.iter()
		.find(|extension| extension.id.as_str() == package)
		.ok_or_else(|| miette!("signed registry has no package `{package}`"))?;
	let (release, artifact) = extension
		.releases
		.iter()
		.filter(|release| release.attested && !release.yanked)
		.filter_map(|release| target_artifact(release, target).map(|artifact| (release, artifact)))
		.max_by(|(left, _), (right, _)| {
			compare_versions(left.version.as_str(), right.version.as_str())
		})
		.ok_or_else(|| miette!("signed registry has no attested `{target}` asset for `{package}`"))?;
	verify_artifact_signature(
		extension.publisher_key.as_str(),
		artifact.blake3.as_str(),
		artifact.sha256.as_str(),
		release.capability_digest.as_str(),
		artifact.signature.as_str(),
	)
	.into_diagnostic()?;
	Ok(Selected { issued_at: &index.issued_at, extension, release, artifact })
}
fn target_artifact<'a>(release: &'a IndexRelease, target: &str) -> Option<&'a IndexArtifact> {
	release
		.artifacts
		.iter()
		.find(|artifact| artifact.target.as_str() == target)
}

#[tracing::instrument(
	level = "debug",
	name = "update_install",
	skip_all,
	fields(source = "signed_index", version = %selected.release.version)
)]
async fn install(selected: Selected<'_>) -> miette::Result<()> {
	if selected.artifact.size > MAX_ASSET_BYTES {
		return Err(miette!("signed update asset exceeds the 256 MiB safety ceiling"));
	}
	let data_dir = omp_core::dirs::data_dir(None).into_diagnostic()?;
	let cache =
		if let Some(cache) = env::var_os("OMP_CACHE_DIR").filter(|value| !value.is_empty()) {
			PathBuf::from(cache)
		} else {
			let home = env::var_os("HOME")
				.filter(|value| !value.is_empty())
				.map(PathBuf::from)
				.ok_or_else(|| {
					miette!("HOME or OMP_CACHE_DIR must be set for native update staging")
				})?;
			omp_core::dirs::native_directories(&home).cache
		}
		.join("updates");
	fs::create_dir_all(&cache).into_diagnostic()?;
	let lock_path = cache.join("update.lock");
	OpenOptions::new()
		.write(true)
		.create_new(true)
		.open(&lock_path)
		.map_err(|error| miette!("another updater owns {}: {error}", lock_path.display()))?;
	let _lock = UpdateLock(lock_path);

	let bytes = fetch_asset(selected.artifact).await?;
	verify_bytes(&bytes, selected.artifact)?;
	let executable = extract_executable(&bytes, selected.artifact.file.as_str())?;
	let current = env::current_exe().into_diagnostic()?;
	let destination = renamed_destination(&current);
	let install_dir = destination.parent().unwrap_or_else(|| Path::new("."));
	prune_stale(install_dir)?;
	let timestamp = SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.into_diagnostic()?
		.as_millis();
	let attempt = format!("{timestamp}.{}", process::id());
	let (staged, backup) = update_artifact_paths(&destination, &attempt)?;
	write_executable(&staged, &executable)?;
	let mut keys =
		KeysFile::read(&data_dir.join("ext/keys.toml")).map_err(|error| miette!("{error}"))?;
	keys
		.verify_or_pin(
			&selected.extension.id,
			&selected.extension.publisher_key,
			&selected.release.version,
			selected.issued_at,
			None,
		)
		.map_err(|error| miette!("{error}"))?;
	keys
		.write(&data_dir.join("ext/keys.toml"))
		.into_diagnostic()?;
	atomic_replace(&staged, &destination, &backup, selected.release.version.as_str())?;
	retire_renamed_source(&current, &destination, &attempt)?;
	Ok(())
}

async fn fetch_asset(asset: &IndexArtifact) -> miette::Result<Vec<u8>> {
	if let Some(path) = asset.url.strip_prefix("file://") {
		return fs::read(path).into_diagnostic();
	}
	if !asset.url.starts_with("https://") {
		return Err(miette!("signed update asset URL must use HTTPS"));
	}
	let response = omp_http::default_client()
		.get(&asset.url)
		.send()
		.await
		.into_diagnostic()?;
	if !response.status().is_success() {
		return Err(miette!("update download returned HTTP {}", response.status()));
	}
	let mut bytes = Vec::with_capacity(usize::try_from(asset.size).unwrap_or_default());
	let mut stream = response.bytes_stream();
	while let Some(chunk) = stream.next().await {
		let chunk = chunk.into_diagnostic()?;
		if bytes.len().saturating_add(chunk.len())
			> usize::try_from(MAX_ASSET_BYTES).unwrap_or(usize::MAX)
		{
			return Err(miette!("update download exceeded the 256 MiB safety ceiling"));
		}
		bytes.extend_from_slice(&chunk);
	}
	Ok(bytes)
}

fn verify_bytes(bytes: &[u8], asset: &IndexArtifact) -> miette::Result<()> {
	if u64::try_from(bytes.len()).unwrap_or(u64::MAX) != asset.size {
		return Err(miette!("update asset size differs from signed registry metadata"));
	}
	let sha256 = format!("sha256:{}", hex::encode(&Sha256::digest(bytes)));
	if sha256 != asset.sha256.as_str() {
		return Err(miette!("update asset SHA-256 differs from signed registry metadata"));
	}
	let blake3 = format!("b3:{}", blake3::hash(bytes).to_hex());
	if blake3 != asset.blake3.as_str() {
		return Err(miette!("update asset BLAKE3 differs from signed registry metadata"));
	}
	Ok(())
}

fn extract_executable(bytes: &[u8], filename: &str) -> miette::Result<Vec<u8>> {
	if matches!(filename, "omp" | "omp.exe") {
		return Ok(bytes.to_vec());
	}
	let files =
		omp_ar::unpack(bytes).map_err(|error| miette!("update archive is invalid: {error}"))?;
	let executable_name = if cfg!(windows) { "omp.exe" } else { "omp" };
	let mut matches = files.into_iter().filter(|(path, _)| {
		Path::new(path.as_str())
			.file_name()
			.is_some_and(|name| name == executable_name)
	});
	let (_, executable) = matches
		.next()
		.ok_or_else(|| miette!("update archive contains no `{executable_name}` executable"))?;
	if matches.next().is_some() {
		return Err(miette!("update archive contains multiple `{executable_name}` executables"));
	}
	Ok(executable)
}

fn write_executable(path: &Path, bytes: &[u8]) -> miette::Result<()> {
	let mut file = OpenOptions::new()
		.write(true)
		.create_new(true)
		.open(path)
		.into_diagnostic()?;
	file.write_all(bytes).into_diagnostic()?;
	file.sync_all().into_diagnostic()?;
	#[cfg(unix)]
	{
		use std::os::unix::fs::PermissionsExt as _;
		fs::set_permissions(path, fs::Permissions::from_mode(0o755)).into_diagnostic()?;
	}
	Ok(())
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum RenameFailureKind {
	Denied,
	Other,
}

fn classify_rename_failure(error: &io::Error) -> RenameFailureKind {
	if error.kind() == io::ErrorKind::PermissionDenied
		|| matches!(error.raw_os_error(), Some(5 | 32 | 33))
	{
		RenameFailureKind::Denied
	} else {
		RenameFailureKind::Other
	}
}

fn update_artifact_paths(destination: &Path, attempt: &str) -> miette::Result<(PathBuf, PathBuf)> {
	let file = destination
		.file_name()
		.ok_or_else(|| miette!("update destination has no filename"))?
		.to_string_lossy();
	let parent = destination.parent().unwrap_or_else(|| Path::new("."));
	Ok((parent.join(format!("{file}.{attempt}.new")), parent.join(format!("{file}.{attempt}.bak"))))
}

fn atomic_replace(
	staged: &Path,
	destination: &Path,
	backup: &Path,
	expected_version: &str,
) -> miette::Result<()> {
	let had_destination = destination.exists();
	if had_destination {
		if let Err(error) = fs::rename(destination, backup) {
			return match classify_rename_failure(&error) {
				RenameFailureKind::Denied => Err(miette!(
					"running omp executable could not be renamed; the existing installation was left \
					 untouched"
				)),
				RenameFailureKind::Other => Err(error).into_diagnostic(),
			};
		}
	}
	if let Err(error) = fs::rename(staged, destination) {
		if had_destination {
			let _ = fs::rename(backup, destination);
		}
		return Err(error).into_diagnostic();
	}
	let verified = Command::new(destination)
		.arg("--version")
		.output()
		.ok()
		.filter(|output| output.status.success())
		.is_some_and(|output| String::from_utf8_lossy(&output.stdout).contains(expected_version));
	if !verified {
		let failed = destination.with_extension("failed-update");
		let _ = fs::rename(destination, &failed);
		if had_destination {
			fs::rename(backup, destination).into_diagnostic()?;
		}
		let _ = fs::remove_file(failed);
		return Err(miette!("installed omp failed version verification; previous binary restored"));
	}
	if had_destination {
		// Windows keeps the renamed process image mapped until this updater
		// exits. A failed unlink does not invalidate a verified replacement;
		// the next locked update reclaims the numeric `.bak` sidecar.
		let _ = fs::remove_file(backup);
	}
	Ok(())
}

fn retire_renamed_source(current: &Path, destination: &Path, attempt: &str) -> miette::Result<()> {
	if current == destination || !current.exists() {
		return Ok(());
	}
	let (_, backup) = update_artifact_paths(current, attempt)?;
	fs::rename(current, &backup).into_diagnostic()?;
	let _ = fs::remove_file(backup);
	Ok(())
}

fn renamed_destination(current: &Path) -> PathBuf {
	renamed_destination_for(current, cfg!(windows))
}

fn renamed_destination_for(current: &Path, windows: bool) -> PathBuf {
	if current
		.file_stem()
		.and_then(|name| name.to_str())
		.is_some_and(|name| matches!(name, "pi" | "oh-my-pi"))
	{
		return current.with_file_name(if windows { "omp.exe" } else { "omp" });
	}
	current.to_path_buf()
}
fn is_update_artifact_name(name: &str) -> bool {
	const BASES: [&str; 6] = ["omp.exe", "oh-my-pi.exe", "pi.exe", "omp", "oh-my-pi", "pi"];
	for base in BASES {
		let Some(rest) = name.strip_prefix(base) else {
			continue;
		};
		let middle = if let Some(middle) = rest.strip_suffix(".bak") {
			middle
		} else if let Some(middle) = rest.strip_suffix(".new") {
			middle
		} else {
			continue;
		};
		if middle.is_empty()
			|| middle.strip_prefix('.').is_some_and(|numeric| {
				!numeric.is_empty()
					&& numeric
						.split('.')
						.all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
			}) {
			return true;
		}
	}
	false
}

fn prune_stale(directory: &Path) -> miette::Result<()> {
	for entry in fs::read_dir(directory).into_diagnostic()? {
		let entry = entry.into_diagnostic()?;
		let name = entry.file_name();
		if is_update_artifact_name(&name.to_string_lossy()) {
			// A mapped Windows backup may still belong to a running older
			// updater. Deletion remains best-effort.
			let _ = fs::remove_file(entry.path());
		}
	}
	Ok(())
}

fn classify_installation(executable: &Path) -> InstallManager {
	if let Some(value) = env::var_os("OMP_INSTALL_MANAGER") {
		return value
			.to_string_lossy()
			.parse()
			.unwrap_or(InstallManager::Native);
	}
	let path = executable.to_string_lossy().to_ascii_lowercase();
	if path.contains("/nix/store/") {
		InstallManager::Nix
	} else if path.contains("/.local/share/mise/") || path.contains("/.mise/") {
		InstallManager::Mise
	} else if path.contains("/cellar/") || path.contains("/homebrew/") || path.contains("linuxbrew")
	{
		InstallManager::Homebrew
	} else if path.contains("node_modules") || path.contains("/npm/") {
		InstallManager::Npm
	} else {
		InstallManager::Native
	}
}

fn github_asset_name() -> String {
	let arch = match consts::ARCH {
		"x86_64" => "x64",
		"aarch64" => "arm64",
		other => other,
	};
	match consts::OS {
		"macos" => format!("omp-darwin-{arch}"),
		"windows" => format!("omp-windows-{arch}.exe"),
		"linux" if cfg!(target_env = "musl") => format!("omp-linux-musl-{arch}"),
		"linux" => format!("omp-linux-{arch}"),
		other => format!("omp-{other}-{arch}"),
	}
}

fn platform_target() -> String {
	let arch = match consts::ARCH {
		"x86_64" => "x86_64",
		"aarch64" => "aarch64",
		other => other,
	};
	match consts::OS {
		"macos" => format!("{arch}-apple-darwin"),
		"windows" => format!("{arch}-pc-windows-msvc"),
		"linux" if cfg!(target_env = "musl") => format!("{arch}-unknown-linux-musl"),
		"linux" => format!("{arch}-unknown-linux-gnu"),
		other => format!("{arch}-unknown-{other}"),
	}
}

struct ParsedVersion<'a> {
	core:       [u64; 3],
	prerelease: Option<&'a str>,
}

fn parse_release_version(version: &str) -> Option<ParsedVersion<'_>> {
	let version = version.trim_start_matches('v');
	let (version, build) = version
		.split_once('+')
		.map_or((version, None), |(version, build)| (version, Some(build)));
	let (core, prerelease) = version
		.split_once('-')
		.map_or((version, None), |(core, prerelease)| (core, Some(prerelease)));
	if [build, prerelease].into_iter().flatten().any(|suffix| {
		suffix.is_empty()
			|| suffix.split('.').any(|part| {
				part.is_empty()
					|| !part
						.bytes()
						.all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
			})
	}) {
		return None;
	}
	let mut parts = core.split('.');
	let parsed =
		[parts.next()?.parse().ok()?, parts.next()?.parse().ok()?, parts.next()?.parse().ok()?];
	if parts.next().is_some() {
		return None;
	}
	Some(ParsedVersion { core: parsed, prerelease })
}

fn compare_prereleases(left: &str, right: &str) -> cmp::Ordering {
	let mut left = left.split('.');
	let mut right = right.split('.');
	loop {
		match (left.next(), right.next()) {
			(None, None) => return cmp::Ordering::Equal,
			(Some(_), None) => return cmp::Ordering::Greater,
			(None, Some(_)) => return cmp::Ordering::Less,
			(Some(left), Some(right)) => {
				let ordering = match (left.parse::<u64>(), right.parse::<u64>()) {
					(Ok(left), Ok(right)) => left.cmp(&right),
					(Ok(_), Err(_)) => cmp::Ordering::Less,
					(Err(_), Ok(_)) => cmp::Ordering::Greater,
					(Err(_), Err(_)) => left.cmp(right),
				};
				if !ordering.is_eq() {
					return ordering;
				}
			},
		}
	}
}

pub(crate) fn compare_versions(left: &str, right: &str) -> cmp::Ordering {
	match (parse_release_version(left), parse_release_version(right)) {
		(Some(left), Some(right)) => {
			left
				.core
				.cmp(&right.core)
				.then_with(|| match (left.prerelease, right.prerelease) {
					(None, None) => cmp::Ordering::Equal,
					(None, Some(_)) => cmp::Ordering::Greater,
					(Some(_), None) => cmp::Ordering::Less,
					(Some(left), Some(right)) => compare_prereleases(left, right),
				})
		},
		_ => left
			.trim_start_matches('v')
			.cmp(right.trim_start_matches('v')),
	}
}

async fn upgrade_extensions() -> miette::Result<()> {
	use crate::ext_cli::{ExtArgs, ExtCommand, ExtUpgradeArgs, Scope};
	ext_cli::run(ExtArgs {
		project:       PathBuf::from("."),
		data_dir:      None,
		store:         None,
		cache:         None,
		index:         Vec::new(),
		index_keys:    None,
		offline:       false,
		locked:        false,
		exclude_newer: None,
		disable:       Vec::new(),
		grant:         None,
		allow_build:   false,
		sign_key:      None,
		uv:            None,
		targets:       Vec::new(),
		trace:         false,
		env_socket:    None,
		layer:         None,
		scope:         Scope::User,
		json:          false,
		verbose:       false,
		command:       ExtCommand::Upgrade(ExtUpgradeArgs {
			ids: Vec::new(),
			to: None,
			dry_run: false,
			allow_capability_widening: false,
			rollback: None,
		}),
	})
	.await
}
#[cfg(test)]
mod tests {
	use super::*;

	fn artifact(target: &'static str, file: &'static str) -> IndexArtifact {
		IndexArtifact {
			target:    Str::new_static(target),
			url:       format!("https://releases.example/{file}"),
			file:      Str::new_static(file),
			tag:       Str::new_static("native"),
			size:      1,
			blake3:    Str::new_static("b3:00"),
			sha256:    Str::new_static("sha256:00"),
			signature: Str::new_static("signature"),
		}
	}

	fn update_args() -> UpdateArgs {
		UpdateArgs {
			check:     false,
			force:     false,
			plugins:   false,
			canary:    false,
			stable:    false,
			index:     None,
			index_key: None,
		}
	}

	fn github_release(version: &'static str, prerelease: bool) -> GithubRelease {
		let tag = Str::from(format!("v{version}"));
		let name = Str::new_static("omp-darwin-arm64");
		GithubRelease {
			tag_name: tag.clone(),
			draft: false,
			prerelease,
			assets: vec![GithubAsset {
				name:                 name.clone(),
				browser_download_url: format!("{GITHUB_DOWNLOAD_ROOT}/{tag}/{name}"),
				state:                Str::new_static("uploaded"),
				size:                 1,
				digest:               Some(Str::new_static(
					"sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
				)),
			}],
		}
	}

	#[test]
	fn channel_controls_select_exact_manifests_and_conflict() {
		assert_eq!(manifest_url(UpdateChannel::Stable), NPM_STABLE_MANIFEST);
		assert_eq!(manifest_url(UpdateChannel::Canary), NPM_CANARY_MANIFEST);

		let mut args = update_args();
		args.canary = true;
		assert_eq!(requested_channel(&args).unwrap(), Some(UpdateChannel::Canary));
		args.stable = true;
		assert!(matches!(requested_channel(&args), Err(UpdateError::ConflictingChannels)));
	}

	#[test]
	fn stable_manifest_rejects_prereleases_while_canary_accepts_them() {
		let version = Str::new_static("18.1.0-canary.1");
		assert!(matches!(
			validate_manifest_version(UpdateChannel::Stable, version.clone()),
			Err(UpdateError::StableManifestPrerelease { .. })
		));
		assert_eq!(
			validate_manifest_version(UpdateChannel::Canary, version).unwrap(),
			"18.1.0-canary.1"
		);
	}

	#[test]
	fn explicit_channel_switch_installs_downgrades_but_check_never_mutates() {
		assert!(should_install(false, false, false, true));
		assert!(should_install(false, true, false, false));
		assert!(should_install(false, false, true, false));
		assert!(!should_install(false, false, false, false));
		assert!(!should_install(true, true, true, true));
	}

	#[test]
	fn explicit_channel_persists_through_the_archived_convar() {
		let root = tempfile::tempdir().unwrap();
		let path = root.path().join("config.cfg");
		assert_eq!(read_persisted_channel_at(&path).unwrap(), UpdateChannel::Stable);
		persist_channel_at(&path, UpdateChannel::Canary).unwrap();
		assert_eq!(read_persisted_channel_at(&path).unwrap(), UpdateChannel::Canary);
		assert!(
			fs::read_to_string(path)
				.unwrap()
				.contains("cl_update_channel canary")
		);
	}

	#[test]
	fn exact_release_asset_resolution_enforces_channel_and_integrity_metadata() {
		let stable = github_release("18.0.0", false);
		let (asset, digest) =
			resolve_github_asset(&stable, "18.0.0", "omp-darwin-arm64", UpdateChannel::Stable)
				.unwrap();
		assert_eq!(asset.name, "omp-darwin-arm64");
		assert_eq!(digest, "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");

		let canary = github_release("18.1.0-canary.1", true);
		assert!(
			resolve_github_asset(
				&canary,
				"18.1.0-canary.1",
				"omp-darwin-arm64",
				UpdateChannel::Canary,
			)
			.is_ok()
		);
		assert!(matches!(
			resolve_github_asset(
				&canary,
				"18.1.0-canary.1",
				"omp-darwin-arm64",
				UpdateChannel::Stable,
			),
			Err(UpdateError::StablePrerelease { .. })
		));
	}

	#[test]
	fn exact_release_asset_resolution_rejects_untrusted_metadata() {
		let mut release = github_release("18.0.0", false);
		release.assets[0].browser_download_url =
			"https://attacker.invalid/omp-darwin-arm64".to_owned();
		assert!(matches!(
			resolve_github_asset(&release, "18.0.0", "omp-darwin-arm64", UpdateChannel::Stable,),
			Err(UpdateError::GithubAssetUrl { .. })
		));

		let mut release = github_release("18.0.0", false);
		release.assets[0].digest = None;
		assert!(matches!(
			resolve_github_asset(&release, "18.0.0", "omp-darwin-arm64", UpdateChannel::Stable,),
			Err(UpdateError::GithubAssetDigestMissing { .. })
		));

		let mut release = github_release("18.0.0", false);
		let duplicate = release.assets[0].clone();
		release.assets.push(duplicate);
		assert!(matches!(
			resolve_github_asset(&release, "18.0.0", "omp-darwin-arm64", UpdateChannel::Stable,),
			Err(UpdateError::GithubAssetCount { count: 2, .. })
		));
	}

	#[test]
	fn stable_versions_sort_after_matching_canary_prereleases() {
		assert!(compare_versions("18.0.0", "18.0.0-canary.1").is_gt());
		assert!(compare_versions("18.0.0-canary.2", "18.0.0-canary.1").is_gt());
		assert!(compare_versions("18.0.0-canary.10", "18.0.0-canary.2").is_gt());
	}

	#[test]
	fn windows_release_selects_its_attested_target_asset() {
		let windows = "x86_64-pc-windows-msvc";
		let release = IndexRelease {
			version:                    Str::new_static("18.0.0"),
			manifest_digest:            Str::new_static("b3:manifest"),
			manifest_capability_digest: Str::new_static("b3:capabilities"),
			capability_digest:          Str::new_static("b3:capabilities"),
			requires:                   Vec::new(),
			capabilities:               Vec::new(),
			features:                   std::collections::BTreeMap::new(),
			declarations:               Vec::new(),
			attested:                   true,
			yanked:                     false,
			shadows:                    Vec::new(),
			artifacts:                  vec![
				artifact("aarch64-apple-darwin", "omp-darwin"),
				artifact(windows, "omp.exe"),
			],
		};
		assert_eq!(target_artifact(&release, windows).unwrap().file, "omp.exe");
	}

	#[test]
	fn rename_denial_is_classified_without_a_helper_route() {
		let portable = io::Error::new(io::ErrorKind::PermissionDenied, "denied");
		assert_eq!(classify_rename_failure(&portable), RenameFailureKind::Denied);
		let windows_sharing_violation = io::Error::from_raw_os_error(32);
		assert_eq!(classify_rename_failure(&windows_sharing_violation), RenameFailureKind::Denied);
		let missing = io::Error::new(io::ErrorKind::NotFound, "missing");
		assert_eq!(classify_rename_failure(&missing), RenameFailureKind::Other);
	}

	#[test]
	fn stale_numeric_backups_and_downloads_are_pruned() {
		let root = tempfile::tempdir().unwrap();
		for name in [
			"omp.100.42.bak",
			"omp.exe.101.43.new",
			"pi.102.44.bak",
			"oh-my-pi.exe.103.45.bak",
			"omp.bak",
		] {
			fs::write(root.path().join(name), b"stale").unwrap();
		}
		for name in ["omp.notes.bak", "company.bak", "omp.100.42.txt"] {
			fs::write(root.path().join(name), b"keep").unwrap();
		}
		prune_stale(root.path()).unwrap();
		assert!(!root.path().join("omp.100.42.bak").exists());
		assert!(!root.path().join("omp.exe.101.43.new").exists());
		assert!(!root.path().join("pi.102.44.bak").exists());
		assert!(!root.path().join("oh-my-pi.exe.103.45.bak").exists());
		assert!(!root.path().join("omp.bak").exists());
		assert!(root.path().join("omp.notes.bak").exists());
		assert!(root.path().join("company.bak").exists());
		assert!(root.path().join("omp.100.42.txt").exists());
	}
	#[cfg(unix)]
	#[test]
	fn atomic_replace_verifies_and_removes_backup() {
		let root = tempfile::tempdir().unwrap();
		let destination = root.path().join("omp");
		let staged = root.path().join("omp.100.42.new");
		let backup = root.path().join("omp.100.42.bak");
		write_executable(&destination, b"#!/bin/sh\necho 'omp 17.0.0'\n").unwrap();
		write_executable(&staged, b"#!/bin/sh\necho 'omp 18.0.0'\n").unwrap();
		atomic_replace(&staged, &destination, &backup, "18.0.0").unwrap();
		assert!(!backup.exists());
		assert_eq!(fs::read_to_string(destination).unwrap(), "#!/bin/sh\necho 'omp 18.0.0'\n");
	}

	#[cfg(unix)]
	#[test]
	fn atomic_replace_restores_previous_binary_after_failed_verification() {
		let root = tempfile::tempdir().unwrap();
		let destination = root.path().join("omp");
		let staged = root.path().join("omp.100.42.new");
		let backup = root.path().join("omp.100.42.bak");
		let old = b"#!/bin/sh\necho 'omp 17.0.0'\n";
		write_executable(&destination, old).unwrap();
		write_executable(&staged, b"#!/bin/sh\necho 'not omp'\n").unwrap();
		assert!(atomic_replace(&staged, &destination, &backup, "18.0.0").is_err());
		assert_eq!(fs::read(destination).unwrap(), old);
		assert!(!backup.exists());
	}

	#[test]
	fn legacy_windows_name_migrates_to_omp_exe() {
		assert_eq!(
			renamed_destination_for(Path::new("/tools/pi.exe"), true),
			PathBuf::from("/tools/omp.exe")
		);
	}
}
