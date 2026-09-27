import { toNano, Address } from '@ton/core';
import { NetworkProvider } from '@ton/blueprint';
import {
    actorAddr,
    actorKeyPair,
    ActorName,
    confirmSend,
    GENERATED_ACTORS,
    lastTxLt,
    sendFromWallet,
    sleep,
    tonBalance,
    walletV4,
    RawMessage,
} from './actors';
import { reqEnv } from './env';

// Tops up actor wallets to their target TON balances with owner-signed
// transfers (batches of <=4, the wallet V4 per-transfer limit).
// Env: <NAME>_TON per actor, e.g. ADMIN1_TON=0.7.
// Idempotent: balances already at/above target are skipped.
const MIN_DELTA = toNano('0.02');

export async function run(provider: NetworkProvider) {
    const ownerMnemonic = reqEnv('WALLET_MNEMONIC');

    const targets: { name: ActorName; addr: Address; delta: bigint }[] = [];
    for (const name of GENERATED_ACTORS) {
        const raw = process.env[`${name}_TON`];
        if (!raw) continue;
        const addr = actorAddr(name);
        const bal = await tonBalance(provider, addr);
        const delta = toNano(raw) - bal;
        if (delta > MIN_DELTA) {
            targets.push({ name, addr, delta });
        } else {
            console.log(`FUND ${name} at target (${bal})`);
        }
    }

    if (targets.length === 0) {
        console.log('FUND nothing to fund');
        return;
    }

    const total = targets.reduce((s, t) => s + t.delta, 0n);
    const ownerAddr = actorAddr('OWNER');
    const ownerBal = await tonBalance(provider, ownerAddr);
    if (ownerBal < total + toNano('0.05')) {
        throw new Error(
            `Owner balance ${ownerBal} < required ${total + toNano('0.05')} (top up the owner wallet, then re-run)`,
        );
    }

    const messages: RawMessage[] = [];
    const funded: { name: string; addr: Address; prevLt: string }[] = [];
    for (const t of targets) {
        const kp = await actorKeyPair(t.name);
        const wallet = walletV4(kp.publicKey);
        const prevLt = await lastTxLt(provider, t.addr);
        messages.push({ to: t.addr, value: t.delta, bounce: false, init: wallet.init });
        funded.push({ name: t.name, addr: t.addr, prevLt });
        console.log(`FUND ${t.name} ${t.addr.toString()} delta=${t.delta}`);
    }

    // Wallet V4 signs at most 4 messages per transfer; batch accordingly.
    for (let i = 0; i < messages.length; i += 4) {
        const sent = await sendFromWallet(provider, ownerMnemonic, messages.slice(i, i + 4));
        await confirmSend(provider, sent.address, sent.prevLt, `owner funding tx ${i / 4 + 1}`);
    }

    for (const f of funded) {
        await confirmSend(provider, f.addr, f.prevLt, `fund ${f.name}`);
    }
    await sleep(1500);
    console.log('FUND done total=' + total);
}
