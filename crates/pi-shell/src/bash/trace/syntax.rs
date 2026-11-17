//! Immutable canonical syntax retained only for an observed compilation.

use std::sync::{Arc, OnceLock};

use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Deserializer, Serialize, Serializer};

use crate::bash::{
	ids::ModeId,
	ir,
	syntax::{self as syn, tree as st},
};

const ARCHIVE_VERSION: u8 = 3;

/// Exact originating region, when the engine supplies one.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceParent {
	pub unit: u32,
	pub node: u32,
	pub lo:   u32,
	pub hi:   u32,
}

/// What a syntax root is.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum RootKind {
	List,
	Command,
	Word,
}

/// A root of the existing bash syntax, not a visualization grammar: node
/// `root` of a shared flat tree.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SyntaxTree {
	pub tree: Arc<st::Tree>,
	pub root: u32,
	pub kind: RootKind,
}

/// A view of a [`SyntaxTree`]'s root.
#[derive(Clone, Copy, Debug)]
pub enum Root<'t> {
	List(st::List<'t>),
	Command(st::Command<'t>),
	Word(st::Word<'t>),
}

impl SyntaxTree {
	pub fn new(tree: st::Tree, root: u32, kind: RootKind) -> Self {
		Self { tree: Arc::new(tree), root, kind }
	}

	/// The tree of a run-time parsed word.
	pub fn from_word(tree: st::Tree, root: u32) -> Self {
		Self::new(tree, root, RootKind::Word)
	}

	/// The root as a view.
	pub fn view(&self) -> Root<'_> {
		match self.kind {
			RootKind::List => Root::List(st::List::at(&self.tree, self.root)),
			RootKind::Command => Root::Command(st::Command::at(&self.tree, self.root)),
			RootKind::Word => Root::Word(st::Word::at(&self.tree, self.root)),
		}
	}
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
struct SyntaxContext {
	mode:     ModeId,
	features: u32,
	aliases:  Vec<(bstr::BString, bstr::BString)>,
}
impl Default for SyntaxContext {
	fn default() -> Self {
		Self { mode: ModeId::Bash, features: 0, aliases: Vec::new() }
	}
}

/// Parser span origin and the actual immutable tree.
#[derive(Clone, Debug)]
pub struct UnitSyntax {
	pub offset: u32,
	pub tree:   SyntaxTree,
	pub parent: Option<SourceParent>,
	context:    Arc<SyntaxContext>,
	archive:    OnceLock<String>,
}

impl PartialEq for UnitSyntax {
	fn eq(&self, other: &Self) -> bool {
		self.offset == other.offset
			&& self.tree == other.tree
			&& self.parent == other.parent
			&& self.context == other.context
	}
}
impl Eq for UnitSyntax {}

#[derive(Serialize)]
struct ArchiveRef<'a> {
	version: u8,
	offset:  u32,
	parent:  Option<SourceParent>,
	context: &'a SyntaxContext,
	kind:    RootKind,
	root:    u32,
	tree:    &'a st::Tree,
}

/// [`ArchiveRef`] after its version byte.
#[derive(Deserialize)]
struct Archive {
	offset:  u32,
	parent:  Option<SourceParent>,
	context: SyntaxContext,
	kind:    RootKind,
	root:    u32,
	tree:    st::Tree,
}

impl UnitSyntax {
	/// Retain a parsed command list and its aliases without cloning the
	/// canonical tree.
	pub fn list(cc: syn::CompleteCommand) -> Self {
		let mut syntax =
			Self::new(cc.span.lo, SyntaxTree::new(cc.tree, cc.root.index(), RootKind::List));
		Arc::make_mut(&mut syntax.context).aliases = cc
			.aliases
			.into_iter()
			.map(|alias| (alias.name.into(), alias.value.into()))
			.collect();
		syntax
	}

	/// Wrap a native syntax root with its original parser byte offset.
	pub fn new(offset: u32, tree: SyntaxTree) -> Self {
		Self {
			offset,
			tree,
			parent: None,
			context: Arc::new(SyntaxContext::default()),
			archive: OnceLock::new(),
		}
	}

	pub(crate) fn with_context(mut self, mode: ModeId, features: u32) -> Self {
		let context = Arc::make_mut(&mut self.context);
		context.mode = mode;
		context.features = features;
		self.archive = OnceLock::new();
		self
	}

	pub(crate) fn with_aliases(mut self, aliases: &[(bstr::BString, bstr::BString)]) -> Self {
		Arc::make_mut(&mut self.context).aliases = aliases.to_vec();
		self.archive = OnceLock::new();
		self
	}

	pub(crate) fn shares_tree(&self, other: &Self) -> bool {
		self.offset == other.offset
			&& self.parent == other.parent
			&& self.tree.root == other.tree.root
			&& Arc::ptr_eq(&self.tree.tree, &other.tree.tree)
	}

	pub(crate) fn with_parent(&self, parent: SourceParent) -> Self {
		Self {
			offset:  self.offset,
			tree:    self.tree.clone(),
			parent:  Some(parent),
			context: Arc::clone(&self.context),
			archive: OnceLock::new(),
		}
	}

	/// Restore only at an announced unit boundary, using its exact parser
	/// context.
	pub(crate) fn restore(unit: &ir::Unit) -> Option<Self> {
		if let Some(bytes) = unit.deferred.as_ref().filter(|bytes| !bytes.is_empty()) {
			let (offset, tree, root): (u32, st::Tree, u32) = postcard::from_bytes(bytes).ok()?;
			return Some(
				Self::new(offset, SyntaxTree::new(tree, root, RootKind::Command))
					.with_context(unit.mode, unit.features)
					.with_aliases(&unit.aliases),
			);
		}
		Self::parse_boundary(&unit.source, unit.features, &unit.aliases, unit.line)
			.map(|(syntax, _)| syntax.with_context(unit.mode, unit.features))
	}

	/// Parse only the first announced command, including all of its heredocs.
	pub(crate) fn parse_boundary(
		source: &[u8],
		features: u32,
		aliases: &[(bstr::BString, bstr::BString)],
		line: u32,
	) -> Option<(Self, usize)> {
		struct Aliases<'a>(&'a [(bstr::BString, bstr::BString)]);
		impl syn::AliasLookup for Aliases<'_> {
			fn alias(&self, name: &[u8]) -> Option<&[u8]> {
				self
					.0
					.iter()
					.find(|(key, _)| key.as_slice() == name)
					.map(|(_, value)| value.as_slice())
			}
		}
		let aliases = Aliases(aliases);
		let mut parser = syn::Parser::new(source, syn::Features::from_bits(features), &aliases)
			.with_pos(syn::Pos { offset: 0, line });
		let cc = parser.next_command()?.ok()?;
		let end = cc.span.hi as usize;
		Some((Self::list(cc).with_context(ModeId::Bash, features), end))
	}
}

impl Serialize for UnitSyntax {
	fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
		let bytes = self.archive.get_or_init(|| {
			STANDARD.encode(
				postcard::to_allocvec(&ArchiveRef {
					version: ARCHIVE_VERSION,
					offset:  self.offset,
					parent:  self.parent,
					context: self.context.as_ref(),
					kind:    self.tree.kind,
					root:    self.tree.root,
					tree:    &self.tree.tree,
				})
				.expect("canonical syntax serializes"),
			)
		});
		bytes.serialize(serializer)
	}
}

impl<'de> Deserialize<'de> for UnitSyntax {
	fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
		let encoded = String::deserialize(deserializer)?;
		let bytes = STANDARD
			.decode(&encoded)
			.map_err(serde::de::Error::custom)?;
		match bytes.first() {
			Some(&ARCHIVE_VERSION) => {},
			Some(_) => {
				return Err(serde::de::Error::custom("unsupported native syntax archive version"));
			},
			None => return Err(serde::de::Error::custom("empty native syntax archive")),
		}
		let Archive { offset, parent, context, kind, root, tree } =
			postcard::from_bytes(&bytes[1..]).map_err(serde::de::Error::custom)?;
		if root as usize >= tree.nodes.len() {
			return Err(serde::de::Error::custom("native syntax archive root out of range"));
		}
		let tree = SyntaxTree::new(tree, root, kind);
		Ok(Self {
			offset,
			parent,
			tree,
			context: Arc::new(context),
			archive: OnceLock::from(encoded),
		})
	}
}

impl UnitSyntax {
	/// The root kind of an archive in any version, this build's or not:
	/// every version starts with the same header (version, offset, parent,
	/// context) and then the root's kind, in this order of kinds. `None`
	/// when not even that decodes.
	pub(crate) fn archived_kind(encoded: &str) -> Option<RootKind> {
		#[derive(Deserialize)]
		struct Header {
			_version: u8,
			_offset:  u32,
			_parent:  Option<SourceParent>,
			_context: SyntaxContext,
			kind:     RootKind,
		}
		let bytes = STANDARD.decode(encoded).ok()?;
		postcard::take_from_bytes::<Header>(&bytes)
			.ok()
			.map(|(header, _)| header.kind)
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::bash::{
		ids::ModeId,
		syntax::{Features, Parser},
	};

	#[test]
	fn archive_round_trip_preserves_native_syntax_and_origin() {
		let source = b"f() { printf '%s' \"$1\"; }\n";
		let (syntax, _) = UnitSyntax::parse_boundary(source, Features::NONE.bits(), &[], 3).unwrap();
		let syntax = syntax.with_parent(SourceParent { unit: 2, node: 7, lo: 12, hi: 40 });
		let encoded = serde_json::to_string(&syntax).unwrap();
		let decoded: UnitSyntax = serde_json::from_str(&encoded).unwrap();
		assert_eq!(decoded, syntax);
		assert_eq!(serde_json::to_string(&decoded).unwrap(), encoded);
	}

	#[test]
	fn archive_rejects_unknown_version_before_decoding_a_tree() {
		let encoded = serde_json::to_string(&STANDARD.encode([ARCHIVE_VERSION + 1])).unwrap();
		let error = serde_json::from_str::<UnitSyntax>(&encoded).unwrap_err();
		assert!(
			error
				.to_string()
				.contains("unsupported native syntax archive version")
		);
	}

	#[test]
	fn deferred_definition_restores_real_alias_syntax_before_discarding_deferred_input() {
		struct Alias;
		impl syn::AliasLookup for Alias {
			fn alias(&self, name: &[u8]) -> Option<&[u8]> {
				(name == b"say").then_some(b"printf preserved".as_slice())
			}
		}
		let source = b"f() { say; }";
		let cc = Parser::new(source, Features::NONE, &Alias)
			.next_command()
			.unwrap()
			.unwrap();
		let deferred = ir::lower_deferred(&cc, source, ModeId::Bash, Features::NONE).unwrap();
		let saved = postcard::to_allocvec(deferred.funcs[0].body.as_ref()).unwrap();
		let restored: ir::Unit = postcard::from_bytes(&saved).unwrap();
		assert!(restored.trace_syntax.get().is_none());
		let observed = ir::materialize(&restored, true).unwrap();
		assert!(observed.trace_syntax.get().is_some());
		let unobserved = ir::materialize(&restored, false).unwrap();
		assert!(unobserved.trace_syntax.get().is_none());
		assert_eq!(observed.nodes, unobserved.nodes);
		assert_eq!(observed.id, unobserved.id);
		let archive = serde_json::to_string(observed.trace_syntax.get().unwrap().as_ref()).unwrap();
		let decoded: UnitSyntax = serde_json::from_str(&archive).unwrap();
		assert_eq!(&decoded, observed.trace_syntax.get().unwrap().as_ref());
	}
}
