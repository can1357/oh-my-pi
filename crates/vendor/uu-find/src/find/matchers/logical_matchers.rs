// Copyright 2017 Google Inc.
//
// Use of this source code is governed by a MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.

//! This modules contains the matchers used for combining other matchers and
//! performing boolean logic on them (and a couple of trivial always-true and
//! always-false matchers). The design is strongly tied to the precedence rules
//! when parsing command-line options (e.g. "-foo -o -bar -baz" is equivalent
//! to "-foo -o ( -bar -baz )", not "( -foo -o -bar ) -baz").
use std::{error::Error, path::Path};

use super::{Matcher, MatcherIO, WalkEntry};

/// This matcher contains a collection of other matchers. A file only matches
/// if it matches ALL the contained sub-matchers. For sub-matchers that have
/// side effects, the side effects occur in the same order as the sub-matchers
/// were pushed into the collection.
pub struct AndMatcher {
	submatchers: Vec<Box<dyn Matcher>>,
}

impl AndMatcher {
	pub fn new(submatchers: Vec<Box<dyn Matcher>>) -> Self {
		Self { submatchers }
	}
}

impl Matcher for AndMatcher {
	/// Returns true if all sub-matchers return true. Short-circuiting does take
	/// place. If the nth sub-matcher returns false, then we immediately return
	/// and don't make any further calls.
	fn matches(&self, dir_entry: &WalkEntry, matcher_io: &mut MatcherIO) -> bool {
		for matcher in &self.submatchers {
			if !matcher.matches(dir_entry, matcher_io) {
				return false;
			}
			if matcher_io.should_quit() {
				break;
			}
		}

		true
	}

	fn has_side_effects(&self) -> bool {
		self
			.submatchers
			.iter()
			.any(super::Matcher::has_side_effects)
	}

	fn finished_dir(&self, dir: &Path, matcher_io: &mut MatcherIO) {
		for m in &self.submatchers {
			m.finished_dir(dir, matcher_io);
		}
	}

	fn finished(&self, matcher_io: &mut MatcherIO) {
		for m in &self.submatchers {
			m.finished(matcher_io);
		}
	}
}

pub struct AndMatcherBuilder {
	submatchers: Vec<Box<dyn Matcher>>,
}

impl AndMatcherBuilder {
	pub fn new() -> Self {
		Self { submatchers: Vec::new() }
	}

	pub fn new_and_condition(&mut self, matcher: impl Matcher) {
		self.submatchers.push(matcher.into_box());
	}

	/// Builds a Matcher: consuming the builder in the process.
	pub fn build(mut self) -> Box<dyn Matcher> {
		// special case. If there's only one submatcher, just return that directly
		if self.submatchers.len() == 1 {
			// safe to unwrap: we've just checked the size
			return self.submatchers.pop().unwrap();
		}
		AndMatcher::new(self.submatchers).into_box()
	}
}

/// This matcher contains a collection of other matchers. A file matches
/// if it matches any of the contained sub-matchers. For sub-matchers that have
/// side effects, the side effects occur in the same order as the sub-matchers
/// were pushed into the collection.
pub struct OrMatcher {
	submatchers: Vec<Box<dyn Matcher>>,
}

impl OrMatcher {
	pub fn new(submatchers: Vec<Box<dyn Matcher>>) -> Self {
		Self { submatchers }
	}
}

impl Matcher for OrMatcher {
	/// Returns true if any sub-matcher returns true. Short-circuiting does take
	/// place. If the nth sub-matcher returns true, then we immediately return
	/// and don't make any further calls.
	fn matches(&self, dir_entry: &WalkEntry, matcher_io: &mut MatcherIO) -> bool {
		for matcher in &self.submatchers {
			if matcher.matches(dir_entry, matcher_io) {
				return true;
			}
			if matcher_io.should_quit() {
				break;
			}
		}

		false
	}

	fn has_side_effects(&self) -> bool {
		self
			.submatchers
			.iter()
			.any(super::Matcher::has_side_effects)
	}

	fn finished_dir(&self, dir: &Path, matcher_io: &mut MatcherIO) {
		for m in &self.submatchers {
			m.finished_dir(dir, matcher_io);
		}
	}

	fn finished(&self, matcher_io: &mut MatcherIO) {
		for m in &self.submatchers {
			m.finished(matcher_io);
		}
	}
}

pub struct OrMatcherBuilder {
	submatchers: Vec<AndMatcherBuilder>,
}

impl OrMatcherBuilder {
	pub fn new_and_condition(&mut self, matcher: impl Matcher) {
		// safe to unwrap. submatchers always has at least one member
		self
			.submatchers
			.last_mut()
			.unwrap()
			.new_and_condition(matcher);
	}

	pub fn new_or_condition(&mut self, arg: &str) -> Result<(), Box<dyn Error>> {
		if self.submatchers.last().unwrap().submatchers.is_empty() {
			return Err(From::from(format!(
				"invalid expression; you have used a binary operator '{arg}' with nothing before it."
			)));
		}
		self.submatchers.push(AndMatcherBuilder::new());
		Ok(())
	}

	pub fn new() -> Self {
		let mut o = Self { submatchers: Vec::new() };
		o.submatchers.push(AndMatcherBuilder::new());
		o
	}

	/// Builds a Matcher: consuming the builder in the process.
	pub fn build(mut self) -> Box<dyn Matcher> {
		// Special case: if there's only one submatcher, just return that directly
		if self.submatchers.len() == 1 {
			// safe to unwrap: we've just checked the size
			return self.submatchers.pop().unwrap().build();
		}
		let mut submatchers = vec![];
		for x in self.submatchers {
			submatchers.push(x.build());
		}
		OrMatcher::new(submatchers).into_box()
	}
}

/// This matcher contains a collection of other matchers. In contrast to
/// `OrMatcher` and `AndMatcher`, all the submatcher objects are called
/// regardless of the results of previous submatchers. This is primarily used
/// for submatchers with side-effects. For such sub-matchers the side effects
/// occur in the same order as the sub-matchers were pushed into the collection.
pub struct ListMatcher {
	submatchers: Vec<Box<dyn Matcher>>,
}

impl ListMatcher {
	pub fn new(submatchers: Vec<Box<dyn Matcher>>) -> Self {
		Self { submatchers }
	}
}

impl Matcher for ListMatcher {
	/// Calls matches on all submatcher objects, with no short-circuiting.
	/// Returns the result of the call to the final submatcher
	fn matches(&self, dir_entry: &WalkEntry, matcher_io: &mut MatcherIO) -> bool {
		let mut rc = false;
		for matcher in &self.submatchers {
			rc = matcher.matches(dir_entry, matcher_io);
			if matcher_io.should_quit() {
				break;
			}
		}
		rc
	}

	fn has_side_effects(&self) -> bool {
		self
			.submatchers
			.iter()
			.any(super::Matcher::has_side_effects)
	}

	fn finished_dir(&self, dir: &Path, matcher_io: &mut MatcherIO) {
		for m in &self.submatchers {
			m.finished_dir(dir, matcher_io);
		}
	}

	fn finished(&self, matcher_io: &mut MatcherIO) {
		for m in &self.submatchers {
			m.finished(matcher_io);
		}
	}
}

pub struct ListMatcherBuilder {
	submatchers: Vec<OrMatcherBuilder>,
}

impl ListMatcherBuilder {
	pub fn new_and_condition(&mut self, matcher: impl Matcher) {
		// safe to unwrap. submatchers always has at least one member
		self
			.submatchers
			.last_mut()
			.unwrap()
			.new_and_condition(matcher);
	}

	pub fn new_or_condition(&mut self, arg: &str) -> Result<(), Box<dyn Error>> {
		self.submatchers.last_mut().unwrap().new_or_condition(arg)
	}

	pub fn check_new_and_condition(&mut self) -> Result<(), Box<dyn Error>> {
		{
			let child_or_matcher = &self.submatchers.last().unwrap();
			let grandchild_and_matcher = &child_or_matcher.submatchers.last().unwrap();

			if grandchild_and_matcher.submatchers.is_empty() {
				return Err(From::from(
					"invalid expression; you have used a binary operator '-a' with nothing before it.",
				));
			}
		}
		Ok(())
	}

	pub fn new_list_condition(&mut self) -> Result<(), Box<dyn Error>> {
		{
			let child_or_matcher = &self.submatchers.last().unwrap();
			let grandchild_and_matcher = &child_or_matcher.submatchers.last().unwrap();

			if grandchild_and_matcher.submatchers.is_empty() {
				return Err(From::from(
					"invalid expression; you have used a binary operator ',' with nothing before it.",
				));
			}
		}
		self.submatchers.push(OrMatcherBuilder::new());
		Ok(())
	}

	pub fn new() -> Self {
		let mut o = Self { submatchers: Vec::new() };
		o.submatchers.push(OrMatcherBuilder::new());
		o
	}

	/// Builds a Matcher: consuming the builder in the process.
	pub fn build(mut self) -> Box<dyn Matcher> {
		// Special case: if there's only one submatcher, just return that directly
		if self.submatchers.len() == 1 {
			// safe to unwrap: we've just checked the size
			return self.submatchers.pop().unwrap().build();
		}
		let mut submatchers = vec![];
		for x in self.submatchers {
			submatchers.push(x.build());
		}
		Box::new(ListMatcher::new(submatchers))
	}
}

/// A simple matcher that always matches.
pub struct TrueMatcher;

impl Matcher for TrueMatcher {
	fn matches(&self, _dir_entry: &WalkEntry, _: &mut MatcherIO) -> bool {
		true
	}
}

/// A simple matcher that never matches.
pub struct FalseMatcher;

impl Matcher for FalseMatcher {
	fn matches(&self, _dir_entry: &WalkEntry, _: &mut MatcherIO) -> bool {
		false
	}
}

/// Matcher that wraps another matcher and inverts matching criteria.
pub struct NotMatcher {
	submatcher: Box<dyn Matcher>,
}

impl NotMatcher {
	pub fn new(submatcher: impl Matcher) -> Self {
		Self { submatcher: submatcher.into_box() }
	}
}

impl Matcher for NotMatcher {
	fn matches(&self, dir_entry: &WalkEntry, matcher_io: &mut MatcherIO) -> bool {
		!self.submatcher.matches(dir_entry, matcher_io)
	}

	fn has_side_effects(&self) -> bool {
		self.submatcher.has_side_effects()
	}

	fn finished_dir(&self, dir: &Path, matcher_io: &mut MatcherIO) {
		self.submatcher.finished_dir(dir, matcher_io);
	}

	fn finished(&self, matcher_io: &mut MatcherIO) {
		self.submatcher.finished(matcher_io);
	}
}

#[cfg(test)]
mod tests {
	use std::{cell::RefCell, rc::Rc};

	use super::*;
	use crate::find::{
		matchers::{quit::QuitMatcher, tests::get_dir_entry_for},
		tests::FakeDependencies,
	};

	/// Simple Matcher impl that has side effects
	pub struct HasSideEffects;

	impl Matcher for HasSideEffects {
		fn matches(&self, _: &WalkEntry, _: &mut MatcherIO) -> bool {
			false
		}

		fn has_side_effects(&self) -> bool {
			true
		}
	}

	/// Matcher that counts its invocations
	struct Counter(Rc<RefCell<u32>>);

	impl Matcher for Counter {
		fn matches(&self, _: &WalkEntry, _: &mut MatcherIO) -> bool {
			*self.0.borrow_mut() += 1;
			true
		}
	}

	#[test]
	fn and_matches_works() {
		let abbbc = get_dir_entry_for("test_data/simple", "abbbc");
		let mut builder = AndMatcherBuilder::new();
		let deps = FakeDependencies::new();

		// start with one matcher returning true
		builder.new_and_condition(TrueMatcher);
		assert!(builder.build().matches(&abbbc, &mut deps.new_matcher_io()));

		builder = AndMatcherBuilder::new();
		builder.new_and_condition(TrueMatcher);
		builder.new_and_condition(FalseMatcher);
		assert!(!builder.build().matches(&abbbc, &mut deps.new_matcher_io()));
	}

	#[test]
	fn or_matches_works() {
		let abbbc = get_dir_entry_for("test_data/simple", "abbbc");
		let mut builder = OrMatcherBuilder::new();
		let deps = FakeDependencies::new();

		// start with one matcher returning false
		builder.new_and_condition(FalseMatcher);
		assert!(!builder.build().matches(&abbbc, &mut deps.new_matcher_io()));

		let mut builder = OrMatcherBuilder::new();
		builder.new_and_condition(FalseMatcher);
		builder.new_or_condition("-o").unwrap();
		builder.new_and_condition(TrueMatcher);
		assert!(builder.build().matches(&abbbc, &mut deps.new_matcher_io()));
	}

	#[test]
	fn list_matches_works() {
		let abbbc = get_dir_entry_for("test_data/simple", "abbbc");
		let mut builder = ListMatcherBuilder::new();
		let deps = FakeDependencies::new();

		// result should always match that of the last pushed submatcher
		builder.new_and_condition(FalseMatcher);
		assert!(!builder.build().matches(&abbbc, &mut deps.new_matcher_io()));

		builder = ListMatcherBuilder::new();
		builder.new_and_condition(FalseMatcher);
		builder.new_list_condition().unwrap();
		builder.new_and_condition(TrueMatcher);
		assert!(builder.build().matches(&abbbc, &mut deps.new_matcher_io()));

		builder = ListMatcherBuilder::new();
		builder.new_and_condition(FalseMatcher);
		builder.new_list_condition().unwrap();
		builder.new_and_condition(TrueMatcher);
		builder.new_list_condition().unwrap();
		builder.new_and_condition(FalseMatcher);
		assert!(!builder.build().matches(&abbbc, &mut deps.new_matcher_io()));
	}

	#[test]
	fn true_matches_works() {
		let abbbc = get_dir_entry_for("test_data/simple", "abbbc");
		let matcher = TrueMatcher {};
		let deps = FakeDependencies::new();

		assert!(matcher.matches(&abbbc, &mut deps.new_matcher_io()));
	}

	#[test]
	fn false_matches_works() {
		let abbbc = get_dir_entry_for("test_data/simple", "abbbc");
		let matcher = FalseMatcher {};
		let deps = FakeDependencies::new();

		assert!(!matcher.matches(&abbbc, &mut deps.new_matcher_io()));
	}

	#[test]
	fn and_has_side_effects_works() {
		let mut builder = AndMatcherBuilder::new();

		// start with one matcher with no side effects false
		builder.new_and_condition(TrueMatcher);
		assert!(!builder.build().has_side_effects());

		builder = AndMatcherBuilder::new();
		builder.new_and_condition(TrueMatcher);
		builder.new_and_condition(HasSideEffects);
		assert!(builder.build().has_side_effects());
	}

	#[test]
	fn or_has_side_effects_works() {
		let mut builder = OrMatcherBuilder::new();

		// start with one matcher with no side effects false
		builder.new_and_condition(TrueMatcher);
		assert!(!builder.build().has_side_effects());

		builder = OrMatcherBuilder::new();
		builder.new_and_condition(TrueMatcher);
		builder.new_and_condition(HasSideEffects);
		assert!(builder.build().has_side_effects());
	}

	#[test]
	fn list_has_side_effects_works() {
		let mut builder = ListMatcherBuilder::new();

		// start with one matcher with no side effects false
		builder.new_and_condition(TrueMatcher);
		assert!(!builder.build().has_side_effects());

		builder = ListMatcherBuilder::new();
		builder.new_and_condition(TrueMatcher);
		builder.new_and_condition(HasSideEffects);
		assert!(builder.build().has_side_effects());
	}

	#[test]
	fn true_has_side_effects_works() {
		let matcher = TrueMatcher {};
		assert!(!matcher.has_side_effects());
	}

	#[test]
	fn false_has_side_effects_works() {
		let matcher = FalseMatcher {};
		assert!(!matcher.has_side_effects());
	}

	#[test]
	fn not_matches_works() {
		let abbbc = get_dir_entry_for("test_data/simple", "abbbc");
		let not_true = NotMatcher::new(TrueMatcher);
		let not_false = NotMatcher::new(FalseMatcher);
		let deps = FakeDependencies::new();
		assert!(!not_true.matches(&abbbc, &mut deps.new_matcher_io()));
		assert!(not_false.matches(&abbbc, &mut deps.new_matcher_io()));
	}

	#[test]
	fn not_has_side_effects_works() {
		let has_fx = NotMatcher::new(HasSideEffects);
		let has_no_fx = NotMatcher::new(FalseMatcher);
		assert!(has_fx.has_side_effects());
		assert!(!has_no_fx.has_side_effects());
	}

	#[test]
	fn and_quit_works() {
		let abbbc = get_dir_entry_for("test_data/simple", "abbbc");
		let mut builder = AndMatcherBuilder::new();
		let deps = FakeDependencies::new();

		let before = Rc::new(RefCell::new(0));
		let after = Rc::new(RefCell::new(0));
		builder.new_and_condition(Counter(before.clone()));
		builder.new_and_condition(QuitMatcher);
		builder.new_and_condition(Counter(after.clone()));
		builder.build().matches(&abbbc, &mut deps.new_matcher_io());

		assert_eq!(*before.borrow(), 1);
		assert_eq!(*after.borrow(), 0);
	}

	#[test]
	fn or_quit_works() {
		let abbbc = get_dir_entry_for("test_data/simple", "abbbc");
		let mut builder = OrMatcherBuilder::new();
		let deps = FakeDependencies::new();

		let before = Rc::new(RefCell::new(0));
		let after = Rc::new(RefCell::new(0));
		builder.new_and_condition(Counter(before.clone()));
		builder.new_or_condition("-o").unwrap();
		builder.new_and_condition(QuitMatcher);
		builder.new_or_condition("-o").unwrap();
		builder.new_and_condition(Counter(after.clone()));
		builder.build().matches(&abbbc, &mut deps.new_matcher_io());

		assert_eq!(*before.borrow(), 1);
		assert_eq!(*after.borrow(), 0);
	}

	#[test]
	fn list_quit_works() {
		let abbbc = get_dir_entry_for("test_data/simple", "abbbc");
		let mut builder = ListMatcherBuilder::new();
		let deps = FakeDependencies::new();

		let before = Rc::new(RefCell::new(0));
		let after = Rc::new(RefCell::new(0));
		builder.new_and_condition(Counter(before.clone()));
		builder.new_list_condition().unwrap();
		builder.new_and_condition(QuitMatcher);
		builder.new_list_condition().unwrap();
		builder.new_and_condition(Counter(after.clone()));
		builder.build().matches(&abbbc, &mut deps.new_matcher_io());

		assert_eq!(*before.borrow(), 1);
		assert_eq!(*after.borrow(), 0);
	}
}
