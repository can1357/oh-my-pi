use std::{
	fs,
	path::{Component, Path, PathBuf},
};

use serde::Deserialize;
use sha2::{Digest, Sha256};

pub const CATEGORIES: &[&str] = &["transport", "operations"];

#[derive(Clone, Debug, Deserialize)]
pub struct Manifest {
	pub schema_version: u32,
	pub category:       String,
	pub fixtures:       Vec<FixtureEntry>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct FixtureEntry {
	pub id:          String,
	pub path:        String,
	pub sha256:      String,
	pub secret_free: bool,
}

#[derive(Clone, Debug)]
pub struct Fixture {
	pub entry: FixtureEntry,
	pub bytes: Vec<u8>,
}

impl Fixture {
	pub fn json<T: serde::de::DeserializeOwned>(&self) -> T {
		serde_json::from_slice(&self.bytes).unwrap_or_else(|error| {
			panic!("oracle fixture {} is not valid typed JSON: {error}", self.entry.id)
		})
	}
}

pub fn manifest(category: &str) -> Manifest {
	assert!(CATEGORIES.contains(&category), "unregistered oracle category {category}");
	let path = corpus_root().join(category).join("manifest.json");
	let bytes = fs::read(&path).unwrap_or_else(|error| panic!("read {}: {error}", path.display()));
	let manifest: Manifest = serde_json::from_slice(&bytes)
		.unwrap_or_else(|error| panic!("parse {}: {error}", path.display()));
	assert_eq!(manifest.schema_version, 1, "unsupported {category} manifest schema");
	assert_eq!(manifest.category, category, "manifest category mismatch");
	manifest
}

pub fn fixture(category: &str, id: &str) -> Fixture {
	let manifest = manifest(category);
	let entry = manifest
		.fixtures
		.into_iter()
		.find(|entry| entry.id == id)
		.unwrap_or_else(|| panic!("fixture {id} is not identified through {category}/manifest.json"));
	load_entry(category, entry)
}

fn load_entry(category: &str, entry: FixtureEntry) -> Fixture {
	assert!(entry.secret_free, "fixture {} is not marked secret-free", entry.id);
	assert_safe_relative_path(&entry.path);
	let path = corpus_root().join(category).join(&entry.path);
	let bytes = fs::read(&path).unwrap_or_else(|error| panic!("read {}: {error}", path.display()));
	let actual = format!("{:x}", Sha256::digest(&bytes));
	assert_eq!(actual, entry.sha256, "fixture digest drift for {}", entry.id);
	Fixture { entry, bytes }
}

fn assert_safe_relative_path(path: &str) {
	let path = Path::new(path);
	assert!(!path.as_os_str().is_empty(), "empty fixture path");
	assert!(!path.is_absolute(), "absolute fixture path is forbidden");
	assert!(
		path
			.components()
			.all(|component| matches!(component, Component::Normal(_))),
		"fixture path must stay inside its category: {}",
		path.display()
	);
}

fn corpus_root() -> PathBuf {
	Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/llm-oracle")
}
