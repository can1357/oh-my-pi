def empty: {}[] as $x | .;

def error:                error_empty  as $x | .    ;
def error(msgs):  (msgs | error_empty) as $x | .    ;

# Booleans
def true:  0 == 0;
def false: 0 != 0;
def not: if . then false else true end;
def select(f): if f then . else empty end;

# Conversion
def tostring: "\(.)";

# Generators
def range(from; to): range(from; to; 1);
def range(to): range(0; to);
def repeat(f): def rec: f, rec; rec;
def recurse(f): def rec: ., (f | rec); rec;
def recurse: recurse(.[]?);
def recurse(f; cond): recurse(f | select(cond));
def while(cond; update): def rec: if cond then ., (update | rec) else empty end; rec;
def until(cond; update): def rec: if cond then . else update | rec end; rec;

# Paths
def paths:    skip(1; path      (..));
def paths(p): skip(1; path_value(..)) | if .[1] | p then .[0] else empty end;
def getpath($path): reduce $path[] as $p (.; .[$p]);
def setpath($path; $x): getpath($path) = $x;
def delpaths($paths): reduce $paths[] as $path (.; getpath($path) |= empty);

# Updates
def map(f): [.[] | f];
def map_values(f): .[] |= f;
def walk(f): .. |= f;
def del(f): f |= empty;

# Arrays
def first:  .[ 0];
def last:   .[-1];
def nth(n): .[ n];
def join($s): .[] |= tostring | .[:-1][] += $s | reduce .[] as $x (""; . + $x);
def combinations: .[][] |= [.] | reduce .[] as $a ([]; . + $a[]);
def combinations($n): [limit($n; repeat(.))] | combinations;

def nth(n; g): first(skip(n; g));

# Objects <-> Arrays
def   to_entries: [key_values[] as [$key, $value] | { $key, $value }];
def from_entries: reduce (.[] | { (.key): .value }) as $x ({}; . + $x);
def with_entries(f): to_entries | map(f) | from_entries;

# Predicates
def isempty(g): first((g | false), true);
def all(g; cond): isempty(g | cond and empty);
def any(g; cond): isempty(g | cond  or empty) | not;
def all(cond): all(.[]; cond);
def any(cond): any(.[]; cond);
def all: all(.[]; .);
def any: any(.[]; .);
