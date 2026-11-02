//! Clones and drops expression trees of any depth on a bounded stack.
//!
//! The expression grammars apply a left-associative operator in a loop, but the tree they
//! build for `a && b && c && …` or `1 + 1 + 1 + …` is as deep as the chain is long. A
//! derived `Clone` or the compiler's drop glue walks such a tree with one stack frame per
//! operator, and a chain of a few thousand operators runs off the end of a thread's stack.
//! These walks recurse over the first levels of a tree, as fast as the derived walks over the
//! small trees everyday expressions make, and keep whatever lies deeper in a heap-allocated
//! list, so a deep tree costs memory, not stack.

/// How many levels a walk recurses before it continues from a list of pending subtrees.
const RECURSION_LIMIT: usize = 16;

/// A tree node whose children are boxed nodes of the same type.
pub(super) trait BoxedTree: Sized {
    /// A node without children, whose construction allocates nothing. Stands in for a
    /// child while the child is being cloned or dropped.
    fn placeholder() -> Self;

    /// The left operand, when the node is a left-associative binary operator.
    fn left_operand(&self) -> Option<&Self>;

    /// The node's boxed children.
    fn children(&self) -> [Option<&Self>; 3];

    /// The node's boxed children, mutably.
    fn children_mut(&mut self) -> [Option<&mut Self>; 3];

    /// A copy of the node whose children are made by `clone_child`, in order.
    fn clone_with(&self, clone_child: impl FnMut(&Self) -> Self) -> Self;
}

fn has_children<T: BoxedTree>(node: &T) -> bool {
    node.children().iter().any(Option::is_some)
}

/// Clones `node` and every node below it.
pub(super) fn clone_tree<T: BoxedTree>(node: &T) -> T {
    clone_within(node, RECURSION_LIMIT)
}

fn clone_within<T: BoxedTree>(node: &T, levels: usize) -> T {
    if levels == 0 {
        return clone_iteratively(node);
    }
    node.clone_with(|child| clone_within(child, levels - 1))
}

#[cold]
#[inline(never)]
fn clone_iteratively<T: BoxedTree>(root: &T) -> T {
    let mut copy = root.clone_with(|_| T::placeholder());
    {
        let mut pending = Pending::new();
        pair_children(root, &mut copy, &mut pending);
        while let Some((source, target)) = pending.pop() {
            *target = source.clone_with(|_| T::placeholder());
            pair_children(source, target, &mut pending);
        }
    }
    copy
}

/// Fills in the placeholders of `target`, a copy of `source` without children: a child
/// without children of its own is copied at once, and any other is left for the caller.
fn pair_children<'s, 't, T: BoxedTree>(
    source: &'s T,
    target: &'t mut T,
    pending: &mut Pending<(&'s T, &'t mut T)>,
) {
    for (source, target) in source.children().into_iter().zip(target.children_mut()) {
        if let (Some(source), Some(target)) = (source, target) {
            if has_children(source) {
                pending.push((source, target));
            } else {
                *target = source.clone_with(|_| T::placeholder());
            }
        }
    }
}

/// Prepares `node` for its drop glue.
///
/// The glue frees the small trees everyday expressions make faster than any walk, so a node is
/// taken apart here only when it heads a chain of at least `RECURSION_LIMIT` left-associative
/// operators, each the left operand of the next: the chain the grammars build in a loop, and so
/// grow without bound. Every other path down the tree passes through nesting the grammars build
/// by recursion, and parsing a level of nesting costs more stack than dropping it.
#[inline]
pub(super) fn drop_children<T: BoxedTree>(node: &mut T) {
    if heads_long_chain(node) {
        drop_children_iteratively(node);
    }
}

/// Whether `node` heads a chain of at least `RECURSION_LIMIT` left-associative operators.
#[inline]
fn heads_long_chain<T: BoxedTree>(node: &T) -> bool {
    let mut node = node;
    for _ in 0..RECURSION_LIMIT {
        match node.left_operand() {
            Some(left) => node = left,
            None => return false,
        }
    }
    true
}

#[cold]
#[inline(never)]
fn drop_children_iteratively<T: BoxedTree>(node: &mut T) {
    let mut pending = Pending::new();
    take_children(node, &mut pending);
    while let Some(mut subtree) = pending.pop() {
        take_children(&mut subtree, &mut pending);
    }
}

/// Moves each child of `node` that has children of its own into `pending`.
fn take_children<T: BoxedTree>(node: &mut T, pending: &mut Pending<T>) {
    for child in node.children_mut().into_iter().flatten() {
        if has_children(child) {
            pending.push(std::mem::replace(child, T::placeholder()));
        }
    }
}

/// Work left by a walk: the subtree to visit next, and the rest.
///
/// A chain of left-associative operators has one child with children of its own per node, so
/// the walk visits it through `next` alone and never allocates the list.
struct Pending<T> {
    next: Option<T>,
    rest: Vec<T>,
}

impl<T> Pending<T> {
    const fn new() -> Self {
        Self {
            next: None,
            rest: Vec::new(),
        }
    }

    fn push(&mut self, item: T) {
        if self.next.is_none() {
            self.next = Some(item);
        } else {
            self.rest.push(item);
        }
    }

    fn pop(&mut self) -> Option<T> {
        self.next.take().or_else(|| self.rest.pop())
    }
}
