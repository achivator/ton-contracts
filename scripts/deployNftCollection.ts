import { Cell, toNano, beginCell } from '@ton/core';
import { NftCollection } from '../wrappers/NftCollection';
import { NetworkProvider } from '@ton/blueprint';

export async function run(provider: NetworkProvider) {
    let owner = provider.sender().address;
    if (!owner) throw new Error('Owner address is not defined');

    const OFFCHAIN_CONTENT_PREFIX = 0x01;
    const collectionUrl = "https://achivator.seniorsoftwarevlogger.com/metadata/";
    let collectionContent = beginCell().storeInt(OFFCHAIN_CONTENT_PREFIX, 8).storeStringRefTail(collectionUrl).endCell();

    const nftCollection = provider.open(await NftCollection.fromInit(collectionContent, {
        $$type: "RoyaltyParams",
        numerator: 350n, // 350n = 35%
        denominator: 1000n,
        destination: owner,
    }));

    await nftCollection.send(
        provider.sender(),
        {
            value: toNano('0.05'),
        },
        {
            $$type: 'Deploy',
            queryId: 0n,
        }
    );

    await provider.waitForDeploy(nftCollection.address);

    // run methods on `nftCollection`
    console.log('NftCollection deployed at:', nftCollection.address.toString());

    await nftCollection.send(
        provider.sender(),
        {
            value: toNano('0.05'),
        },
        {
            $$type: 'Mint',
            query_id: 0n,
            item_template: "v1/clown"
        }
    );
}
