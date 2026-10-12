import { keyPairFromSeed } from '@ton/crypto';
import { randomBytes } from 'crypto';

// Generates the backend ed25519 keypair used to sign vouchers. Run once per
// network (testnet and mainnet MUST NOT share a key), then keep
// BACKEND_SECRET private and pass BACKEND_PUBLIC_KEY to the master and
// registry deploys of that network.
export async function run() {
    const seed = randomBytes(32);
    const kp = keyPairFromSeed(seed);
    const pub = BigInt('0x' + kp.publicKey.toString('hex'));

    console.log('BACKEND_SECRET     (keep private):', seed.toString('hex'));
    console.log('BACKEND_PUBLIC_KEY (for deploy)  :', pub.toString());
}
