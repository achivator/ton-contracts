import { keyPairFromSeed } from '@ton/crypto';
import { Address } from '@ton/core';
import { DistributorMaster } from '../wrappers/DistributorMaster';
import { NetworkProvider } from '@ton/blueprint';
import { reqEnv } from './env';

// Read-only: derives the backend public key from BACKEND_SECRET and, when
// MASTER_ADDRESS is set, compares it with the master's on-chain key.
// Prints public data only.
export async function run(provider: NetworkProvider) {
    const kp = keyPairFromSeed(Buffer.from(reqEnv('BACKEND_SECRET'), 'hex'));
    const pub = BigInt('0x' + kp.publicKey.toString('hex'));
    console.log('BACKEND_PUBLIC_KEY=' + pub.toString());

    const masterAddr = process.env.MASTER_ADDRESS;
    if (masterAddr) {
        const master = provider.open(DistributorMaster.fromAddress(Address.parse(masterAddr)));
        const onchain = await master.getBackendKey();
        console.log('MASTER_BACKEND_KEY=' + onchain.toString());
        console.log('KEY_MATCH=' + (onchain === pub ? 'yes' : 'no'));
    }
}
