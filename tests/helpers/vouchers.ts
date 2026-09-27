import { beginCell, Cell } from '@ton/core';
export { TAG, signVoucher } from '../../wrappers/Vouchers';

export function signatureCell(signature: Buffer): Cell {
    return beginCell().storeBuffer(signature).endCell();
}
