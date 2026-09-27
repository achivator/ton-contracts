import * as fs from 'fs';
import { WalletContractV4 } from '@ton/ton';
import { mnemonicNew, mnemonicToPrivateKey } from '@ton/crypto';
import { NetworkProvider } from '@ton/blueprint';
import { ACTORS_FILE, GENERATED_ACTORS, readActorsFile } from './actors';
import { reqEnv } from './env';

// Idempotently creates/reuses the scenario's actor wallets:
//   ADMIN1, ADMIN2      - chat admins (register pools)
//   MEMBER1, MEMBER2    - reward claimants
//   ATTACKER            - adversarial wallet
// Re-runs keep existing mnemonics; only addresses are printed.
export async function run(_provider: NetworkProvider) {
    const version = process.env.WALLET_VERSION ?? 'v4';
    if (version !== 'v4') {
        throw new Error(`This toolkit assumes WALLET_VERSION=v4 (got ${version})`);
    }

    const existing = readActorsFile();
    const lines: string[] = [
        '# Auto-generated actor wallets for the multi-actor testnet scenario.',
        '# Gitignored. Re-running genActors keeps existing wallets.',
        '',
    ];

    console.log('actor     address');
    for (const name of GENERATED_ACTORS) {
        let mn = process.env[`${name}_MNEMONIC`] ?? existing.get(`${name}_MNEMONIC`);
        if (!mn) {
            mn = (await mnemonicNew(24)).join(' ');
        }
        const kp = await mnemonicToPrivateKey(mn.trim().split(/\s+/));
        const addr = WalletContractV4.create({ workchain: 0, publicKey: kp.publicKey }).address;
        lines.push(`${name}_MNEMONIC=${mn}`, `${name}_ADDR=${addr.toString()}`, '');
        console.log(`${name.padEnd(9)} ${addr.toString()}`);
    }

    const ownerKp = await mnemonicToPrivateKey(reqEnv('WALLET_MNEMONIC').trim().split(/\s+/));
    const ownerAddr = WalletContractV4.create({ workchain: 0, publicKey: ownerKp.publicKey }).address;
    lines.push(`OWNER_ADDR=${ownerAddr.toString()}`, '');
    console.log(`${'OWNER'.padEnd(9)} ${ownerAddr.toString()}`);

    // Preserve runner-persisted keys (e.g. MASTER_ADDRESS) across regeneration.
    const extra = new Map(existing);
    for (const name of GENERATED_ACTORS) {
        extra.delete(`${name}_MNEMONIC`);
        extra.delete(`${name}_ADDR`);
    }
    extra.delete('OWNER_ADDR');
    if (extra.size > 0) {
        lines.push('# persisted state');
        for (const [k, v] of extra) {
            lines.push(`${k}=${v}`);
        }
    }

    fs.writeFileSync(ACTORS_FILE, lines.join('\n') + '\n');
    console.log('written :', ACTORS_FILE);
}
