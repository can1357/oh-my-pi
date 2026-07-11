#!/usr/bin/env julia
# bash_corpus_stats.jl
# Extract every bash execution from ~/.omp/stats.db and analyze it.
#   sources: (1) bash-tool calls   (2) full-file writes to *.sh
# Reports: (1) bash constructs   (2) CLI utilities   (3) flags per utility
#
#   julia bash_corpus_stats.jl
# deps:  import Pkg; Pkg.add(["SQLite","JSON3","DBInterface"])

using SQLite, JSON3, DBInterface, Printf

# ─────────────────────────── extraction ───────────────────────────
const DB = SQLite.DB(joinpath(homedir(), ".omp", "stats.db"))

field(j, k) = try
    v = get(JSON3.read(j), k, nothing); v isa AbstractString ? String(v) : nothing
catch; nothing end

function extract()
    bash, sh = String[], String[]
    for r in DBInterface.execute(DB, "SELECT arg_json FROM ss_tool_calls WHERE tool_name IN " *
            "('bash','Bash','shell','bash_exec','execute_command','run_command')")
        c = field(r.arg_json, :command); c !== nothing && !isempty(strip(c)) && push!(bash, c)
    end
    for r in DBInterface.execute(DB, "SELECT arg_json FROM ss_tool_calls WHERE tool_name IN " *
            "('write','write_file','create_file','file_write','replace_file','edit_file') " *
            "AND json_extract(arg_json,'\$.path') LIKE '%.sh'")
        c = field(r.arg_json, :content); c !== nothing && !isempty(strip(c)) && push!(sh, c)
    end
    return bash, sh
end

# ─────────────────────────── lexer ───────────────────────────
# Splits a bash string into words + control/redirection operators, tracks
# expansion/construct features, and captures the inner text of command &
# process substitutions (and shell-source heredoc bodies) for recursion.
const WS = (' ', '\t')
const SHELLS = Set(["sh","bash","zsh","dash","ksh","mksh","ash"])
struct Tok; kind::Symbol; text::String; end   # :W word  :O operator  :C comment

function read_balanced(cs::Vector{Char}, j::Int, openc::Char, closec::Char)
    n = length(cs); depth = 1; buf = Char[]
    while j <= n && depth > 0
        c = cs[j]
        if c == '\\' && j+1 <= n
            push!(buf, c, cs[j+1]); j += 2; continue
        elseif c == '\''
            k = j+1; while k <= n && cs[k] != '\''; k += 1; end
            if k > n; append!(buf, @view cs[j:n]); return String(buf), n+1; end
            append!(buf, @view cs[j:k]); j = k+1; continue
        elseif c == '"'
            k = j+1
            while k <= n && cs[k] != '"'; cs[k] == '\\' ? (k += 2) : (k += 1); end
            kk = min(k, n); append!(buf, @view cs[j:kk]); j = kk+1; continue
        end
        if c == openc; depth += 1
        elseif c == closec; depth -= 1; depth == 0 && return String(buf), j+1
        end
        push!(buf, c); j += 1
    end
    return String(buf), j
end

function lex(s::String)
    cs = collect(s); n = length(cs)
    toks = Tok[]; feats = String[]; subs = String[]
    hd_queue = Tuple{String,Bool}[]
    word = Char[]; started = false
    expect_delim::Union{Nothing,Bool} = nothing
    i = 1

    flush!() = begin
        if started
            w = String(word)
            if expect_delim !== nothing
                d = replace(strip(strip(w), ['\'','"']), "\\"=>"")
                push!(hd_queue, (String(d), expect_delim)); expect_delim = nothing
            end
            push!(toks, Tok(:W, w))
        end
        empty!(word); started = false
    end
    line_is_shell() = begin
        e = length(toks) - 1; st = e - 1
        while st >= 1 && !(toks[st].kind == :O && toks[st].text == "\n"); st -= 1; end
        for idx in (st+1):e
            t = toks[idx]
            t.kind == :W && (last(split(t.text, '/')) in SHELLS) && return true
            if t.kind == :O && (t.text == ">" || t.text == ">>") && idx < e
                nt = toks[idx+1]
                nt.kind == :W && endswith(strip(nt.text, ['\'','"']), ".sh") && return true
            end
        end
        false
    end
    consume_heredocs(j) = begin
        shell = line_is_shell()
        for (delim, stripmode) in hd_queue
            j += 1; body = Char[]; first = true
            while j <= n
                e = j; while e <= n && cs[e] != '\n'; e += 1; end
                ln = String(@view cs[j:min(e-1,n)])
                test = stripmode ? lstrip(ln, '\t') : ln
                if test == delim; j = e; break; end
                first ? (first = false) : push!(body, '\n'); append!(body, collect(ln))
                if e > n; j = n+1; break; end
                j = e + 1
            end
            shell && !isempty(body) && push!(subs, String(body))
        end
        empty!(hd_queue); j
    end

    while i <= n
        c = cs[i]
        if c == '\\' && i+1 <= n && cs[i+1] == '\n'; i += 2; continue; end
        if c == '\\' && i+1 <= n; push!(word, c, cs[i+1]); started = true; i += 2; continue; end
        if c in WS; flush!(); i += 1; continue; end
        if c == '\n'
            flush!(); push!(toks, Tok(:O, "\n"))
            i = isempty(hd_queue) ? i+1 : consume_heredocs(i); continue
        end
        if c == '#' && !started
            j = i; while j <= n && cs[j] != '\n'; j += 1; end
            push!(toks, Tok(:C, String(@view cs[i:j-1]))); i = j; continue
        end
        if c == '\''
            k = i+1; while k <= n && cs[k] != '\''; k += 1; end
            kk = min(k, n); append!(word, @view cs[i:kk]); started = true; i = kk+1; continue
        end
        if c == '"'
            j = i+1; push!(word, '"')
            while j <= n && cs[j] != '"'
                if cs[j] == '\\' && j+1 <= n; push!(word, cs[j], cs[j+1]); j += 2; continue; end
                if cs[j] == '$' && j+1 <= n && cs[j+1] == '('
                    inner, j2 = read_balanced(cs, j+2, '(', ')')
                    push!(feats, "cmdsub_\$()"); push!(subs, inner)
                    append!(word, collect("\$(" * inner * ")")); j = j2; continue
                end
                if cs[j] == '$' && j+1 <= n && cs[j+1] == '{'
                    inner, j2 = read_balanced(cs, j+2, '{', '}')
                    push!(feats, "paramexp_\${}"); append!(word, collect("\${" * inner * "}")); j = j2; continue
                end
                if cs[j] == '`'
                    k = j+1; while k <= n && cs[k] != '`'; cs[k] == '\\' ? (k += 2) : (k += 1); end
                    kk = min(k, n); push!(feats, "cmdsub_backtick"); push!(subs, String(@view cs[j+1:min(kk-1,n)]))
                    append!(word, @view cs[j:kk]); j = kk+1; continue
                end
                cs[j] == '$' && push!(feats, "var_in_dq")
                push!(word, cs[j]); j += 1
            end
            push!(word, '"'); started = true; i = min(j+1, n+1); continue
        end
        if c == '$' && i+1 <= n
            nx = cs[i+1]
            if nx == '('
                if i+2 <= n && cs[i+2] == '('
                    inner, j = read_balanced(cs, i+3, '(', ')')
                    push!(feats, "arith_\$(())"); append!(word, collect("\$((" * inner * "))")); started = true
                    i = (j <= n && cs[j] == ')') ? j+1 : j; continue
                end
                inner, j = read_balanced(cs, i+2, '(', ')')
                push!(feats, "cmdsub_\$()"); push!(subs, inner)
                append!(word, collect("\$(" * inner * ")")); started = true; i = j; continue
            end
            if nx == '{'
                inner, j = read_balanced(cs, i+2, '{', '}')
                push!(feats, "paramexp_\${}"); append!(word, collect("\${" * inner * "}")); started = true; i = j; continue
            end
            if nx == '\''
                k = i+2; while k <= n && cs[k] != '\''; cs[k] == '\\' ? (k += 2) : (k += 1); end
                kk = min(k, n); push!(feats, "ansi_c_quote"); append!(word, @view cs[i:kk]); started = true; i = kk+1; continue
            end
            push!(feats, "var_\$"); push!(word, '$'); started = true; i += 1; continue
        end
        if c == '`'
            k = i+1; while k <= n && cs[k] != '`'; cs[k] == '\\' ? (k += 2) : (k += 1); end
            kk = min(k, n); push!(feats, "cmdsub_backtick"); push!(subs, String(@view cs[i+1:min(kk-1,n)]))
            append!(word, @view cs[i:kk]); started = true; i = kk+1; continue
        end
        if c in ('|','&',';','<','>','(',')')
            flush!()
            if (c == '<' || c == '>') && i+1 <= n && cs[i+1] == '('
                inner, j = read_balanced(cs, i+2, '(', ')')
                push!(feats, c == '<' ? "procsub_<()" : "procsub_>()"); push!(subs, inner)
                push!(toks, Tok(:W, string(c) * "(" * inner * ")")); i = j; continue
            end
            three = String(@view cs[i:min(i+2,n)]); two = String(@view cs[i:min(i+1,n)])
            if three == "<<<"; push!(toks, Tok(:O, "<<<")); i += 3; continue; end
            if two == "<<"
                op = three == "<<-" ? "<<-" : "<<"
                push!(toks, Tok(:O, op)); expect_delim = (op == "<<-"); i += length(op); continue
            end
            if three == "&>>"; push!(toks, Tok(:O, "&>>")); i += 3; continue; end
            if two in ("&&","||",";;","|&",">>","<&",">&","&>","<>"); push!(toks, Tok(:O, two)); i += 2; continue; end
            push!(toks, Tok(:O, string(c))); i += 1; continue
        end
        push!(word, c); started = true; i += 1
    end
    flush!()
    return toks, feats, subs
end

# ─────────────────────────── analyzer ───────────────────────────
const KW = Set(["if","then","else","elif","fi","for","while","until","do","done",
                "case","esac","select","function","in","time","coproc"])
const WRAPPERS = Set(["sudo","env","timeout","command","builtin","exec","nohup","nice",
                      "ionice","stdbuf","setsid","doas","xargs","watch"])
const REDIRS = Set(["<",">",">>","<<","<<-","<<<","<&",">&","&>","&>>","<>"])
const OPC = Dict(
 "|"=>"pipe |","|&"=>"pipe |&","&&"=>"and &&","||"=>"or ||",";"=>"seq ;",";;"=>"case-clause ;;",
 "&"=>"background &",">"=>"redir >",">>"=>"redir-append >>","<"=>"redir-in <","<&"=>"fd-dup <&",
 ">&"=>"fd-dup >&","&>"=>"redir-both &>","&>>"=>"redir-both-append &>>","<>"=>"redir-rw <>",
 "<<<"=>"herestring <<<","<<"=>"heredoc <<","<<-"=>"heredoc <<-")
const FEATC = Dict(
 "cmdsub_\$()"=>"cmdsub \$()","cmdsub_backtick"=>"cmdsub ``","arith_\$(())"=>"arith-exp \$(())",
 "paramexp_\${}"=>"paramexp \${}","procsub_<()"=>"procsub <()","procsub_>()"=>"procsub >()",
 "var_\$"=>"var \$x","var_in_dq"=>"var-in-dquotes","ansi_c_quote"=>"ansi-c \$'..'")

inc!(d, k) = (d[k] = get(d, k, 0) + 1)

function normutil(w::AbstractString)
    isempty(w) && return nothing
    (startswith(w,"\$")||startswith(w,"`")||occursin("\$(",w)||occursin("\${",w)||
     startswith(w,"\"")||startswith(w,"'")) && return "<dynamic>"
    base = String(last(split(w, '/')))
    isempty(base) ? nothing : base
end
function recordflag!(flags, util, w)
    util == "" && return
    f = w; eq = findfirst('=', f); eq !== nothing && (f = f[1:prevind(f,eq)])
    (isempty(f) || f == "-" || f == "--") && return
    d = get!(flags, util, Dict{String,Int}()); d[f] = get(d,f,0)+1
end
function dwc!(w, constructs)
    u = replace(w, r"'[^']*'"=>"", "\""=>"")
    startswith(w, "~") && inc!(constructs, "tilde ~")
    (occursin(r"\{[^{}]*\.\.[^{}]*\}", u) || occursin(r"\{[^{}]*,[^{}]*\}", u)) && inc!(constructs, "brace-expansion {}")
    (occursin('*', u) || occursin('?', u) || occursin(r"\[[^]]+\]", u)) && inc!(constructs, "glob */?/[]")
end
function unquote_script(w)        # strip outer quotes of a `bash -c '<script>'` arg
    n = lastindex(w)
    if length(w) >= 2 && ((startswith(w,"'") && endswith(w,"'")) || (startswith(w,"\"") && endswith(w,"\"")))
        return w[nextind(w,1):prevind(w,n)]
    elseif startswith(w,"-")
        return nothing
    else
        return w
    end
end

function analyze!(s::String, constructs, utils, flags, depth::Int=0)
    depth > 25 && return
    toks, feats, subs = lex(s)
    for f in feats; inc!(constructs, get(FEATC, f, f)); end
    expect = true; skip_target = 0; curutil = ""; wrapper = false; ddash = false; want_script = false
    i = 1; N = length(toks)
    while i <= N
        t = toks[i]
        if t.kind == :O
            op = t.text
            if op == "("
                if i < N && toks[i+1].kind == :O && toks[i+1].text == "("
                    inc!(constructs,"arith-cmd (( ))"); i+=2; expect=false; curutil=""; ddash=false; want_script=false; continue
                end
                inc!(constructs,"subshell ( )"); expect=true; curutil=""; ddash=false; want_script=false; i+=1; continue
            elseif op == ")" || op == "\n"
                expect=true; curutil=""; ddash=false; want_script=false; i+=1; continue
            elseif haskey(OPC, op)
                inc!(constructs, OPC[op])
                if op in ("|","|&","&&","||",";",";;","&"); expect=true; curutil=""; ddash=false; want_script=false
                else; skip_target += 1; end
                i+=1; continue
            else; i+=1; continue; end
        elseif t.kind == :C
            i+=1; continue
        end
        w = t.text
        if skip_target > 0; skip_target -= 1; i+=1; continue; end
        if expect && occursin(r"^\d+$", w) && i < N && toks[i+1].kind==:O && toks[i+1].text in REDIRS
            i+=1; continue                                   # leading fd (2>&1)
        end
        if expect
            if w in KW
                inc!(constructs,"kw "*w); expect = !(w in ("for","select","case")); i+=1; continue
            elseif w == "{"; inc!(constructs,"group { }"); expect=true; i+=1; continue
            elseif w == "}"; expect=true; i+=1; continue
            elseif w == "!"; inc!(constructs,"negation !"); expect=true; i+=1; continue
            elseif startswith(w,"[["); inc!(constructs,"test [[ ]]"); expect=false; i+=1; continue
            elseif w == "["; inc!(constructs,"test [ ]"); expect=false; i+=1; continue
            elseif occursin(r"^[A-Za-z_][A-Za-z0-9_]*(\[[^]]*\])?\+?=", w)
                inc!(constructs,"assignment VAR="); expect=true; i+=1; continue
            else
                u = normutil(w)
                if u !== nothing; inc!(utils,u); curutil=u; wrapper=(u in WRAPPERS)
                else; curutil=""; wrapper=false; end
                expect=false; ddash=false; want_script=false; i+=1; continue
            end
        else
            dwc!(w, constructs)
            if w == "--"; ddash = true; i+=1; continue; end  # option terminator
            if want_script
                want_script = false
                src = unquote_script(w)
                src !== nothing && analyze!(String(src), constructs, utils, flags, depth+1)
                i+=1; continue
            end
            if wrapper                                       # sudo/env/timeout/xargs: count, then find real subcommand
                if startswith(w,"-"); recordflag!(flags,curutil,w); i+=1; continue
                elseif occursin(r"^[A-Za-z_][A-Za-z0-9_]*=", w) || occursin(r"^\d+(\.\d+)?[smhd]?$", w); i+=1; continue
                else
                    u2 = normutil(w)
                    if u2 !== nothing; inc!(utils,u2); curutil=u2; wrapper=(u2 in WRAPPERS)
                    else; curutil=""; wrapper=false; end
                    ddash=false; i+=1; continue
                end
            end
            if !ddash && startswith(w,"-") && length(w)>1 && curutil!=""
                recordflag!(flags,curutil,w)
                (curutil in SHELLS && occursin(r"^-[a-z]*c$", w)) && (want_script = true)   # bash -c <script>
            end
            i+=1; continue
        end
    end
    for sub in subs; analyze!(sub, constructs, utils, flags, depth+1); end
end

# ─────────────────────────── reporting ───────────────────────────
sortd(d) = sort(collect(d), by=x->-x[2])

function main()
    bash, sh = extract()
    corpus = vcat(bash, sh); total = length(corpus)
    constructs = Dict{String,Int}(); utils = Dict{String,Int}(); flags = Dict{String,Dict{String,Int}}()
    for s in corpus; analyze!(s, constructs, utils, flags); end

    println("corpus: $(length(bash)) bash calls + $(length(sh)) .sh writes = $total snippets\n")
    println("="^60, "\n1) BASH CONSTRUCTS\n", "="^60)
    for (k,v) in sortd(constructs)
        @printf("  %-26s %9d  %5.1f%%\n", k, v, 100v/total)
    end
    ut = sum(values(utils))
    println("\n", "="^60, "\n2) CLI UTILITIES ($(length(utils)) distinct)\n", "="^60)
    for (k,v) in sortd(utils)[1:min(60,length(utils))]
        @printf("  %-22s %9d  %5.1f%%\n", k, v, 100v/ut)
    end
    println("\n", "="^60, "\n3) FLAGS PER UTILITY\n", "="^60)
    flagtot = Dict(u => sum(values(d)) for (u,d) in flags)
    for (u, ft) in sort(collect(flagtot), by=x->-x[2])[1:min(30,length(flagtot))]
        fl = sortd(flags[u]); shown = fl[1:min(12,length(fl))]
        println("  ", rpad(u,12), "[$ft uses, $(length(fl)) distinct]")
        println("      ", join(["$k·$v" for (k,v) in shown], "  "),
                length(fl) > 12 ? "  (+$(length(fl)-12))" : "")
    end
end

main()
