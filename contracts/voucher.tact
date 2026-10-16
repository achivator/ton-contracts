// ---------------------------------------------------------------------------
// Backend voucher signatures — shared by ChatPool and AchievementRegistry
// ---------------------------------------------------------------------------

// Domain separation: one backend key signs every voucher kind (deposit,
// claim, admin, and the achievement registry's register/mint). The signature
// is therefore NOT over the voucher cell itself but over a SignedVoucher
// envelope that the verifying contract rebuilds from what it knows on-chain:
// a per-kind tag, the network's global id and its own address. A voucher of
// one kind can never be accepted as another kind, a voucher signed for one
// contract is worthless on any other, and a voucher signed for one network is
// worthless on another. Contracts also reject trailing data in the voucher
// cell (endParse), so layouts cannot alias each other.
//
// The network binding matters because addresses do NOT tell the networks
// apart: the same owner wallet and backend key give a master, its pools and
// the registry the very same address on testnet and mainnet. The global id
// keeps a testnet voucher off mainnet even then. Still, use a separate
// backend key per network: a testnet key is handled far more loosely, and a
// leak of a shared key would hand over both networks.
struct SignedVoucher {
    tag: Int as uint32;              // voucher kind: VoucherTag* constants
    globalId: Int as int32;          // network: config param 19 (-239 mainnet, -3 testnet)
    target: Address;                 // the contract that must verify it
    voucher: Cell;                   // the voucher cell itself (as a ref)
}

// Version of the protocol this code speaks: the voucher layouts, the
// envelope and the fees. Every contract reports it through `version()`, so
// the backend can refuse to sign a voucher a contract would reject (contracts
// are immutable, an old pool keeps its old layouts). 1 is implied for
// contracts without the getter (the DEP1 deposit voucher with a fee); 2
// dropped every TON fee; 3 binds the envelope to the network (globalId).
const ProtocolVersion: Int = 3;

// Global id of the network this contract runs on: config param 19, a signed
// 32-bit integer (-239 on mainnet, -3 on testnet). Reading it walks the
// config dictionary: about 1,230 gas (~0.0005 TON) per verified voucher.
// (The GLOBALID opcode would be cheaper, but the Fift assembler and the
// disassembler bundled with Tact 1.2.0 do not know it.)
inline fun networkGlobalId(): Int {
    let param: Cell = getConfigParam(19)!!;
    let s: Slice = param.beginParse();
    return s.loadInt(32);
}

// Hash the backend signs for a voucher of kind `tag` addressed to `target`
// on this network.
fun signedVoucherHash(tag: Int, target: Address, voucher: Cell): Int {
    return beginCell()
        .storeUint(tag, 32)
        .storeInt(networkGlobalId(), 32)
        .storeAddress(target)
        .storeRef(voucher)
        .endCell()
        .hash();
}
