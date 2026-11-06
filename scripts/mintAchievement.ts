import { Address, beginCell, toNano } from '@ton/core';
import { keyPairFromSeed } from '@ton/crypto';
import { NetworkProvider, sleep } from '@ton/blueprint';
import { AchievementRegistry, storeTransfer } from '../wrappers/AchievementRegistry';
import { AchievementItem } from '../wrappers/AchievementItem';
import { mintAchievementBody, mintVoucherCell } from '../wrappers/Achievements';
import { TAG } from '../wrappers/Vouchers';
import { confirmSend, lastTxLt, tonBalance } from './actors';
import { voucherSignerFor } from './network';
import { reqEnv } from './env';

// Env: ACHIEVEMENT_REGISTRY, BACKEND_SECRET, TEMPLATE_KEY (0x..), USER_TAG (0x..)
//      MODE=mint (default): mints the template's SBT for USER_TAG. RECIPIENT
//           names the voucher's recipient (default the connected wallet), so
//           a foreign recipient shows the registry refusing the sender.
//      MODE=transfer: tries to transfer the SBT to TO; soulbound items refuse.
//
// Testnet verification tool: prints the wallet's TON delta, the item's state
// and the exit code of the transaction that decided the outcome.
export async function run(provider: NetworkProvider) {
    const sender = provider.sender().address;
    if (!sender) throw new Error('Sender address is not defined');
    if (provider.network() === 'mainnet') throw new Error('mintAchievement is a testnet tool');
    const registry = provider.open(AchievementRegistry.fromAddress(Address.parse(reqEnv('ACHIEVEMENT_REGISTRY'))));
    const templateKey = BigInt(reqEnv('TEMPLATE_KEY'));
    const userTag = BigInt(reqEnv('USER_TAG'));
    const mode = process.env.MODE ?? 'mint';
    const itemAddress = await registry.getItemAddress(templateKey, userTag);
    const item = provider.open(AchievementItem.fromAddress(itemAddress));

    const before = await tonBalance(provider, sender);
    const prevLt = await lastTxLt(provider, sender);
    const watched = mode === 'transfer' ? itemAddress : registry.address;
    const watchedLt = await lastTxLt(provider, watched);

    if (mode === 'mint') {
        const recipient = process.env.RECIPIENT ? Address.parse(process.env.RECIPIENT) : sender;
        const kp = keyPairFromSeed(Buffer.from(reqEnv('BACKEND_SECRET'), 'hex'));
        const signFor = await voucherSignerFor(provider, registry.address);
        const expiry = BigInt(Math.floor(Date.now() / 1000) + 3600);
        const voucher = mintVoucherCell({ templateKey, recipient, userTag, expiry });
        await provider.sender().send({
            to: registry.address,
            value: toNano('0.15'),
            body: mintAchievementBody(voucher, signFor(voucher, kp, TAG.Mint)),
        });
    } else if (mode === 'transfer') {
        const body = beginCell()
            .store(
                storeTransfer({
                    $$type: 'Transfer',
                    query_id: 1n,
                    new_owner: Address.parse(reqEnv('TO')),
                    response_destination: sender,
                    custom_payload: null,
                    forward_amount: 0n,
                    forward_payload: beginCell().storeUint(0, 1).endCell(),
                }),
            )
            .endCell();
        await provider.sender().send({ to: itemAddress, value: toNano('0.1'), body });
    } else {
        throw new Error(`Unknown MODE "${mode}"`);
    }

    await confirmSend(provider, sender, prevLt, `mintAchievement ${mode}`);
    await reportTx(provider, watched, watchedLt, mode);

    // the chain of messages behind the first one needs a few more blocks
    await sleep(25000);
    console.log(`DELTA|ton=${(await tonBalance(provider, sender)) - before}`);
    if (await provider.isContractDeployed(itemAddress)) {
        const data = await item.getGetNftData();
        console.log(
            `ITEM|${itemAddress.toString()}|initialized=${data.is_initialized}|owner=${data.owner_address.beginParse().loadAddress().toString()}|revoked=${await item.getGetRevokedTime()}`,
        );
    } else {
        console.log(`ITEM|${itemAddress.toString()}|not deployed`);
    }
}

// Waits for the watched contract's next transaction and prints its hash and
// compute-phase exit code.
async function reportTx(provider: NetworkProvider, addr: Address, prevLt: string, mode: string) {
    const api: any = provider.api();
    for (let i = 0; i < 16; i++) {
        const txs = await api.getTransactions(addr, { limit: 1 });
        if (txs && txs.length > 0 && txs[0].lt.toString() !== prevLt) {
            const d: any = txs[0].description;
            const exit = d?.computePhase?.type === 'vm' ? d.computePhase.exitCode : 'n/a';
            console.log(
                `TX|${mode}|${addr.toString()}|hash=${txs[0].hash().toString('hex')}|exit=${exit}|aborted=${d?.aborted}`,
            );
            return;
        }
        await sleep(2500);
    }
    console.log(`TX|${mode}|${addr.toString()}|not observed`);
}
