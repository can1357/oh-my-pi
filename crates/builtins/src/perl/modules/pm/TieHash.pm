package Tie::Hash;
our $VERSION = '1.05';

sub TIEHASH {
    my $class = shift;
    my $legacy = $class->can('new');
    return $class->new(@_) if $legacy && $legacy != \&Tie::Hash::new;
    die "$class doesn't define a TIEHASH method";
}

sub new {
    my $class = shift;
    my $constructor = $class->can('TIEHASH');
    return $class->TIEHASH(@_) if $constructor && $constructor != \&Tie::Hash::TIEHASH;
    die "$class must define either a TIEHASH() or a new() method";
}

sub CLEAR {
    my $self = shift;
    my @keys;
    my $key = $self->FIRSTKEY();
    while (defined $key) {
        push @keys, $key;
        $key = $self->NEXTKEY($key);
    }
    $self->DELETE($_) for @keys;
    return;
}

sub EXISTS { die ref($_[0]) . " doesn't define an EXISTS method" }

package Tie::StdHash;

sub TIEHASH { return bless {}, $_[0] }
sub FETCH { return $_[0]->{$_[1]} }
sub STORE { $_[0]->{$_[1]} = $_[2] }
sub DELETE { return delete $_[0]->{$_[1]} }
sub EXISTS { return exists $_[0]->{$_[1]} }
sub CLEAR { %{$_[0]} = () }
sub SCALAR { return scalar %{$_[0]} }
sub FIRSTKEY { keys %{$_[0]}; return scalar each %{$_[0]} }
sub NEXTKEY { return scalar each %{$_[0]} }

package Tie::ExtraHash;

sub TIEHASH { my $class = shift; return bless [{}, @_], $class }
sub FETCH { return $_[0]->[0]->{$_[1]} }
sub STORE { $_[0]->[0]->{$_[1]} = $_[2] }
sub DELETE { return delete $_[0]->[0]->{$_[1]} }
sub EXISTS { return exists $_[0]->[0]->{$_[1]} }
sub CLEAR { %{$_[0]->[0]} = () }
sub SCALAR { return scalar %{$_[0]->[0]} }
sub FIRSTKEY { keys %{$_[0]->[0]}; return scalar each %{$_[0]->[0]} }
sub NEXTKEY { return scalar each %{$_[0]->[0]} }

1;
