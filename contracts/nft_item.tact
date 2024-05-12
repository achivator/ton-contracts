import "@stdlib/deploy";
import "@stdlib/ownable";
import "./messages.tact";
const minTonsForStorage: Int = ton("0.02");
const gasConsumption: Int = ton("0.02");

contract NftItem with Deployable, Ownable {
    collection_address: Address;
    item_index: Int;
    is_initialized: Bool;
    owner: Address;
    individual_content: Cell?;
    init(owner: Address, collection_address: Address, item_index: Int){
        require(sender() == collection_address, "not from collection");
        self.owner = owner;
        self.collection_address = collection_address;
        self.item_index = item_index;
        self.is_initialized = false;
    }

    receive(msg: Transfer){
        let ctx: Context = context();
        let msgValue: Int = ctx.value; // Check the gasCost for storage
        let tonBalanceBeforeMsg: Int = (myBalance() - msgValue);
        let storageFee: Int = (minTonsForStorage - min(tonBalanceBeforeMsg, minTonsForStorage));
        msgValue = (msgValue - (storageFee + gasConsumption));
        if (self.is_initialized == false) {
            // Initial Transfer, aka the "Minting" of the NFT
            require(ctx.sender == self.collection_address, "Only collection can mint");
            self.is_initialized = true;
            self.owner = msg.new_owner;
            self.individual_content = msg.custom_payload;
            send(SendParameters{
                    to: msg.response_destination!!,
                    value: msgValue,
                    mode: SendPayGasSeparately,
                    body: Excesses{query_id: msg.query_id}.toCell()
                }
            );
        } else {
            require(ctx.sender == self.owner, "Only owner can transfer");
            self.owner = msg.new_owner; // change current owner to the new_owner
            if (msg.forward_amount > 0) {
                send(SendParameters{
                        to: msg.new_owner,
                        value: msg.forward_amount,
                        mode: SendPayGasSeparately,
                        bounce: true,
                        body: OwnershipAssigned{
                            query_id: msg.query_id,
                            prev_owner: ctx.sender,
                            forward_payload: msg.forward_payload
                        }.toCell()
                    }
                );
            }
            msgValue = (msgValue - ctx.readForwardFee());
            if (msg.response_destination != null) {
                send(SendParameters{
                        to: msg.response_destination!!,
                        value: (msgValue - msg.forward_amount),
                        mode: SendPayGasSeparately,
                        bounce: true,
                        body: Excesses{query_id: msg.query_id}.toCell()
                    }
                );
            }
        }
    }

    receive(msg: GetStaticData){
        let ctx: Context = context();
        send(SendParameters{
                to: ctx.sender,
                value: 0,
                mode: 64, // (return msg amount except gas fees)
                bounce: true,
                body: ReportStaticData{
                    query_id: msg.query_id,
                    index_id: self.item_index,
                    collection: self.collection_address
                }.toCell()
            }
        );
    }

    // --------- Get Function  --------- //
    get fun get_nft_data(): GetNftData {
        let b: StringBuilder = beginString();
        return
            GetNftData{
                is_initialized: self.is_initialized,
                index: self.item_index,
                collection_address: self.collection_address,
                owner_address: self.owner,
                individual_content: self.individual_content!! // Resolve Maybe
            };
    }
}