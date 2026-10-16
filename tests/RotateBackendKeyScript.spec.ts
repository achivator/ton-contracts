// DM-6: scripts/rotateBackendKey.ts refuses, before sending anything, the
// keys the master itself rejects (0, the current key) and malformed input.
import { keyPairFromSeed } from '@ton/crypto';
import { checkNewBackendKey } from '../scripts/rotateBackendKey';

const pub = (seed: number) => BigInt('0x' + keyPairFromSeed(Buffer.alloc(32, seed)).publicKey.toString('hex'));

describe('scripts/rotateBackendKey.ts', () => {
    it('accepts a new key as decimal or 0x hex', () => {
        const next = pub(8);
        expect(checkNewBackendKey(next.toString(), pub(7))).toEqual(next);
        expect(checkNewBackendKey('0x' + next.toString(16), pub(7))).toEqual(next);
    });

    it('refuses 0, the current key and malformed or oversized input', () => {
        expect(() => checkNewBackendKey('0', pub(7))).toThrow(/invalid/i);
        expect(() => checkNewBackendKey(pub(7).toString(), pub(7))).toThrow(/current/i);
        expect(() => checkNewBackendKey('', pub(7))).toThrow(/invalid/i);
        expect(() => checkNewBackendKey('nope', pub(7))).toThrow(/invalid/i);
        expect(() => checkNewBackendKey((1n << 256n).toString(), pub(7))).toThrow(/invalid/i);
    });
});
