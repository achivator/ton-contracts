import { toNano } from '@ton/core';
import { DistributorMaster } from '../wrappers/DistributorMaster';
import { NetworkProvider } from '@ton/blueprint';

// Set this to the backend's ed25519 public key (as a 256-bit integer) that
// will sign deposit and claim vouchers.
const BACKEND_PUBLIC_KEY = BigInt(process.env.BACKEND_PUBLIC_KEY ?? '0');

export async function run(provider: NetworkProvider) {
    const owner = provider.sender().address;
    if (!owner) throw new Error('Owner address is not defined');
    if (BACKEND_PUBLIC_KEY === 0n) {
        throw new Error('Set BACKEND_PUBLIC_KEY (256-bit integer) before deploying');
    }

    const master = provider.open(await DistributorMaster.fromInit(owner, BACKEND_PUBLIC_KEY));

    await master.send(provider.sender(), { value: toNano('0.1') }, { $$type: 'Deploy', queryId: 0n });
    await provider.waitForDeploy(master.address);

    console.log('DistributorMaster deployed at:', master.address.toString());
}
