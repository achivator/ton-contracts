import { toNano } from '@ton/core';
import { DistributorMaster } from '../wrappers/DistributorMaster';
import { NetworkProvider } from '@ton/blueprint';
import { refuseKeySharedWithOtherNetwork } from './network';

// Set this to the backend's ed25519 public key (as a 256-bit integer) that
// will sign deposit, claim and admin vouchers.
//
// Testnet and mainnet MUST use different backend keys (and should use
// different owner wallets): with both shared, the master and every pool get
// the same address on both networks. Vouchers name their network (protocol
// v3), but a leak of the loosely handled testnet key would still sign for
// mainnet. The deploy refuses when this very master already exists on the
// other network.
const BACKEND_PUBLIC_KEY = BigInt(process.env.BACKEND_PUBLIC_KEY ?? '0');

export async function run(provider: NetworkProvider) {
    const owner = provider.sender().address;
    if (!owner) throw new Error('Owner address is not defined');
    if (BACKEND_PUBLIC_KEY === 0n) {
        throw new Error('Set BACKEND_PUBLIC_KEY (256-bit integer) before deploying');
    }

    const master = provider.open(await DistributorMaster.fromInit(owner, BACKEND_PUBLIC_KEY));
    await refuseKeySharedWithOtherNetwork(provider, master.address, 'DistributorMaster');

    await master.send(provider.sender(), { value: toNano('0.1') }, { $$type: 'Deploy', queryId: 0n });
    await provider.waitForDeploy(master.address);

    console.log('DistributorMaster deployed at:', master.address.toString());
}
