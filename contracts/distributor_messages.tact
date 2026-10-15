// ---------------------------------------------------------------------------
// Token Distribution Bot — shared messages & wire structs
//
// Architecture: DistributorMaster (pool registry) deploys one ChatPool per
// Telegram chat. Pools custody arbitrary third-party jettons,
// credit deposits, pay out claims and let the chat admin withdraw the
// remainder without any backend involvement.
//
// TON pays for gas and storage only: no contract here takes a platform fee,
// and every handler returns what the sender attached beyond that.
//
// Trust model (hybrid):
//   - off-chain backend tracks activity -> points, and signs vouchers;
//   - on-chain ChatPool enforces signatures, balances and the admin-only
//     withdrawal guarantee.
// ---------------------------------------------------------------------------

import "./voucher.tact";

// ---- Jetton standard (TEP-74) ----
message(0xf8a7ea5) JettonTransfer {
    queryId: Int as uint64;
    amount: Int as coins;
    destination: Address;
    responseDestination: Address?;
    customPayload: Cell?;
    forwardTonAmount: Int as coins;
    forwardPayload: Slice as remaining;
}

message(0x7362d09c) JettonTransferNotification {
    queryId: Int as uint64;
    amount: Int as coins;
    sender: Address;             // the original depositor (chat admin)
    forwardPayload: Slice as remaining;
}

// ---- Jetton wallet discovery (TEP-89) ----
// ChatPool asks a jetton master for its own wallet and trusts only the
// master's answer, never a voucher or a notification (CP-1).
message(0x2c76b973) ProvideWalletAddress {
    queryId: Int as uint64;
    ownerAddress: Address;
    includeAddress: Bool;
}

message(0xd1735400) TakeWalletAddress {
    queryId: Int as uint64;
    walletAddress: Address?;     // addr_none when the master cannot tell
    ownerAddress: Cell?;         // Maybe ^MsgAddress, only if asked for
}

// ---- Wire structs (documentation of the signed-cell layout) ----
//
// These mirror exactly the cells the backend serialises and signs, and the
// order in which ChatPool parses them. Field order and sizes MUST stay in
// sync with the manual parsing in chat_pool.tact. All fit a single 1023-bit
// cell, so no refs are involved.
//
// Signatures are over a SignedVoucher envelope, never the bare voucher cell;
// see voucher.tact for the domain separation rationale.
const VoucherTagDeposit: Int = 0x44455032;   // "DEP2", target = pool (DEP1 carried a fee)
const VoucherTagClaim: Int = 0x434c4d31;     // "CLM1", target = pool
const VoucherTagAdmin: Int = 0x41444d31;     // "ADM1", target = pool
const VoucherTagAdminProposal: Int = 0x41505231; // "APR1", target = pool

// Carried (as a ref) inside JettonTransferNotification.forwardPayload,
// followed by a 512-bit ed25519 signature (see SignedVoucher). Protocol v3
// names no wallet: the pool credits only jettons that arrive from the
// wallet it registered for jettonMaster (RegisterJetton, TEP-89), and only
// when the depositor is the pool admin. (v2 pools still take the v2 layout
// with an expectedJettonWallet after jettonMaster.)
struct DepositVoucher {
    chatId: Int as int64;
    jettonMaster: Address;
    expiry: Int as uint64;
}

// Submitted by the recipient inside a Claim message.
struct ClaimVoucher {
    chatId: Int as int64;
    recipient: Address;
    jettonMaster: Address;
    amount: Int as coins;
    nonce: Int as uint64;            // replay protection
    expiry: Int as uint64;
}

// Admin init / rotation voucher. The backend signs it only after verifying
// (via Telegram initData + Bot API) that the named wallet's owner is a
// current chat administrator. On init the named wallet must claim itself
// (sender() == admin); on rotation the current admin must send the tx.
struct AdminInitVoucher {
    chatId: Int as int64;
    master: Address;                 // binds to this master deployment
    admin: Address;                  // wallet allowed to claim / receive the slot
    expiry: Int as uint64;
}

// Admin recovery voucher (CP-12): the backend signs it only after verifying
// (via Telegram initData + Bot API) that the requester is a current chat
// administrator or the creator, for a pool whose admin wallet is lost or no
// longer theirs. Submitted by the named wallet itself (ProposeAdmin), it
// starts a 7-day timelock that the current admin can cancel. seq must equal
// the pool's adminProposalSeq(), which every cancel and execute bumps, so a
// voucher can start at most one proposal.
struct AdminProposalVoucher {
    chatId: Int as int64;
    newAdmin: Address;
    seq: Int as uint32;
    expiry: Int as uint64;
}

// ---- ChatPool messages ----
// Admin-only, none of them needs the backend.

// Moves tracked jettons out: at most what the ledger holds for the jetton.
message WithdrawRemainder {
    jettonMaster: Address;
    amount: Int as coins;
    to: Address;
}

// Registers the pool's wallet of a jetton: the pool asks the jetton master
// (TEP-89 provide_wallet_address) and registers the wallet from its
// take_wallet_address reply. Needed before the first deposit of a jetton,
// and enough to sweep jettons that reached an unregistered wallet.
message RegisterJetton {
    jettonMaster: Address;
}

// Moves jettons the ledger does not track (strays, kept underfunded
// deposits) out of a registered wallet. The ledger never changes, not even
// on a bounce. Sweeping more than the untracked surplus takes tracked
// jettons with it: the ledger then overstates the wallet and claims for the
// difference bounce, which only the admin can cause, and only to its pool.
message SweepUntracked {
    jettonMaster: Address;
    amount: Int as coins;
    to: Address;
}

// Moves the pool's own TON out (claim storage fees, top-ups), never below
// PoolMinTonReserve.
message WithdrawTon {
    to: Address;
    amount: Int as coins;
}

// ---- Admin-only safety controls. They limit what a leaked backend key can
// do: the key signs claims, but the pool admin caps how much claims can move
// per day, can freeze claims outright, and can move the pool to a new
// backend key. None of this widens the admin's power: the admin can already
// withdraw everything. ----
message SetClaimsPaused {
    paused: Bool;
}

// Per-jetton daily claim budget. 0 restores the default (a share of the
// balance, see DefaultDailyClaimPercent).
message SetClaimLimit {
    jettonMaster: Address;
    dailyLimit: Int as coins;
}

message SetPoolBackendKey {
    backendPubKey: Int as uint256;
}

message Claim {
    voucherCell: Cell;               // serialised ClaimVoucher
    signature: Slice as remaining;   // 512-bit ed25519 signature, see SignedVoucher
}

// Admin recovery, see AdminProposalVoucher. Anyone may execute a proposal
// once its timelock is over; only the current admin may cancel it.
message ProposeAdmin {
    voucherCell: Cell;               // serialised AdminProposalVoucher
    signature: Slice as remaining;   // 512-bit ed25519 signature, see SignedVoucher
}

message CancelAdminProposal {
}

message ExecuteAdminProposal {
}

// Init or rotate the pool admin. Init: the wallet named in the voucher sends
// this itself. Rotation: the current admin sends it, naming the successor;
// it takes effect at once.
message SetAdmin {
    voucherCell: Cell;               // serialised AdminInitVoucher
    signature: Slice as remaining;   // 512-bit ed25519 signature, see SignedVoucher
}

// ---- DistributorMaster messages ----
message CreatePool {
    chatId: Int as int64;
}

message RotateBackendKey {
    backendPubKey: Int as uint256;   // affects pools created afterwards
}

// Master -> pool, with the pool's StateInit: sets the backend key of a new
// pool (its address depends on (master, chatId) only, so it survives key
// rotation). Accepted only from the master, and only once; a repeated
// CreatePool hands the value back to excessTo.
message InitPool {
    backendPubKey: Int as uint256;
    excessTo: Address;               // whoever paid for the CreatePool
}

// Two-step ownership transfer of the master: the owner proposes (null
// withdraws a proposal), the proposed wallet accepts.
message ProposeOwner {
    newOwner: Address?;
}

message AcceptOwnership {
}

// TEP-74 excess notification: carries TON back to whoever overpaid.
message(0xd53276db) TonExcesses {
    queryId: Int as uint64;
}
