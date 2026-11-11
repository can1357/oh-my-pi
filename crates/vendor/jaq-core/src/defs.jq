def empty: {}[] as $x | .;

def error(msg): msg|error;

# Booleans
def true:  0 == 0;
def false: 0 != 0;
def not: if . then false else true end;
def select(f): if f then . else empty end;

# Generators
def range($x): range(0; $x);
def repeat(f): def _repeat: f, _repeat; _repeat;
def recurse(f): def r: ., (f | r); r;
def recurse(f; cond): def r: ., (f | select(cond) | r); r;
def recurse: recurse(.[]?);
def while(cond; update): def _while: if cond then ., (update | _while) else empty end; _while;
def until(cond; next): def _until: if cond then . else (next | _until) end; _until;

# Updates
def map(f): [.[] | f];
def map_values(f): .[] |= f;
