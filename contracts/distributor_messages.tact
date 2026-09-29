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

// Carried (as a ref) inside JettonTransferNotification.forwardPayload,
// followed by a 512-bit ed25519 signature (see SignedVoucher).
struct DepositVoucher {
    chatId: Int as int64;
    jettonMaster: Address;
    expectedJettonWallet: Address;   // the pool's own jetton wallet (backend-derived)
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

// ---- ChatPool messages ----
// admin-only, NEVER requires the backend
message WithdrawRemainder {
    jettonMaster: Address;
    amount: Int as coins;
    to: Address;
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

// Init or rotate the pool admin. Init: the wallet named in the voucher sends
// this itself. Rotation: the current admin sends it, naming the successor.
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

// TEP-74 excess notification: carries TON back to whoever overpaid.
message(0xd53276db) TonExcesses {
    queryId: Int as uint64;
}
