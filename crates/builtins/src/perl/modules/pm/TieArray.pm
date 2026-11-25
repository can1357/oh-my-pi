package Tie::Array;
our $VERSION = '1.07';

sub EXTEND { }
sub DESTROY { }
sub EXISTS { die ref($_[0]) . " doesn't define an EXISTS method" }
sub DELETE { die ref($_[0]) . " doesn't define a DELETE method" }
sub CLEAR { $_[0]->STORESIZE(0) }

sub PUSH {
    my $self = shift;
    my $next = $self->FETCHSIZE();
    $self->STORE($next++, $_) for @_;
    return $next;
}

sub POP {
    my $self = shift;
    my $size = $self->FETCHSIZE();
    return undef unless $size;
    my $last = $self->FETCH($size - 1);
    $self->STORESIZE($size - 1);
    return $last;
}

sub SHIFT {
    my $self = shift;
    return scalar $self->SPLICE(0, 1);
}

sub UNSHIFT {
    my $self = shift;
    $self->SPLICE(0, 0, @_);
    return $self->FETCHSIZE();
}

sub SPLICE {
    my $self = shift;
    my $size = $self->FETCHSIZE();
    my $start = @_ ? int(shift) : 0;
    $start += $size if $start < 0;
    die "Modification of non-creatable array value attempted, subscript $start" if $start < 0;
    $start = $size if $start > $size;
    my $count = @_ ? int(shift) : $size - $start;
    $count += $size - $start if $count < 0;
    $count = 0 if $count < 0;
    $count = $size - $start if $count > $size - $start;
    my @removed;
    for (my $i = 0; $i < $count; $i++) {
        push @removed, scalar $self->FETCH($start + $i);
    }
    my $delta = scalar(@_) - $count;
    my $tail = $start + $count;
    if ($delta > 0) {
        $self->STORESIZE($size + $delta);
        for (my $i = $size - 1; $i >= $tail; $i--) {
            $self->STORE($i + $delta, scalar $self->FETCH($i));
        }
    } elsif ($delta < 0) {
        for (my $i = $tail; $i < $size; $i++) {
            $self->STORE($i + $delta, scalar $self->FETCH($i));
        }
        $self->STORESIZE($size + $delta);
    }
    $self->STORE($start++, $_) for @_;
    return @removed if wantarray;
    return $removed[-1];
}

package Tie::StdArray;
our @ISA = ('Tie::Array');

sub TIEARRAY { return bless [], $_[0] }
sub FETCH { return $_[0]->[$_[1]] }
sub STORE { $_[0]->[$_[1]] = $_[2] }
sub FETCHSIZE { return scalar @{$_[0]} }
sub STORESIZE { $#{$_[0]} = $_[1] - 1 }
sub EXISTS { return exists $_[0]->[$_[1]] }
sub DELETE { return delete $_[0]->[$_[1]] }
sub CLEAR { @{$_[0]} = () }
sub POP { return pop @{$_[0]} }
sub PUSH { my $self = shift; return push @$self, @_ }
sub SHIFT { return shift @{$_[0]} }
sub UNSHIFT { my $self = shift; return unshift @$self, @_ }
sub SPLICE {
    my $self = shift;
    return splice @$self unless @_;
    my $start = shift;
    return splice @$self, $start unless @_;
    my $count = shift;
    return splice @$self, $start, $count, @_;
}

1;
