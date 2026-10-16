import { Address, beginCell, Cell, Dictionary, TupleReader } from '@ton/core';
import { sha256_sync } from '@ton/crypto';
import { NetworkProvider } from '@ton/blueprint';

// Generic TEP-74 / TEP-64 helpers: they work for any jetton, not only the
// test jetton, because they only use the standard getters.

// TEP-64 says decimals defaults to 9 when the metadata does not set it.
const DEFAULT_DECIMALS = 9;

// Decimals of a jetton, read from get_jetton_data's TEP-64 content. For
// off-chain metadata (which is not readable on-chain) set JETTON_DECIMALS.
export async function jettonDecimals(provider: NetworkProvider, jettonMaster: Address): Promise<number> {
    const res = await provider.provider(jettonMaster).get('get_jetton_data', []);
    const stack = res.stack as TupleReader;
    stack.skip(3); // total_supply, mintable, admin_address
    return decimalsFromContent(stack.readCell(), process.env.JETTON_DECIMALS);
}

export function decimalsFromContent(content: Cell, fallback?: string): number {
    const s = content.beginParse();
    const layout = s.loadUint(8);
    if (layout !== 0x00) {
        if (fallback === undefined) {
            throw new Error(`jetton metadata is not on-chain (layout 0x${layout.toString(16)}); set JETTON_DECIMALS`);
        }
        return checkDecimals(fallback);
    }
    const dict = s.loadDict(Dictionary.Keys.BigUint(256), Dictionary.Values.Cell());
    const value = dict.get(BigInt('0x' + sha256_sync('decimals').toString('hex')));
    if (!value) return DEFAULT_DECIMALS;
    const vs = value.beginParse();
    if (vs.loadUint(8) !== 0x00) throw new Error('unsupported TEP-64 value encoding for decimals');
    return checkDecimals(vs.loadStringTail());
}

function checkDecimals(text: string): number {
    if (!/^\d{1,3}$/.test(text) || Number(text) > 255) throw new Error(`invalid jetton decimals: ${text}`);
    return Number(text);
}

// "2.5" with 6 decimals -> 2500000n. Rejects more fractional digits than the
// jetton has instead of silently rounding.
export function parseJettonAmount(text: string, decimals: number): bigint {
    const m = /^(\d+)(?:\.(\d+))?$/.exec(text.trim());
    if (!m) throw new Error(`invalid amount: ${text}`);
    const frac = m[2] ?? '';
    if (frac.length > decimals) throw new Error(`amount ${text} has more than ${decimals} decimals`);
    return BigInt(m[1] + frac.padEnd(decimals, '0'));
}

export async function jettonWalletAddress(
    provider: NetworkProvider,
    jettonMaster: Address,
    owner: Address,
): Promise<Address> {
    const res = await provider
        .provider(jettonMaster)
        .get('get_wallet_address', [{ type: 'slice', cell: beginCell().storeAddress(owner).endCell() }]);
    return (res.stack as TupleReader).readAddress();
}

// Balance from get_wallet_data. 0 only when the wallet does not exist yet;
// any other failure (wrong master, not a jetton wallet, network) throws.
export async function jettonWalletBalance(provider: NetworkProvider, wallet: Address): Promise<bigint> {
    if (!(await provider.isContractDeployed(wallet))) return 0n;
    const res = await provider.provider(wallet).get('get_wallet_data', []);
    return (res.stack as TupleReader).readBigNumber();
}

// Testnet-only scripts call this before touching anything. A custom
// endpoint is refused too: it may well be mainnet, and nothing here can tell.
export function requireTestnet(provider: NetworkProvider, script: string): void {
    const network = provider.network();
    if (network !== 'testnet') {
        throw new Error(`${script} is testnet-only; refusing to run on ${network} (run it with --testnet)`);
    }
}
