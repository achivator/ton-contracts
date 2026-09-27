import { beginCell, Address, toNano } from '@ton/core';
import { NetworkProvider } from '@ton/blueprint';
import { storeJettonTransfer } from '../wrappers/ChatPool';
import {
    ACTOR_NAMES,
    ActorName,
    actorAddr,
    confirmSend,
    jettonBalanceOf,
    jettonWalletOf,
    lastTxLt,
    sendFromWallet,
    sleep,
    RawMessage,
} from './actors';
import { reqEnv } from './env';

// Tops up actor jetton balances to their targets in a single owner-signed
// transfer. Env: DIST="ADMIN1:500,ADMIN2:150,ATTACKER:100" (whole tokens;
// amounts are 9-decimal jetton units). Idempotent.
const ATTACH = toNano('0.12');

export async function run(provider: NetworkProvider) {
    const ownerMnemonic = reqEnv('WALLET_MNEMONIC');
    const jettonMaster = Address.parse(reqEnv('JETTON_MASTER'));
    const ownerAddr = actorAddr('OWNER');

    const dist = new Map<ActorName, bigint>();
    for (const chunk of (process.env.DIST ?? '').split(',')) {
        const t = chunk.trim();
        if (!t) continue;
        const [name, amt] = t.split(':');
        if (!ACTOR_NAMES.includes(name as ActorName) || name === 'OWNER') {
            throw new Error(`DIST entry "${t}": unknown actor`);
        }
        dist.set(name as ActorName, toNano(amt));
    }
    if (dist.size === 0) {
        console.log('JETTONS nothing to distribute (DIST is empty)');
        return;
    }

    const targets: { name: ActorName; addr: Address; jw: Address; delta: bigint }[] = [];
    let total = 0n;
    for (const [name, target] of dist) {
        const addr = actorAddr(name);
        const jw = await jettonWalletOf(provider, jettonMaster, addr);
        const bal = await jettonBalanceOf(provider, jettonMaster, addr);
        const delta = target - bal;
        if (delta > 0n) {
            targets.push({ name, addr, jw, delta });
            total += delta;
        } else {
            console.log(`JETTONS ${name} at target (${bal})`);
        }
    }
    if (targets.length === 0) {
        console.log('JETTONS nothing to distribute');
        return;
    }

    const ownerBal = await jettonBalanceOf(provider, jettonMaster, ownerAddr);
    if (ownerBal < total) {
        throw new Error(
            `Owner jetton balance ${ownerBal} < required ${total}; mint more with: MINT_AMOUNT=1000000 npx blueprint run deployTestJetton --mnemonic`,
        );
    }

    // TEP-74: transfers must go through the sender's OWN jetton wallet,
    // which forwards to (and deploys) the recipients' wallets. Sending
    // straight to a fresh recipient wallet just bounces back.
    const ownerJw = await jettonWalletOf(provider, jettonMaster, ownerAddr);

    const messages: RawMessage[] = [];
    const pending: { name: string; jw: Address; prevLt: string }[] = [];
    for (const t of targets) {
        const body = beginCell()
            .store(
                storeJettonTransfer({
                    $$type: 'JettonTransfer',
                    queryId: 0n,
                    amount: t.delta,
                    destination: t.addr,
                    responseDestination: t.addr,
                    customPayload: null,
                    forwardTonAmount: 0n,
                    forwardPayload: beginCell().endCell(),
                }),
            )
            .endCell();
        messages.push({ to: ownerJw, value: ATTACH, body, bounce: true });
        pending.push({ name: t.name, jw: t.jw, prevLt: await lastTxLt(provider, t.jw) });
        console.log(`JETTONS ${t.name} ${t.jw.toString()} delta=${t.delta}`);
    }

    const sent = await sendFromWallet(provider, ownerMnemonic, messages);
    await confirmSend(provider, sent.address, sent.prevLt, 'owner jetton tx');

    for (const p of pending) {
        await confirmSend(provider, p.jw, p.prevLt, `jetton wallet ${p.name}`);
    }
    await sleep(1500);
    console.log('JETTONS done total=' + total);
}
