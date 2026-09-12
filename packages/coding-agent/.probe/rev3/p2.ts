import picomatch from "picomatch";
const OPT = { dot: true, nonegate: true, noextglob: true, noglobstar: true, windows: false, fastpaths: false, literalBrackets: false } as any;
const show = (p: string) => {
  try {
    const st = picomatch.parse(p, OPT) as any;
    console.log(JSON.stringify(p), "=>", JSON.stringify(st.tokens.map((t: any) => `${t.type}:${t.value}:${t.output ?? ""}`)));
  } catch (e) { console.log(JSON.stringify(p), "=> PARSE THREW:", String(e)); }
};
show("{a..c}"); show("{1..9}"); show("{a,b"); show("{a,"); show("{,"); show("{}");
show("{{a,b},c}"); show("{a,b}}"); show("{{a,b}");
show("[[:alpha:]]"); show("[[:digit:]]"); show("[[:foo:]]");
show("[\\x41]"); show("[\\d]"); show("[\\w]"); show("[a\\]"); show("[!a]"); show("[^]"); show("[a"); show("[");
show("\\x5Ba"); show("x\\x5D");
