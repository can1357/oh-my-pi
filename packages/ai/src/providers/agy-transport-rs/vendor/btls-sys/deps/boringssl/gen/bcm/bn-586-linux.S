// This file is generated from a similarly-named Perl script in the BoringSSL
// source tree. Do not edit by hand.

#include <openssl/asm_base.h>

#if !defined(OPENSSL_NO_ASM) && defined(OPENSSL_X86) && defined(__ELF__)
.text
.globl	bn_mul_add_words
.hidden	bn_mul_add_words
.type	bn_mul_add_words,@function
.align	16
bn_mul_add_words:
.L_bn_mul_add_words_begin:
	movl	4(%esp),%eax
	movl	8(%esp),%edx
	movl	12(%esp),%ecx
	movd	16(%esp),%mm0
	pxor	%mm1,%mm1
	jmp	.L000maw_sse2_entry
.align	16
.L001maw_sse2_unrolled:
	movd	(%eax),%mm3
	paddq	%mm3,%mm1
	movd	(%edx),%mm2
	pmuludq	%mm0,%mm2
	movd	4(%edx),%mm4
	pmuludq	%mm0,%mm4
	movd	8(%edx),%mm6
	pmuludq	%mm0,%mm6
	movd	12(%edx),%mm7
	pmuludq	%mm0,%mm7
	paddq	%mm2,%mm1
	movd	4(%eax),%mm3
	paddq	%mm4,%mm3
	movd	8(%eax),%mm5
	paddq	%mm6,%mm5
	movd	12(%eax),%mm4
	paddq	%mm4,%mm7
	movd	%mm1,(%eax)
	movd	16(%edx),%mm2
	pmuludq	%mm0,%mm2
	psrlq	$32,%mm1
	movd	20(%edx),%mm4
	pmuludq	%mm0,%mm4
	paddq	%mm3,%mm1
	movd	24(%edx),%mm6
	pmuludq	%mm0,%mm6
	movd	%mm1,4(%eax)
	psrlq	$32,%mm1
	movd	28(%edx),%mm3
	addl	$32,%edx
	pmuludq	%mm0,%mm3
	paddq	%mm5,%mm1
	movd	16(%eax),%mm5
	paddq	%mm5,%mm2
	movd	%mm1,8(%eax)
	psrlq	$32,%mm1
	paddq	%mm7,%mm1
	movd	20(%eax),%mm5
	paddq	%mm5,%mm4
	movd	%mm1,12(%eax)
	psrlq	$32,%mm1
	paddq	%mm2,%mm1
	movd	24(%eax),%mm5
	paddq	%mm5,%mm6
	movd	%mm1,16(%eax)
	psrlq	$32,%mm1
	paddq	%mm4,%mm1
	movd	28(%eax),%mm5
	paddq	%mm5,%mm3
	movd	%mm1,20(%eax)
	psrlq	$32,%mm1
	paddq	%mm6,%mm1
	movd	%mm1,24(%eax)
	psrlq	$32,%mm1
	paddq	%mm3,%mm1
	movd	%mm1,28(%eax)
	leal	32(%eax),%eax
	psrlq	$32,%mm1
	subl	$8,%ecx
	jz	.L002maw_sse2_exit
.L000maw_sse2_entry:
	testl	$4294967288,%ecx
	jnz	.L001maw_sse2_unrolled
.align	4
.L003maw_sse2_loop:
	movd	(%edx),%mm2
	movd	(%eax),%mm3
	pmuludq	%mm0,%mm2
	leal	4(%edx),%edx
	paddq	%mm3,%mm1
	paddq	%mm2,%mm1
	movd	%mm1,(%eax)
	subl	$1,%ecx
	psrlq	$32,%mm1
	leal	4(%eax),%eax
	jnz	.L003maw_sse2_loop
.L002maw_sse2_exit:
	movd	%mm1,%eax
	emms
	ret
	popl	%edi
	popl	%esi
	popl	%ebx
	popl	%ebp
	ret
.size	bn_mul_add_words,.-.L_bn_mul_add_words_begin
.globl	bn_mul_words
.hidden	bn_mul_words
.type	bn_mul_words,@function
.align	16
bn_mul_words:
.L_bn_mul_words_begin:
	movl	4(%esp),%eax
	movl	8(%esp),%edx
	movl	12(%esp),%ecx
	movd	16(%esp),%mm0
	pxor	%mm1,%mm1
.align	16
.L004mw_sse2_loop:
	movd	(%edx),%mm2
	pmuludq	%mm0,%mm2
	leal	4(%edx),%edx
	paddq	%mm2,%mm1
	movd	%mm1,(%eax)
	subl	$1,%ecx
	psrlq	$32,%mm1
	leal	4(%eax),%eax
	jnz	.L004mw_sse2_loop
	movd	%mm1,%eax
	emms
	ret
	popl	%edi
	popl	%esi
	popl	%ebx
	popl	%ebp
	ret
.size	bn_mul_words,.-.L_bn_mul_words_begin
.globl	bn_sqr_add_words
.hidden	bn_sqr_add_words
.type	bn_sqr_add_words,@function
.align	16
bn_sqr_add_words:
.L_bn_sqr_add_words_begin:
	movl	4(%esp),%eax
	movl	8(%esp),%edx
	movl	12(%esp),%ecx
	pxor	%mm1,%mm1
.align	16
.L005sqr_sse2_loop:
	movd	(%edx),%mm0
	movd	(%eax),%mm2
	movd	4(%eax),%mm3
	pmuludq	%mm0,%mm0
	leal	4(%edx),%edx
	paddq	%mm0,%mm1
	paddq	%mm2,%mm1
	movd	%mm1,(%eax)
	psrlq	$32,%mm1
	paddq	%mm3,%mm1
	movd	%mm1,4(%eax)
	psrlq	$32,%mm1
	subl	$1,%ecx
	leal	8(%eax),%eax
	jnz	.L005sqr_sse2_loop
	emms
	ret
	popl	%edi
	popl	%esi
	popl	%ebx
	popl	%ebp
	ret
.size	bn_sqr_add_words,.-.L_bn_sqr_add_words_begin
.globl	bn_add_words
.hidden	bn_add_words
.type	bn_add_words,@function
.align	16
bn_add_words:
.L_bn_add_words_begin:
	pushl	%ebp
	pushl	%ebx
	pushl	%esi
	pushl	%edi

	movl	20(%esp),%ebx
	movl	24(%esp),%esi
	movl	28(%esp),%edi
	movl	32(%esp),%ebp
	xorl	%eax,%eax
	andl	$4294967288,%ebp
	jz	.L006aw_finish
.L007aw_loop:

	movl	(%esi),%ecx
	movl	(%edi),%edx
	addl	%eax,%ecx
	movl	$0,%eax
	adcl	%eax,%eax
	addl	%edx,%ecx
	adcl	$0,%eax
	movl	%ecx,(%ebx)

	movl	4(%esi),%ecx
	movl	4(%edi),%edx
	addl	%eax,%ecx
	movl	$0,%eax
	adcl	%eax,%eax
	addl	%edx,%ecx
	adcl	$0,%eax
	movl	%ecx,4(%ebx)

	movl	8(%esi),%ecx
	movl	8(%edi),%edx
	addl	%eax,%ecx
	movl	$0,%eax
	adcl	%eax,%eax
	addl	%edx,%ecx
	adcl	$0,%eax
	movl	%ecx,8(%ebx)

	movl	12(%esi),%ecx
	movl	12(%edi),%edx
	addl	%eax,%ecx
	movl	$0,%eax
	adcl	%eax,%eax
	addl	%edx,%ecx
	adcl	$0,%eax
	movl	%ecx,12(%ebx)

	movl	16(%esi),%ecx
	movl	16(%edi),%edx
	addl	%eax,%ecx
	movl	$0,%eax
	adcl	%eax,%eax
	addl	%edx,%ecx
	adcl	$0,%eax
	movl	%ecx,16(%ebx)

	movl	20(%esi),%ecx
	movl	20(%edi),%edx
	addl	%eax,%ecx
	movl	$0,%eax
	adcl	%eax,%eax
	addl	%edx,%ecx
	adcl	$0,%eax
	movl	%ecx,20(%ebx)

	movl	24(%esi),%ecx
	movl	24(%edi),%edx
	addl	%eax,%ecx
	movl	$0,%eax
	adcl	%eax,%eax
	addl	%edx,%ecx
	adcl	$0,%eax
	movl	%ecx,24(%ebx)

	movl	28(%esi),%ecx
	movl	28(%edi),%edx
	addl	%eax,%ecx
	movl	$0,%eax
	adcl	%eax,%eax
	addl	%edx,%ecx
	adcl	$0,%eax
	movl	%ecx,28(%ebx)

	addl	$32,%esi
	addl	$32,%edi
	addl	$32,%ebx
	subl	$8,%ebp
	jnz	.L007aw_loop
.L006aw_finish:
	movl	32(%esp),%ebp
	andl	$7,%ebp
	jz	.L008aw_end

	movl	(%esi),%ecx
	movl	(%edi),%edx
	addl	%eax,%ecx
	movl	$0,%eax
	adcl	%eax,%eax
	addl	%edx,%ecx
	adcl	$0,%eax
	decl	%ebp
	movl	%ecx,(%ebx)
	jz	.L008aw_end

	movl	4(%esi),%ecx
	movl	4(%edi),%edx
	addl	%eax,%ecx
	movl	$0,%eax
	adcl	%eax,%eax
	addl	%edx,%ecx
	adcl	$0,%eax
	decl	%ebp
	movl	%ecx,4(%ebx)
	jz	.L008aw_end

	movl	8(%esi),%ecx
	movl	8(%edi),%edx
	addl	%eax,%ecx
	movl	$0,%eax
	adcl	%eax,%eax
	addl	%edx,%ecx
	adcl	$0,%eax
	decl	%ebp
	movl	%ecx,8(%ebx)
	jz	.L008aw_end

	movl	12(%esi),%ecx
	movl	12(%edi),%edx
	addl	%eax,%ecx
	movl	$0,%eax
	adcl	%eax,%eax
	addl	%edx,%ecx
	adcl	$0,%eax
	decl	%ebp
	movl	%ecx,12(%ebx)
	jz	.L008aw_end

	movl	16(%esi),%ecx
	movl	16(%edi),%edx
	addl	%eax,%ecx
	movl	$0,%eax
	adcl	%eax,%eax
	addl	%edx,%ecx
	adcl	$0,%eax
	decl	%ebp
	movl	%ecx,16(%ebx)
	jz	.L008aw_end

	movl	20(%esi),%ecx
	movl	20(%edi),%edx
	addl	%eax,%ecx
	movl	$0,%eax
	adcl	%eax,%eax
	addl	%edx,%ecx
	adcl	$0,%eax
	decl	%ebp
	movl	%ecx,20(%ebx)
	jz	.L008aw_end

	movl	24(%esi),%ecx
	movl	24(%edi),%edx
	addl	%eax,%ecx
	movl	$0,%eax
	adcl	%eax,%eax
	addl	%edx,%ecx
	adcl	$0,%eax
	movl	%ecx,24(%ebx)
.L008aw_end:
	popl	%edi
	popl	%esi
	popl	%ebx
	popl	%ebp
	ret
.size	bn_add_words,.-.L_bn_add_words_begin
.globl	bn_sub_words
.hidden	bn_sub_words
.type	bn_sub_words,@function
.align	16
bn_sub_words:
.L_bn_sub_words_begin:
	pushl	%ebp
	pushl	%ebx
	pushl	%esi
	pushl	%edi

	movl	20(%esp),%ebx
	movl	24(%esp),%esi
	movl	28(%esp),%edi
	movl	32(%esp),%ebp
	xorl	%eax,%eax
	andl	$4294967288,%ebp
	jz	.L009aw_finish
.L010aw_loop:

	movl	(%esi),%ecx
	movl	(%edi),%edx
	subl	%eax,%ecx
	movl	$0,%eax
	adcl	%eax,%eax
	subl	%edx,%ecx
	adcl	$0,%eax
	movl	%ecx,(%ebx)

	movl	4(%esi),%ecx
	movl	4(%edi),%edx
	subl	%eax,%ecx
	movl	$0,%eax
	adcl	%eax,%eax
	subl	%edx,%ecx
	adcl	$0,%eax
	movl	%ecx,4(%ebx)

	movl	8(%esi),%ecx
	movl	8(%edi),%edx
	subl	%eax,%ecx
	movl	$0,%eax
	adcl	%eax,%eax
	subl	%edx,%ecx
	adcl	$0,%eax
	movl	%ecx,8(%ebx)

	movl	12(%esi),%ecx
	movl	12(%edi),%edx
	subl	%eax,%ecx
	movl	$0,%eax
	adcl	%eax,%eax
	subl	%edx,%ecx
	adcl	$0,%eax
	movl	%ecx,12(%ebx)

	movl	16(%esi),%ecx
	movl	16(%edi),%edx
	subl	%eax,%ecx
	movl	$0,%eax
	adcl	%eax,%eax
	subl	%edx,%ecx
	adcl	$0,%eax
	movl	%ecx,16(%ebx)

	movl	20(%esi),%ecx
	movl	20(%edi),%edx
	subl	%eax,%ecx
	movl	$0,%eax
	adcl	%eax,%eax
	subl	%edx,%ecx
	adcl	$0,%eax
	movl	%ecx,20(%ebx)

	movl	24(%esi),%ecx
	movl	24(%edi),%edx
	subl	%eax,%ecx
	movl	$0,%eax
	adcl	%eax,%eax
	subl	%edx,%ecx
	adcl	$0,%eax
	movl	%ecx,24(%ebx)

	movl	28(%esi),%ecx
	movl	28(%edi),%edx
	subl	%eax,%ecx
	movl	$0,%eax
	adcl	%eax,%eax
	subl	%edx,%ecx
	adcl	$0,%eax
	movl	%ecx,28(%ebx)

	addl	$32,%esi
	addl	$32,%edi
	addl	$32,%ebx
	subl	$8,%ebp
	jnz	.L010aw_loop
.L009aw_finish:
	movl	32(%esp),%ebp
	andl	$7,%ebp
	jz	.L011aw_end

	movl	(%esi),%ecx
	movl	(%edi),%edx
	subl	%eax,%ecx
	movl	$0,%eax
	adcl	%eax,%eax
	subl	%edx,%ecx
	adcl	$0,%eax
	decl	%ebp
	movl	%ecx,(%ebx)
	jz	.L011aw_end

	movl	4(%esi),%ecx
	movl	4(%edi),%edx
	subl	%eax,%ecx
	movl	$0,%eax
	adcl	%eax,%eax
	subl	%edx,%ecx
	adcl	$0,%eax
	decl	%ebp
	movl	%ecx,4(%ebx)
	jz	.L011aw_end

	movl	8(%esi),%ecx
	movl	8(%edi),%edx
	subl	%eax,%ecx
	movl	$0,%eax
	adcl	%eax,%eax
	subl	%edx,%ecx
	adcl	$0,%eax
	decl	%ebp
	movl	%ecx,8(%ebx)
	jz	.L011aw_end

	movl	12(%esi),%ecx
	movl	12(%edi),%edx
	subl	%eax,%ecx
	movl	$0,%eax
	adcl	%eax,%eax
	subl	%edx,%ecx
	adcl	$0,%eax
	decl	%ebp
	movl	%ecx,12(%ebx)
	jz	.L011aw_end

	movl	16(%esi),%ecx
	movl	16(%edi),%edx
	subl	%eax,%ecx
	movl	$0,%eax
	adcl	%eax,%eax
	subl	%edx,%ecx
	adcl	$0,%eax
	decl	%ebp
	movl	%ecx,16(%ebx)
	jz	.L011aw_end

	movl	20(%esi),%ecx
	movl	20(%edi),%edx
	subl	%eax,%ecx
	movl	$0,%eax
	adcl	%eax,%eax
	subl	%edx,%ecx
	adcl	$0,%eax
	decl	%ebp
	movl	%ecx,20(%ebx)
	jz	.L011aw_end

	movl	24(%esi),%ecx
	movl	24(%edi),%edx
	subl	%eax,%ecx
	movl	$0,%eax
	adcl	%eax,%eax
	subl	%edx,%ecx
	adcl	$0,%eax
	movl	%ecx,24(%ebx)
.L011aw_end:
	popl	%edi
	popl	%esi
	popl	%ebx
	popl	%ebp
	ret
.size	bn_sub_words,.-.L_bn_sub_words_begin
#endif  // !defined(OPENSSL_NO_ASM) && defined(OPENSSL_X86) && defined(__ELF__)
