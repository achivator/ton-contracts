import { NetworkProvider } from '@ton/blueprint';
import { Address, Cell } from '@ton/core';
import { KeyPair } from '@ton/crypto';
import { GLOBAL_ID, signLegacyVoucher, signVoucher } from '../wrappers/Vouchers';

// Global id (config param 19) of the network blueprint runs against: every
// voucher is signed for it (contracts/voucher.tact). `--custom` endpoints
// count as the network named by --custom-type; a custom network with no type
// has to name its id in TON_GLOBAL_ID.
export function networkGlobalId(provider: NetworkProvider): number {
    const network = provider.network();
    if (network === 'mainnet' || network === 'testnet') return GLOBAL_ID[network];
    const id = Number(process.env.TON_GLOBAL_ID);
    if (!process.env.TON_GLOBAL_ID || !Number.isInteger(id)) {
        throw new Error('Set TON_GLOBAL_ID (config param 19) or --custom-type mainnet|testnet for a custom network');
    }
    return id;
}

export type VoucherSigner = (voucher: Cell, kp: KeyPair, tag: bigint) => Buffer;

// Signs vouchers for `target` in the envelope its version() getter asks for:
// network-bound for protocol v3, the legacy network-less one for v2 (pools of
// a v2 master keep it for good).
export async function voucherSignerFor(provider: NetworkProvider, target: Address): Promise<VoucherSigner> {
    const version = (await provider.provider(target).get('version', [])).stack.readNumber();
    if (version === 3) {
        const globalId = networkGlobalId(provider);
        return (voucher, kp, tag) => signVoucher(voucher, kp, tag, target, globalId);
    }
    if (version === 2) return (voucher, kp, tag) => signLegacyVoucher(voucher, kp, tag, target);
    throw new Error(`${target.toString()} speaks protocol v${version}; these scripts sign for v2 and v3 only`);
}
