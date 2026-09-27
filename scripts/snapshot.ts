import { Address } from '@ton/core';
import { DistributorMaster } from '../wrappers/DistributorMaster';
import { ChatPool } from '../wrappers/ChatPool';
import { NetworkProvider } from '@ton/blueprint';
import {
    actorAddr,
    GENERATED_ACTORS,
    isDeployed,
    jettonBalanceOf,
    tonBalance,
} from './actors';
import { reqEnv } from './env';

// Read-only snapshot of all scenario state, printed as greppable
// `SNAP|<key>|<value>` lines for run-multi-actor-e2e.sh / scenarioVerify.ts.
// Env: MASTER_ADDRESS, JETTON_MASTER, CHAT1, CHAT2, P1_NONCES, P2_NONCES
export async function run(provider: NetworkProvider) {
    const masterAddr = Address.parse(reqEnv('MASTER_ADDRESS'));
    const jm = Address.parse(reqEnv('JETTON_MASTER'));
    const master = provider.open(DistributorMaster.fromAddress(masterAddr));

    console.log(`SNAP|master.ton|${await tonBalance(provider, masterAddr)}`);

    const pools: [string, string, string][] = [
        ['pool1', 'CHAT1', 'P1_NONCES'],
        ['pool2', 'CHAT2', 'P2_NONCES'],
    ];
    for (const [label, chatEnv, nonceEnv] of pools) {
        const chatId = BigInt(reqEnv(chatEnv));
        const poolAddr = await master.getPoolAddress(chatId);
        const deployed = await isDeployed(provider, poolAddr);
        const nonces = (process.env[nonceEnv] ?? '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);

        console.log(`SNAP|${label}.addr|${poolAddr.toString()}`);
        console.log(`SNAP|${label}.deployed|${deployed ? 1 : 0}`);
        console.log(`SNAP|${label}.phys|${await jettonBalanceOf(provider, jm, poolAddr)}`);
        if (deployed) {
            const pool = provider.open(ChatPool.fromAddress(poolAddr));
            const admin = await pool.getPoolAdmin();
            console.log(`SNAP|${label}.ledger|${await pool.getBalanceOf(jm)}`);
            console.log(`SNAP|${label}.admin|${admin ? admin.toString() : 'null'}`);
            console.log(`SNAP|${label}.ton|${await tonBalance(provider, poolAddr)}`);
            for (const n of nonces) {
                console.log(`SNAP|${label}.nonce.${n}|${(await pool.getIsNonceUsed(BigInt(n))) ? 1 : 0}`);
            }
        } else {
            console.log(`SNAP|${label}.ledger|0`);
            console.log(`SNAP|${label}.admin|null`);
            console.log(`SNAP|${label}.ton|${await tonBalance(provider, poolAddr)}`);
            for (const n of nonces) {
                console.log(`SNAP|${label}.nonce.${n}|0`);
            }
        }
    }

    for (const name of GENERATED_ACTORS) {
        const addr = actorAddr(name);
        console.log(`SNAP|act.addr.${name}|${addr.toString()}`);
        console.log(`SNAP|act.jw.${name}|${await jettonBalanceOf(provider, jm, addr)}`);
        console.log(`SNAP|act.ton.${name}|${await tonBalance(provider, addr)}`);
    }
}
