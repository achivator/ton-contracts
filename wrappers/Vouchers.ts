import { Address, beginCell, Cell } from '@ton/core';
import { KeyPair, sign } from '@ton/crypto';
import { storeSignedVoucher } from './ChatPool';

// Voucher kinds, mirrored from contracts/*_messages.tact. The backend signs a
// SignedVoucher{tag, globalId, target, ^voucher} envelope, never the bare
// voucher cell (see contracts/voucher.tact); target is the verifying
// contract, globalId the network it runs on.
export const TAG = {
    Deposit: 0x44455032n, // "DEP2", target = chat pool
    Claim: 0x434c4d31n, // target = chat pool
    Admin: 0x41444d31n, // target = chat pool
    Register: 0x52454731n, // target = achievement registry
    Mint: 0x4d4e5431n, // target = achievement registry
};

// Network global ids (config param 19), as the contracts read them on-chain.
export const GLOBAL_ID = {
    mainnet: -239,
    testnet: -3,
} as const;

// The envelope a protocol v3 contract verifies:
// uint32 tag, int32 globalId, address target, ref(voucher).
export function signedVoucherCell(voucher: Cell, tag: bigint, target: Address, globalId: number | bigint): Cell {
    return beginCell()
        .store(storeSignedVoucher({ $$type: 'SignedVoucher', tag, globalId: BigInt(globalId), target, voucher }))
        .endCell();
}

// Signs `voucher` as a voucher of kind `tag` for the contract `target` on the
// network `globalId` (GLOBAL_ID.mainnet / GLOBAL_ID.testnet).
export function signVoucher(
    voucher: Cell,
    kp: KeyPair,
    tag: bigint,
    target: Address,
    globalId: number | bigint,
): Buffer {
    return sign(signedVoucherCell(voucher, tag, target, globalId).hash(), kp.secretKey);
}

// Pre-v3 envelope (uint32 tag, address target, ref(voucher)), which names no
// network. Only for contracts whose version() is 2.
export function signLegacyVoucher(voucher: Cell, kp: KeyPair, tag: bigint, target: Address): Buffer {
    const envelope = beginCell().storeUint(tag, 32).storeAddress(target).storeRef(voucher).endCell();
    return sign(envelope.hash(), kp.secretKey);
}

// DepositVoucher in the layout of the pool's protocol version. v3 names no
// wallet (the pool credits only its TEP-89-registered wallet): int64 chatId,
// address jettonMaster, uint64 expiry. v2 pools still parse int64 chatId,
// address jettonMaster, address expectedJettonWallet, uint64 expiry.
export function depositVoucherCell(
    version: number,
    v: { chatId: bigint; jettonMaster: Address; expiry: bigint; expectedJettonWallet?: Address },
): Cell {
    const b = beginCell().storeInt(v.chatId, 64).storeAddress(v.jettonMaster);
    if (version === 2) {
        if (!v.expectedJettonWallet) throw new Error('a v2 deposit voucher names the pool jetton wallet');
        b.storeAddress(v.expectedJettonWallet);
    } else if (version !== 3) {
        throw new Error(`no deposit voucher layout for protocol v${version}`);
    }
    return b.storeUint(v.expiry, 64).endCell();
}
