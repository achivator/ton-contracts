import { Address, toNano } from '@ton/core';
import { TestJettonMinter } from '../wrappers/TestJetton';
import { NetworkProvider, sleep } from '@ton/blueprint';
import { reqEnv } from './env';
import { jettonDecimals, jettonWalletBalance, parseJettonAmount, requireTestnet } from './jetton';

// Mints test jettons (testnet only) from the TestJettonMinter owned by the
// connected wallet to any address, e.g. a chat creator's wallet for pool
// deposits. Env: JETTON_MASTER, RECIPIENT, AMOUNT (whole tokens; scaled by
// the jetton's decimals from get_jetton_data)
export async function run(provider: NetworkProvider) {
    requireTestnet(provider, 'mintTestJetton');
    const jettonMaster = Address.parse(reqEnv('JETTON_MASTER'));
    const minter = provider.open(TestJettonMinter.fromAddress(jettonMaster));
    const recipient = Address.parse(reqEnv('RECIPIENT'));
    const amount = parseJettonAmount(reqEnv('AMOUNT'), await jettonDecimals(provider, jettonMaster));

    const walletAddr = await minter.getGetWalletAddress(recipient);
    const before = await jettonWalletBalance(provider, walletAddr);

    await minter.send(provider.sender(), { value: toNano('0.15') }, { $$type: 'Mint', queryId: 0n, amount, recipient });

    for (let i = 0; i < 30; i++) {
        await sleep(3000);
        const balance = await jettonWalletBalance(provider, walletAddr);
        if (balance >= before + amount) {
            console.log('recipient jetton wallet:', walletAddr.toString());
            console.log('balance               :', balance.toString());
            return;
        }
    }
    throw new Error('mint not confirmed');
}
