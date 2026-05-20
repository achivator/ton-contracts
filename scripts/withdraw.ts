import { Address, toNano } from '@ton/core';
import { DistributorMaster } from '../wrappers/DistributorMaster';
import { ChatPool } from '../wrappers/ChatPool';
import { NetworkProvider } from '@ton/blueprint';
import { reqEnv } from './env';

// Env: MASTER_ADDRESS, JETTON_MASTER, CHAT_ID, AMOUNT
//      TO (default: the connected wallet)
//
// Admin-only withdrawal of the pool remainder. No backend involvement.
export async function run(provider: NetworkProvider) {
    const masterAddr = Address.parse(reqEnv('MASTER_ADDRESS'));
    const jettonMaster = Address.parse(reqEnv('JETTON_MASTER'));
    const chatId = BigInt(reqEnv('CHAT_ID'));
    const amount = toNano(reqEnv('AMOUNT'));

    const sender = provider.sender().address;
    if (!sender) throw new Error('Sender address is not defined');
    const to = process.env.TO ? Address.parse(process.env.TO) : sender;

    const master = provider.open(DistributorMaster.fromAddress(masterAddr));
    const poolAddr = await master.getPoolAddress(chatId);

    const pool = provider.open(ChatPool.fromAddress(poolAddr));
    await pool.send(
        provider.sender(),
        { value: toNano('0.15') },
        { $$type: 'WithdrawRemainder', jettonMaster, amount, to },
    );

    console.log('Withdraw sent:', amount.toString(), '->', to.toString());
}
