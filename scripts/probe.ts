import { Address } from '@ton/core';
import { DistributorMaster } from '../wrappers/DistributorMaster';
import { NetworkProvider } from '@ton/blueprint';
import { isDeployed, jettonBalanceOf, jettonWalletOf, tonBalance } from './actors';

// Read-only preflight probe. Lines are meant to be grepped by the runner:
//   ADDR|<addr>|deployed=<0|1>|ton=<coins>
//   MASTER|<addr>|deployed=<0|1>|ton=<coins>
//   POOL|<chatId>|<addr>|deployed=<0|1>|ton=<coins>
//   OWNER_JW|<addr>|<balance>
export async function run(provider: NetworkProvider) {
    const addrEnv = process.env.ADDR;
    if (addrEnv) {
        const addr = Address.parse(addrEnv);
        console.log(
            `ADDR|${addr.toString()}|deployed=${(await isDeployed(provider, addr)) ? 1 : 0}|ton=${await tonBalance(provider, addr)}`,
        );
    }

    const masterAddr = process.env.MASTER_ADDRESS;
    if (masterAddr) {
        const master = Address.parse(masterAddr);
        console.log(
            `MASTER|${master.toString()}|deployed=${(await isDeployed(provider, master)) ? 1 : 0}|ton=${await tonBalance(provider, master)}`,
        );

        const chatId = process.env.CHAT_ID;
        if (chatId) {
            const m = provider.open(DistributorMaster.fromAddress(master));
            const pool = await m.getPoolAddress(BigInt(chatId));
            console.log(
                `POOL|${chatId}|${pool.toString()}|deployed=${(await isDeployed(provider, pool)) ? 1 : 0}|ton=${await tonBalance(provider, pool)}`,
            );
        }
    }

    const jettonMaster = process.env.JETTON_MASTER;
    const owner = provider.sender().address;
    if (jettonMaster && owner) {
        const jm = Address.parse(jettonMaster);
        const jw = await jettonWalletOf(provider, jm, owner);
        console.log(`OWNER_JW|${jw.toString()}|${await jettonBalanceOf(provider, jm, owner)}`);
    }
}
