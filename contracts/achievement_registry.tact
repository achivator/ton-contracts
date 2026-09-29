import "@stdlib/deploy";
import "@stdlib/ownable";
import "@stdlib/content";
import "./achievement_messages.tact";
import "./achievement_item.tact";

// Storage rent the registry keeps for what a message adds to its state, so a
// busy registry never rents itself into freezing (about 0.002 TON/year for a
// template, 0.001 for the two map entries of a mint). Not a platform fee: no
// one can take TON out of the registry.
const RegisterStorageFee: Int = ton("0.01");
const MintStorageFee: Int = ton("0.004");
const MintItemValue: Int = ton("0.05");   // forwarded to the item: gas + storage
// Registry gas per message, paid by the sender on top of the rent; whatever
// is left over is refunded.
const RegistryGas: Int = ton("0.05");
// Metadata URL cap: at most two cells of the snake string (~250 bytes). The
// URL lives in registry storage forever and every mint copies it.
const MaxContentUrlCells: Int = 2;

// One global registry of per-chat achievement templates. The backend signs
// vouchers (who is a chat admin, who earned what); the contract enforces
// signatures and per-user-per-template uniqueness. It takes no fee and has no
// way to pay TON out: the sender covers gas and the storage rent of what they
// add, and gets the rest back. The owner is only the TEP-62 collection owner,
// with no moderation power.
contract AchievementRegistry with Deployable, Ownable {
    owner: Address;
    backendPubKey: Int as uint256;
    collectionContent: Cell;          // TEP-64 collection metadata

    nextTemplateId: Int as uint32 = 0;
    nextItemIndex: Int as uint32 = 0;
    templates: map<Int, Template>;
    usedNonces: map<Int, Bool>;
    mintedUsers: map<Int, Bool>;      // composite key: templateId * 2^64 + tgUserId

    init(owner: Address, backendPubKey: Int, collectionContent: Cell) {
        self.owner = owner;
        self.backendPubKey = backendPubKey;
        self.collectionContent = collectionContent;
    }

    // Storage rent top-ups.
    receive() {}

    // ---- RegisterTemplate: the chat admin defines an achievement ----
    receive(msg: RegisterTemplate) {
        let ctx: Context = context();
        require(checkSignature(signedVoucherHash(VoucherTagRegister, myAddress(), msg.voucherCell), msg.signature.beginParse(), self.backendPubKey),
            "bad register voucher signature");

        let vs: Slice = msg.voucherCell.beginParse();
        let vChatId: Int = vs.loadInt(64);
        let vRegistrant: Address = vs.loadAddress();
        let vExpiry: Int = vs.loadUint(64);
        vs.endParse();

        require(now() < vExpiry, "voucher expired");
        require(ctx.sender == vRegistrant, "only the named admin may register");
        // denominator 0 would make every marketplace divide by zero
        require(msg.royalty.denominator > 0, "royalty denominator is zero");
        require(msg.royalty.numerator <= msg.royalty.denominator, "royalty numerator exceeds denominator");
        require(self.snakeCells(msg.contentUrl.asSlice()) <= MaxContentUrlCells, "content url too long");
        require(ctx.value >= RegisterStorageFee + RegistryGas, "insufficient value for registration");

        self.templates.set(self.nextTemplateId, Template{
            chatId: vChatId,
            creator: ctx.sender,
            contentUrl: msg.contentUrl,
            contentHash: msg.contentHash,
            royalty: msg.royalty,
            mintedCount: 0
        });
        emit(TemplateRegistered{templateId: self.nextTemplateId, chatId: vChatId, creator: ctx.sender}.toCell());
        self.nextTemplateId = self.nextTemplateId + 1;

        self.keepRentRefundRest(ctx, RegisterStorageFee);
    }

    // ---- MintAchievement: the recipient claims an earned achievement ----
    receive(msg: MintAchievement) {
        let ctx: Context = context();
        require(checkSignature(signedVoucherHash(VoucherTagMint, myAddress(), msg.voucherCell), msg.signature, self.backendPubKey),
            "bad mint voucher signature");

        let vs: Slice = msg.voucherCell.beginParse();
        let vTemplateId: Int = vs.loadUint(32);
        let vRecipient: Address = vs.loadAddress();
        let vTgUserId: Int = vs.loadInt(64);
        let vNonce: Int = vs.loadUint(64);
        let vExpiry: Int = vs.loadUint(64);
        vs.endParse();

        require(now() < vExpiry, "voucher expired");
        require(self.usedNonces.get(vNonce) == null, "voucher already used");

        let tmpl: Template? = self.templates.get(vTemplateId);
        require(tmpl != null, "unknown template");

        // Defense in depth: even a replayed-but-refreshed voucher cannot mint
        // the same (template, user) twice.
        let userKey: Int = vTemplateId * 18446744073709551616 + (vTgUserId & 18446744073709551615);
        require(self.mintedUsers.get(userKey) == null, "achievement already minted for this user");

        require(ctx.value >= MintStorageFee + MintItemValue + RegistryGas, "insufficient value for mint");

        let t: Template = tmpl!!;
        // custom_payload: royalty inline + content cell (TEP-64 off-chain) as ref
        let cp: Cell = beginCell()
            .storeUint(t.royalty.numerator, 16)
            .storeUint(t.royalty.denominator, 16)
            .storeAddress(t.royalty.destination)
            .storeRef(createOffchainContent(t.contentUrl))
            .endCell();

        // Reserve first so the item's value and the refund below come out of
        // the incoming message, never out of the registry's rent balance.
        nativeReserve(myBalance() - ctx.value + MintStorageFee, 0);
        let itemInit: StateInit = initOf AchievementItem(myAddress(), self.nextItemIndex);
        send(SendParameters{
            to: contractAddress(itemInit),
            value: MintItemValue,
            bounce: false,
            body: Transfer{
                query_id: 0,
                new_owner: vRecipient,
                response_destination: ctx.sender,
                custom_payload: cp,
                forward_amount: 0,
                forward_payload: emptySlice()
            }.toCell(),
            code: itemInit.code,
            data: itemInit.data
        });

        t.mintedCount = t.mintedCount + 1;
        self.templates.set(vTemplateId, t);
        self.usedNonces.set(vNonce, true);
        self.mintedUsers.set(userKey, true);
        emit(AchievementMinted{
            templateId: vTemplateId,
            itemIndex: self.nextItemIndex,
            recipient: vRecipient,
            tgUserId: vTgUserId
        }.toCell());
        self.nextItemIndex = self.nextItemIndex + 1;

        // Last action: mode 128 sends everything unreserved, so any action
        // after it (the emit above included) would fail for lack of funds.
        self.refundRest(ctx);
    }

    // Keep `rent` out of the incoming value and return the rest to the
    // sender. Must be the last action of the handler (see refundRest).
    fun keepRentRefundRest(ctx: Context, rent: Int) {
        nativeReserve(myBalance() - ctx.value + rent, 0);
        self.refundRest(ctx);
    }

    // Everything not reserved goes back to the sender (after a prior
    // nativeReserve). Ignore errors: a dust remainder must not abort the tx.
    fun refundRest(ctx: Context) {
        send(SendParameters{
            to: ctx.sender,
            value: 0,
            mode: SendRemainingBalance + SendIgnoreErrors,
            bounce: false,
            body: Excesses{query_id: 0}.toCell()
        });
    }

    // Number of cells in a snake-encoded slice.
    fun snakeCells(s: Slice): Int {
        let n: Int = 1;
        let cur: Slice = s;
        while (cur.refs() > 0) {
            cur = cur.loadRef().beginParse();
            n = n + 1;
        }
        return n;
    }

    // ---- Getters ----
    get fun template(templateId: Int): Template? {
        return self.templates.get(templateId);
    }

    get fun templatesCount(): Int {
        return self.nextTemplateId;
    }

    get fun itemsCount(): Int {
        return self.nextItemIndex;
    }

    get fun mintedCount(templateId: Int): Int {
        let t: Template? = self.templates.get(templateId);
        if (t == null) {
            return 0;
        }
        let tmpl: Template = t!!;
        return tmpl.mintedCount;
    }

    // Whether this Telegram user already holds the template's NFT.
    get fun isMinted(templateId: Int, tgUserId: Int): Bool {
        return self.mintedUsers.get(templateId * 18446744073709551616 + (tgUserId & 18446744073709551615)) != null;
    }

    get fun isNonceUsed(nonce: Int): Bool {
        return self.usedNonces.get(nonce) != null;
    }

    get fun nftAddress(itemIndex: Int): Address {
        return contractAddress(initOf AchievementItem(myAddress(), itemIndex));
    }

    // ---- TEP-62 collection getters, so wallets and explorers can resolve
    // items back to this collection ----
    get fun get_collection_data(): CollectionData {
        return CollectionData{
            next_item_index: self.nextItemIndex,
            collection_content: self.collectionContent,
            owner_address: self.owner
        };
    }

    get fun get_nft_address_by_index(index: Int): Address {
        return contractAddress(initOf AchievementItem(myAddress(), index));
    }

    // TEP-62 collection view of item content (off-chain layout item-side)
    get fun get_nft_content(index: Int, individual_content: Cell): Cell {
        return individual_content;
    }
}
