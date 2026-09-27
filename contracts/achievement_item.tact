import "./achievement_messages.tact";

// Kept on the item forever: achievements never burn, and the registry only
// forwards a fixed MintItemValue, so the item must protect its own rent.
const ItemMinTonForStorage: Int = ton("0.02");
// Owner-initiated transfer gas, paid on top of any forward_amount.
const ItemTransferGas: Int = ton("0.01");
// raw_reserve mode: reserve at most the amount (never fail on a low balance)
const ReserveAtMost: Int = 2;

// TEP-62 NFT item. The AchievementRegistry is its collection. It is deployed
// by the registry's mint Transfer (first Transfer == mint, isInitialized
// false), which carries the template's content cell and royalty packed in
// custom_payload:
//     uint16 numerator, uint16 denominator, Address destination, ref(content)
// where content is a TEP-64 off-chain cell (0x01 + metadata URL).
contract AchievementItem {
    registry: Address;               // doubles as the TEP-62 collection address
    itemIndex: Int as uint32;
    isInitialized: Bool;
    owner: Address;                  // registry itself until the mint Transfer
    individualContent: Cell?;
    royaltyNumerator: Int as uint16;
    royaltyDenominator: Int as uint16;
    royaltyDestination: Address;

    init(registry: Address, itemIndex: Int) {
        self.registry = registry;
        self.itemIndex = itemIndex;
        self.isInitialized = false;
        self.owner = registry;
        self.royaltyNumerator = 0;
        self.royaltyDenominator = 0;
        self.royaltyDestination = registry;
    }

    receive(msg: Transfer) {
        let ctx: Context = context();
        if (!self.isInitialized) {
            // Initial Transfer, aka the "minting" of the NFT
            require(ctx.sender == self.registry, "only registry can mint");
            self.isInitialized = true;
            self.owner = msg.new_owner;

            let payload: Cell = msg.custom_payload!!;
            let cp: Slice = payload.beginParse();
            self.royaltyNumerator = cp.loadUint(16);
            self.royaltyDenominator = cp.loadUint(16);
            self.royaltyDestination = cp.loadAddress();
            self.individualContent = cp.loadRef();

            self.returnExcess(msg.response_destination, msg.query_id);
        } else {
            require(ctx.sender == self.owner, "only owner can transfer");
            // forward_amount comes from the sender, not the storage reserve
            require(ctx.value >= msg.forward_amount + ItemTransferGas, "insufficient value for transfer");
            self.owner = msg.new_owner;
            if (msg.forward_amount > 0) {
                send(SendParameters{
                    to: msg.new_owner,
                    value: msg.forward_amount,
                    mode: SendPayGasSeparately,
                    bounce: false,
                    body: OwnershipAssigned{
                        query_id: msg.query_id,
                        prev_owner: ctx.sender,
                        forward_payload: msg.forward_payload
                    }.toCell()
                });
            }
            self.returnExcess(msg.response_destination, msg.query_id);
        }
    }

    // Send everything above the storage reserve back. The reserve is an
    // action, so it applies after the forward_amount send above: the excess
    // is what is really left, and the two sends can never overdraw (the old
    // explicit-value version sent myBalance() - reserve on top of
    // forward_amount, which failed the action phase for any marketplace
    // transfer with a forward_amount).
    fun returnExcess(responseDestination: Address?, queryId: Int) {
        nativeReserve(ItemMinTonForStorage, ReserveAtMost);
        if (responseDestination != null) {
            send(SendParameters{
                to: responseDestination!!,
                value: 0,
                mode: SendRemainingBalance + SendIgnoreErrors,
                bounce: false,
                body: Excesses{query_id: queryId}.toCell()
            });
        }
    }

    receive(msg: GetStaticData) {
        send(SendParameters{
            to: sender(),
            value: 0,
            mode: SendRemainingValue,
            bounce: true,
            body: ReportStaticData{
                query_id: msg.query_id,
                index_id: self.itemIndex,
                collection: self.registry
            }.toCell()
        });
    }

    receive(msg: GetRoyaltyParams) {
        send(SendParameters{
            to: sender(),
            value: 0,
            mode: SendRemainingValue,
            bounce: true,
            body: ReportRoyaltyParams{
                query_id: msg.query_id,
                numerator: self.royaltyNumerator,
                denominator: self.royaltyDenominator,
                destination: self.royaltyDestination
            }.toCell()
        });
    }

    get fun get_nft_data(): GetNftData {
        let content: Cell = beginCell().endCell();
        let stored: Cell? = self.individualContent;
        if (stored != null) {
            content = stored!!;
        }
        return GetNftData{
            is_initialized: self.isInitialized,
            index: self.itemIndex,
            collection_address: self.registry,
            owner_address: self.owner,
            individual_content: content
        };
    }

    get fun get_royalty_params(): RoyaltyParams {
        return RoyaltyParams{
            numerator: self.royaltyNumerator,
            denominator: self.royaltyDenominator,
            destination: self.royaltyDestination
        };
    }
}
