import * as fs from 'fs';
import { Address } from '@ton/core';
import { NetworkProvider } from '@ton/blueprint';
import { actorAddr } from './actors';
import { reqEnv } from './env';

// Compares the two snapshots produced by snapshot.ts and asserts the exact
// end-state of the multi-actor scenario. Prints CHECK lines and a final
// RESULT line. Env: SNAP_BEFORE, SNAP_AFTER, P1_USED, P1_UNUSED,
// P2_USED, P2_UNUSED.
//
// Scenario flow this verifies (amounts in whole 9-decimal jettons):
//   pool1: ADMIN1 deposits 200; ATTACKER's leaked-voucher init (naming ADMIN1)
//          is rejected; ADMIN1 takes the admin slot via SetAdmin; MEMBER1
//          claims 50; forged claims rejected; ADMIN1 withdraws 150
//   pool2: ATTACKER front-runs createPool and squat-deposits 20 into the
//          adminless pool (refunded); forged-signature init is rejected;
//          ADMIN2 takes the slot and deposits 150; ATTACKER's valid-signature
//          rotation attempt is rejected; ADMIN2 rotates the slot to MEMBER2
//          (rotation demo); ATTACKER pays 30 to MEMBER2; ATTACKER's
//          withdraw and replay attempts are rejected; MEMBER2 sweeps 120 to
//          ADMIN2
//   junk:  ATTACKER sends 10 junk jettons (no voucher) to pool2; the pool
//          refunds them to ATTACKER without crediting its ledger
// => ADMIN1 -50, ADMIN2 -30, ATTACKER 0 (squat and junk refunded),
//    MEMBER1 +50, MEMBER2 +30
const DEC = 10n ** 9n;

function loadSnap(file: string): Map<string, string> {
    const out = new Map<string, string>();
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        const t = line.trim();
        if (!t.startsWith('SNAP|')) continue;
        const parts = t.split('|');
        out.set(parts[1], parts.slice(2).join('|'));
    }
    return out;
}

export async function run(_provider: NetworkProvider) {
    const before = loadSnap(reqEnv('SNAP_BEFORE'));
    const after = loadSnap(reqEnv('SNAP_AFTER'));
    let failures = 0;

    const check = (label: string, ok: boolean, detail = '') => {
        console.log(`CHECK ${ok ? 'OK  ' : 'FAIL'} ${label}${detail ? ` (${detail})` : ''}`);
        if (!ok) {
            failures++;
        }
    };
    const val = (map: Map<string, string>, key: string, fallback = '0'): string => map.get(key) ?? fallback;
    const delta = (key: string): bigint => BigInt(val(after, key)) - BigInt(val(before, key));

    const expected: [string, bigint][] = [
        ['act.jw.ADMIN1', -50n * DEC],
        ['act.jw.ADMIN2', -30n * DEC],
        ['act.jw.ATTACKER', 0n],
        ['act.jw.MEMBER1', 50n * DEC],
        ['act.jw.MEMBER2', 30n * DEC],
    ];
    for (const [key, exp] of expected) {
        const d = delta(key);
        check(`delta ${key} == ${exp}`, d === exp, `got ${d}`);
    }

    for (const key of ['pool1.ledger', 'pool1.phys', 'pool2.ledger', 'pool2.phys']) {
        const v = BigInt(val(after, key));
        check(`${key} == 0`, v === 0n, `got ${v}`);
    }

    check('pool1.addr stable', val(before, 'pool1.addr') === val(after, 'pool1.addr'), val(after, 'pool1.addr'));
    check('pool2.addr stable', val(before, 'pool2.addr') === val(after, 'pool2.addr'), val(after, 'pool2.addr'));

    const admin1 = val(after, 'pool1.admin', 'null');
    const admin2 = val(after, 'pool2.admin', 'null');
    check(
        'pool1.admin == ADMIN1',
        admin1 !== 'null' && Address.parse(admin1).equals(actorAddr('ADMIN1')),
        admin1,
    );
    // The squat is defeated: the squat deposit is refunded, ADMIN2
    // is seated by SetAdmin, and the rotation demo hands pool2 to MEMBER2.
    check(
        'pool2.admin == MEMBER2 (rotated, never the squatter)',
        admin2 !== 'null' && Address.parse(admin2).equals(actorAddr('MEMBER2')),
        admin2,
    );

    const nonceChecks: [string, string, string][] = [
        ['pool1', 'P1_USED', '1'],
        ['pool1', 'P1_UNUSED', '0'],
        ['pool2', 'P2_USED', '1'],
        ['pool2', 'P2_UNUSED', '0'],
    ];
    for (const [poolLabel, envName, want] of nonceChecks) {
        for (const n of (process.env[envName] ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
            const v = val(after, `${poolLabel}.nonce.${n}`);
            check(`${poolLabel}.nonce.${n} == ${want}`, v === want, `got ${v}`);
        }
    }

    for (const key of ['pool1.ton', 'pool2.ton']) {
        const v = BigInt(val(after, key));
        check(`${key} > 0.01 TON`, v > DEC / 100n, `got ${v}`);
    }
    const masterTon = BigInt(val(after, 'master.ton'));
    check('master.ton > 0', masterTon > 0n, `got ${masterTon}`);

    if (failures > 0) {
        console.log(`RESULT: FAIL (${failures})`);
    } else {
        console.log('RESULT: PASS');
    }
}
