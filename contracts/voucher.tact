// ---------------------------------------------------------------------------
// Backend voucher signatures — shared by ChatPool and AchievementRegistry
// ---------------------------------------------------------------------------

// Domain separation: one backend key signs every voucher kind (deposit,
// claim, admin, and the achievement registry's register/mint), and pools of
// different masters (testnet/mainnet, redeploys) may share that key. The
// signature is therefore NOT over the voucher cell itself but over a
// SignedVoucher envelope that the verifying contract rebuilds from its own
// constants: a per-kind tag plus its own address. A voucher of one kind can
// never be accepted as another kind, and a voucher signed for one contract
// is worthless on any other. Contracts also reject trailing data in the
// voucher cell (endParse), so layouts cannot alias each other.
struct SignedVoucher {
    tag: Int as uint32;              // voucher kind: VoucherTag* constants
    target: Address;                 // the contract that must verify it
    voucher: Cell;                   // the voucher cell itself (as a ref)
}

// Hash the backend signs for a voucher of kind `tag` addressed to `target`.
fun signedVoucherHash(tag: Int, target: Address, voucher: Cell): Int {
    return beginCell()
        .storeUint(tag, 32)
        .storeAddress(target)
        .storeRef(voucher)
        .endCell()
        .hash();
}
