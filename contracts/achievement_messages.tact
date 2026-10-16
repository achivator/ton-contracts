// ---------------------------------------------------------------------------
// Achievement SBTs: messages and wire structs
//
// Topology (all addresses deterministic, all state O(1) per contract):
//
//   AchievementRegistry(owner, backendKey, collectionContent)
//       the TEP-62 collection and the TEP-85 authority. Verifies backend
//       vouchers; stores no per-template or per-mint data.
//   AchievementTemplate(registry, templateKey)
//       one per achievement template: chatTag, creator, contentHash and the
//       TEP-64 content cell. templateKey = hash(chatTag, contentHash).
//   AchievementItem(registry, index)
//       one soulbound item (TEP-85 SBT) per (template, user):
//       index = hash(templateKey, userTag), a uint256.
//
// Mint: user -> registry (voucher) -> template (exists?) -> registry (sender
// is that template?) -> item (deployed bounceable; an item that already
// exists refunds the payer instead). Uniqueness is the item's address, so
// nothing grows on the registry.
//
// Privacy: no contract ever sees a raw Telegram id. The backend passes
//   userTag = HMAC-SHA256(tagKey, "user:" + tgUserId)
//   chatTag = HMAC-SHA256(tagKey, "chat:" + chatId)     (0 = platform-wide)
// as uint256 (miniapp src/lib/ton/achievement-tags.js). The tag key never
// changes: the tags key on-chain uniqueness.
//
// Content model: a template carries a metadata URL (ipfs:// or https) plus a
// SHA-256 over the content bytes. The hash is the anchor: a dead URL can be
// re-hosted with verifiably identical content.
// ---------------------------------------------------------------------------

import "./voucher.tact";

// ---- TEP-62 NFT item messages (standard opcodes) ----
// Only the registry may send this, and only to mint: an SBT has no transfer.
message(0x5fcc3d14) Transfer {
    query_id: Int as uint64;
    new_owner: Address;
    response_destination: Address?;
    custom_payload: Cell?;
    forward_amount: Int as coins;
    forward_payload: Slice as remaining;   // TEP-62 Either: the mint sends a single 0 bit
}

message(0xd53276db) Excesses {
    query_id: Int as uint64;
}

message(0x2fcb26a2) GetStaticData {
    query_id: Int as uint64;
}

message(0x8b771735) ReportStaticData {
    query_id: Int as uint64;
    index: Int as uint256;
    collection: Address;
}

// get_nft_data. Addresses are slices so that a destroyed item can report
// addr_none for its owner (TEP-85).
struct NftData {
    is_initialized: Bool;
    index: Int;
    collection_address: Address;
    owner_address: Slice;
    individual_content: Cell;
}

// ---- TEP-85 SBT messages (standard opcodes) ----
message(0x04ded148) ProveOwnership {
    query_id: Int as uint64;
    dest: Address;
    forward_payload: Cell;
    with_content: Bool;
}

message(0x0524c7ae) OwnershipProof {
    query_id: Int as uint64;
    item_id: Int as uint256;
    owner: Address;
    data: Cell;
    revoked_at: Int as uint64;
    content: Cell?;
}

message(0xc18e86d2) OwnershipProofBounced {
    query_id: Int as uint64;
}

message(0xd0c3bfea) RequestOwner {
    query_id: Int as uint64;
    dest: Address;
    forward_payload: Cell;
    with_content: Bool;
}

message(0x0dd607e3) OwnerInfo {
    query_id: Int as uint64;
    item_id: Int as uint256;
    initiator: Address;
    owner: Address?;                 // addr_none once destroyed
    data: Cell;
    revoked_at: Int as uint64;
    content: Cell?;
}

message(0x1f04537a) Destroy {
    query_id: Int as uint64;
}

message(0x6f89f5e3) Revoke {
    query_id: Int as uint64;
}

// ---- Registry messages ----
// Both carry the voucher by reference and the 512-bit ed25519 signature
// inline (see SignedVoucher in voucher.tact; target = the registry).
message(0xac4e0001) RegisterTemplate {
    voucherCell: Cell;               // serialised RegisterVoucher
    signature: Slice as remaining;
}

message(0xf7b315f8) MintAchievement {
    voucherCell: Cell;               // serialised MintVoucher
    signature: Slice as remaining;
}

// Owner-only administration.
message(0xac4e0005) RotateBackendKey {
    newKey: Int as uint256;
}

message(0xac4e0006) SetPaused {
    paused: Bool;
}

// Two-step ownership transfer: the owner proposes (null cancels), the
// proposed address accepts.
message(0xac4e0007) ProposeOwner {
    newOwner: Address?;
}

message(0xac4e0008) AcceptOwnership {
}

// TEP-85 revoke of one item, by its index (the registry is the authority).
message(0xac4e0009) RevokeAchievement {
    query_id: Int as uint64;
    index: Int as uint256;
}

// ---- Registry <-> template (internal) ----
// registry -> template, with the template's StateInit. The creator pays.
message(0xac4e0002) TemplateInit {
    chatTag: Int as uint256;
    creator: Address;
    contentHash: Int as uint256;
    content: Cell;                   // TEP-64 off-chain cell: 0x01 + URL
}

// registry -> template. The recipient pays (and gets the excess back).
message(0xac4e0003) TemplateMintRequest {
    recipient: Address;
    userTag: Int as uint256;
}

// template -> registry: the template exists; here is its content.
message(0xac4e0004) TemplateMintApproved {
    templateKey: Int as uint256;
    recipient: Address;
    userTag: Int as uint256;
    mint: Cell;                      // ItemContent: contentHash + ^content
}

// ---- Events (external out messages; tags only, never raw ids) ----
message(0xac4e0010) TemplateRegistered {
    templateKey: Int as uint256;
    chatTag: Int as uint256;
    creator: Address;
}

// ---- Wire structs (signed-cell layouts; MUST stay in sync with the manual
// parsing in achievement_registry.tact). Signatures are over a SignedVoucher
// envelope (voucher.tact) with target = the registry address. ----
const VoucherTagRegister: Int = 0x52454731;  // "REG1", target = registry
const VoucherTagMint: Int = 0x4d4e5431;      // "MNT1", target = registry

// The backend signs this only after verifying (initData + Bot API) that the
// registrant administers the chat, and that contentUrl is allowed and
// serves content whose SHA-256 is contentHash. It binds the exact content,
// so the voucher can only ever create one template; replaying it is a no-op.
struct RegisterVoucher {
    chatTag: Int as uint256;         // HMAC tag of the chat; 0 = platform-wide
    registrant: Address;             // must equal the transaction sender
    contentHash: Int as uint256;     // SHA-256 of the metadata JSON
    expiry: Int as uint64;           // at most MaxVoucherTtl ahead
    contentUrl: Cell;                // one cell: 8..126 bytes, ipfs:// or https://
}

// The backend signs this once a user has earned the achievement off-chain.
// No nonce: replay is bounded by expiry, and a second mint of the same
// (template, user) reaches an item that already exists.
struct MintVoucher {
    templateKey: Int as uint256;
    recipient: Address;              // must equal the transaction sender
    userTag: Int as uint256;         // HMAC tag of the Telegram user
    expiry: Int as uint64;           // at most MaxVoucherTtl ahead
}

// The item's custom_payload in the mint Transfer.
struct ItemContent {
    contentHash: Int as uint256;
    content: Cell;
}

// TEP-62 get_collection_data
struct CollectionData {
    next_item_index: Int;            // -1: indexes are hashes, not a sequence
    collection_content: Cell;
    owner_address: Address;
}

// AchievementTemplate.get_template_data
struct TemplateData {
    is_initialized: Bool;
    registry: Address;
    template_key: Int;
    chat_tag: Int;
    creator: Address?;
    content_hash: Int;
    content: Cell?;
}

// Index of the item for (templateKey, userTag): hash of the cell
// uint256 templateKey ++ uint256 userTag.
inline fun achievementItemIndex(templateKey: Int, userTag: Int): Int {
    return beginCell().storeUint(templateKey, 256).storeUint(userTag, 256).endCell().hash();
}

// Key of the template for (chatTag, contentHash): hash of the cell
// uint256 chatTag ++ uint256 contentHash.
inline fun achievementTemplateKey(chatTag: Int, contentHash: Int): Int {
    return beginCell().storeUint(chatTag, 256).storeUint(contentHash, 256).endCell().hash();
}

// addr_none (TEP-62 null address) or the address, as a slice.
fun addressOrNone(a: Address?): Slice {
    if (a == null) {
        return beginCell().storeUint(0, 2).asSlice();
    }
    let addr: Address = a!!;
    return addr.asSlice();
}
