# Ported from jq 1.8.2's src/builtin.jq; natives mirror src/builtin.c.
def null: [][0];

def halt_error: halt_error(5);
def sort_by(f): _sort_by_impl(map([f]));
def group_by(f): _group_by_impl(map([f]));
def unique_by(f): _unique_by_impl(map([f]));
def max_by(f): _max_by_impl(map([f]));
def min_by(f): _min_by_impl(map([f]));
def add(f): reduce f as $x (null; . + $x);
def add: add(.[]);
def abs: if . < 0 then - . else . end;

def to_entries: [keys_unsorted[] as $k | {key: $k, value: .[$k]}];
def from_entries: map({ (.key // .Key // .name // .Name):
  if has("value") then .value else .Value end }) | add // {};
def with_entries(f): to_entries | map(f) | from_entries;
def reverse: [.[length - 1 - range(0;length)]];
def indices($i): if type == "array" and ($i|type) == "array" then .[$i]
  elif type == "array" then .[[$i]]
  elif type == "string" and ($i|type) == "string" then _strindices($i)
  else .[$i] end;
def index($i):   indices($i) | .[0];
def rindex($i):  indices($i) | .[-1:][0];
def getpath($p):
    if ($p|type) != "array" then error("Path must be specified as an array")
  elif ($p|length) > 10000 then error("Path too deep")
  else reduce $p[] as $k (.; .[$k]) end;
def paths: path(recurse)|select(length > 0);
def paths(node_filter): path(recurse|select(node_filter))|select(length > 0);
def del(f): delpaths([path(f)]);
def isfinite: type == "number" and (isinfinite | not);
def arrays: select(type == "array");
def objects: select(type == "object");
def iterables: select(type|. == "array" or . == "object");
def booleans: select(type == "boolean");
def numbers: select(type == "number");
def normals: select(isnormal);
def finites: select(isfinite);
def strings: select(type == "string");
def nulls: select(. == null);
def values: select(. != null);
def scalars: select(type|. != "array" and . != "object");
def join($x): reduce .[] as $i (null;
            (if .==null then "" else .+$x end) +
            ($i | if type=="boolean" or type=="number" then tostring else .//"" end)
        ) // "";
def _flatten($x): reduce .[] as $i ([]; if $i | type == "array" and $x != 0 then . + ($i | _flatten($x-1)) else . + [$i] end);
def flatten($x): if $x < 0 then error("flatten depth must not be negative") else _flatten($x) end;
def flatten: _flatten(-1);
def fromdateiso8601: strptime("%Y-%m-%dT%H:%M:%SZ")|mktime;
def todateiso8601: strftime("%Y-%m-%dT%H:%M:%SZ");
def fromdate: fromdateiso8601;
def todate: todateiso8601;
def ltrimstr($left): if startswith($left) then .[$left | length:] end;
def rtrimstr($right): if endswith($right) then .[:length - ($right | length)] end;
def trimstr($val): ltrimstr($val) | rtrimstr($val);
def match(re; mode): _match_impl(re; mode; false)|.[];
def match($val): ($val|type) as $vt | if $vt == "string" then match($val; null)
   elif $vt == "array" and ($val | length) > 1 then match($val[0]; $val[1])
   elif $vt == "array" and ($val | length) > 0 then match($val[0]; null)
   else error( $vt + " not a string or array") end;
def test(re; mode): _match_impl(re; mode; true);
def test($val): ($val|type) as $vt | if $vt == "string" then test($val; null)
   elif $vt == "array" and ($val | length) > 1 then test($val[0]; $val[1])
   elif $vt == "array" and ($val | length) > 0 then test($val[0]; null)
   else error( $vt + " not a string or array") end;
def capture(re; mods): match(re; mods) | reduce ( .captures | .[] | select(.name != null) | { (.name) : .string } ) as $pair ({}; . + $pair);
def capture($val): ($val|type) as $vt | if $vt == "string" then capture($val; null)
   elif $vt == "array" and ($val | length) > 1 then capture($val[0]; $val[1])
   elif $vt == "array" and ($val | length) > 0 then capture($val[0]; null)
   else error( $vt + " not a string or array") end;
def scan($re; $flags):
  match($re; "g" + $flags)
    | if (.captures|length > 0)
      then [ .captures | .[] | .string ]
      else .string
      end;
def scan($re): scan($re; null);
def splits($re; $flags):
  . as $s
  | foreach (match($re; $flags+"g"), null) as {$offset, $length}
      (null; {start: .next, end: $offset, next: ($offset+$length)}; $s[.start:.end]);
def splits($re): splits($re; null);
def split($re; $flags): [ splits($re; $flags) ];
def sub($re; s; $flags):
   . as $in
   | (reduce match($re; $flags) as $edit
        ({result: [], previous: 0};
            $in[ .previous: ($edit | .offset) ] as $gap
            | [reduce ( $edit | .captures | .[] | select(.name != null) | { (.name) : .string } ) as $pair
                 ({}; . + $pair) | s ] as $inserts
            | reduce range(0; $inserts|length) as $ix (.; .result[$ix] += $gap + $inserts[$ix])
            | .previous = ($edit | .offset + .length ) )
          | .result[] + $in[.previous:] )
      // $in;
def sub($re; s): sub($re; s; "");
def gsub($re; s; flags): sub($re; s; flags + "g");
def gsub($re; s): sub($re; s; "g");

def isempty(g): first((g|false), true);
def all(generator; condition): isempty(generator|condition and empty);
def any(generator; condition): isempty(generator|condition or empty)|not;
def all(condition): all(.[]; condition);
def any(condition): any(.[]; condition);
def all: all(.[]; .);
def any: any(.[]; .);
def nth($n; g):
  if $n < 0 then error("nth doesn't support negative indices")
  else first(skip($n; g)) end;
def first: .[0];
def last: .[-1];
def nth($n): .[$n];
def combinations:
    if length == 0 then [] else
        .[0][] as $x
          | (.[1:] | combinations) as $y
          | [$x] + $y
    end;
def combinations(n):
    . as $dot
      | [range(n) | $dot]
      | combinations;
def transpose: [range(0; map(length)|max // 0) as $i | [.[][$i]]];
def in(xs): . as $x | xs | has($x);
def inside(xs): . as $x | xs | contains($x);
def ascii_downcase:
  explode | map( if 65 <= . and . <= 90 then . + 32  else . end) | implode;
def ascii_upcase:
  explode | map( if 97 <= . and . <= 122 then . - 32  else . end) | implode;

def truncate_stream(stream):
  . as $n | null | stream | . as $input | if (.[0]|length) > $n then setpath([0];$input[0][$n:]) else empty end;
def fromstream(i): {x: null, e: false} as $init |
  foreach i as $i ($init
  ; if .e then $init else . end
  | if $i|length == 2
    then setpath(["e"]; $i[0]|length==0) | setpath(["x"]+$i[0]; $i[1])
    else setpath(["e"]; $i[0]|length==1) end
  ; if .e then .x else empty end);
def tostream:
  path(def r: (.[]?|r), .; r) as $p |
  getpath($p) |
  reduce path(.[]?) as $q ([$p, .]; [$p+$q]);

def walk(f):
  def w:
    if type == "object"
    then map_values(w)
    elif type == "array" then map(w)
    else .
    end
    | f;
  w;

def pick(pathexps):
  . as $in
  | reduce path(pathexps) as $a (null;
      setpath($a; $in|getpath($a)) );

def debug(msgs): (msgs | debug | empty), .;

def INDEX(stream; idx_expr):
  reduce stream as $row ({}; .[$row|idx_expr|tostring] = $row);
def INDEX(idx_expr): INDEX(.[]; idx_expr);
def JOIN($idx; idx_expr):
  [.[] | [., $idx[idx_expr]]];
def JOIN($idx; stream; idx_expr):
  stream | [., $idx[idx_expr]];
def JOIN($idx; stream; idx_expr; join_expr):
  stream | [., $idx[idx_expr]] | join_expr;
def IN(s): any(s == .; .);
def IN(src; s): any(src == s; .);

def format($f):
    if ($f|type) != "string" then $f | _type_error("is not a valid format")
  elif $f == "json" then tojson
  elif $f == "text" then tostring
  elif $f == "csv" then @csv
  elif $f == "tsv" then @tsv
  elif $f == "html" then @html
  elif $f == "uri" then @uri
  elif $f == "urid" then @urid
  elif $f == "sh" then @sh
  elif $f == "base64" then @base64
  elif $f == "base64d" then @base64d
  else error($f + " is not a valid format") end;
def @text: tostring;
def @json: tojson;
def @base32: format("base32");
def @base32d: format("base32d");
def have_decnum: true;
def have_literal_numbers: true;

def builtins: ["have_literal_numbers/0","have_decnum/0","input_line_number/0","input_filename/0","now/0","localtime/0","gmtime/0","mktime/0","strflocaltime/1","strftime/1","strptime/1","stderr/0","debug/0","input/0","modulemeta/0","get_jq_origin/0","get_prog_origin/0","get_search_list/0","halt_error/1","halt/0","env/0","format/1","error/0","max/0","min/0","bsearch/1","unique/0","sort/0","nan/0","infinite/0","isnormal/0","isnan/0","isinfinite/0","type/0","utf8bytelength/0","length/0","contains/1","has/1","delpaths/1","getpath/1","setpath/2","rtrim/0","ltrim/0","trim/0","implode/0","explode/0","split/1","endswith/1","startswith/1","keys_unsorted/0","keys/0","tostring/0","toboolean/0","tonumber/0","fromjson/0","tojson/0","lgamma_r/0","frexp/0","modf/0","ldexp/2","trunc/0","significand/0","scalbln/2","scalb/2","round/0","rint/0","nexttoward/2","nextafter/2","nearbyint/0","logb/0","log1p/0","lgamma/0","gamma/0","fmod/2","fmin/2","fmax/2","fma/3","fdim/2","fabs/0","expm1/0","exp10/0","erfc/0","erf/0","drem/2","copysign/2","ceil/0","yn/2","jn/2","y1/0","y0/0","tgamma/0","tanh/0","tan/0","sqrt/0","sinh/0","sin/0","remainder/2","pow/2","log2/0","log10/0","log/0","j1/0","j0/0","hypot/2","floor/0","exp2/0","exp/0","cosh/0","cos/0","cbrt/0","atanh/0","atan2/2","atan/0","asinh/0","asin/0","acosh/0","acos/0","empty/0","not/0","path/1","last/1","range/2","halt_error/0","error/1","map/1","select/1","sort_by/1","group_by/1","unique_by/1","max_by/1","min_by/1","add/1","add/0","del/1","abs/0","map_values/1","recurse/1","recurse/2","recurse/0","to_entries/0","from_entries/0","with_entries/1","reverse/0","indices/1","index/1","rindex/1","paths/0","paths/1","isfinite/0","arrays/0","objects/0","iterables/0","booleans/0","numbers/0","normals/0","finites/0","strings/0","nulls/0","values/0","scalars/0","join/1","flatten/1","flatten/0","range/1","fromdateiso8601/0","todateiso8601/0","fromdate/0","todate/0","ltrimstr/1","rtrimstr/1","trimstr/1","match/2","match/1","test/2","test/1","capture/2","capture/1","scan/2","scan/1","splits/2","splits/1","split/2","sub/3","sub/2","gsub/3","gsub/2","while/2","until/2","limit/2","skip/2","range/3","first/1","isempty/1","all/2","any/2","all/1","any/1","all/0","any/0","nth/2","first/0","last/0","nth/1","combinations/0","combinations/1","transpose/0","in/1","inside/1","repeat/1","inputs/0","ascii_downcase/0","ascii_upcase/0","truncate_stream/1","fromstream/1","tostream/0","walk/1","pick/1","debug/1","INDEX/2","INDEX/1","JOIN/2","JOIN/3","JOIN/4","IN/1","IN/2","builtins/0"];
