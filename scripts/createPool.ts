import { Address, toNano } from '@ton/core';
import { DistributorMaster } from '../wrappers/DistributorMaster';
import { NetworkProvider } from '@ton/blueprint';
import { reqEnv } from './env';
import { confirmSend, lastTxLt } from './actors';

// Env: MASTER_ADDRESS, CHAT_ID
export async function run(provider: NetworkProvider) {
    const masterAddr = Address.parse(reqEnv('MASTER_ADDRESS'));
    const chatId = BigInt(reqEnv('CHAT_ID'));

    const sender = provider.sender().address;
    if (!sender) throw new Error('Sender address is not defined');

    const master = provider.open(DistributorMaster.fromAddress(masterAddr));
    const poolAddr = await master.getPoolAddress(chatId);

    const prevLt = await lastTxLt(provider, sender);
    await master.send(provider.sender(), { value: toNano('0.3') }, { $$type: 'CreatePool', chatId });

    console.log('ChatPool address:', poolAddr.toString());
    await provider.waitForDeploy(poolAddr);
    await confirmSend(provider, sender, prevLt, 'createPool');
    console.log('Pool deployed for chat', chatId.toString());
}
