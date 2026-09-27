import { Address, toNano } from '@ton/core';
import { AchievementRegistry } from '../wrappers/AchievementRegistry';
import { NetworkProvider } from '@ton/blueprint';
import { reqEnv } from './env';
import { confirmSend, lastTxLt } from './actors';

// Owner-only withdrawal of accumulated template/mint fees from the
// AchievementRegistry (its storage reserve stays).
// Env: ACHIEVEMENT_REGISTRY, AMOUNT; TO (default: the connected wallet)
export async function run(provider: NetworkProvider) {
    const registryAddr = Address.parse(reqEnv('ACHIEVEMENT_REGISTRY'));
    const amount = toNano(reqEnv('AMOUNT'));

    const sender = provider.sender().address;
    if (!sender) throw new Error('Sender address is not defined');
    const to = process.env.TO ? Address.parse(process.env.TO) : sender;

    const registry = provider.open(AchievementRegistry.fromAddress(registryAddr));
    const prevLt = await lastTxLt(provider, sender);
    await registry.send(provider.sender(), { value: toNano('0.05') }, { $$type: 'WithdrawFees', amount, to });

    console.log('Registry fee withdrawal sent:', amount.toString(), '->', to.toString());
    await confirmSend(provider, sender, prevLt, 'withdrawRegistryFees');
}
