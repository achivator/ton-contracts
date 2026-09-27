import { keyPairFromSeed } from '@ton/crypto';
import { randomBytes } from 'crypto';

// Generates the backend ed25519 keypair used to sign deposit and claim
// vouchers. Run once, then keep BACKEND_SECRET private and pass
// BACKEND_PUBLIC_KEY to the master deploy.
export async function run() {
    const seed = randomBytes(32);
    const kp = keyPairFromSeed(seed);
    const pub = BigInt('0x' + kp.publicKey.toString('hex'));

    console.log('BACKEND_SECRET     (keep private):', seed.toString('hex'));
    console.log('BACKEND_PUBLIC_KEY (for deploy)  :', pub.toString());
}
