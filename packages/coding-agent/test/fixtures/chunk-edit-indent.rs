pub struct Greeter;

impl Greeter {
    pub fn render(&self, name: &str) -> String {
        let prefix = "Hello";
        format!("{prefix}, {name}")
    }
}
