/// A persistent, shareable list of keys or filter bindings.
#[derive(Debug, PartialEq, Eq)]
pub struct List<T>(Option<alloc::rc::Rc<Node<T>>>);

#[derive(Clone, Debug, PartialEq, Eq)]
enum Node<T> {
    Cons(T, List<T>),
    /// a path that the value it belongs to is not at, see [`List::invalid`]
    Invalid,
}

impl<T> Clone for List<T> {
    fn clone(&self) -> Self {
        Self(self.0.clone())
    }
}

impl<T> Default for List<T> {
    fn default() -> Self {
        Self::new()
    }
}

impl<T> Drop for List<T> {
    fn drop(&mut self) {
        let mut head = self.0.take();
        while let Some(rc) = head {
            match alloc::rc::Rc::try_unwrap(rc) {
                Ok(Node::Cons(_, mut tail)) => head = tail.0.take(),
                _ => break,
            }
        }
    }
}

impl<T: Clone> List<T> {
    /// Remove the most recently added element, if this list is uniquely owned.
    pub fn pop(mut self) -> Option<(T, Self)> {
        match alloc::rc::Rc::try_unwrap(self.0.take()?).unwrap_or_else(|rc| (*rc).clone()) {
            Node::Invalid => None,
            Node::Cons(head, tail) => Some((head, tail)),
        }
    }
}

impl<T> List<T> {
    pub(crate) fn pop_unique(mut self) -> Option<(T, Self)> {
        match alloc::rc::Rc::try_unwrap(self.0.take()?).ok()? {
            Node::Cons(head, tail) => Some((head, tail)),
            Node::Invalid => None,
        }
    }

    /// Return an empty list.
    pub fn new() -> Self {
        Self(None)
    }

    /// Return a list that marks a value as not being at any path,
    /// such as the output of `1` in `path(1)`.
    pub fn invalid() -> Self {
        Self(Some(Node::Invalid.into()))
    }

    /// Whether the list is [`Self::invalid`].
    pub fn is_invalid(&self) -> bool {
        matches!(self.0.as_deref(), Some(Node::Invalid))
    }

    /// Append a new element to the list.
    pub fn cons(self, x: T) -> Self {
        Self(Some(Node::Cons(x, self).into()))
    }

    /// Repeatedly add elements to the list.
    pub fn extend(self, iter: impl IntoIterator<Item = T>) -> Self {
        iter.into_iter().fold(self, Self::cons)
    }

    /// Return the element most recently added to the list.
    pub fn head(&self) -> Option<&T> {
        match self.0.as_deref()? {
            Node::Invalid => None,
            Node::Cons(x, _) => Some(x),
        }
    }

    /// Get the `n`-th element from the list, starting from the most recently added.
    pub fn get(&self, n: usize) -> Option<&T> {
        self.skip(n).head()
    }

    /// Remove the `n` top values from the list.
    ///
    /// If `n` is greater than the number of list elements, return nil.
    pub fn skip(&self, n: usize) -> &Self {
        let mut cur = self;
        for _ in 0..n {
            match cur.0.as_deref() {
                Some(Node::Cons(_, xs)) => cur = xs,
                _ => break,
            }
        }
        cur
    }

    /// Iterate from the most recently added key or binding.
    pub fn iter(&self) -> Iter<'_, T> {
        Iter(self)
    }
}

/// Borrowed iterator over a persistent list.
pub struct Iter<'a, T>(&'a List<T>);

impl<'a, T> Iterator for Iter<'a, T> {
    type Item = &'a T;
    fn next(&mut self) -> Option<Self::Item> {
        let (x, xs) = match self.0.0.as_deref()? {
            Node::Cons(x, xs) => (x, xs),
            Node::Invalid => return None,
        };
        self.0 = xs;
        Some(x)
    }
}

#[test]
fn test() {
    use alloc::{vec, vec::Vec};
    let eq = |l: &List<_>, a| assert_eq!(l.iter().cloned().collect::<Vec<_>>(), a);

    let l = List::new().cons(2).cons(1).cons(0);
    eq(&l, vec![0, 1, 2]);

    eq(l.skip(0), vec![0, 1, 2]);
    eq(l.skip(1), vec![1, 2]);
    eq(l.skip(2), vec![2]);
    eq(l.skip(3), vec![]);

    assert_eq!(l.get(0), Some(&0));
    assert_eq!(l.get(1), Some(&1));
    assert_eq!(l.get(2), Some(&2));
    assert_eq!(l.get(3), None);
}
