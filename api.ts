import {
    Address,
    beginCell,
    toNano,
    TonClient4,
    internal,
    WalletContractV4,
    Cell
} from "@ton/ton";
import { mnemonicToPrivateKey } from "@ton/crypto";
import { storeMint, storeTransfer } from './wrappers/NftCollection';

import * as dotenv from "dotenv";
dotenv.config();

(async () => {
    // Create client for testnet sandboxv4 API - alternative endpoint
    const client4 = new TonClient4({
        endpoint: "https://sandbox-v4.tonhubapi.com", // Test-net
    });

    let mnemonics = (process.env.mnemonics2 || "").toString();
    let keyPair = await mnemonicToPrivateKey(mnemonics.split(" "));
    let secretKey = keyPair.secretKey;
    let workchain = 0;
    let wallet = WalletContractV4.create({ workchain, publicKey: keyPair.publicKey });
    let walletContract = client4.open(wallet);
    let seqno: number = await walletContract.getSeqno();
    let balance: bigint = await walletContract.getBalance();
    console.log(seqno, balance);

    await walletContract.sendTransfer({
        seqno,
        secretKey,
        messages: [
            internal({
                to: Address.parse("EQCE3SuQEOpb1ouP9Fa17ec3gyv0M13v-Tk_t_NobhXEctrZ"),
                value: toNano("1"),
                bounce: true,
                body: beginCell().store(storeMint({
                    $$type: 'Mint',
                    query_id: 0n,
                    item_template: "v1/newbie",
                })).endCell(),
            })],
    });

    // seqno = await walletContract.getSeqno();
    // await walletContract.sendTransfer({
    //     seqno,
    //     secretKey,
    //     messages: [
    //         internal({
    //             to: Address.parse("kQAIsiMLw5fzlDC6GKjac8DLHSAK58D3Ty4nXkIWQ9Hax4lL"), // nft item address
    //             value: toNano("1"),
    //             bounce: true,
    //             body: beginCell().store(storeTransfer({
    //                 $$type: 'Transfer',
    //                 query_id: 0n,
    //                 new_owner: Address.parse("0QB90HCP-0zxukY1n_056MbeRZ7KVEjYH8s7AQSA6241NHTe"),
    //                 response_destination: Address.parse("UQCOzy4iPwPulDxnPFlEpEB4jFf9_5jnzwE25EGnv6CooRlA"),
    //                 forward_amount: toNano("0.5"),
    //                 forward_payload: Cell.EMPTY,
    //                 custom_payload: Cell.EMPTY,
    //             })).endCell(),
    //         })],
    // });
})();
