use alloc::boxed::Box;
use alloc::rc::Rc;
use once_cell::unsync::Lazy;

#[derive(Clone)]
pub struct List<'a, T>(Rc<Lazy<Node<'a, T>, Eval<'a, T>>>);
struct Node<'a, T>(Option<(T, List<'a, T>)>);
type Eval<'a, T> = Box<dyn FnOnce() -> Node<'a, T> + 'a>;

impl<T> Drop for List<'_, T> {
    fn drop(&mut self) {
        while let Some((_head, tail)) = Rc::get_mut(&mut self.0)
            .and_then(Lazy::get_mut)
            .and_then(|node| node.0.take())
        {
            *self = tail;
        }
    }
}

impl<'a, T> Node<'a, T> {
    fn from_iter(mut iter: impl Iterator<Item = T> + 'a) -> Self {
        Self(iter.next().map(|x| (x, List::from_iter(iter))))
    }
}

impl<'a, T> List<'a, T> {
    pub fn from_iter(iter: impl Iterator<Item = T> + 'a) -> Self {
        Self(Rc::new(Lazy::new(Box::new(|| Node::from_iter(iter)))))
    }
}

impl<'a, T: Clone + 'a> Iterator for List<'a, T> {
    type Item = T;

    fn next(&mut self) -> Option<T> {
        match &Lazy::force(&self.0).0 {
            None => None,
            Some((x, xs)) => {
                let x = x.clone();
                *self = xs.clone();
                Some(x)
            }
        }
    }
}

#[test]
fn drop() {
    let list = List::from_iter(0..100_000);
    // clone() ensures that we keep a copy of the whole list around
    // sum() then evaluates the whole list
    assert_eq!(list.clone().sum::<u64>(), 4999950000);
    // at the end, a long, fully evaluated list is dropped,
    // which would result in a stack overflow without the custom `Drop` impl
    std::mem::drop(list);
}
