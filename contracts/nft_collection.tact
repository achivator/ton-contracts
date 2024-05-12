import "@stdlib/deploy";
import "@stdlib/ownable";
import "./messages.tact";
import "./nft_item.tact";

// Mapping function signatures from FunC to Tact:
// @name(check_signature)
// native checkSignature(hash: Int, signature: Slice, public_key: Int): Int;

contract NftCollection with Deployable, Ownable {
    next_item_index: Int as uint32 = 0;
    owner: Address;
    royalty_params: RoyaltyParams?;
    collection_content: Cell;
    publicKey: Int as uint256;
    init(collection_content: Cell, royalty_params: RoyaltyParams, publicKey: Int){
        self.owner = sender();
        self.collection_content = collection_content;
        self.royalty_params = royalty_params;
        self.publicKey = publicKey;
    }

    receive(msg: Mint){
        let ctx: Context = context(); // get sender Info
        let msgValue: Int = ctx.value;
        // Verify the signature
        // let sigCell: Cell = beginCell()
        //     .storeAddress(ctx.sender)
        //     .storeCoins(value)
        //     .endCell();
        // let hash: Int = sigCell.hash();
        require(checkSignature(msg.hash, msg.item_template.asSlice(), self.publicKey), "Invalid signature");
        require(msgValue >= 1000000000, "Minimum value is 1 TON");
        // Use typed message to send parameters, we won't be able to send it manually

        let tonBalanceBeforeMsg: Int = (myBalance() - msgValue);
        let storageFee: Int = (minTonsForStorage - min(tonBalanceBeforeMsg, minTonsForStorage));
        msgValue = (msgValue - (storageFee + gasConsumption));
        self.mint(ctx.sender, msgValue, msg.query_id, msg.item_template);
        emit(EventMintRecord{minter: sender(), item_id: self.next_item_index, generate_number: nativeRandom()}.toCell()
        );
    }

    // ===== Private Methods ===== //
     fun mint(sender: Address, msgValue: Int, query_id: Int, item_template: String) {
        require(self.next_item_index >= 0, "non-sequential NFTs");
        let nft_init: StateInit = self.getNftItemInit(self.next_item_index);
        let b: StringBuilder = beginString();
        b.append(self.collection_content.asSlice().asString());
        b.append("items/");
        b.append(item_template);
        b.append(".json");
        dump(b.toString());
        send(SendParameters{
                to: contractAddress(nft_init),
                value: msgValue,
                bounce: false,
                mode: SendIgnoreErrors,
                body: Transfer{
                    query_id: query_id,
                    new_owner: sender,
                    response_destination: self.owner,
                    custom_payload: b.toCell(),
                    forward_amount: 0,
                    forward_payload: emptySlice()
                }.toCell(),
                code: nft_init.code,
                data: nft_init.data
            }
        );
        // dump(self.next_item_index);
        self.next_item_index = (self.next_item_index + 1);
    }

    receive(msg: GetRoyaltyParams){
        let ctx: Context = context(); // get sender Info
        let royalty_params: RoyaltyParams = self.royalty_params!!;
        send(SendParameters{
                to: ctx.sender,
                value: 0,
                mode: 64,
                bounce: false,
                body: ReportRoyaltyParams{
                    query_id: msg.query_id,
                    numerator: royalty_params.numerator,
                    denominator: royalty_params.denominator,
                    destination: self.owner
                }.toCell()
            }
        );
    }

    // ------------------ Get Function  ------------------ //
    get fun get_collection_data(): CollectionData {
        let b: StringBuilder = beginString();
        let collectionDataString: String = self.collection_content.asSlice().asString();
        b.append(collectionDataString);
        b.append("collection.json");
        return
            CollectionData{
                next_item_index: self.next_item_index,
                collection_content: b.toCell(),
                owner_address: self.owner
            };
    }

    get fun get_nft_address_by_index(item_index: Int): Address? {
        let initCode: StateInit = self.getNftItemInit(item_index);
        return contractAddress(initCode);
    }

    get fun getNftItemInit(item_index: Int): StateInit {
        let itemInit: StateInit = initOf NftItem(self.owner, myAddress(), item_index);
        return itemInit;
    }

    get fun get_nft_content(index: Int, individual_content: Cell): Cell {
        let b: StringBuilder = beginString();
        let ic: String = individual_content.asSlice().asString();
        b.append(ic);
        return b.toCell();
    }

    get fun royalty_params(): RoyaltyParams {
        return self.royalty_params!!;
    }
}