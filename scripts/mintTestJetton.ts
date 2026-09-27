import { Address, toNano } from '@ton/core';
import { TestJettonMinter, TestJettonWallet } from '../wrappers/TestJetton';
import { NetworkProvider, sleep } from '@ton/blueprint';
import { reqEnv } from './env';

// Mints test jettons (testnet only) from the TestJettonMinter owned by the
// connected wallet to any address, e.g. a chat creator's wallet for pool
// deposits. Env: JETTON_MASTER, RECIPIENT, AMOUNT (whole tokens, 9 decimals)
export async function run(provider: NetworkProvider) {
    const minter = provider.open(TestJettonMinter.fromAddress(Address.parse(reqEnv('JETTON_MASTER'))));
    const recipient = Address.parse(reqEnv('RECIPIENT'));
    const amount = toNano(reqEnv('AMOUNT'));

    const walletAddr = await minter.getGetWalletAddress(recipient);
    const wallet = provider.open(TestJettonWallet.fromAddress(walletAddr));
    const before = (await provider.isContractDeployed(walletAddr)) ? await wallet.getWalletBalance() : 0n;

    await minter.send(provider.sender(), { value: toNano('0.15') }, { $$type: 'Mint', amount, recipient });

    for (let i = 0; i < 30; i++) {
        await sleep(3000);
        if (!(await provider.isContractDeployed(walletAddr))) continue;
        const balance = await wallet.getWalletBalance();
        if (balance >= before + amount) {
            console.log('recipient jetton wallet:', walletAddr.toString());
            console.log('balance               :', balance.toString());
            return;
        }
    }
    throw new Error('mint not confirmed');
}
