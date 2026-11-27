//! Stack-safe pull evaluation.
//!
//! jaq evaluates a filter as a tree of producers.  Polling such a tree with
//! nested `Iterator::next` calls uses one native stack frame per nesting level,
//! which a deeply nested or recursive filter turns into a stack overflow.
//!
//! Instead, every producer is a [`Node`], a small state machine that the
//! [`Driver`] resumes.  The driver keeps the nesting in a heap `Vec` and hands
//! the terminal iterator one item at a time, so the native stack stays flat
//! however deep the filter recurses.  A logical depth limit turns unbounded
//! recursion into the same error a host would otherwise reach by exhausting
//! its stack.

use alloc::{boxed::Box, collections::VecDeque, rc::Rc, vec::Vec};
use core::cell::RefCell;

use crate::box_iter::BoxIter;

/// What a [`Node`] is resumed with.
pub enum Input<T> {
    /// Begin, or continue after this node yielded.
    Start,
    /// An item from the child this node descended into.
    Item(T),
    /// The child this node descended into is exhausted.
    End,
}

/// What a [`Node`] asks the [`Driver`] to do next.
pub enum Action<'a, T> {
    /// Output `T` to the consumer.
    Yield(T),
    /// Drive `child`, feeding this node each of its items and then [`Input::End`].
    Descend(Box<dyn Node<'a, T> + 'a>),
    /// Descend a tail call while retaining the previous body's remaining outputs.
    TailBranch(Box<dyn Node<'a, T> + 'a>),
    /// Drive the child this node descended into for its next item.
    Continue,
    /// Leave a replay source suspended and start its consumer.
    ReplayScope(Replay<T>, Box<dyn Node<'a,T> + 'a>, Box<dyn Node<'a,T> + 'a>),
    /// Read an indexed item from a replay source in this evaluation.
    Read(Replay<T>, usize),
    /// Stop the newest child and resume this node with `End`.
    Discard,
    /// Abandon the child this node last descended into and drive `child` instead.
    Replace(Box<dyn Node<'a, T> + 'a>),
    /// Replace this producer before it has children, without increasing depth.
    Install(Box<dyn Node<'a, T> + 'a>),
    /// This node is exhausted.
    Done,
}

/// A resumable producer over items of type `T`.
pub trait Node<'a, T> {
    /// Advance the node by one step.
    fn resume(&mut self, input: Input<T>) -> Action<'a, T>;

    /// Resume, indicating when an item is the child's final output.
    fn resume_item(&mut self, input: Input<T>, _last: bool) -> Action<'a,T> {
        self.resume(input)
    }

    /// Report whether this node just yielded its final output.
    fn last(&self, _child_last: bool) -> bool { false }
}

/// Construct the producer on first resume, without consuming a driver level.
pub fn lazy<'a, T: 'a>(f: impl FnOnce() -> Box<dyn Node<'a, T> + 'a> + 'a) -> Box<dyn Node<'a, T> + 'a> {
    Box::new(Lazy(Some(f)))
}

struct Lazy<F>(Option<F>);

impl<'a, T: 'a, F: FnOnce() -> Box<dyn Node<'a, T> + 'a>> Node<'a, T> for Lazy<F> {
    fn resume(&mut self, input: Input<T>) -> Action<'a, T> {
        debug_assert!(matches!(input, Input::Start));
        Action::Install(self.0.take().expect("lazy producer constructed twice")())
    }
}

/// A node that yields a single item.
pub struct Once<T>(Option<T>);

impl<T> Once<T> {
    /// Create a node yielding `item`.
    pub fn new(item: T) -> Self {
        Self(Some(item))
    }
}

impl<'a, T: 'a> Node<'a, T> for Once<T> {
    fn last(&self, _: bool) -> bool { self.0.is_none() }
    fn resume(&mut self, input: Input<T>) -> Action<'a, T> {
        match input {
            Input::Start => match self.0.take() {
                Some(x) => Action::Yield(x),
                None => Action::Done,
            },
            _ => Action::Done,
        }
    }
}

/// A node that yields nothing.
#[derive(Default)]
pub struct Empty;

impl<'a, T: 'a> Node<'a, T> for Empty {
    fn resume(&mut self, _input: Input<T>) -> Action<'a, T> {
        Action::Done
    }
}

/// A node over an existing iterator.
pub struct FromIter<'a, T>(BoxIter<'a, T>);

impl<'a, T> FromIter<'a, T> {
    /// Create a node yielding the items of `iter`.
    pub fn new(iter: BoxIter<'a, T>) -> Self {
        Self(iter)
    }
}

impl<'a, T: 'a> Node<'a, T> for FromIter<'a, T> {
    fn last(&self, _: bool) -> bool { self.0.size_hint().1 == Some(0) }
    fn resume(&mut self, input: Input<T>) -> Action<'a, T> {
        match input {
            Input::Start => match self.0.next() {
                Some(x) => Action::Yield(x),
                None => Action::Done,
            },
            _ => Action::Done,
        }
    }
}

/// Yield the items of each child in turn.
pub struct Concat<'a, T> {
    children: VecDeque<Box<dyn Node<'a, T> + 'a>>,
    active:   bool,
}

impl<'a, T: 'a> Concat<'a, T> {
    /// Create a node over `children`.
    pub fn new(children: impl IntoIterator<Item = Box<dyn Node<'a, T> + 'a>>) -> Self {
        Self { children: children.into_iter().collect(), active: false }
    }

    fn next_child(&mut self) -> Action<'a, T> {
        match self.children.pop_front() {
            Some(c) => {
                self.active = true;
                Action::Descend(c)
            },
            None => Action::Done,
        }
    }
}

impl<'a, T: 'a> Node<'a, T> for Concat<'a, T> {
    fn last(&self, child_last: bool) -> bool { child_last && self.children.is_empty() }
    fn resume(&mut self, input: Input<T>) -> Action<'a, T> {
        match input {
            Input::Start if !self.active => self.next_child(),
            Input::Start => Action::Continue,
            Input::Item(x) => Action::Yield(x),
            Input::End => {
                self.active = false;
                self.next_child()
            },
        }
    }
}

/// Apply `f` to every item of the child.
pub struct Map<'a, T, F> {
    child:   Box<dyn Node<'a, T> + 'a>,
    f:       F,
    started: bool,
}

impl<'a, T: 'a, F: FnMut(T) -> T + 'a> Map<'a, T, F> {
    /// Create a node mapping the items of `child` with `f`.
    pub fn new(child: Box<dyn Node<'a, T> + 'a>, f: F) -> Self {
        Self { child, f, started: false }
    }
}

impl<'a, T: 'a, F: FnMut(T) -> T + 'a> Node<'a, T> for Map<'a, T, F> {
    fn last(&self, child_last: bool) -> bool { child_last }
    fn resume(&mut self, input: Input<T>) -> Action<'a, T> {
        match input {
            Input::Start if !self.started => {
                self.started = true;
                Action::Descend(core::mem::replace(&mut self.child, Box::new(Empty)))
            },
            Input::Start => Action::Continue,
            Input::Item(x) => Action::Yield((self.f)(x)),
            Input::End => Action::Done,
        }
    }
}

/// For every item of the child, either drive a new node or forward an item.
pub struct FlatMap<'a, T, F> {
    child:   Box<dyn Node<'a, T> + 'a>,
    f:       F,
    started: bool,
    /// whether the currently driven child is the outer one
    outer:   bool,
    outer_last: bool,
}

impl<'a, T: 'a, F: FnMut(T) -> Result<Box<dyn Node<'a, T> + 'a>, T> + 'a> FlatMap<'a, T, F> {
    /// Create a node flat-mapping the items of `child` with `f`.
    pub fn new(child: Box<dyn Node<'a, T> + 'a>, f: F) -> Self {
        Self { child, f, started: false, outer: true, outer_last: false }
    }
}

impl<'a, T: 'a, F: FnMut(T) -> Result<Box<dyn Node<'a, T> + 'a>, T> + 'a> Node<'a, T> for FlatMap<'a, T, F> {
    fn last(&self, child_last: bool) -> bool { child_last && (self.outer || self.outer_last) }

    fn resume(&mut self, input: Input<T>) -> Action<'a, T> { self.resume_item(input,false) }

    fn resume_item(&mut self, input: Input<T>, last: bool) -> Action<'a, T> {
        match input {
            Input::Start if !self.started => {
                self.started = true;
                self.outer = true;
                Action::Descend(core::mem::replace(&mut self.child, Box::new(Empty)))
            },
            Input::Start => Action::Continue,
            Input::Item(x) if self.outer => {
                self.outer_last = last;
                match (self.f)(x) {
                    Ok(child) => { self.outer = false; Action::Descend(child) },
                    Err(x) => Action::Yield(x),
                }
            },
            Input::Item(x) => Action::Yield(x),
            Input::End if self.outer => Action::Done,
            Input::End => {
                self.outer = true;
                Action::Continue
            },
        }
    }
}

/// `l // r`: yield the truthy items of `l`, or all items of `r` if `l` has none.
pub struct Alt<'a, T> {
    l:       Box<dyn Node<'a, T> + 'a>,
    r:       Option<Box<dyn Node<'a, T> + 'a>>,
    truthy:  fn(&T) -> bool,
    started: bool,
    seen:    bool,
    in_r:    bool,
}

impl<'a, T> Alt<'a, T> {
    /// Create an alternatives node from a truthy predicate and two children.
    pub fn new(
        l: Box<dyn Node<'a, T> + 'a>,
        r: Box<dyn Node<'a, T> + 'a>,
        truthy: fn(&T) -> bool,
    ) -> Self {
        Self { l, r: Some(r), truthy, started: false, seen: false, in_r: false }
    }
}

impl<'a, T: 'a> Node<'a, T> for Alt<'a, T> {
    fn last(&self, child_last: bool) -> bool { child_last && (self.seen || self.in_r) }
    fn resume(&mut self, input: Input<T>) -> Action<'a, T> {
        match input {
            Input::Start if !self.started => {
                self.started = true;
                Action::Descend(core::mem::replace(&mut self.l, Box::new(Empty)))
            },
            Input::Start => Action::Continue,
            Input::Item(x) if self.in_r => Action::Yield(x),
            Input::Item(x) if (self.truthy)(&x) => {
                self.seen = true;
                Action::Yield(x)
            },
            Input::Item(_) => Action::Continue,
            Input::End if self.seen || self.in_r => Action::Done,
            Input::End => {
                self.in_r = true;
                Action::Descend(self.r.take().expect("alt has no right child"))
            },
        }
    }
}

/// Cache for a producer shared by the branches of one resumable fold.
pub struct Replay<T>(Rc<RefCell<ReplayState<T>>>);

struct ReplayState<T> {
    frame: Option<usize>,
    items: Vec<T>,
    done: bool,
    waiter: Option<(usize, usize)>,
    copy: fn(&T) -> T,
}

impl<T> Clone for Replay<T> {
    fn clone(&self) -> Self { Self(self.0.clone()) }
}

impl<T> Replay<T> {
    /// Create an empty cache, with a copy operation for its items.
    pub fn new(copy: fn(&T) -> T) -> Self {
        Self(Rc::new(RefCell::new(ReplayState { frame: None, items: Vec::new(), done: false, waiter: None, copy })))
    }
}

/// Drive a producer lazily on behalf of one or more consuming branches.
pub fn with_replay<'a, T: 'a>(replay: Replay<T>, source: Box<dyn Node<'a,T> + 'a>, body: Box<dyn Node<'a,T> + 'a>) -> Box<dyn Node<'a,T> + 'a> {
    struct Scope<'a,T>(Option<(Replay<T>, Box<dyn Node<'a,T> + 'a>, Box<dyn Node<'a,T> + 'a>)>);
    impl<'a,T: 'a> Node<'a,T> for Scope<'a,T> {
        fn resume(&mut self, input: Input<T>) -> Action<'a,T> {
            match input {
                Input::Start => self.0.take().map_or(Action::Continue, |(r,xs,body)| Action::ReplayScope(r,xs,body)),
                Input::Item(x) => Action::Yield(x),
                Input::End => Action::Done,
            }
        }
    }
    Box::new(Scope(Some((replay, source, body))))
}

struct Frame<'a, T> {
    node: Box<dyn Node<'a, T> + 'a>,
    parent: usize,
    depth: usize,
    replay: Option<Replay<T>>,
    children: Vec<usize>,
}

/// Drives a tree of [`Node`]s on the heap, yielding one item at a time.
pub struct Driver<'a, T> {
    frames: Vec<Option<Frame<'a, T>>>,
    free: Vec<usize>,
    discard: Vec<usize>,
    active: usize,
    limit: usize,
    replay_offset: usize,
    too_deep: fn() -> T,
    done: bool,
}

impl<'a, T: 'a> Driver<'a, T> {
    /// Create a driver over the root node.
    pub fn new(root: Box<dyn Node<'a, T> + 'a>, too_deep: fn() -> T, limit: usize) -> Self {
        Self {
            frames: Vec::from([Some(Frame { node: root, parent: 0, depth: 0, replay: None, children: Vec::new() })]),
            free: Vec::new(),
            discard: Vec::new(),
            active: 0,
            limit,
            replay_offset: 0,
            too_deep,
            done: false,
        }
    }

    fn frame(&mut self, id: usize) -> &mut Frame<'a, T> {
        self.frames[id].as_mut().unwrap()
    }

    fn descend(&mut self, parent: usize, node: Box<dyn Node<'a, T> + 'a>) -> usize {
        let depth = self.frame(parent).depth + 1;
        self.descend_at(parent, depth, node)
    }

    fn descend_at(&mut self, parent: usize, depth: usize, node: Box<dyn Node<'a, T> + 'a>) -> usize {
        let node: Box<dyn Node<'a, T> + 'a> = if depth + self.replay_offset >= self.limit {
            Box::new(Once::new((self.too_deep)()))
        } else {
            node
        };
        let frame = Some(Frame { node, parent, depth, replay: None, children: Vec::new() });
        let child = if let Some(child) = self.free.pop() {
            self.frames[child] = frame;
            child
        } else {
            let child = self.frames.len();
            self.frames.push(frame);
            child
        };
        self.frame(parent).children.push(child);
        child
    }

    fn discard(&mut self, id: usize) {
        self.discard.push(id);
        while let Some(id) = self.discard.pop() {
            let frame = self.frames[id].take().unwrap();
            self.discard.extend(frame.children);
            self.free.push(id);
        }
    }

    /// Produce the next item, or `None` once the root is exhausted.
    pub fn next(&mut self) -> Option<T> {
        if self.done {
            return None;
        }
        let mut input = Input::Start;
        let mut last = false;
        loop {
            let i = self.active;
            let child_last = core::mem::take(&mut last);
            let action = self.frame(i).node.resume_item(input, child_last);
            match action {
                Action::Done => {
                    if i == 0 {
                        self.done = true;
                        self.discard(i);
                        return None;
                    }
                    let p = self.frame(i).parent;
                    let siblings = &mut self.frame(p).children;
                    if siblings.last() == Some(&i) {
                        siblings.pop();
                    } else {
                        debug_assert_eq!(siblings.first(), Some(&i));
                        siblings.remove(0);
                    }
                    let target = if let Some(replay) = self.frame(i).replay.take() {
                        let mut replay = replay.0.borrow_mut();
                        replay.done = true;
                        let (waiter, offset) = replay.waiter.take().unwrap();
                        self.replay_offset = offset;
                        waiter
                    } else { p };
                    self.discard(i);
                    self.active = target;
                    input = Input::End;
                },
                Action::Yield(x) if i == 0 => return Some(x),
                Action::Yield(x) => {
                    last = self.frame(i).node.last(child_last);
                    let frame = self.frames[i].as_ref().unwrap();
                    self.active = if let Some(replay) = &frame.replay {
                        let mut replay = replay.0.borrow_mut();
                        let saved = (replay.copy)(&x);
                        replay.items.push(saved);
                        let (waiter, offset) = replay.waiter.take().unwrap();
                        self.replay_offset = offset;
                        waiter
                    } else { frame.parent };
                    input = Input::Item(x);
                },
                Action::Continue => {
                    self.active = *self.frame(i).children.last().expect("node continued without a child");
                    input = Input::Start;
                },
                Action::ReplayScope(replay, source, body) => {
                    let source = self.descend(i, source);
                    replay.0.borrow_mut().frame = Some(source);
                    self.frame(source).replay = Some(replay);
                    self.active = self.descend(i, body);
                    input = Input::Start;
                },
                Action::Read(replay, pos) => {
                    let mut replay = replay.0.borrow_mut();
                    input = if let Some(x) = replay.items.get(pos) {
                        Input::Item((replay.copy)(x))
                    } else if replay.done {
                        Input::End
                    } else {
                        debug_assert_eq!(pos, replay.items.len());
                        let source = replay.frame.unwrap();
                        let offset = (self.frame(i).depth + 1).saturating_sub(self.frame(source).depth);
                        if self.frame(source).depth + offset + self.replay_offset >= self.limit {
                            Input::Item((self.too_deep)())
                        } else {
                            assert!(replay.waiter.replace((i, self.replay_offset)).is_none());
                            self.replay_offset += offset;
                            self.active = source;
                            Input::Start
                        }
                    };
                },
                Action::Descend(child) => {
                    self.active = self.descend(i, child);
                    input = Input::Start;
                },
                Action::Install(node) => {
                    let frame = self.frame(i);
                    debug_assert!(frame.children.is_empty());
                    frame.node = node;
                    input = Input::Start;
                },
                Action::TailBranch(child) => {
                    let suspended = *self.frame(i).children.last().expect("tail call without a child");
                    let depth = self.frame(suspended).depth + 1;
                    self.active = self.descend_at(i, depth, child);
                    input = Input::Start;
                },
                Action::Replace(child) => {
                    let old = self.frame(i).children.pop().expect("node replaced without a child");
                    let depth = self.frame(old).depth;
                    self.discard(old);
                    self.active = self.descend_at(i, depth, child);
                    input = Input::Start;
                },
                Action::Discard => {
                    let old = self.frame(i).children.pop().expect("node discarded without a child");
                    self.discard(old);
                    input = Input::End;
                },
            }
        }
    }
}

#[test]
fn lazy_construction_preserves_driver_depth() {
    let items = [lazy(|| Box::new(Once::new(1))), lazy(|| Box::new(Once::new(2)))];
    let mut out = pull(Box::new(Concat::new(items)), || 99, 2);
    assert_eq!(out.next(), Some(1));
    assert_eq!(out.next(), Some(2));
    assert_eq!(out.next(), None);
}

/// The terminal iterator driving a [`Driver`].
pub struct Pull<'a, T>(Driver<'a, T>);

impl<'a, T: 'a> Iterator for Pull<'a, T> {
    type Item = T;

    fn next(&mut self) -> Option<T> {
        self.0.next()
    }
}

/// Wrap `root` into an iterator driven on the heap.
pub fn pull<'a, T: 'a>(
    root: Box<dyn Node<'a, T> + 'a>,
    too_deep: fn() -> T,
    limit: usize,
) -> Pull<'a, T> {
    Pull(Driver::new(root, too_deep, limit))
}
