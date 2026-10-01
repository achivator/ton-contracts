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

// Version of the protocol this code speaks: the voucher layouts and the
// fees. Every contract reports it through `version()`, so the backend can
// refuse to sign a voucher a contract would reject (contracts are immutable,
// an old pool keeps its old layouts). 1 is implied for contracts without the
// getter (the DEP1 deposit voucher with a fee); 2 dropped every TON fee.
const ProtocolVersion: Int = 2;

// Hash the backend signs for a voucher of kind `tag` addressed to `target`.
fun signedVoucherHash(tag: Int, target: Address, voucher: Cell): Int {
    return beginCell()
        .storeUint(tag, 32)
        .storeAddress(target)
        .storeRef(voucher)
        .endCell()
        .hash();
}
