import { Address, beginCell, Cell } from '@ton/core';
import { KeyPair, sign } from '@ton/crypto';
import { storeSignedVoucher } from './ChatPool';

// Voucher kinds, mirrored from contracts/*_messages.tact. The backend signs a
// SignedVoucher{tag, target, ^voucher} envelope, never the bare voucher cell
// (see contracts/voucher.tact); target is the verifying contract.
export const TAG = {
    Deposit: 0x44455031n, // target = chat pool
    Claim: 0x434c4d31n, // target = chat pool
    Admin: 0x41444d31n, // target = chat pool
    Register: 0x52454731n, // target = achievement registry
    Mint: 0x4d4e5431n, // target = achievement registry
};

export function signVoucher(voucher: Cell, kp: KeyPair, tag: bigint, target: Address): Buffer {
    const envelope = beginCell()
        .store(storeSignedVoucher({ $$type: 'SignedVoucher', tag, target, voucher }))
        .endCell();
    return sign(envelope.hash(), kp.secretKey);
}
