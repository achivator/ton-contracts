import { Address, toNano } from '@ton/core';
import { DistributorMaster } from '../wrappers/DistributorMaster';
import { ChatPool } from '../wrappers/ChatPool';
import { NetworkProvider } from '@ton/blueprint';
import { reqEnv } from './env';
import { confirmSend, lastTxLt } from './actors';

// Env: MASTER_ADDRESS, CHAT_ID, MODE, plus per mode:
//   MODE=pause | resume                 freeze / unfreeze claims
//   MODE=limit  JETTON_MASTER, AMOUNT   daily claim budget in whole tokens
//                                       (9 decimals; 0 = default 10%/day)
//   MODE=key    BACKEND_PUBLIC_KEY      move the pool to a new backend key
//
// Pool admin safety controls. The connected wallet must be the pool admin.
// They bound what a leaked backend key can do; see contracts/chat_pool.tact.
export async function run(provider: NetworkProvider) {
    const masterAddr = Address.parse(reqEnv('MASTER_ADDRESS'));
    const chatId = BigInt(reqEnv('CHAT_ID'));
    const mode = reqEnv('MODE');

    const sender = provider.sender().address;
    if (!sender) throw new Error('Sender address is not defined');
    const master = provider.open(DistributorMaster.fromAddress(masterAddr));
    const pool = provider.open(ChatPool.fromAddress(await master.getPoolAddress(chatId)));

    const prevLt = await lastTxLt(provider, sender);
    const value = toNano('0.05');
    switch (mode) {
        case 'pause':
        case 'resume':
            await pool.send(provider.sender(), { value }, { $$type: 'SetClaimsPaused', paused: mode === 'pause' });
            break;
        case 'limit':
            await pool.send(provider.sender(), { value }, {
                $$type: 'SetClaimLimit',
                jettonMaster: Address.parse(reqEnv('JETTON_MASTER')),
                dailyLimit: toNano(reqEnv('AMOUNT')),
            });
            break;
        case 'key':
            await pool.send(provider.sender(), { value }, {
                $$type: 'SetPoolBackendKey',
                backendPubKey: BigInt('0x' + reqEnv('BACKEND_PUBLIC_KEY').replace(/^0x/, '')),
            });
            break;
        default:
            throw new Error(`Unknown MODE "${mode}" (pause | resume | limit | key)`);
    }
    console.log(`poolControl ${mode} sent to ${pool.address.toString()}`);
    await confirmSend(provider, sender, prevLt, `poolControl ${mode}`);
}
