import { beginCell, Cell, Dictionary } from '@ton/core';
import { Blockchain } from '@ton/sandbox';
export { TAG, signVoucher } from '../../wrappers/Vouchers';

export function signatureCell(signature: Buffer): Cell {
    return beginCell().storeBuffer(signature).endCell();
}

// Config param 19: the network's global id (-239 mainnet, -3 testnet).
const GLOBAL_ID_PARAM = 19;

function configDict(bc: Blockchain) {
    return Dictionary.loadDirect(Dictionary.Keys.Int(32), Dictionary.Values.Cell(), bc.config);
}

// Global id the sandbox reports to contracts (what getConfigParam(19) reads).
export function globalIdOf(bc: Blockchain): number {
    const param = configDict(bc).get(GLOBAL_ID_PARAM);
    if (!param) throw new Error('sandbox config has no param 19');
    return param.beginParse().loadInt(32);
}

// Makes the sandbox pose as another network: rewrites config param 19.
export function setGlobalId(bc: Blockchain, globalId: number): void {
    const dict = configDict(bc);
    dict.set(GLOBAL_ID_PARAM, beginCell().storeInt(globalId, 32).endCell());
    bc.setConfig(beginCell().storeDictDirect(dict).endCell());
    if (globalIdOf(bc) !== globalId) throw new Error('setGlobalId did not take effect');
}
