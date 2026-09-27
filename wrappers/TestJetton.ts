import { beginCell, Cell, Dictionary } from '@ton/core';
import { sha256_sync } from '@ton/crypto';

export { TestJettonMinter } from '../build/TestJetton/tact_TestJettonMinter';
export { TestJettonWallet } from '../build/TestJetton/tact_TestJettonWallet';

// TEP-64 on-chain content: 0x00 tag + dict sha256(key) -> snake(0x00 + text).
export function onchainJettonContent(fields: Record<string, string>): Cell {
    const dict = Dictionary.empty(Dictionary.Keys.BigUint(256), Dictionary.Values.Cell());
    for (const [key, value] of Object.entries(fields)) {
        dict.set(BigInt('0x' + sha256_sync(key).toString('hex')), beginCell().storeUint(0, 8).storeStringTail(value).endCell());
    }
    return beginCell().storeUint(0, 8).storeDict(dict).endCell();
}

export const TEST_JETTON_CONTENT = {
    name: 'Achivator Test Jetton',
    symbol: 'ACHT',
    decimals: '9',
    description: 'Testnet-only jetton for achivator reward pools',
};
