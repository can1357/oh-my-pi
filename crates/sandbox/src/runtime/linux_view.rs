use std::{
	collections::BTreeMap,
	fs,
	fs::OpenOptions,
	os::unix::fs::OpenOptionsExt as _,
	path::{Path, PathBuf},
};

use tempfile::Builder;

use crate::{
	Backend, SandboxError, SandboxOperation, SandboxSpec,
	backends::gvisor_oci::OciMount,
	paths::{path_under_any, temp_roots},
	runtime::gvisor::{GvisorPrepared, GvisorResource},
};

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
enum MountMode {
	ReadOnly,
	ReadWrite,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct ViewMount {
	source: PathBuf,
	target: PathBuf,
	mode:   MountMode,
}

#[derive(Clone, Debug)]
struct LinuxView {
	read_host: bool,
	mounts:    Vec<ViewMount>,
	read_deny: Vec<PathBuf>,
}

pub(crate) struct PreparedFilesystem {
	pub(crate) rootfs: PathBuf,
	pub(crate) mounts: Vec<OciMount>,
}

pub(crate) fn prepare(
	spec: &SandboxSpec,
	program: &Path,
	state: &mut GvisorPrepared,
) -> Result<PreparedFilesystem, SandboxError> {
	let view = build_view(spec);
	let mut mounts = Vec::new();
	let rootfs = if view.read_host {
		mounts.extend(view.mounts.iter().map(oci_mount));
		PathBuf::from("/")
	} else {
		let root = Builder::new()
			.prefix("omp-sandbox-gvisor-root-")
			.tempdir()
			.map_err(|source| SandboxError::BackendIo {
				backend: Backend::Gvisor,
				operation: SandboxOperation::Prepare,
				source,
			})?;
		let root_path = root.path().to_path_buf();
		let runtime_mounts = with_runtime_closure(view.mounts, program);
		for mount in &runtime_mounts {
			create_placeholder(&root_path, &mount.target, &mount.source)?;
			mounts.push(oci_mount(mount));
		}
		state.push(GvisorResource::Directory(Some(root)));
		root_path
	};

	if !view.read_deny.is_empty() {
		let scratch = Builder::new()
			.prefix("omp-sandbox-gvisor-deny-")
			.tempdir()
			.map_err(|source| SandboxError::BackendIo {
				backend: Backend::Gvisor,
				operation: SandboxOperation::Prepare,
				source,
			})?;
		for (index, denied) in view.read_deny.iter().enumerate() {
			let Ok(metadata) = fs::symlink_metadata(denied) else {
				continue;
			};
			if !view.read_host {
				create_placeholder(&rootfs, denied, denied)?;
			}
			let (source, options) = if metadata.is_dir() {
				let source = scratch.path().join(format!("d{index}"));
				fs::create_dir(&source).map_err(|source_error| SandboxError::BackendPath {
					backend:   Backend::Gvisor,
					operation: SandboxOperation::Prepare,
					path:      source.clone(),
					source:    source_error,
				})?;
				(source, vec!["rbind".into(), "ro".into()])
			} else {
				let source = scratch.path().join(format!("f{index}"));
				OpenOptions::new()
					.write(true)
					.create_new(true)
					.mode(0o600)
					.open(&source)
					.map_err(|source_error| SandboxError::BackendPath {
						backend:   Backend::Gvisor,
						operation: SandboxOperation::Prepare,
						path:      source.clone(),
						source:    source_error,
					})?;
				(source, vec!["bind".into(), "ro".into()])
			};
			mounts.push(OciMount {
				destination: linux_target(denied)?,
				kind: "bind".into(),
				source: source.to_string_lossy().into_owned(),
				options,
			});
		}
		state.push(GvisorResource::Directory(Some(scratch)));
	}

	Ok(PreparedFilesystem { rootfs, mounts })
}

fn build_view(spec: &SandboxSpec) -> LinuxView {
	let mut paths = BTreeMap::<PathBuf, MountMode>::new();
	for path in &spec.readable {
		paths.entry(path.clone()).or_insert(MountMode::ReadOnly);
	}
	for path in &spec.writable {
		paths.insert(path.clone(), MountMode::ReadWrite);
	}
	if spec.allow_temp {
		for root in temp_roots() {
			paths.insert(root, MountMode::ReadWrite);
		}
	}
	for socket in &spec.unix_sockets {
		paths.insert(socket.clone(), MountMode::ReadWrite);
	}
	for path in spec
		.write_deny
		.iter()
		.filter(|path| path.exists() && path_under_any(path, &spec.writable))
	{
		paths.insert(path.clone(), MountMode::ReadOnly);
	}
	let mounts = paths
		.into_iter()
		.map(|(source, mode)| ViewMount { target: source.clone(), source, mode })
		.collect();
	LinuxView { read_host: spec.readable.is_empty(), mounts, read_deny: spec.read_deny.clone() }
}

fn with_runtime_closure(mounts: Vec<ViewMount>, program: &Path) -> Vec<ViewMount> {
	let mut paths = BTreeMap::<PathBuf, MountMode>::new();
	for mount in mounts {
		paths.insert(mount.source, mount.mode);
	}
	let candidates = [
		PathBuf::from("/etc/ld.so.cache"),
		PathBuf::from("/etc/ld.so.conf"),
		PathBuf::from("/etc/ld.so.conf.d"),
		PathBuf::from("/lib"),
		PathBuf::from("/lib64"),
		PathBuf::from("/usr/lib"),
		PathBuf::from("/usr/lib64"),
		PathBuf::from("/lib/x86_64-linux-gnu"),
		PathBuf::from("/usr/lib/x86_64-linux-gnu"),
		PathBuf::from("/lib/aarch64-linux-gnu"),
		PathBuf::from("/usr/lib/aarch64-linux-gnu"),
		program.to_path_buf(),
	];
	for candidate in candidates {
		if fs::symlink_metadata(&candidate).is_ok() {
			paths
				.entry(candidate.clone())
				.or_insert(MountMode::ReadOnly);
			if let Ok(resolved) = fs::canonicalize(&candidate) {
				paths.entry(resolved).or_insert(MountMode::ReadOnly);
			}
		}
	}
	paths
		.into_iter()
		.map(|(source, mode)| ViewMount { target: source.clone(), source, mode })
		.collect()
}

fn oci_mount(mount: &ViewMount) -> OciMount {
	OciMount {
		destination: mount.target.to_string_lossy().into_owned(),
		kind:        "bind".into(),
		source:      mount.source.to_string_lossy().into_owned(),
		options:     vec!["rbind".into(), match mount.mode {
			MountMode::ReadOnly => "ro".into(),
			MountMode::ReadWrite => "rw".into(),
		}],
	}
}

fn create_placeholder(rootfs: &Path, target: &Path, source: &Path) -> Result<(), SandboxError> {
	if !target.is_absolute() {
		return Err(SandboxError::InvalidMountPath {
			backend: Backend::Gvisor,
			path:    target.to_path_buf(),
		});
	}
	let relative =
		target
			.strip_prefix(Path::new("/"))
			.map_err(|_| SandboxError::InvalidMountPath {
				backend: Backend::Gvisor,
				path:    target.to_path_buf(),
			})?;
	let host_target = rootfs.join(relative);
	let parent = host_target
		.parent()
		.ok_or_else(|| SandboxError::InvalidMountPath {
			backend: Backend::Gvisor,
			path:    target.to_path_buf(),
		})?;
	fs::create_dir_all(parent).map_err(|source_error| SandboxError::BackendPath {
		backend:   Backend::Gvisor,
		operation: SandboxOperation::Prepare,
		path:      parent.to_path_buf(),
		source:    source_error,
	})?;
	let metadata = fs::metadata(source).map_err(|source_error| SandboxError::BackendPath {
		backend:   Backend::Gvisor,
		operation: SandboxOperation::Prepare,
		path:      source.to_path_buf(),
		source:    source_error,
	})?;
	if metadata.is_dir() {
		fs::create_dir_all(&host_target).map_err(|source_error| SandboxError::BackendPath {
			backend:   Backend::Gvisor,
			operation: SandboxOperation::Prepare,
			path:      host_target,
			source:    source_error,
		})
	} else if host_target.exists() {
		Ok(())
	} else {
		OpenOptions::new()
			.write(true)
			.create_new(true)
			.mode(0o600)
			.open(&host_target)
			.map(|_| ())
			.map_err(|source_error| SandboxError::BackendPath {
				backend:   Backend::Gvisor,
				operation: SandboxOperation::Prepare,
				path:      host_target,
				source:    source_error,
			})
	}
}

fn linux_target(path: &Path) -> Result<String, SandboxError> {
	if !path.is_absolute() {
		return Err(SandboxError::InvalidMountPath {
			backend: Backend::Gvisor,
			path:    path.to_path_buf(),
		});
	}
	Ok(path.to_string_lossy().into_owned())
}
#[cfg(test)]
mod tests {
	use std::{fs, os::unix::fs::PermissionsExt as _};

	use tempfile::tempdir;

	use super::{MountMode, build_view, prepare};
	use crate::{SandboxSpec, WriteMode, runtime::gvisor::GvisorPrepared};

	#[test]
	fn writable_mount_overrides_duplicate_readonly_mount() {
		let directory = tempdir().expect("scope");
		let mut spec = SandboxSpec::new("/bin/echo");
		spec.allow_read(directory.path()).expect("read scope");
		spec.set_write(WriteMode::Scoped);
		spec.allow_write(directory.path()).expect("write scope");
		let view = build_view(&spec);
		let mount = view
			.mounts
			.iter()
			.find(|mount| mount.source == directory.path())
			.expect("mount");
		assert_eq!(mount.mode, MountMode::ReadWrite);
	}

	#[test]
	fn write_deny_mount_overrides_writable_parent() {
		let directory = tempdir().expect("scope");
		let denied = directory.path().join("denied");
		fs::create_dir(&denied).expect("denied directory");
		let mut spec = SandboxSpec::new("/bin/echo");
		spec.set_write(WriteMode::Scoped);
		spec.allow_write(directory.path()).expect("write scope");
		spec.deny_write(&denied).expect("write deny");
		let view = build_view(&spec);
		let denied = fs::canonicalize(denied).expect("canonical denied");
		let mount = view
			.mounts
			.iter()
			.find(|mount| mount.source == denied)
			.expect("denied mount");
		assert_eq!(mount.mode, MountMode::ReadOnly);
	}

	#[test]
	fn scoped_root_and_read_deny_masks_are_materialized_without_host_mutation() {
		let directory = tempdir().expect("scope");
		let readable = directory.path().join("readable");
		let denied = readable.join("secret");
		fs::create_dir(&readable).expect("readable");
		fs::write(&denied, b"secret").expect("denied file");
		let mut spec = SandboxSpec::new("/bin/echo");
		spec.allow_read(&readable).expect("read scope");
		spec.deny_read(&denied).expect("read deny");
		let mut state = GvisorPrepared::default();
		let filesystem =
			prepare(&spec, std::path::Path::new("/bin/echo"), &mut state).expect("filesystem view");
		assert_ne!(filesystem.rootfs, std::path::Path::new("/"));
		let mask = filesystem
			.mounts
			.iter()
			.find(|mount| mount.destination == denied.to_string_lossy())
			.expect("deny mask");
		assert_eq!(mask.options, ["bind", "ro"]);
		assert_eq!(
			fs::metadata(&mask.source)
				.expect("mask metadata")
				.permissions()
				.mode() & 0o777,
			0o600,
		);
		assert_eq!(fs::read(&denied).expect("host denied file unchanged"), b"secret");
	}
}
