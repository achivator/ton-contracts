import { beginCell, toNano } from '@ton/core';
import { TestJettonMinter, TestJettonWallet } from '../wrappers/TestJetton';
import { NetworkProvider } from '@ton/blueprint';

// Deploys the TEP-74 test jetton (testnet only) and mints an initial supply
// to the connected wallet.
//
// Env: MINT_AMOUNT (default 1000000, 9-decimal units)
export async function run(provider: NetworkProvider) {
    const owner = provider.sender().address;
    if (!owner) throw new Error('Owner address is not defined');
    const mintAmount = toNano(process.env.MINT_AMOUNT ?? '1000000');

    const content = beginCell()
        .storeUint(0, 8)
        .storeStringTail('achivator test jetton (testnet only)')
        .endCell();

    const minter = provider.open(await TestJettonMinter.fromInit(owner, content));
    await minter.send(provider.sender(), { value: toNano('0.05') }, { $$type: 'Deploy', queryId: 0n });
    await provider.waitForDeploy(minter.address);
    console.log('TestJettonMinter deployed at:', minter.address.toString());

    const ownerWalletAddr = await minter.getGetWalletAddress(owner);
    await minter.send(provider.sender(), { value: toNano('0.15') },
        { $$type: 'Mint', amount: mintAmount, recipient: owner });
    await provider.waitForDeploy(ownerWalletAddr);

    const wallet = provider.open(TestJettonWallet.fromAddress(ownerWalletAddr));
    const balance = await wallet.getWalletBalance();
    console.log('owner jetton wallet  :', ownerWalletAddr.toString());
    console.log('minted               :', mintAmount.toString(), 'balance:', balance.toString());
    console.log('mintedTotal          :', (await minter.getMintedTotal()).toString());
}
