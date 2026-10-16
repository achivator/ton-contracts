import { Address, toNano } from '@ton/core';
import { NetworkProvider } from '@ton/blueprint';
import { AchievementRegistry } from '../wrappers/AchievementRegistry';
import { reqEnv } from './env';
import { confirmSend, lastTxLt } from './actors';

// Env: ACHIEVEMENT_REGISTRY, MODE, plus per mode:
//   MODE=pause | resume          stop / restart registrations and mints
//   MODE=key     BACKEND_PUBLIC_KEY   rotate the backend key (e.g. after a
//                                      leak; vouchers of the old key stop working)
//   MODE=revoke  ITEM_INDEX            TEP-85 revoke of one SBT (decimal or 0x hex)
//   MODE=propose NEW_OWNER             first step of an ownership transfer
//                                      (NEW_OWNER=none cancels a proposal)
//   MODE=accept                        second step, sent by the proposed owner
//
// Owner controls of the AchievementRegistry. The connected wallet must be
// the owner (or, for accept, the proposed owner). The attached 0.05 TON
// stays on the registry (or, for revoke, on the item) as storage reserve.
export async function run(provider: NetworkProvider) {
    const registry = provider.open(AchievementRegistry.fromAddress(Address.parse(reqEnv('ACHIEVEMENT_REGISTRY'))));
    const mode = reqEnv('MODE');
    const sender = provider.sender().address;
    if (!sender) throw new Error('Sender address is not defined');

    const prevLt = await lastTxLt(provider, sender);
    const value = toNano('0.05');
    const via = provider.sender();
    switch (mode) {
        case 'pause':
        case 'resume':
            await registry.send(via, { value }, { $$type: 'SetPaused', paused: mode === 'pause' });
            break;
        case 'key': {
            const newKey = BigInt('0x' + reqEnv('BACKEND_PUBLIC_KEY').replace(/^0x/, ''));
            if (newKey === (await registry.getBackendKey())) throw new Error('that is the current key');
            await registry.send(via, { value }, { $$type: 'RotateBackendKey', newKey });
            break;
        }
        case 'revoke':
            await registry.send(
                via,
                { value },
                {
                    $$type: 'RevokeAchievement',
                    query_id: 0n,
                    index: BigInt(reqEnv('ITEM_INDEX')),
                },
            );
            break;
        case 'propose': {
            const target = reqEnv('NEW_OWNER');
            await registry.send(
                via,
                { value },
                {
                    $$type: 'ProposeOwner',
                    newOwner: target === 'none' ? null : Address.parse(target),
                },
            );
            break;
        }
        case 'accept':
            await registry.send(via, { value }, { $$type: 'AcceptOwnership' });
            break;
        default:
            throw new Error(`Unknown MODE "${mode}" (pause | resume | key | revoke | propose | accept)`);
    }
    console.log(`registryControl ${mode} sent to ${registry.address.toString()}`);
    await confirmSend(provider, sender, prevLt, `registryControl ${mode}`);
}
