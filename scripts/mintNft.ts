// EQCjHOVbLrkp8pKqcqZZNgWIsz1lBwDUc3Fzyn4bo-jCrbfu

import { Address, toNano } from '@ton/core';
import { NftCollection } from '../wrappers/NftCollection';
import { NetworkProvider } from '@ton/blueprint';

export async function run(provider: NetworkProvider) {
    const collection = provider.open(await NftCollection.fromAddress(Address.parse("EQCE3SuQEOpb1ouP9Fa17ec3gyv0M13v-Tk_t_NobhXEctrZ")));

    await collection.send(
        provider.sender(),
        {
            value: toNano('1'),
        },
        {
            $$type: 'Mint',
            query_id: 0n,
            item_template: "v1/clown"
        }
    );

    // run methods on `nftItem`
}