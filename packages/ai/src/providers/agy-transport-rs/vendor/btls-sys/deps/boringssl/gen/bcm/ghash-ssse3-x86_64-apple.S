// This file is generated from a similarly-named Perl script in the BoringSSL
// source tree. Do not edit by hand.

#include <openssl/asm_base.h>

#if !defined(OPENSSL_NO_ASM) && defined(OPENSSL_X86_64) && defined(__APPLE__)
.text	






.globl	_gcm_gmult_ssse3
.private_extern _gcm_gmult_ssse3
.p2align	4
_gcm_gmult_ssse3:


_CET_ENDBR
	movdqu	(%rdi),%xmm0
	movdqa	L$reverse_bytes(%rip),%xmm10
	movdqa	L$low4_mask(%rip),%xmm2


	pshufb	%xmm10,%xmm0


	movdqa	%xmm2,%xmm1
	pandn	%xmm0,%xmm1
	psrld	$4,%xmm1
	pand	%xmm2,%xmm0




	pxor	%xmm2,%xmm2
	pxor	%xmm3,%xmm3
	movq	$5,%rax
L$oop_row_1:
	movdqu	(%rsi),%xmm4
	leaq	16(%rsi),%rsi


	movdqa	%xmm2,%xmm6
	palignr	$1,%xmm3,%xmm6
	movdqa	%xmm6,%xmm3
	psrldq	$1,%xmm2




	movdqa	%xmm4,%xmm5
	pshufb	%xmm0,%xmm4
	pshufb	%xmm1,%xmm5


	pxor	%xmm5,%xmm2



	movdqa	%xmm4,%xmm5
	psllq	$60,%xmm5
	movdqa	%xmm5,%xmm6
	pslldq	$8,%xmm6
	pxor	%xmm6,%xmm3


	psrldq	$8,%xmm5
	pxor	%xmm5,%xmm2
	psrlq	$4,%xmm4
	pxor	%xmm4,%xmm2

	subq	$1,%rax
	jnz	L$oop_row_1



	pxor	%xmm3,%xmm2
	psrlq	$1,%xmm3
	pxor	%xmm3,%xmm2
	psrlq	$1,%xmm3
	pxor	%xmm3,%xmm2
	psrlq	$5,%xmm3
	pxor	%xmm3,%xmm2
	pxor	%xmm3,%xmm3
	movq	$5,%rax
L$oop_row_2:
	movdqu	(%rsi),%xmm4
	leaq	16(%rsi),%rsi


	movdqa	%xmm2,%xmm6
	palignr	$1,%xmm3,%xmm6
	movdqa	%xmm6,%xmm3
	psrldq	$1,%xmm2




	movdqa	%xmm4,%xmm5
	pshufb	%xmm0,%xmm4
	pshufb	%xmm1,%xmm5


	pxor	%xmm5,%xmm2



	movdqa	%xmm4,%xmm5
	psllq	$60,%xmm5
	movdqa	%xmm5,%xmm6
	pslldq	$8,%xmm6
	pxor	%xmm6,%xmm3


	psrldq	$8,%xmm5
	pxor	%xmm5,%xmm2
	psrlq	$4,%xmm4
	pxor	%xmm4,%xmm2

	subq	$1,%rax
	jnz	L$oop_row_2



	pxor	%xmm3,%xmm2
	psrlq	$1,%xmm3
	pxor	%xmm3,%xmm2
	psrlq	$1,%xmm3
	pxor	%xmm3,%xmm2
	psrlq	$5,%xmm3
	pxor	%xmm3,%xmm2
	pxor	%xmm3,%xmm3
	movq	$6,%rax
L$oop_row_3:
	movdqu	(%rsi),%xmm4
	leaq	16(%rsi),%rsi


	movdqa	%xmm2,%xmm6
	palignr	$1,%xmm3,%xmm6
	movdqa	%xmm6,%xmm3
	psrldq	$1,%xmm2




	movdqa	%xmm4,%xmm5
	pshufb	%xmm0,%xmm4
	pshufb	%xmm1,%xmm5


	pxor	%xmm5,%xmm2



	movdqa	%xmm4,%xmm5
	psllq	$60,%xmm5
	movdqa	%xmm5,%xmm6
	pslldq	$8,%xmm6
	pxor	%xmm6,%xmm3


	psrldq	$8,%xmm5
	pxor	%xmm5,%xmm2
	psrlq	$4,%xmm4
	pxor	%xmm4,%xmm2

	subq	$1,%rax
	jnz	L$oop_row_3



	pxor	%xmm3,%xmm2
	psrlq	$1,%xmm3
	pxor	%xmm3,%xmm2
	psrlq	$1,%xmm3
	pxor	%xmm3,%xmm2
	psrlq	$5,%xmm3
	pxor	%xmm3,%xmm2
	pxor	%xmm3,%xmm3

	pshufb	%xmm10,%xmm2
	movdqu	%xmm2,(%rdi)


	pxor	%xmm0,%xmm0
	pxor	%xmm1,%xmm1
	pxor	%xmm2,%xmm2
	pxor	%xmm3,%xmm3
	pxor	%xmm4,%xmm4
	pxor	%xmm5,%xmm5
	pxor	%xmm6,%xmm6
	ret









.globl	_gcm_ghash_ssse3
.private_extern _gcm_ghash_ssse3
.p2align	4
_gcm_ghash_ssse3:


_CET_ENDBR
	movdqu	(%rdi),%xmm0
	movdqa	L$reverse_bytes(%rip),%xmm10
	movdqa	L$low4_mask(%rip),%xmm11


	andq	$-16,%rcx



	pshufb	%xmm10,%xmm0


	pxor	%xmm3,%xmm3
L$oop_ghash:

	movdqu	(%rdx),%xmm1
	pshufb	%xmm10,%xmm1
	pxor	%xmm1,%xmm0


	movdqa	%xmm11,%xmm1
	pandn	%xmm0,%xmm1
	psrld	$4,%xmm1
	pand	%xmm11,%xmm0




	pxor	%xmm2,%xmm2

	movq	$5,%rax
L$oop_row_4:
	movdqu	(%rsi),%xmm4
	leaq	16(%rsi),%rsi


	movdqa	%xmm2,%xmm6
	palignr	$1,%xmm3,%xmm6
	movdqa	%xmm6,%xmm3
	psrldq	$1,%xmm2




	movdqa	%xmm4,%xmm5
	pshufb	%xmm0,%xmm4
	pshufb	%xmm1,%xmm5


	pxor	%xmm5,%xmm2



	movdqa	%xmm4,%xmm5
	psllq	$60,%xmm5
	movdqa	%xmm5,%xmm6
	pslldq	$8,%xmm6
	pxor	%xmm6,%xmm3


	psrldq	$8,%xmm5
	pxor	%xmm5,%xmm2
	psrlq	$4,%xmm4
	pxor	%xmm4,%xmm2

	subq	$1,%rax
	jnz	L$oop_row_4



	pxor	%xmm3,%xmm2
	psrlq	$1,%xmm3
	pxor	%xmm3,%xmm2
	psrlq	$1,%xmm3
	pxor	%xmm3,%xmm2
	psrlq	$5,%xmm3
	pxor	%xmm3,%xmm2
	pxor	%xmm3,%xmm3
	movq	$5,%rax
L$oop_row_5:
	movdqu	(%rsi),%xmm4
	leaq	16(%rsi),%rsi


	movdqa	%xmm2,%xmm6
	palignr	$1,%xmm3,%xmm6
	movdqa	%xmm6,%xmm3
	psrldq	$1,%xmm2




	movdqa	%xmm4,%xmm5
	pshufb	%xmm0,%xmm4
	pshufb	%xmm1,%xmm5


	pxor	%xmm5,%xmm2



	movdqa	%xmm4,%xmm5
	psllq	$60,%xmm5
	movdqa	%xmm5,%xmm6
	pslldq	$8,%xmm6
	pxor	%xmm6,%xmm3


	psrldq	$8,%xmm5
	pxor	%xmm5,%xmm2
	psrlq	$4,%xmm4
	pxor	%xmm4,%xmm2

	subq	$1,%rax
	jnz	L$oop_row_5



	pxor	%xmm3,%xmm2
	psrlq	$1,%xmm3
	pxor	%xmm3,%xmm2
	psrlq	$1,%xmm3
	pxor	%xmm3,%xmm2
	psrlq	$5,%xmm3
	pxor	%xmm3,%xmm2
	pxor	%xmm3,%xmm3
	movq	$6,%rax
L$oop_row_6:
	movdqu	(%rsi),%xmm4
	leaq	16(%rsi),%rsi


	movdqa	%xmm2,%xmm6
	palignr	$1,%xmm3,%xmm6
	movdqa	%xmm6,%xmm3
	psrldq	$1,%xmm2




	movdqa	%xmm4,%xmm5
	pshufb	%xmm0,%xmm4
	pshufb	%xmm1,%xmm5


	pxor	%xmm5,%xmm2



	movdqa	%xmm4,%xmm5
	psllq	$60,%xmm5
	movdqa	%xmm5,%xmm6
	pslldq	$8,%xmm6
	pxor	%xmm6,%xmm3


	psrldq	$8,%xmm5
	pxor	%xmm5,%xmm2
	psrlq	$4,%xmm4
	pxor	%xmm4,%xmm2

	subq	$1,%rax
	jnz	L$oop_row_6



	pxor	%xmm3,%xmm2
	psrlq	$1,%xmm3
	pxor	%xmm3,%xmm2
	psrlq	$1,%xmm3
	pxor	%xmm3,%xmm2
	psrlq	$5,%xmm3
	pxor	%xmm3,%xmm2
	pxor	%xmm3,%xmm3
	movdqa	%xmm2,%xmm0


	leaq	-256(%rsi),%rsi


	leaq	16(%rdx),%rdx
	subq	$16,%rcx
	jnz	L$oop_ghash


	pshufb	%xmm10,%xmm0
	movdqu	%xmm0,(%rdi)


	pxor	%xmm0,%xmm0
	pxor	%xmm1,%xmm1
	pxor	%xmm2,%xmm2
	pxor	%xmm3,%xmm3
	pxor	%xmm4,%xmm4
	pxor	%xmm5,%xmm5
	pxor	%xmm6,%xmm6
	ret




.section	__DATA,__const
.p2align	4


L$reverse_bytes:
.byte	15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0

L$low4_mask:
.quad	0x0f0f0f0f0f0f0f0f, 0x0f0f0f0f0f0f0f0f
.text	
#endif
