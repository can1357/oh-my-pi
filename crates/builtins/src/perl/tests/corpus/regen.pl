#!/usr/bin/perl
# Regenerate every expectation in the per-area corpus TSVs with the Perl 5.34
# oracle (/usr/bin/perl), never the builtin. Inputs (name, script, arg=,
# stdin=, file:) are kept; stdout, stderr=, status= and after: are rewritten.
# The TSV format is documented in crates/builtins/src/perl/tests.rs.
use v5.34;
use strict;
use warnings;
use File::Basename qw(dirname);
use File::Path qw(make_path);
use File::Spec::Functions qw(rel2abs);
use File::Temp qw(tempdir);
use POSIX qw(_exit);

my $root = rel2abs(dirname(__FILE__));
my $count = 0;
for my $tsv (sort glob("$root/*.tsv")) {
    open my $in, '<:raw', $tsv or die "open $tsv: $!";
    my @out;
    while (my $line = <$in>) {
        chomp $line;
        if ($line eq '' || $line =~ /\A#/) { push @out, $line; next }
        push @out, regenerate($tsv, $line);
        $count++;
    }
    close $in;
    open my $out, '>:raw', $tsv or die "write $tsv: $!";
    print {$out} map { "$_\n" } @out;
    close $out or die "close $tsv: $!";
}
print "Regenerated $count Perl oracle cases\n";

sub regenerate {
    my ($tsv, $line) = @_;
    my ($name, $script, undef, @fields) = split /\t/, $line, -1;
    my (@args, @inputs, @watch);
    my $stdin = '';
    for my $field (@fields) {
        my ($key, $value) = split /=/, $field, 2;
        if ($key eq 'arg') { push @args, decode_field($value); push @inputs, $field }
        elsif ($key eq 'stdin') { $stdin = decode_field($value); push @inputs, $field }
        elsif ($key =~ /\Afile:/) { push @inputs, $field }
        elsif ($key =~ /\Aafter:(.+)\z/) { push @watch, $1 }
        elsif ($key ne 'stderr' && $key ne 'status') { die "$tsv: $name: unknown key $key" }
    }
    my $scratch = tempdir(CLEANUP => 1);
    my $dir = "$scratch/work";
    mkdir $dir or die "mkdir $dir: $!";
    for my $field (@inputs) {
        my ($path, $value) = $field =~ /\Afile:([^=]+)=(.*)\z/s or next;
        die "$tsv: $name: invalid seeded path '$path'" if $path =~ m{(?:\A|/)\.\.(?:/|\z)|\A/};
        make_path(dirname("$dir/$path"));
        write_bytes("$dir/$path", decode_field($value));
    }
    if ($script ne '') {
        write_bytes("$dir/$name.pl", decode_field($script) . "\n");
        push @args, "$name.pl";
    }
    write_bytes("$scratch/stdin", $stdin);
    my $pid = fork // die "fork: $!";
    if (!$pid) {
        open STDIN, '<:raw', "$scratch/stdin" or die "stdin: $!";
        open STDOUT, '>:raw', "$scratch/stdout" or die "stdout: $!";
        open STDERR, '>:raw', "$scratch/stderr" or die "stderr: $!";
        chdir $dir or die "chdir $dir: $!";
        delete @ENV{qw(PERL5OPT PERL5LIB PERLLIB PERL_UNICODE PERLIO PERL_LOCAL_LIB_ROOT PERL5DB)};
        $ENV{LC_ALL} = 'C';
        $ENV{TZ} = 'UTC';
        exec('/usr/bin/perl', @args) or do { warn "exec: $!\n"; _exit(127) };
    }
    waitpid($pid, 0) == $pid or die "waitpid: $!";
    die "$tsv: $name: oracle terminated by signal " . ($? & 127) if $? & 127;
    my $status = $? >> 8;
    die "$tsv: $name: oracle unavailable" if $status == 127;
    my @row = ($name, $script, encode_field(read_bytes("$scratch/stdout")), @inputs);
    my $stderr = read_bytes("$scratch/stderr");
    push @row, 'stderr=' . encode_field($stderr) if length $stderr;
    push @row, "status=$status" if $status;
    push @row, "after:$_=" . encode_field(read_bytes("$dir/$_")) for @watch;
    return join "\t", @row;
}

# Control characters as Unicode control pictures; the line is UTF-8 bytes.
sub encode_field {
    my ($bytes) = @_;
    utf8::decode(my $text = $bytes) or die "non-UTF-8 output cannot be stored";
    die "output contains a literal control picture" if $text =~ /[\x{2400}-\x{2426}]/;
    $text =~ s/([\x00-\x1f])/chr(0x2400 + ord $1)/ge;
    $text =~ s/\x7f/\x{2421}/g;
    utf8::encode($text);
    return $text;
}

sub decode_field {
    my ($field) = @_;
    utf8::decode(my $text = $field) or die "field is not UTF-8";
    $text =~ s/([\x{2400}-\x{241f}])/chr(ord($1) - 0x2400)/ge;
    $text =~ s/\x{2421}/\x7f/g;
    utf8::encode($text);
    return $text;
}

sub read_bytes {
    my ($path) = @_;
    open my $fh, '<:raw', $path or die "open $path: $!";
    local $/;
    my $bytes = <$fh> // '';
    return $bytes;
}

sub write_bytes {
    my ($path, $bytes) = @_;
    open my $fh, '>:raw', $path or die "open $path: $!";
    print {$fh} $bytes;
    close $fh or die "close $path: $!";
}
