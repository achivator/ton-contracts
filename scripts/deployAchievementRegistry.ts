import { beginCell, toNano } from '@ton/core';
import { AchievementRegistry } from '../wrappers/AchievementRegistry';
import { NetworkProvider } from '@ton/blueprint';
import { refuseKeySharedWithOtherNetwork } from './network';

// Kept by the registry as its storage reserve (contracts/achievement_registry.tact).
const REGISTRY_RESERVE = toNano('0.5');

// Env: BACKEND_PUBLIC_KEY (256-bit integer or 0x-hex; the key that signs
//      register/mint vouchers - the same backend key as DistributorMaster)
//      COLLECTION_URL (default https://achivator.cc/metadata/collection.json)
//
// Testnet and mainnet MUST use different backend keys (and should use
// different owner wallets): with both shared, the registry gets the same
// address on both networks, and a leak of the loosely handled testnet key
// would still sign mainnet mints. The deploy refuses when this very registry
// already exists on the other network.
//
// Deploys the AchievementRegistry (the TEP-62 collection and TEP-85
// authority of all achievement SBTs). The connected wallet becomes its
// owner: it can rotate the backend key, pause, revoke an SBT and hand the
// ownership over (scripts/registryControl.ts). The deploy value stays on the
// registry as its storage reserve (about 55 years at mainnet prices); the
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
    await refuseKeySharedWithOtherNetwork(provider, registry.address, 'AchievementRegistry');

    await registry.send(provider.sender(), { value: REGISTRY_RESERVE }, { $$type: 'Deploy', queryId: 0n });
    await provider.waitForDeploy(registry.address);

    console.log('AchievementRegistry deployed at:', registry.address.toString());
    console.log('Set in miniapp/.env.local: ACHIEVEMENT_REGISTRY=' + registry.address.toString());
}
