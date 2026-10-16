import "./achievement_messages.tact";

// Storage reserve the item keeps from its mint value. Rent depends on the
// cell count only (mainnet config param 18 since 2026-04-29: 0 per bit, 135
// per cell per 2^16 s). The minted item is 47 cells, about 0.0031 TON a
// year, so 0.04 TON covers about 13 years (measured in
// tests/AchievementSecurity.spec.ts); under the pre-2026 prices (1 per bit,
// 500 per cell) it would cover about 2 years. Anyone can top the item up
// with a plain transfer (empty body), and nothing but the owner's destroy
// ever pays a top-up out. A frozen item still blocks a second mint.
const ItemMinTonForStorage: Int = ton("0.04");
// raw_reserve mode: reserve at most the amount (never fail on a low balance)
const ReserveAtMost: Int = 2;

// TEP-62 NFT item and TEP-85 soulbound token. The AchievementRegistry is its
// collection and its authority. The registry deploys it with a TEP-62
// Transfer (the mint) whose custom_payload is an ItemContent:
//     uint256 contentHash, ref(content)
// where content is a TEP-64 off-chain cell (0x01 + metadata URL). After
// that, nobody can transfer it: the owner can only prove ownership or
// destroy it, and the authority can revoke it.
contract AchievementItem {
    registry: Address;               // TEP-62 collection, TEP-85 authority
    index: Int as uint256;           // hash(templateKey, userTag)
    isInitialized: Bool;
    owner: Address?;                 // null before the mint and after destroy
    hasAuthority: Bool;              // false after destroy (TEP-85)
    revokedAt: Int as uint64;        // 0 = not revoked
    contentHash: Int as uint256;     // SHA-256 of the metadata JSON
    content: Cell?;

    init(registry: Address, index: Int) {
        self.registry = registry;
        self.index = index;
        self.isInitialized = false;
        self.owner = null;
        self.hasAuthority = true;
        self.revokedAt = 0;
        self.contentHash = 0;
        self.content = null;
    }

    // Storage rent top-ups, from anyone.
    receive() {}

    // The mint. Only the registry sends Transfer, and only once per item:
    // a second mint of the same (template, user) arrives here too, and its
    // value goes back to the payer untouched.
    receive(msg: Transfer) {
        let ctx: Context = context();
        require(ctx.sender == self.registry, "SBT is not transferable");
        if (self.isInitialized) {
            // Already minted (or destroyed): refund the duplicate mint.
            send(SendParameters{
                to: msg.response_destination!!,
                value: 0,
                mode: SendRemainingValue + SendIgnoreErrors,
                bounce: false,
                body: Excesses{query_id: msg.query_id}.toCell()
            });
            return;
        }
        // ItemContent: uint256 contentHash, ref(content)
        let payload: Cell = msg.custom_payload!!;
        let cp: Slice = payload.beginParse();
        self.isInitialized = true;
        self.owner = msg.new_owner;
        self.contentHash = cp.loadUint(256);
        self.content = cp.loadRef();

        // Keep the reserve out of the mint value, plus whatever the address
        // held before (a third party's top-up), and refund the rest.
        nativeReserve(myBalance() - ctx.value + ItemMinTonForStorage, ReserveAtMost);
        send(SendParameters{
            to: msg.response_destination!!,
            value: 0,
            mode: SendRemainingBalance + SendIgnoreErrors,
            bounce: false,
            body: Excesses{query_id: msg.query_id}.toCell()
        });
    }

    receive(msg: GetStaticData) {
        send(SendParameters{
            to: sender(),
            value: 0,
            mode: SendRemainingValue,
            bounce: true,
            body: ReportStaticData{query_id: msg.query_id, index: self.index, collection: self.registry}.toCell()
        });
    }

    // TEP-85: the owner proves ownership to `dest`. Replies carry only the
    // incoming value (mode 64), so the forward fees of a large payload come
    // out of the sender's value, never out of the reserve.
    receive(msg: ProveOwnership) {
        require(self.owner != null && sender() == self.owner!!, "only the owner can prove ownership");
        send(SendParameters{
            to: msg.dest,
            value: 0,
            mode: SendRemainingValue,
            bounce: true,
            body: OwnershipProof{
                query_id: msg.query_id,
                item_id: self.index,
                owner: self.owner!!,
                data: msg.forward_payload,
                revoked_at: self.revokedAt,
                content: self.contentIf(msg.with_content)
            }.toCell()
        });
    }

    // TEP-85: anyone asks the item to tell `dest` who owns it.
    receive(msg: RequestOwner) {
        require(self.isInitialized, "not minted");
        send(SendParameters{
            to: msg.dest,
            value: 0,
            mode: SendRemainingValue,
            bounce: true,
            body: OwnerInfo{
                query_id: msg.query_id,
                item_id: self.index,
                initiator: sender(),
                owner: self.owner,
                data: msg.forward_payload,
                revoked_at: self.revokedAt,
                content: self.contentIf(msg.with_content)
            }.toCell()
        });
    }

    // TEP-85: the owner destroys the SBT. Like the reference implementation,
    // the item pays out its whole balance to the owner and keeps no owner
    // and no authority. It stays initialised: the same (template, user) can
    // never be minted again while the account exists.
    receive(msg: Destroy) {
        require(self.owner != null && sender() == self.owner!!, "only the owner can destroy");
        self.owner = null;
        self.hasAuthority = false;
        send(SendParameters{
            to: sender(),
            value: 0,
            mode: SendRemainingBalance,
            bounce: false,
            body: Excesses{query_id: msg.query_id}.toCell()
        });
    }

    // TEP-85: the authority (the registry, on its owner's request) revokes.
    // The attached value stays on the item as a top-up.
    receive(msg: Revoke) {
        require(self.hasAuthority && sender() == self.registry, "only the authority can revoke");
        require(self.isInitialized, "not minted");
        require(self.revokedAt == 0, "already revoked");
        self.revokedAt = now();
    }

    // TEP-85: a bounced ownership proof is reported to the owner.
    bounced(msg: bounced<OwnershipProof>) {
        if (self.owner != null) {
            send(SendParameters{
                to: self.owner!!,
                value: 0,
                mode: SendRemainingValue,
                bounce: false,
                body: OwnershipProofBounced{query_id: msg.query_id}.toCell()
            });
        }
    }

    // TEP-85 with_content: the content cell, or nothing.
    fun contentIf(withContent: Bool): Cell? {
        if (withContent) {
            return self.content;
        }
        return null;
    }

    get fun get_nft_data(): NftData {
        let content: Cell = emptyCell();
        if (self.content != null) {
            content = self.content!!;
        }
        return NftData{
            is_initialized: self.isInitialized,
            index: self.index,
            collection_address: self.registry,
            owner_address: addressOrNone(self.owner),
            individual_content: content
        };
    }

    get fun get_authority_address(): Slice {
        if (self.hasAuthority) {
            return self.registry.asSlice();
        }
        return addressOrNone(null);
    }

    get fun get_revoked_time(): Int {
        return self.revokedAt;
    }

    // SHA-256 of the metadata JSON the content URL must serve.
    get fun get_content_hash(): Int {
        return self.contentHash;
    }
}
