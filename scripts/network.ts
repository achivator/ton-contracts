import { NetworkProvider } from '@ton/blueprint';
import { Address, Cell } from '@ton/core';
import { KeyPair } from '@ton/crypto';
import { TonClient } from '@ton/ton';
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

const PUBLIC_API = {
    mainnet: 'https://toncenter.com/api/v2/jsonRPC',
    testnet: 'https://testnet.toncenter.com/api/v2/jsonRPC',
};

// Account state ('active' / 'uninitialized' / 'frozen') on a public network.
export type StateLookup = (network: 'mainnet' | 'testnet', address: Address) => Promise<string>;
const publicApiState: StateLookup = async (network, address) =>
    (await new TonClient({ endpoint: PUBLIC_API[network] }).getContractState(address)).state;

// Testnet and mainnet MUST use different backend keys (BACKEND_SECRET) and
// should use different owner wallets. With both shared, every contract gets
// the same address on both networks; vouchers no longer replay across them
// (they name the network), but a testnet key leak would still hand over
// mainnet. Refuses the deploy when `address` (derived from the owner and the
// backend key) is already deployed on the other network: that is exactly
// this case. A shared key under different owner wallets cannot be seen from
// here; keep the keys apart regardless. An unreachable API only warns.
export async function refuseKeySharedWithOtherNetwork(
    provider: NetworkProvider,
    address: Address,
    what: string,
    lookup: StateLookup = publicApiState,
) {
    const network = provider.network();
    if (network === 'custom') return;
    const other = network === 'mainnet' ? 'testnet' : 'mainnet';
    let state: string;
    try {
        state = await lookup(other, address);
    } catch (e) {
        console.warn(`Could not check ${other} for ${address.toString()} (${(e as Error).message}); continuing.`);
        return;
    }
    if (state !== 'uninitialized') {
        throw new Error(
            `${what} ${address.toString()} is already deployed on ${other} with this owner wallet and ` +
                `BACKEND_PUBLIC_KEY: the backend key is shared between networks. Generate a separate key for ` +
                `${network} (npx blueprint run genBackendKey) and use a separate owner wallet.`,
        );
    }
}
