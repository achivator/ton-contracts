import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { toNano } from '@ton/core';
import { NftItem } from '../wrappers/NftItem';
import '@ton/test-utils';

describe('NftItem', () => {
    let blockchain: Blockchain;
    let deployer: SandboxContract<TreasuryContract>;
    let nftItem: SandboxContract<NftItem>;

    beforeEach(async () => {
        blockchain = await Blockchain.create();

        nftItem = blockchain.openContract(await NftItem.fromInit());

        deployer = await blockchain.treasury('deployer');

        const deployResult = await nftItem.send(
            deployer.getSender(),
            {
                value: toNano('0.05'),
            },
            {
                $$type: 'Deploy',
                queryId: 0n,
            }
        );

        expect(deployResult.transactions).toHaveTransaction({
            from: deployer.address,
            to: nftItem.address,
            deploy: true,
            success: true,
        });
    });

    it('should deploy', async () => {
        // the check is done inside beforeEach
        // blockchain and nftItem are ready to use
    });
});
