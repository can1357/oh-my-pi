package Tie::Scalar;
our $VERSION = '1.05';

sub TIESCALAR {
    my $class = shift;
    my $legacy = $class->can('new');
    return $class->new(@_) if $legacy && $legacy != \&Tie::Scalar::new;
    die "$class doesn't define a TIESCALAR method";
}

sub new {
    my $class = shift;
    my $constructor = $class->can('TIESCALAR');
    return $class->TIESCALAR(@_) if $constructor && $constructor != \&Tie::Scalar::TIESCALAR;
    die "$class must define either a TIESCALAR() or a new() method";
}

sub FETCH { die ref($_[0]) . " doesn't define a FETCH method" }
sub STORE { die ref($_[0]) . " doesn't define a STORE method" }

package Tie::StdScalar;
our @ISA = ('Tie::Scalar');

sub TIESCALAR {
    my ($class, $initial) = @_;
    return bless \$initial, $class;
}

sub FETCH { return ${$_[0]} }
sub STORE { ${$_[0]} = $_[1] }
sub DESTROY { }

1;
