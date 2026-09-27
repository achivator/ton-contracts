import { Address, toNano } from '@ton/core';
import { DistributorMaster } from '../wrappers/DistributorMaster';
import { NetworkProvider } from '@ton/blueprint';
import { reqEnv } from './env';
import { confirmSend, lastTxLt } from './actors';

// Owner-only withdrawal of accumulated TON fees from the master.
// Env: MASTER_ADDRESS, AMOUNT; TO (default: the connected wallet)
export async function run(provider: NetworkProvider) {
    const masterAddr = Address.parse(reqEnv('MASTER_ADDRESS'));
    const amount = toNano(reqEnv('AMOUNT'));

    const sender = provider.sender().address;
    if (!sender) throw new Error('Sender address is not defined');
    const to = process.env.TO ? Address.parse(process.env.TO) : sender;

    const master = provider.open(DistributorMaster.fromAddress(masterAddr));
    const prevLt = await lastTxLt(provider, sender);
    await master.send(provider.sender(), { value: toNano('0.05') }, { $$type: 'WithdrawFee', amount, to });

    console.log('Fee withdrawal sent:', amount.toString(), '->', to.toString());
    await confirmSend(provider, sender, prevLt, 'withdrawFee');
}
