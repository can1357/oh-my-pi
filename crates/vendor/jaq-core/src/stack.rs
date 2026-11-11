use alloc::vec::Vec;
use core::ops::ControlFlow;

pub struct Stack<I, F>(Vec<I>, F);

impl<I, F> Stack<I, F> {
    pub fn new(v: Vec<I>, f: F) -> Self {
        Self(v, f)
    }
}

/// If `F` returns `Break(x)`, then `x` is returned
/// If `F` returns `Continue(iter)`, then the iterator is pushed onto the stack
impl<I: Iterator, F: Fn(I::Item) -> ControlFlow<I::Item, I>> Iterator for Stack<I, F> {
    type Item = I::Item;

    fn next(&mut self) -> Option<Self::Item> {
        // uncomment this to verify that the stack does not grow
        //println!("stack size: {}", self.0.len());
        loop {
            let mut top = self.0.pop()?;
            if let Some(next) = top.next() {
                // try not to grow the stack with empty iterators left behind
                if top.size_hint() != (0, Some(0)) {
                    self.0.push(top);
                }
                match self.1(next) {
                    ControlFlow::Break(next) => return Some(next),
                    ControlFlow::Continue(iter) => self.0.push(iter),
                }
            }
        }
    }
}
