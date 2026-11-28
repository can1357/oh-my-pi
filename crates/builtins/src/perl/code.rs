//! Code referents and prototypes, as described in perlsub and perlref.

use std::{cell::RefCell, rc::Rc};

use super::{interp::{NativeFn, PerlBody}, value::{PStr, Value}};

/// Identity shared by all references to one Perl subroutine.
pub(in crate::perl) type Cv = Rc<CodeBody>;

/// A Perl subroutine's declaration, implementation, and reference metadata.
pub(in crate::perl) struct CodeBody {
	/// Fully qualified name, or `None` for an anonymous subroutine.
	pub name: RefCell<Option<Rc<str>>>,
	/// Package the subroutine was compiled in.
	pub pkg: Rc<str>,
	/// Optional call-site prototype.
	pub prototype: RefCell<Option<PStr>>,
	/// Current definition, which can change after declaration.
	pub body: RefCell<CodeImpl>,
	/// Class of a blessed code reference.
	pub blessed: RefCell<Option<Rc<str>>>,
}

/// The current implementation of a subroutine.
#[derive(Clone)]
pub(in crate::perl) enum CodeImpl {
	/// Declared, but not defined.
	Undefined,
	/// An AST body and its lexical environment.
	Perl(Rc<PerlBody>),
	/// A native implementation accepting aliased arguments.
	Native(NativeFn),
	/// A compile-time constant subroutine.
	Constant(Rc<[Value]>),
}
