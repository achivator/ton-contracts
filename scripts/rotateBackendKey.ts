import { Address, toNano } from '@ton/core';
import { NetworkProvider } from '@ton/blueprint';
import { DistributorMaster } from '../wrappers/DistributorMaster';
import { reqEnv } from './env';
import { confirmSend, lastTxLt } from './actors';

// Env: MASTER_ADDRESS, NEW_BACKEND_PUBLIC_KEY (decimal or 0x hex, 256 bits)
//
// Rotates the master's backend key (owner wallet only). Runbook after a key
// leak or a planned rotation:
//   1. Generate the new key (npx blueprint run genBackendKey), one per network.
//   2. Every pool admin pauses claims (SetClaimsPaused) if the old key leaked.
//   3. Run this script: pools created from now on start with the new key.
//      Pool addresses do not change (they depend on (master, chatId) only).
//   4. Each existing pool moves to the new key through its admin's
//      SetPoolBackendKey (miniapp: pool page, safety controls); vouchers
//      signed by the old key stop working there at once.
//   5. Switch the backend's BACKEND_SECRET to the new key, then unpause.
// The master refuses 0 and its current key; so does this script, before
// sending anything.
export function checkNewBackendKey(raw: string, current: bigint): bigint {
    const text = raw.trim();
    let key: bigint;
    try {
        if (!/^(0x[0-9a-fA-F]+|[0-9]+)$/.test(text)) throw new Error();
        key = BigInt(text);
    } catch {
        throw new Error(`invalid backend key: ${raw}`);
    }
    if (key <= 0n || key >= 1n << 256n) throw new Error(`invalid backend key: ${raw}`);
    if (key === current) throw new Error('the new backend key equals the current one');
    return key;
}

export async function run(provider: NetworkProvider) {
    const masterAddr = Address.parse(reqEnv('MASTER_ADDRESS'));
    const sender = provider.sender().address;
    if (!sender) throw new Error('Sender address is not defined');

    const master = provider.open(DistributorMaster.fromAddress(masterAddr));
    const owner = await master.getOwner();
    if (!owner.equals(sender)) throw new Error(`only the master owner ${owner.toString()} can rotate the key`);
    const current = await master.getBackendKey();
    const next = checkNewBackendKey(reqEnv('NEW_BACKEND_PUBLIC_KEY'), current);

    const prevLt = await lastTxLt(provider, sender);
    await master.send(
        provider.sender(),
        { value: toNano('0.05') },
        { $$type: 'RotateBackendKey', backendPubKey: next },
    );
    await confirmSend(provider, sender, prevLt, 'rotateBackendKey');
    console.log('Backend key rotated. Existing pools keep the old key until their admin sends SetPoolBackendKey.');
}
