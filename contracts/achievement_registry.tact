import "@stdlib/deploy";
import "@stdlib/ownable";
import "./achievement_messages.tact";
import "./achievement_template.tact";
import "./achievement_item.tact";

// Lowest value a registration must carry: the template's storage reserve
// plus gas and forward fees of registry -> template (with its StateInit) ->
// refund: about 0.0045 TON at mainnet prices (tests/AchievementRegistry.spec.ts),
// so 0.1 leaves a wide margin; the template refunds whatever is left.
const RegisterMinValue: Int = ton("0.1");
// Lowest value a mint must carry: the item's storage reserve plus gas and
// forward fees of registry -> template -> registry -> item (with its
// StateInit) -> refund: about 0.007 TON at mainnet prices (68k gas over four
// transactions, tests/AchievementRegistry.spec.ts). The item refunds
// whatever is left.
const MintMinValue: Int = ton("0.1");
// Upper bound on a voucher's lifetime. Vouchers carry no nonce: a register
// voucher binds its content (replaying it is a no-op) and a mint voucher
// binds an item that can exist only once, so the expiry only limits how long
// a leaked voucher stays usable.
const MaxVoucherTtl: Int = 86400;
// Metadata URL: one cell, no refs, whole bytes, ipfs:// or https://. 126
// bytes so that the TEP-64 content cell (0x01 + URL) is a single cell too.
const MinContentUrlBytes: Int = 8;
const MaxContentUrlBytes: Int = 126;
const SchemeHttps: Int = 0x68747470733a2f2f;   // "https://", 64 bits
const SchemeIpfs: Int = 0x697066733a2f2f;      // "ipfs://", 56 bits

// The AchievementRegistry: the TEP-62 collection of all achievement SBTs
// and their TEP-85 authority. Its storage is O(1): templates live in their
// own contracts and every item at its own address, and uniqueness of a
// (template, user) item is its address. The backend signs vouchers (who
// administers a chat, who earned what); the registry checks them and
// forwards the sender's value down the chain. It takes no fee and has no way
// to pay TON out: everything it keeps is its own storage reserve.
//
// Storage reserve: the deploy value stays (scripts/deployAchievementRegistry.ts
// sends 0.5 TON). The registry, with the template and item code inside, is
// 137 cells, about 0.0089 TON a year at mainnet prices, so 0.5 TON lasts
// about 55 years (tests/AchievementSecurity.spec.ts measures 0.4 TON: 44
// years); under the pre-2026 prices about 9 years. Plain transfers top it
// up.
//
// The owner can rotate the backend key, pause registrations and mints,
// revoke an item (TEP-85) and hand the ownership over in two steps.
contract AchievementRegistry with Ownable {
    owner: Address;
    pendingOwner: Address?;
    backendPubKey: Int as uint256;
    collectionContent: Cell;          // TEP-64 collection metadata
    paused: Bool;

    init(owner: Address, backendPubKey: Int, collectionContent: Cell) {
        self.owner = owner;
        self.pendingOwner = null;
        self.backendPubKey = backendPubKey;
        self.collectionContent = collectionContent;
        self.paused = false;
    }

    // Storage rent top-ups.
    receive() {}

    // Deployment: the value stays as the storage reserve.
    receive(msg: Deploy) {}

    // ---- RegisterTemplate: a chat admin (or the platform) defines one ----
    receive(msg: RegisterTemplate) {
        let ctx: Context = context();
        require(!self.paused, "registry is paused");
        require(checkSignature(signedVoucherHash(VoucherTagRegister, myAddress(), msg.voucherCell), msg.signature, self.backendPubKey),
            "bad register voucher signature");

        let vs: Slice = msg.voucherCell.beginParse();
        let vChatTag: Int = vs.loadUint(256);
        let vRegistrant: Address = vs.loadAddress();
        let vContentHash: Int = vs.loadUint(256);
        let vExpiry: Int = vs.loadUint(64);
        let vUrl: Cell = vs.loadRef();
        vs.endParse();

        self.requireFresh(vExpiry);
        require(ctx.sender == vRegistrant, "only the named admin may register");
        require(ctx.value >= RegisterMinValue, "insufficient value for registration");
        let url: Slice = self.validContentUrl(vUrl);

        let templateKey: Int = achievementTemplateKey(vChatTag, vContentHash);
        let init: StateInit = initOf AchievementTemplate(myAddress(), templateKey);
        send(SendParameters{
            to: contractAddress(init),
            value: 0,
            mode: SendRemainingValue,
            bounce: true,
            body: TemplateInit{
                chatTag: vChatTag,
                creator: ctx.sender,
                contentHash: vContentHash,
                content: beginCell().storeUint(1, 8).storeSlice(url).endCell()
            }.toCell(),
            code: init.code,
            data: init.data
        });
    }

    // ---- MintAchievement: the recipient claims an earned achievement ----
    receive(msg: MintAchievement) {
        let ctx: Context = context();
        require(!self.paused, "registry is paused");
        require(checkSignature(signedVoucherHash(VoucherTagMint, myAddress(), msg.voucherCell), msg.signature, self.backendPubKey),
            "bad mint voucher signature");

        let vs: Slice = msg.voucherCell.beginParse();
        let vTemplateKey: Int = vs.loadUint(256);
        let vRecipient: Address = vs.loadAddress();
        let vUserTag: Int = vs.loadUint(256);
        let vExpiry: Int = vs.loadUint(64);
        vs.endParse();

        self.requireFresh(vExpiry);
        // The recipient pays and gets every refund; nobody else can spend a
        // leaked voucher (AR-12).
        require(ctx.sender == vRecipient, "only the recipient may mint");
        require(ctx.value >= MintMinValue, "insufficient value for mint");

        // Ask the template (it must exist and be registered). It answers
        // with TemplateMintApproved below.
        send(SendParameters{
            to: contractAddress(initOf AchievementTemplate(myAddress(), vTemplateKey)),
            value: 0,
            mode: SendRemainingValue,
            bounce: true,
            body: TemplateMintRequest{recipient: vRecipient, userTag: vUserTag}.toCell()
        });
    }

    // ---- The template's answer: deploy the item ----
    receive(msg: TemplateMintApproved) {
        // Only the template at the address of this key can approve it.
        require(sender() == contractAddress(initOf AchievementTemplate(myAddress(), msg.templateKey)),
            "not a template of this registry");
        let init: StateInit = initOf AchievementItem(myAddress(), achievementItemIndex(msg.templateKey, msg.userTag));
        // Bounceable: if the item cannot take the mint, the value comes back
        // here (see bounced below). An item that already exists does not
        // bounce: it refunds the recipient itself.
        send(SendParameters{
            to: contractAddress(init),
            value: 0,
            mode: SendRemainingValue,
            bounce: true,
            body: Transfer{
                query_id: 0,
                new_owner: msg.recipient,
                response_destination: msg.recipient,
                custom_payload: msg.mint,
                forward_amount: 0,
                forward_payload: beginCell().storeUint(0, 1).asSlice()   // TEP-62 Either: empty, inline
            }.toCell(),
            code: init.code,
            data: init.data
        });
    }

    // A bounced template request (no template at that key) or item mint.
    // A bounce carries no more than 256 bits of the original body, which is
    // not enough for the payer's address, so the value stays here as storage
    // reserve. The backend only signs mints for templates it has seen
    // registered, so this takes a backend error.
    bounced(msg: Slice) {}

    // ---- Owner: TEP-85 revoke ----
    receive(msg: RevokeAchievement) {
        self.requireOwner();
        send(SendParameters{
            to: contractAddress(initOf AchievementItem(myAddress(), msg.index)),
            value: 0,
            mode: SendRemainingValue,
            bounce: true,
            body: Revoke{query_id: msg.query_id}.toCell()
        });
    }

    // ---- Owner: key rotation and pause (AR-6). The attached value stays
    // as storage reserve. ----
    receive(msg: RotateBackendKey) {
        self.requireOwner();
        require(msg.newKey != 0, "backend key is zero");
        require(msg.newKey != self.backendPubKey, "backend key unchanged");
        self.backendPubKey = msg.newKey;
    }

    receive(msg: SetPaused) {
        self.requireOwner();
        self.paused = msg.paused;
    }

    // ---- Owner: two-step ownership transfer (AR-14) ----
    receive(msg: ProposeOwner) {
        self.requireOwner();
        self.pendingOwner = msg.newOwner;
    }

    receive(msg: AcceptOwnership) {
        require(self.pendingOwner != null && sender() == self.pendingOwner!!, "only the proposed owner can accept");
        self.owner = self.pendingOwner!!;
        self.pendingOwner = null;
    }

    fun requireFresh(expiry: Int) {
        require(now() < expiry, "voucher expired");
        require(expiry <= now() + MaxVoucherTtl, "voucher lives too long");
    }

    // The URL must be one ordinary cell with no refs (so its size is bounded
    // exactly), a whole number of bytes, and start with https:// or ipfs://.
    // Which https hosts are allowed is the backend's call before it signs.
    fun validContentUrl(url: Cell): Slice {
        let s: Slice = url.beginParse();
        require(s.refs() == 0, "content url must be one cell");
        let bits: Int = s.bits();
        require(bits % 8 == 0 && bits >= MinContentUrlBytes * 8 && bits <= MaxContentUrlBytes * 8,
            "bad content url length");
        require(s.preloadUint(64) == SchemeHttps || s.preloadUint(56) == SchemeIpfs, "content url must be https or ipfs");
        return s;
    }

    // ---- Getters ----
    get fun version(): Int {
        return ProtocolVersion;
    }

    get fun backendKey(): Int {
        return self.backendPubKey;
    }

    get fun isPaused(): Bool {
        return self.paused;
    }

    get fun pendingOwner(): Address? {
        return self.pendingOwner;
    }

    get fun templateKeyOf(chatTag: Int, contentHash: Int): Int {
        return achievementTemplateKey(chatTag, contentHash);
    }

    get fun templateAddress(templateKey: Int): Address {
        return contractAddress(initOf AchievementTemplate(myAddress(), templateKey));
    }

    get fun itemIndexOf(templateKey: Int, userTag: Int): Int {
        return achievementItemIndex(templateKey, userTag);
    }

    // Where the (template, user) SBT lives. It is minted iff that account
    // reports is_initialized (get_nft_data): the backend's "already minted"
    // check.
    get fun itemAddress(templateKey: Int, userTag: Int): Address {
        return contractAddress(initOf AchievementItem(myAddress(), achievementItemIndex(templateKey, userTag)));
    }

    // ---- TEP-62 collection getters ----
    get fun get_collection_data(): CollectionData {
        return CollectionData{
            next_item_index: -1,
            collection_content: self.collectionContent,
            owner_address: self.owner
        };
    }

    get fun get_nft_address_by_index(index: Int): Address {
        return contractAddress(initOf AchievementItem(myAddress(), index));
    }

    // Items store their full TEP-64 content.
    get fun get_nft_content(index: Int, individual_content: Cell): Cell {
        return individual_content;
    }
}
