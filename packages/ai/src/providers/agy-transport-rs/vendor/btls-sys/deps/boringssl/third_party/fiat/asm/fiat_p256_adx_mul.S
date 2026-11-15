#include <openssl/asm_base.h>

#if !defined(OPENSSL_NO_ASM) && defined(OPENSSL_X86_64) && \
    (defined(__APPLE__) || defined(__ELF__))

.text
#if defined(__APPLE__)
.private_extern _fiat_p256_adx_mul
.global _fiat_p256_adx_mul
_fiat_p256_adx_mul:
#else
.type fiat_p256_adx_mul, @function
.hidden fiat_p256_adx_mul
.global fiat_p256_adx_mul
fiat_p256_adx_mul:
#endif

.cfi_startproc
_CET_ENDBR
pushq %rbp
;.cfi_adjust_cfa_offset 8
.cfi_offset rbp, -16
movq %rsp, %rbp
movq %rdx, %rax
movq (%rsi), %rdx
testb %al, %al
mulxq (%rax), %rcx, %r8
movq %rbx, -0x80(%rsp)
.cfi_offset rbx, -16-0x80
mulxq 0x8(%rax), %r9, %rbx
movq %r14, -0x68(%rsp)
.cfi_offset r14, -16-0x68
adcq %r8, %r9
movq %r15, -0x60(%rsp)
.cfi_offset r15, -16-0x60
mulxq 0x10(%rax), %r14, %r15
movq %r12, -0x78(%rsp)
.cfi_offset r12, -16-0x78
adcq %rbx, %r14
mulxq 0x18(%rax), %r10, %r11
movq %r13, -0x70(%rsp)
.cfi_offset r13, -16-0x70
adcq %r15, %r10
movq 0x8(%rsi), %rdx
mulxq (%rax), %r8, %rbx
adcq $0x0, %r11
xorq %r15, %r15
adcxq %r9, %r8
adoxq %r14, %rbx
movq %rdi, -0x58(%rsp)
mulxq 0x8(%rax), %r9, %rdi
adcxq %rbx, %r9
adoxq %r10, %rdi
mulxq 0x10(%rax), %r14, %rbx
adcxq %rdi, %r14
adoxq %r11, %rbx
mulxq 0x18(%rax), %r12, %r13
adcxq %rbx, %r12
movq $0x100000000, %rdx
mulxq %rcx, %r10, %r11
adoxq %r15, %r13
adcxq %r15, %r13
xorq %rdi, %rdi
adoxq %r8, %r10
mulxq %r10, %rbx, %r8
adoxq %r9, %r11
adcxq %r11, %rbx
adoxq %r14, %r8
movq $0xffffffff00000001, %rdx
mulxq %rcx, %r15, %r9
adcxq %r8, %r15
adoxq %r12, %r9
mulxq %r10, %rcx, %r14
movq 0x10(%rsi), %rdx
mulxq 0x8(%rax), %r12, %r10
adcxq %r9, %rcx
adoxq %r13, %r14
mulxq (%rax), %r13, %r11
movq %rdi, %r9
adcxq %r9, %r14
adoxq %rdi, %rdi
adcq $0x0, %rdi
xorq %r9, %r9
adcxq %rbx, %r13
adoxq %r15, %r11
movq 0x10(%rsi), %rdx
mulxq 0x10(%rax), %r8, %r15
adoxq %rcx, %r10
mulxq 0x18(%rax), %rbx, %rcx
movq 0x18(%rsi), %rdx
adcxq %r11, %r12
mulxq 0x8(%rax), %r11, %rsi
adcxq %r10, %r8
adoxq %r14, %r15
adcxq %r15, %rbx
adoxq %r9, %rcx
adcxq %r9, %rcx
mulxq (%rax), %r10, %r15
addq %rdi, %rcx
movq %r9, %r14
adcq $0x0, %r14
xorq %r9, %r9
adcxq %r12, %r10
adoxq %r8, %r15
adcxq %r15, %r11
adoxq %rbx, %rsi
mulxq 0x10(%rax), %r12, %r8
adoxq %rcx, %r8
mulxq 0x18(%rax), %rbx, %rcx
adcxq %rsi, %r12
adoxq %r9, %rcx
movq $0x100000000, %rdx
adcxq %r8, %rbx
adcq $0x0, %rcx
mulxq %r13, %r15, %rdi
xorq %rax, %rax
adcxq %r14, %rcx
adcq $0x0, %rax
xorq %r9, %r9
adoxq %r10, %r15
mulxq %r15, %r10, %r14
adoxq %r11, %rdi
movq $0xffffffff00000001, %rdx
adoxq %r12, %r14
adcxq %rdi, %r10
mulxq %r13, %r11, %r12
adcxq %r14, %r11
adoxq %rbx, %r12
mulxq %r15, %r13, %rbx
adcxq %r12, %r13
adoxq %rcx, %rbx
movq %r9, %r8
adoxq %r9, %rax
adcxq %rbx, %r8
adcq $0x0, %rax
movq %rax, %rcx
movq $0xffffffffffffffff, %r15
movq %r10, %rdi
subq %r15, %rdi
movq $0xffffffff, %r14
movq %r11, %r12
sbbq %r14, %r12
movq %r13, %rbx
sbbq %r9, %rbx
movq %rax, %rax
movq %r8, %rax
sbbq %rdx, %rax
sbbq %r9, %rcx
cmovcq %r10, %rdi
movq -0x58(%rsp), %r10
cmovcq %r13, %rbx
movq -0x70(%rsp), %r13
.cfi_restore r13
cmovcq %r11, %r12
cmovcq %r8, %rax
movq %rbx, 0x10(%r10)
movq -0x80(%rsp), %rbx
.cfi_restore rbx
movq %rdi, (%r10)
movq %r12, 0x8(%r10)
movq %rax, 0x18(%r10)
movq -0x78(%rsp), %r12
.cfi_restore r12
movq -0x68(%rsp), %r14
.cfi_restore r14
movq -0x60(%rsp), %r15
.cfi_restore r15
popq %rbp
.cfi_restore rbp
.cfi_adjust_cfa_offset -8
retq
.cfi_endproc
#if defined(__ELF__)
.size fiat_p256_adx_mul, .-fiat_p256_adx_mul
#endif

#endif
