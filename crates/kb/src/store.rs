use std::{
	collections::{BTreeMap, BTreeSet},
	fs::{self, File, OpenOptions},
	io::{self, Write},
	path::{Path, PathBuf},
	process::{Command, Stdio},
};

use omp_ast::SupportLang;
use omp_core::Hash32;
use serde::{Deserialize, Serialize};

use crate::{
	error::{Context, Error, Result},
	graph::Index,
	producer::{PRODUCERS, Run},
};

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct Snapshot {
	pub revision:    String,
	pub fingerprint: String,
	files:           BTreeMap<String, Option<String>>,
}

#[cfg(test)]
impl Snapshot {
	pub(crate) fn empty() -> Self {
		Self { revision: String::new(), fingerprint: String::new(), files: BTreeMap::new() }
	}
}
#[derive(Serialize, Deserialize)]
struct Head {
	version: u32,
	digest:  String,
}

pub struct Store {
	pub(crate) root: PathBuf,
	dir:             PathBuf,
}

fn git(root: &Path, args: &[&str]) -> Result<Vec<u8>> {
	let output = Command::new("git")
		.current_dir(root)
		.args(args)
		.output()
		.context("running git")?;
	if !output.status.success() {
		return Err(Error::Git {
			args:   args.join(" "),
			stderr: String::from_utf8_lossy(&output.stderr).trim().to_owned(),
		});
	}
	Ok(output.stdout)
}

fn git_line(root: &Path, args: &[&str]) -> Result<String> {
	Ok(String::from_utf8(git(root, args)?)
		.context("git returned non-UTF-8 output")?
		.trim_end()
		.to_owned())
}

fn file_hash(path: &Path) -> Result<Option<String>> {
	let metadata = match fs::symlink_metadata(path) {
		Ok(metadata) => metadata,
		Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
		Err(error) => return Err(error).context(format!("reading {}", path.display())),
	};
	let mut hasher = Hash32::hasher();
	if metadata.file_type().is_symlink() {
		let target = fs::read_link(path)?;
		hasher
			.update(b"symlink\0")
			.update(target.as_os_str().as_encoded_bytes());
		match fs::metadata(path) {
			Ok(metadata) if metadata.is_file() => {
				io::copy(&mut File::open(path)?, &mut hasher)?;
			},
			Ok(_) => {},
			Err(error) if error.kind() == io::ErrorKind::NotFound => {},
			Err(error) => {
				return Err(error).context(format!("reading symlink target {}", path.display()));
			},
		}
	} else if metadata.is_file() {
		io::copy(&mut File::open(path)?, &mut hasher)?;
	} else if metadata.is_dir() {
		hasher.update(b"directory\0");
		if let Ok(revision) = git_line(path, &["rev-parse", "--verify", "HEAD"]) {
			hasher.update(revision);
		}
	} else {
		return Err(Error::UnsupportedFile { path: path.display().to_string() });
	}
	Ok(Some(hasher.finalize().to_string()))
}

impl Store {
	pub fn open(path: &Path) -> Result<Self> {
		let path =
			fs::canonicalize(path).context(format!("opening repository {}", path.display()))?;
		let root = PathBuf::from(git_line(&path, &["rev-parse", "--show-toplevel"])?);
		let git_dir = PathBuf::from(git_line(&root, &["rev-parse", "--git-path", "omp-kb"])?);
		let dir = root.join(git_dir);
		Ok(Self { root, dir })
	}

	fn snapshot(&self, extra: &[String]) -> Result<Snapshot> {
		let revision = git_line(&self.root, &["rev-parse", "--verify", "HEAD"])?;
		let output =
			git(&self.root, &["ls-files", "--cached", "--others", "--exclude-standard", "-z"])?;
		let mut paths = BTreeSet::new();
		for bytes in output
			.split(|byte| *byte == 0)
			.filter(|part| !part.is_empty())
		{
			paths.insert(
				std::str::from_utf8(bytes)
					.context("repository path is not UTF-8")?
					.to_owned(),
			);
		}
		paths.extend(extra.iter().cloned());
		let mut files = BTreeMap::new();
		for path in paths {
			files.insert(
				path.clone(),
				file_hash(&self.root.join(&path)).context(format!("hashing {path}"))?,
			);
		}
		let fingerprint = Hash32::sum(serde_json::to_vec(&files)?).to_string();
		Ok(Snapshot { revision, fingerprint, files })
	}

	pub fn stale(&self, index: &Index) -> Result<bool> {
		let extra: Vec<_> = index.snapshot.files.keys().cloned().collect();
		Ok(self.dir.join("refresh.pending").exists() || self.snapshot(&extra)? != index.snapshot)
	}

	pub fn load(&self) -> Result<Index> {
		let path = self.dir.join("index.json");
		let head: Head = serde_json::from_slice(
			&fs::read(&path)
				.context(format!("reading {}; run omp-kb update first", path.display()))?,
		)
		.context("invalid knowledge-base head")?;
		if head.version != 1 {
			return Err(Error::HeadVersion { version: head.version });
		}
		let digest: Hash32 = head
			.digest
			.parse()
			.context("invalid knowledge-base object digest")?;
		let object = self.dir.join("objects").join(format!("{digest}.json"));
		let bytes = fs::read(&object).context(format!("reading {}", object.display()))?;
		if Hash32::sum(&bytes) != digest {
			return Err(Error::DigestMismatch);
		}
		let index: Index = serde_json::from_slice(&bytes).context("invalid knowledge-base index")?;
		if index.version != 1 {
			return Err(Error::IndexVersion { version: index.version });
		}
		Ok(index)
	}

	pub fn build(&self) -> Result<Index> {
		fs::create_dir_all(&self.dir)?;
		let tag_path = ".omp/wasm-rust".to_owned();
		let before = self.snapshot(std::slice::from_ref(&tag_path))?;
		let sources: Vec<(&str, SupportLang)> = before
			.files
			.iter()
			.filter(|(_, hash)| hash.is_some())
			.filter_map(|(path, _)| Some((path.as_str(), SupportLang::from_path(Path::new(path))?)))
			.collect();
		let mut combined = scip::types::Index::new();
		let mut paths = vec![tag_path];
		for producer in PRODUCERS.iter().filter(|producer| {
			producer.applies(&before.files)
				&& sources
					.iter()
					.any(|(_, language)| producer.handles(*language))
		}) {
			let scip = tempfile::NamedTempFile::new_in(&self.dir)?;
			if producer.run(&self.root, scip.path())? == Run::Absent {
				continue;
			}
			let bytes = fs::read(scip.path()).context(format!("reading {} output", producer.name))?;
			let mut raw =
				Index::read_scip(&bytes).context(format!("decoding {} output", producer.name))?;
			paths.extend(Index::document_paths(&raw)?);
			combined.documents.append(&mut raw.documents);
			combined.external_symbols.append(&mut raw.external_symbols);
		}
		let after = self.snapshot(&paths)?;
		let covered: BTreeSet<&str> = paths.iter().map(String::as_str).collect();
		if before.revision != after.revision {
			return Err(Error::RevisionChangedDuringProducers);
		}
		let changed = before
			.files
			.iter()
			.find(|(path, hash)| after.files.get(*path) != Some(hash))
			.map(|(path, _)| path)
			.or_else(|| {
				after
					.files
					.keys()
					.find(|path| !before.files.contains_key(*path) && !covered.contains(path.as_str()))
			});
		if let Some(path) = changed {
			return Err(Error::ChangedDuringProducers { path: path.clone() });
		}
		let uncovered: Vec<&str> = sources
			.iter()
			.map(|(path, _)| *path)
			.filter(|path| !covered.contains(path))
			.collect();
		let mut index = Index::decode(&self.root, &combined, after.clone())?;
		index.add_syntactic(&self.root, &uncovered)?;
		self.add_wasm_tags(&mut index)?;
		if !index.has_definitions() {
			return Err(Error::NoDefinitions);
		}
		if self.snapshot(&paths)? != after {
			return Err(Error::ChangedDuringBuild);
		}
		Ok(index)
	}

	fn add_wasm_tags(&self, index: &mut Index) -> Result<()> {
		let tags = match fs::read_to_string(self.root.join(".omp/wasm-rust")) {
			Ok(tags) => tags,
			Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
			Err(error) => return Err(error).context("reading .omp/wasm-rust"),
		};
		let tracked = git(&self.root, &["ls-files", "--cached", "-z"])?;
		let tracked: BTreeSet<&[u8]> = tracked.split(|byte| *byte == 0).collect();
		for line in tags.lines() {
			let Some((wasm, rust)) = line.split_once('=') else {
				continue;
			};
			let (wasm, rust) = (wasm.trim(), rust.trim());
			let valid = |path: &str, extension: &str| {
				let path = Path::new(path);
				path.extension().is_some_and(|ext| ext == extension)
					&& path
						.components()
						.all(|c| matches!(c, std::path::Component::Normal(_)))
					&& fs::canonicalize(self.root.join(path))
						.is_ok_and(|resolved| resolved.starts_with(&self.root) && resolved.is_file())
			};
			if valid(wasm, "wasm") && valid(rust, "rs") && tracked.contains(rust.as_bytes()) {
				if let Some(name) = Path::new(wasm)
					.file_stem()
					.and_then(|name| name.to_str())
					.filter(|name| !name.is_empty())
				{
					index.add_wasm_tag(wasm, name, rust);
				}
			}
		}
		Ok(())
	}

	pub fn update(&self) -> Result<Index> {
		fs::create_dir_all(&self.dir)?;
		let lock = OpenOptions::new()
			.create(true)
			.truncate(false)
			.read(true)
			.write(true)
			.open(self.dir.join("update.lock"))?;
		lock.lock().context("locking knowledge-base update")?;
		let index = self.build()?;
		let objects = self.dir.join("objects");
		fs::create_dir_all(&objects)?;
		let mut object = tempfile::NamedTempFile::new_in(&objects)?;
		serde_json::to_writer(&mut object, &index)?;
		object.write_all(b"\n")?;
		object.as_file().sync_all()?;
		let digest = file_hash(object.path())?.context("temporary index object disappeared")?;
		let destination = objects.join(format!("{digest}.json"));
		if !destination.exists() || file_hash(&destination)?.as_deref() != Some(&digest) {
			object
				.persist(&destination)
				.map_err(|error| Error::foreign("publishing knowledge-base object", error))?;
		}
		let mut temporary = tempfile::NamedTempFile::new_in(&self.dir)?;
		serde_json::to_writer(&mut temporary, &Head { version: 1, digest })?;
		temporary.write_all(b"\n")?;
		temporary.as_file().sync_all()?;
		temporary
			.persist(self.dir.join("index.json"))
			.map_err(|error| Error::foreign("publishing knowledge-base head", error))?;
		match fs::remove_file(self.dir.join("refresh.pending")) {
			Ok(()) => {},
			Err(error) if error.kind() == io::ErrorKind::NotFound => {},
			Err(error) => return Err(error).context("clearing refresh marker"),
		}
		Ok(index)
	}

	pub fn refresh(&self, paths: &[PathBuf]) -> Result<()> {
		for path in paths {
			let relative = if path.is_absolute() {
				path
					.strip_prefix(&self.root)
					.map_err(|error| Error::foreign("refresh path is outside repository", error))?
			} else {
				path.as_path()
			};
			if relative.as_os_str().is_empty()
				|| relative.components().any(|c| {
					!matches!(c, std::path::Component::Normal(_) | std::path::Component::CurDir)
				}) {
				return Err(Error::InvalidRefresh { path: path.display().to_string() });
			}
		}
		fs::create_dir_all(&self.dir)?;
		let lock = OpenOptions::new()
			.create(true)
			.truncate(false)
			.read(true)
			.write(true)
			.open(self.dir.join("update.lock"))?;
		lock.lock().context("locking knowledge-base refresh")?;
		fs::write(self.dir.join("refresh.pending"), b"")?;
		let log = OpenOptions::new()
			.create(true)
			.append(true)
			.open(self.dir.join("refresh.log"))?;
		let executable = std::env::current_exe()?;
		let mut command = std::process::Command::new(&executable);
		if executable.file_name().and_then(|name| name.to_str()) == Some("omp") {
			command.arg("kb");
		}
		command
			.arg("--repo")
			.arg(&self.root)
			.arg("update")
			.stdin(Stdio::null())
			.stdout(Stdio::null())
			.stderr(Stdio::from(log));
		#[cfg(unix)]
		{
			use std::os::unix::process::CommandExt;
			command.process_group(0);
		}
		command
			.spawn()
			.context("starting detached knowledge-base refresh")?;
		Ok(())
	}
}

#[cfg(all(test, unix))]
mod tests {
	use std::{fs, os::unix::fs::symlink};

	use super::file_hash;

	#[test]
	fn link_fingerprint_tracks_target_contents_and_dangling_state() {
		let dir = tempfile::tempdir().unwrap();
		let target = dir.path().join("target");
		let link = dir.path().join("link");
		fs::write(&target, b"first").unwrap();
		symlink("target", &link).unwrap();
		let first = file_hash(&link).unwrap();
		fs::write(&target, b"second").unwrap();
		assert_ne!(first, file_hash(&link).unwrap());
		fs::remove_file(&target).unwrap();
		assert_ne!(first, file_hash(&link).unwrap());
	}
}
