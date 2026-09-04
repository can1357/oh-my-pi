//! External-tool GitHub release asset selection and atomic installation.

use std::{
	env,
	env::consts,
	io,
	path::{Path, PathBuf},
};

use futures::StreamExt as _;
use omp_ai::local::{
	ArtifactError, ArtifactFetchRequest, ArtifactFetcher as _, SystemArtifactFetcher,
};
use omp_core::Str;
use thiserror::Error;
use tokio::io::AsyncWriteExt as _;

/// One downloadable GitHub release asset discovered by the API authority.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReleaseAsset {
	/// Published asset filename.
	pub name:  Str,
	/// Browser-download URL from the release response.
	pub url:   Str,
	/// Exact release asset size.
	pub bytes: u64,
}

/// External tool installation failure.
#[derive(Debug, Error)]
pub enum ToolInstallError {
	/// No release asset matches the current platform.
	#[error("release has no asset for {platform}{hint}")]
	NoPlatformAsset {
		/// Stable platform selector.
		platform: Str,
		/// Termux-specific guidance when applicable.
		hint:     Str,
	},
	/// Public artifact fetch failed.
	#[error(transparent)]
	Fetch(#[from] ArtifactError),
	/// Local atomic installation failed.
	#[error("could not install external tool at {path:?}")]
	Io {
		/// Destination or temporary path.
		path:   PathBuf,
		/// Filesystem failure.
		#[source]
		source: io::Error,
	},
	/// The release response and streamed body disagree on asset size.
	#[error("release asset size changed: expected {expected} bytes, received {actual}")]
	SizeChanged {
		/// GitHub release metadata size.
		expected: u64,
		/// Streamed byte count.
		actual:   u64,
	},
}

/// Selects the current OS/architecture asset from one GitHub release.
///
/// Checksums, signatures, and source archives are excluded. Remaining matches
/// preserve release order so publishers retain control over equivalent archive
/// formats.
pub fn select_release_asset(assets: &[ReleaseAsset]) -> Result<&ReleaseAsset, ToolInstallError> {
	let os = match consts::OS {
		"macos" => &["darwin", "macos", "apple"] as &[&str],
		"windows" => &["windows", "win32", "pc-windows"],
		_ => &["linux", "unknown-linux"],
	};
	let arch = match consts::ARCH {
		"aarch64" => &["aarch64", "arm64"] as &[&str],
		"x86_64" => &["x86_64", "amd64", "x64"],
		"arm" => &["armv7", "armhf"],
		other => &[other],
	};
	let selected = assets.iter().find(|asset| {
		let name = asset.name.to_ascii_lowercase();
		!name.contains("checksum")
			&& !name.contains("sha256")
			&& !name.contains("signature")
			&& !name.contains("source")
			&& os.iter().any(|marker| name.contains(marker))
			&& arch.iter().any(|marker| name.contains(marker))
	});
	selected.ok_or_else(|| {
		let platform = Str::from(format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH));
		let termux = env::var_os("PREFIX")
			.is_some_and(|prefix| prefix.to_string_lossy().contains("com.termux"));
		let hint = if termux {
			Str::new_static("; Termux users should install the package with pkg or pip/uv")
		} else {
			Str::default()
		};
		ToolInstallError::NoPlatformAsset { platform, hint }
	})
}

/// Streams one selected release asset into an installer-owned sidecar, verifies
/// its declared length, and atomically publishes it at `destination`.
pub async fn download_release_asset(
	asset: &ReleaseAsset,
	destination: &Path,
) -> Result<(), ToolInstallError> {
	let parent = destination.parent().unwrap_or_else(|| Path::new("."));
	tokio::fs::create_dir_all(parent)
		.await
		.map_err(|source| ToolInstallError::Io { path: parent.to_path_buf(), source })?;
	let temporary = destination.with_extension("omp-download-part");
	let mut file = tokio::fs::File::create(&temporary)
		.await
		.map_err(|source| ToolInstallError::Io { path: temporary.clone(), source })?;
	let response = SystemArtifactFetcher::new()
		.fetch(ArtifactFetchRequest {
			source:         asset.url.clone(),
			offset:         0,
			expected_bytes: asset.bytes,
		})
		.await?;
	let mut body = response.body;
	let mut received = 0_u64;
	while let Some(chunk) = body.next().await {
		let chunk = chunk?;
		received = received.saturating_add(u64::try_from(chunk.len()).unwrap_or(u64::MAX));
		file
			.write_all(&chunk)
			.await
			.map_err(|source| ToolInstallError::Io { path: temporary.clone(), source })?;
	}
	if received != asset.bytes {
		let _ = tokio::fs::remove_file(&temporary).await;
		return Err(ToolInstallError::SizeChanged { expected: asset.bytes, actual: received });
	}
	file
		.sync_all()
		.await
		.map_err(|source| ToolInstallError::Io { path: temporary.clone(), source })?;
	drop(file);
	tokio::fs::rename(&temporary, destination)
		.await
		.map_err(|source| ToolInstallError::Io { path: destination.to_path_buf(), source })?;
	Ok(())
}
