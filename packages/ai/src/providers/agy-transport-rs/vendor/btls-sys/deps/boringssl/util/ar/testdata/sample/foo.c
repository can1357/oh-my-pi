extern void external_symbol(void);
extern void bar(void);

void foo(void) {
  external_symbol();
  bar();
}
