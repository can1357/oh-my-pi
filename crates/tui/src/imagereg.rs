//! Process-global interning of `<img src>` sources for typed image cells.
//!
//! [`crate::components::Img`] interns an image source once and paints typed
//! image cells carrying the returned ID; the renderer resolves IDs it has
//! never seen through [`bytes`] and uploads them on first reference, so
//! applications never touch terminal image IDs. Mirrors the hyperlink
//! interner in [`crate::frame`].
//!
//! IDs are allocated downward from the top of Kitty's 24-bit range so they
//! cannot collide with the low IDs applications typically pass to
//! [`crate::Renderer::register_image`].

use std::{
	collections::{HashMap, HashSet},
	fs,
	io::Cursor,
	path::PathBuf,
	sync::{Arc, LazyLock},
};

use omp_core::{CowBytes, Str};
use parking_lot::Mutex;

use crate::{
	assets,
	imagefmt::{self, ImageDimensions},
};

/// One interned source: terminal image ID, PNG bytes, and probed dimensions.
#[derive(Clone)]
pub struct InternedImage {
	pub(crate) id:         u32,
	pub(crate) png:        CowBytes<'static>,
	pub(crate) dimensions: ImageDimensions,
}

#[derive(Default)]
struct Registry {
	/// Source URI or path → interned entry; failures cache as `None` so
	/// missing sources are probed once, not every rebuild.
	by_source:  HashMap<Str, Option<InternedImage>>,
	by_id:      HashMap<u32, CowBytes<'static>>,
	converting: HashSet<Str>,
	allocated:  u32,
}

static IMAGES: LazyLock<Mutex<Registry>> = LazyLock::new(|| Mutex::new(Registry::default()));

/// Application-installed resolver mapping one URI scheme's `<img src>`
/// sources to filesystem paths.
pub type SourceResolver = Arc<dyn Fn(&str) -> Option<PathBuf> + Send + Sync>;

/// Scheme → resolver, kept apart from [`IMAGES`] because sources resolve
/// while the interner lock is held.
static SCHEMES: LazyLock<Mutex<Vec<(&'static str, SourceResolver)>>> =
	LazyLock::new(|| Mutex::new(Vec::new()));

/// Installs a resolver for `scheme://…` image sources (`artifact` → the
/// session blob store). The resolver receives the whole source and returns
/// the file to read; a later registration for the same scheme replaces the
/// earlier one.
pub fn register_scheme(scheme: &'static str, resolver: SourceResolver) {
	let mut schemes = SCHEMES.lock();
	match schemes.iter_mut().find(|(name, _)| *name == scheme) {
		Some(entry) => entry.1 = resolver,
		None => schemes.push((scheme, resolver)),
	}
}

fn resolve_scheme(source: &str) -> Option<PathBuf> {
	let (scheme, _) = source.split_once("://")?;
	let resolver = SCHEMES
		.lock()
		.iter()
		.find(|(name, _)| *name == scheme)
		.map(|(_, resolver)| Arc::clone(resolver))?;
	resolver(source)
}

/// Interns a PNG filesystem path or packaged `asset://login/<provider>`
/// source, returning its stable terminal image ID and pixel dimensions.
/// Non-PNG sources return `None` until [`prepare_png`] converts and caches them
/// off the paint path. Unreadable sources are negatively cached.
pub fn intern(source: &str) -> Option<InternedImage> {
	let mut registry = IMAGES.lock();
	if let Some(cached) = registry.by_source.get(source) {
		return cached.clone();
	}
	if registry.converting.contains(source) {
		return None;
	}
	let Some(png) = source_bytes(source) else {
		registry.by_source.insert(Str::new(source), None);
		return None;
	};
	// Kitty transmissions are sent as `f=100`: PNG only. Leave other formats
	// uncached so the component's existing off-thread loader can claim and convert
	// them.
	if !is_png(&png) {
		return None;
	}
	let Some(interned) = make_interned(png, registry.allocated) else {
		registry.by_source.insert(Str::new(source), None);
		return None;
	};
	registry.allocated += 1;
	registry.by_id.insert(interned.id, interned.png.clone());
	registry
		.by_source
		.insert(Str::new(source), Some(interned.clone()));
	Some(interned)
}

/// PNG bytes for a registry-allocated ID, for renderer-side upload.
pub fn bytes(id: u32) -> Option<CowBytes<'static>> {
	let registry = IMAGES.lock();
	registry.by_id.get(&id).cloned()
}

/// Registers renderer-local image bytes under an opaque extension resource
/// name.
///
/// Existing registrations are immutable: a repeated name returns the original
/// image so extension generations cannot replace a resource after TML parsing.
pub fn register(source: impl Into<Str>, bytes: impl Into<CowBytes<'static>>) -> bool {
	let source = source.into();
	let mut registry = IMAGES.lock();
	if registry.by_source.contains_key(&source) {
		return registry.by_source.get(&source).is_some_and(Option::is_some);
	}
	let bytes = bytes.into();
	let png = if is_png(&bytes) {
		Some(bytes)
	} else {
		let image = image::load_from_memory(&bytes).ok();
		image.and_then(|image| {
			let mut output = Cursor::new(Vec::new());
			image
				.write_to(&mut output, image::ImageFormat::Png)
				.ok()
				.map(|()| CowBytes::from(output.into_inner()))
		})
	};
	let Some(png) = png else {
		registry.by_source.insert(source, None);
		return false;
	};
	let Some(interned) = make_interned(png, registry.allocated) else {
		registry.by_source.insert(source, None);
		return false;
	};
	registry.allocated += 1;
	registry.by_id.insert(interned.id, interned.png.clone());
	registry.by_source.insert(source, Some(interned));
	true
}

fn make_interned(png: CowBytes<'static>, allocated: u32) -> Option<InternedImage> {
	let id = 0x00ff_ffff_u32.checked_sub(allocated)?;
	let dimensions = imagefmt::dimensions(&png)?;
	Some(InternedImage { id, png, dimensions })
}

fn is_png(bytes: &[u8]) -> bool {
	bytes.starts_with(b"\x89PNG\r\n\x1a\n")
}

/// Returns a cached PNG form of `source`, converting supported non-PNG formats
/// exactly once.
///
/// Async hosts run this through the component's off-thread decode loader. Its
/// normal completion delivery invalidates the component and repaints the newly
/// interned Kitty image.
pub fn prepare_png(source: &str) -> Option<CowBytes<'static>> {
	{
		let mut registry = IMAGES.lock();
		if let Some(cached) = registry.by_source.get(source) {
			return cached.as_ref().map(|entry| entry.png.clone());
		}
		if !registry.converting.insert(Str::new(source)) {
			return None;
		}
	}

	let png = convert_to_png(source);
	let mut registry = IMAGES.lock();
	registry.converting.remove(source);
	let Some(png) = png else {
		registry.by_source.insert(Str::new(source), None);
		return None;
	};
	let Some(interned) = make_interned(png, registry.allocated) else {
		registry.by_source.insert(Str::new(source), None);
		return None;
	};
	registry.allocated += 1;
	registry.by_id.insert(interned.id, interned.png.clone());
	registry
		.by_source
		.insert(Str::new(source), Some(interned.clone()));
	Some(interned.png)
}

fn convert_to_png(source: &str) -> Option<CowBytes<'static>> {
	let bytes = source_bytes(source)?;
	if is_png(&bytes) {
		return Some(bytes);
	}
	let image = image::load_from_memory(&bytes).ok()?;
	let mut output = Cursor::new(Vec::new());
	image.write_to(&mut output, image::ImageFormat::Png).ok()?;
	Some(CowBytes::from(output.into_inner()))
}

/// Loads bytes from a filesystem path, a packaged provider-logo URI, or a
/// source whose scheme an application resolver ([`register_scheme`]) maps
/// to a file.
///
/// Embedded assets stay backed directly by executable static data; file
/// sources retain their owned read buffer.
pub fn source_bytes(source: &str) -> Option<CowBytes<'static>> {
	if let Some(provider_id) = source.strip_prefix("asset://login/") {
		return assets::provider_logo(provider_id).map(CowBytes::from_static);
	}
	if let Some(path) = resolve_scheme(source) {
		return fs::read(path).ok().map(CowBytes::from);
	}
	fs::read(source).ok().map(CowBytes::from)
}

#[cfg(test)]
mod tests {
	use std::{env, fs, sync::Arc};

	use super::{register_scheme, source_bytes};

	#[test]
	fn registered_scheme_resolves_sources_to_files() {
		let path =
			env::temp_dir().join(format!("omp-tui-imagereg-scheme-{}.bin", std::process::id()));
		fs::write(&path, b"payload").expect("fixture");
		let resolved = path.clone();
		register_scheme(
			"omp-test",
			Arc::new(move |source| (source == "omp-test://one").then(|| resolved.clone())),
		);
		assert_eq!(source_bytes("omp-test://one").as_deref(), Some(&b"payload"[..]));
		assert!(source_bytes("omp-test://two").is_none(), "resolver misses read nothing");
		assert!(source_bytes("nope://one").is_none(), "unknown schemes fall through to the path");
		let _ = fs::remove_file(path);
	}
}
