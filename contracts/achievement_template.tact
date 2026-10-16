import "./achievement_messages.tact";

// Storage reserve a template keeps from its registration value. A template
// is 29 cells, about 0.0019 TON a year at mainnet prices (0 per bit, 135 per
// cell per 2^16 s), so 0.05 TON covers about 26 years (measured in
// tests/AchievementSecurity.spec.ts); under the pre-2026 prices about 4
// years. Anyone can top it up with a plain transfer. A frozen template
// cannot mint until it is topped up and unfrozen.
const TemplateMinTonForStorage: Int = ton("0.05");
const TemplateReserveAtMost: Int = 2;

// One achievement template, deployed by the AchievementRegistry at the
// address of (registry, templateKey), templateKey = hash(chatTag,
// contentHash). Because the key is derived from the content, registering
// the same content for the same chat twice reaches the same template, and
// the second registration is refunded: there is no id to race for.
//
// On a mint the registry asks the template, the template answers with its
// content, and the registry checks the answer comes from this very address
// before it deploys the item. A template that was never registered (or an
// address with no template) cannot mint.
contract AchievementTemplate {
    registry: Address;
    templateKey: Int as uint256;
    isInitialized: Bool;
    chatTag: Int as uint256;
    creator: Address?;
    contentHash: Int as uint256;
    content: Cell?;                  // TEP-64 off-chain cell: 0x01 + URL

    init(registry: Address, templateKey: Int) {
        self.registry = registry;
        self.templateKey = templateKey;
        self.isInitialized = false;
        self.chatTag = 0;
        self.creator = null;
        self.contentHash = 0;
        self.content = null;
    }

    // Storage rent top-ups, from anyone.
    receive() {}

    receive(msg: TemplateInit) {
        let ctx: Context = context();
        require(ctx.sender == self.registry, "only the registry can register");
        if (self.isInitialized) {
            // Same chat, same content: already registered. Nothing changes.
            send(SendParameters{
                to: msg.creator,
                value: 0,
                mode: SendRemainingValue + SendIgnoreErrors,
                bounce: false,
                body: Excesses{query_id: 0}.toCell()
            });
            return;
        }
        // The registry derived the key from these very fields.
        require(achievementTemplateKey(msg.chatTag, msg.contentHash) == self.templateKey, "template key mismatch");
        self.isInitialized = true;
        self.chatTag = msg.chatTag;
        self.creator = msg.creator;
        self.contentHash = msg.contentHash;
        self.content = msg.content;
        emit(TemplateRegistered{templateKey: self.templateKey, chatTag: msg.chatTag, creator: msg.creator}.toCell());

        nativeReserve(myBalance() - ctx.value + TemplateMinTonForStorage, TemplateReserveAtMost);
        send(SendParameters{
            to: msg.creator,
            value: 0,
            mode: SendRemainingBalance + SendIgnoreErrors,
            bounce: false,
            body: Excesses{query_id: 0}.toCell()
        });
    }

    receive(msg: TemplateMintRequest) {
        require(sender() == self.registry, "only the registry can mint");
        if (!self.isInitialized) {
            // Deployed by someone else but never registered: refund.
            send(SendParameters{
                to: msg.recipient,
                value: 0,
                mode: SendRemainingValue + SendIgnoreErrors,
                bounce: false,
                body: Excesses{query_id: 0}.toCell()
            });
            return;
        }
        send(SendParameters{
            to: self.registry,
            value: 0,
            mode: SendRemainingValue,
            bounce: true,
            body: TemplateMintApproved{
                templateKey: self.templateKey,
                recipient: msg.recipient,
                userTag: msg.userTag,
                mint: ItemContent{contentHash: self.contentHash, content: self.content!!}.toCell()
            }.toCell()
        });
    }

    get fun get_template_data(): TemplateData {
        return TemplateData{
            is_initialized: self.isInitialized,
            registry: self.registry,
            template_key: self.templateKey,
            chat_tag: self.chatTag,
            creator: self.creator,
            content_hash: self.contentHash,
            content: self.content
        };
    }
}
