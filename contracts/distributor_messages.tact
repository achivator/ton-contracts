// ---------------------------------------------------------------------------
// Token Distribution Bot — shared messages & wire structs
//
// Architecture: DistributorMaster (registry + TON fee collection) deploys one
// ChatPool per Telegram chat. Pools custody arbitrary third-party jettons,
// credit deposits, pay out claims and let the chat admin withdraw the
// remainder without any backend involvement.
//
// Trust model (hybrid):
//   - off-chain backend tracks activity -> points, and signs vouchers;
//   - on-chain ChatPool enforces signatures, balances and the admin-only
//     withdrawal guarantee.
// ---------------------------------------------------------------------------

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
// sync with the manual parsing in chat_pool.tact. Both fit a single 1023-bit
// cell, so no refs are involved.

// Carried (as a ref) inside JettonTransferNotification.forwardPayload,
// followed by a 512-bit ed25519 signature over the cell hash.
struct DepositVoucher {
    chatId: Int as int64;
    jettonMaster: Address;
    expectedJettonWallet: Address;   // the pool's own jetton wallet (backend-derived)
    tier: Int as uint16;             // chat-size tier, recomputed every deposit
    feeTon: Int as coins;            // flat platform fee in TON for this tier
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

// ---- ChatPool messages ----
message Claim {
    voucherCell: Cell;               // serialised ClaimVoucher
    signature: Slice as remaining;   // 512-bit ed25519 signature over voucherCell.hash()
}

// admin-only, NEVER requires the backend
message WithdrawRemainder {
    jettonMaster: Address;
    amount: Int as coins;
    to: Address;
}

// ---- DistributorMaster messages ----
message CreatePool {
    chatId: Int as int64;
}

message RotateBackendKey {
    backendPubKey: Int as uint256;   // affects pools created afterwards
}

message SetFeeTier {
    tier: Int as uint16;
    depositFeeTon: Int as coins;
}

message WithdrawFee {
    amount: Int as coins;
    to: Address;
}

// pool -> master, carries the TON fee as message value
message CollectFee {
    chatId: Int as int64;
}
