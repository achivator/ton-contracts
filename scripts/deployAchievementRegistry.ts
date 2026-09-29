import { beginCell, toNano } from '@ton/core';
import { AchievementRegistry } from '../wrappers/AchievementRegistry';
import { NetworkProvider } from '@ton/blueprint';

// Env: BACKEND_PUBLIC_KEY (256-bit integer or 0x-hex; the key that signs
//      register/mint vouchers - the same backend key as DistributorMaster)
//      COLLECTION_URL (default https://achivator.cc/metadata/collection.json)
//
// Deploys the AchievementRegistry (the TEP-62 collection of all achievement
// NFTs). The connected wallet becomes the TEP-62 collection owner; the
// registry takes no fee and pays no TON out.
export async function run(provider: NetworkProvider) {
    const owner = provider.sender().address;
    if (!owner) throw new Error('Owner address is not defined');
    const backendKey = BigInt(process.env.BACKEND_PUBLIC_KEY ?? '0');
    if (backendKey === 0n) throw new Error('Set BACKEND_PUBLIC_KEY before deploying');
    const collectionUrl = process.env.COLLECTION_URL ?? 'https://achivator.cc/metadata/collection.json';

    // TEP-64 off-chain content: 0x01 prefix + URL
    const content = beginCell().storeUint(1, 8).storeStringTail(collectionUrl).endCell();
    const registry = provider.open(await AchievementRegistry.fromInit(owner, backendKey, content));

    await registry.send(provider.sender(), { value: toNano('0.1') }, { $$type: 'Deploy', queryId: 0n });
    await provider.waitForDeploy(registry.address);

    console.log('AchievementRegistry deployed at:', registry.address.toString());
    console.log('Set in miniapp/.env.local: ACHIEVEMENT_REGISTRY=' + registry.address.toString());
}
