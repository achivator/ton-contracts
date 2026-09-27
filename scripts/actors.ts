import * as fs from 'fs';
import * as path from 'path';
import {
    Address,
    beginCell,
    Cell,
    internal,
    MessageRelaxed,
    SendMode,
    StateInit,
} from '@ton/core';
import { WalletContractV4 } from '@ton/ton';
import { mnemonicToPrivateKey } from '@ton/crypto';
import { NetworkProvider } from '@ton/blueprint';
import { reqEnv } from './env';
import { TestJettonMinter, TestJettonWallet } from '../wrappers/TestJetton';

// Test-actor plumbing shared by the multi-actor E2E scenario scripts.
// The .env.test-actors file lives next to .env and is gitignored; it holds
// per-actor mnemonics + addresses. Secrets are never printed.

export const ACTORS_FILE = path.join(__dirname, '..', '.env.test-actors');

export const ACTOR_NAMES = ['OWNER', 'ADMIN1', 'ADMIN2', 'MEMBER1', 'MEMBER2', 'ATTACKER'] as const;
export type ActorName = (typeof ACTOR_NAMES)[number];

export const GENERATED_ACTORS: ActorName[] = ['ADMIN1', 'ADMIN2', 'MEMBER1', 'MEMBER2', 'ATTACKER'];

export function readActorsFile(): Map<string, string> {
    const out = new Map<string, string>();
    if (!fs.existsSync(ACTORS_FILE)) {
        return out;
    }
    for (const line of fs.readFileSync(ACTORS_FILE, 'utf8').split('\n')) {
        const t = line.trim();
        if (!t || t.startsWith('#')) continue;
        const i = t.indexOf('=');
        if (i <= 0) continue;
        out.set(t.slice(0, i), t.slice(i + 1));
    }
    return out;
}

export function envActors(name: string): string {
    const v = process.env[name] ?? readActorsFile().get(name);
    if (!v) {
        throw new Error(`Set ${name} (env or ${ACTORS_FILE})`);
    }
    return v;
}

export function actorMnemonic(name: ActorName): string {
    if (name === 'OWNER') {
        return reqEnv('WALLET_MNEMONIC');
    }
    return envActors(`${name}_MNEMONIC`);
}

export function actorAddr(name: ActorName): Address {
    return Address.parse(envActors(`${name}_ADDR`));
}

export async function actorKeyPair(name: ActorName) {
    return mnemonicToPrivateKey(actorMnemonic(name).trim().split(/\s+/));
}

export function walletV4(publicKey: Buffer): WalletContractV4 {
    return WalletContractV4.create({ workchain: 0, publicKey });
}

export function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

// Dual-provider helpers: blueprint's api() is a TonClient (testnet/toncenter)
// or a TonClient4 (mainnet v4 endpoints); support both shapes.
export async function tonBalance(provider: NetworkProvider, addr: Address): Promise<bigint> {
    const api: any = provider.api();
    if (typeof api.getBalance === 'function') {
        try {
            return (await api.getBalance(addr)) as bigint;
        } catch {
            return 0n;
        }
    }
    const block = await api.getLastBlock();
    const acc = await api.getAccountLite(block.last.seqno, addr);
    return BigInt(acc.account.balance.coins);
}

export async function isDeployed(provider: NetworkProvider, addr: Address): Promise<boolean> {
    const api: any = provider.api();
    if (typeof api.isContractDeployed === 'function') {
        return (await api.isContractDeployed(addr)) as boolean;
    }
    const block = await api.getLastBlock();
    const acc = await api.getAccountLite(block.last.seqno, addr);
    return acc.account.state.type !== 'uninit';
}

export async function lastTxLt(provider: NetworkProvider, addr: Address): Promise<string> {
    const api: any = provider.api();
    const txs = await api.getTransactions(addr, { limit: 1 });
    if (!txs || txs.length === 0) {
        return '0';
    }
    return txs[0].lt.toString();
}

// Polls the account's last-tx lt until it changes, so the next send from the
// same wallet cannot reuse a stale seqno.
export async function confirmSend(
    provider: NetworkProvider,
    addr: Address,
    prevLt: string,
    label: string,
    attempts = 24,
): Promise<string> {
    for (let i = 0; i < attempts; i++) {
        await sleep(2500);
        const lt = await lastTxLt(provider, addr);
        if (lt !== prevLt) {
            console.log(`confirmed ${label} (lt ${lt})`);
            return lt;
        }
    }
    throw new Error(`${label}: not confirmed after ${attempts} polls`);
}

export type RawMessage = {
    to: Address;
    value: bigint;
    body?: Cell;
    bounce?: boolean;
    init?: StateInit | null;
};

// Raw wallet-driven send. Needed where blueprint's sender cannot be used:
// it forces bounce:true and rejects init-carrying messages, which breaks
// funding fresh wallets. Only ever used with the (deployed) owner wallet.
export async function sendFromWallet(
    provider: NetworkProvider,
    mnemonic: string,
    messages: RawMessage[],
): Promise<{ address: Address; prevLt: string }> {
    const kp = await mnemonicToPrivateKey(mnemonic.trim().split(/\s+/));
    const wallet = walletV4(kp.publicKey);
    const cp = provider.provider(wallet.address, wallet.init);
    const seqno = await wallet.getSeqno(cp);
    const prevLt = await lastTxLt(provider, wallet.address);
    const msgs: MessageRelaxed[] = messages.map((m) =>
        internal({
            to: m.to,
            value: m.value,
            bounce: m.bounce ?? false,
            init: m.init ?? null,
            body: m.body ?? beginCell().endCell(),
        }),
    );
    await wallet.sendTransfer(cp, {
        seqno,
        secretKey: kp.secretKey,
        messages: msgs,
        sendMode: SendMode.PAY_GAS_SEPARATELY,
    });
    return { address: wallet.address, prevLt };
}

export async function jettonWalletOf(
    provider: NetworkProvider,
    minter: Address,
    owner: Address,
): Promise<Address> {
    const m = provider.open(TestJettonMinter.fromAddress(minter));
    return m.getGetWalletAddress(owner);
}

export async function jettonBalanceOf(
    provider: NetworkProvider,
    minter: Address,
    owner: Address,
): Promise<bigint> {
    try {
        const w = await jettonWalletOf(provider, minter, owner);
        const wallet = provider.open(TestJettonWallet.fromAddress(w));
        return await wallet.getWalletBalance();
    } catch {
        return 0n;
    }
}
