// TEP-89 (jetton wallet discovery) as the tests speak it: ChatPool's
// RegisterJetton sends provide_wallet_address to the jetton master, and the
// master answers with take_wallet_address. Tests often play the master with
// a treasury and answer by hand.
import { Address, beginCell, Cell } from '@ton/core';
import { SendMessageResult } from '@ton/sandbox';

export const OP_PROVIDE_WALLET_ADDRESS = 0x2c76b973;
export const OP_TAKE_WALLET_ADDRESS = 0xd1735400;

// The outbound provide_wallet_address the pool sent to `jettonMaster`.
export function provideWalletQuery(res: SendMessageResult, pool: Address, jettonMaster: Address) {
    for (const tx of res.transactions) {
        const m = tx.inMessage;
        if (!m || m.info.type !== 'internal') continue;
        if (!m.info.src.equals(pool) || !m.info.dest.equals(jettonMaster)) continue;
        const s = m.body.beginParse();
        if (s.remainingBits < 32 || s.loadUint(32) !== OP_PROVIDE_WALLET_ADDRESS) continue;
        const queryId = s.loadUintBig(64);
        const owner = s.loadAddress();
        const includeAddress = s.loadBit();
        return { queryId, owner, includeAddress };
    }
    return null;
}

// take_wallet_address#d1735400 query_id:uint64 wallet_address:MsgAddress owner_address:(Maybe ^MsgAddress)
export function takeWalletAddressBody(queryId: bigint, wallet: Address | null): Cell {
    const b = beginCell().storeUint(OP_TAKE_WALLET_ADDRESS, 32).storeUint(queryId, 64);
    if (wallet) b.storeAddress(wallet);
    else b.storeUint(0, 2);
    return b.storeMaybeRef(null).endCell();
}
