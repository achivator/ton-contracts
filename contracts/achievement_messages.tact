// ---------------------------------------------------------------------------
// Achievement NFT registry — messages & wire structs
//
// Architecture: one global AchievementRegistry stores achievement templates
// (admin-defined, per Telegram chat) and mints TEP-62 items on backend
// vouchers, mirroring the ChatPool trust model: the backend attests
// eligibility off-chain, the contract enforces signatures and uniqueness.
// No fees: senders pay gas and the storage rent of what they add.
//
// Content model: a template carries a metadata URL (admin-hosted or IPFS)
// plus a SHA-256 over the content bytes. The hash is the anchor — a dead
// URL can be re-hosted with verifiably identical content, so no host (and
// no platform) is a single point of failure for what an achievement looks
// like.
// ---------------------------------------------------------------------------

import "./voucher.tact";

// ---- TEP-62 NFT item messages (standard opcodes) ----
message(0x5fcc3d14) Transfer {
    query_id: Int as uint64;
    new_owner: Address;
    response_destination: Address?;
    custom_payload: Cell?;
    forward_amount: Int as coins;
    forward_payload: Slice as remaining;
}

message(0x05138d91) OwnershipAssigned {
    query_id: Int as uint64;
    prev_owner: Address;
    forward_payload: Slice as remaining;
}

message(0xd53276db) Excesses {
    query_id: Int as uint64;
}

message(0x2fcb26a2) GetStaticData {
    query_id: Int as uint64;
}

message(0x8b771735) ReportStaticData {
    query_id: Int as uint64;
    index_id: Int;
    collection: Address;
}

struct GetNftData {
    is_initialized: Bool;
    index: Int;
    collection_address: Address;
    owner_address: Address;
    individual_content: Cell;
}

// ---- TEP-74 royalty messages (queried on the item, since royalty is
// per-template, not per-collection) ----
message(0x693d3950) GetRoyaltyParams {
    query_id: Int as uint64;
}

message(0xa8cb00ad) ReportRoyaltyParams {
    query_id: Int as uint64;
    numerator: Int as uint16;
    denominator: Int as uint16;
    destination: Address;
}

// ---- Registry events ----
message TemplateRegistered {
    templateId: Int as uint32;
    chatId: Int as int64;
    creator: Address;
}

message AchievementMinted {
    templateId: Int as uint32;
    itemIndex: Int as uint32;
    recipient: Address;
    tgUserId: Int as int64;
}

// ---- Registry messages ----
// NOTE: RegisterTemplate carries its signature in a ref: inline it would not
// fit (32 op + 256 hash + 299 royalty + 512 signature = 1099 > 1023 bits).
message RegisterTemplate {
    contentUrl: String;              // metadata JSON URL (https or ipfs)
    contentHash: Int as uint256;     // sha-256 over the content bytes
    royalty: RoyaltyParams;          // secondary-sale royalty, destination chosen by the admin
    voucherCell: Cell;               // serialised RegisterVoucher
    signature: Cell;                 // 512-bit ed25519, see SignedVoucher
}

message MintAchievement {
    voucherCell: Cell;               // serialised MintVoucher
    signature: Slice as remaining;   // 512-bit ed25519, see SignedVoucher
}

// ---- Wire structs (signed-cell layouts; MUST stay in sync with the manual
// parsing in achievement_registry.tact). Signatures are over a SignedVoucher
// envelope (voucher.tact) with target = the registry address. ----
const VoucherTagRegister: Int = 0x52454731;  // "REG1", target = registry
const VoucherTagMint: Int = 0x4d4e5431;      // "MNT1", target = registry

// The backend signs this only after verifying (initData + Bot API) that the
// registrant is a current administrator of the chat.
struct RegisterVoucher {
    chatId: Int as int64;
    registrant: Address;             // must equal the transaction sender
    expiry: Int as uint64;
}

// The backend signs this once a user has earned the achievement off-chain.
struct MintVoucher {
    templateId: Int as uint32;
    recipient: Address;
    tgUserId: Int as int64;
    nonce: Int as uint64;            // replay protection
    expiry: Int as uint64;
}

// ---- Registry storage ----
struct RoyaltyParams {
    numerator: Int as uint16;
    denominator: Int as uint16;
    destination: Address;
}

struct Template {
    chatId: Int as int64;
    creator: Address;
    contentUrl: String;
    contentHash: Int as uint256;
    royalty: RoyaltyParams;
    mintedCount: Int as uint32;
}

// TEP-62 get_collection_data
struct CollectionData {
    next_item_index: Int;
    collection_content: Cell;
    owner_address: Address;
}
