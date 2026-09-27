import * as fs from 'fs';
import * as path from 'path';
import { Address, beginCell, toNano } from '@ton/core';
import { keyPairFromSeed, sha256_sync } from '@ton/crypto';
import { NetworkProvider, sleep } from '@ton/blueprint';
import { AchievementRegistry, storeRegisterVoucher } from '../wrappers/AchievementRegistry';
import { signVoucher, TAG } from '../wrappers/Vouchers';
import { reqEnv } from './env';

// Env: ACHIEVEMENT_REGISTRY, BACKEND_SECRET
//      METADATA_BASE (default https://achivator.cc/metadata/items/v1/)
//      ROYALTY_PERCENT (default 5, paid to the connected wallet)
//      START_INDEX (default 0; resume an interrupted run from this file index,
//      which must equal the registry's current templates count)
//
// Registers one template per built-in bot achievement (the ones with a
// metadata file in miniapp/public/metadata/items/v1), as platform-wide
// templates (chatId 0) owned by the connected wallet. Each registration
// costs the 0.1 TON registry fee. Prints the ACHIEVEMENT_TEMPLATES value the
// miniapp needs to sign mint vouchers. Re-running skips nothing: only run it
// once per registry.
export async function run(provider: NetworkProvider) {
    const sender = provider.sender().address;
    if (!sender) throw new Error('Sender address is not defined');
    const registry = provider.open(AchievementRegistry.fromAddress(Address.parse(reqEnv('ACHIEVEMENT_REGISTRY'))));
    const kp = keyPairFromSeed(Buffer.from(reqEnv('BACKEND_SECRET'), 'hex'));
    const base = process.env.METADATA_BASE ?? 'https://achivator.cc/metadata/items/v1/';
    const royaltyPercent = BigInt(process.env.ROYALTY_PERCENT ?? '5');

    const dir = path.resolve(__dirname, '../../miniapp/public/metadata/items/v1');
    const startIndex = Number(process.env.START_INDEX ?? '0');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort().slice(startIndex);
    const templates: Record<string, number> = {};
    const registered = Number(await registry.getTemplatesCount());
    if (registered !== startIndex) {
        throw new Error(`registry has ${registered} templates, START_INDEX must match it (got ${startIndex})`);
    }

    for (const file of files) {
        const bytes = fs.readFileSync(path.join(dir, file));
        const type = file.replace(/\.json$/, '').replace(/-/g, ' ');
        const templateId = Number(await registry.getTemplatesCount());

        const voucherCell = beginCell()
            .store(
                storeRegisterVoucher({
                    $$type: 'RegisterVoucher',
                    chatId: 0n, // platform-wide template
                    registrant: sender,
                    expiry: BigInt(Math.floor(Date.now() / 1000) + 3600),
                }),
            )
            .endCell();
        const signature = beginCell().storeBuffer(signVoucher(voucherCell, kp, TAG.Register, registry.address)).endCell();

        await registry.send(provider.sender(), { value: toNano('0.2') }, {
            $$type: 'RegisterTemplate',
            contentUrl: base + file,
            contentHash: BigInt('0x' + sha256_sync(bytes).toString('hex')),
            royalty: { $$type: 'RoyaltyParams', numerator: royaltyPercent, denominator: 100n, destination: sender },
            voucherCell,
            signature,
        });

        // wait until the registry has counted this template
        for (let i = 0; i < 30 && Number(await registry.getTemplatesCount()) === templateId; i++) await sleep(3000);
        if (Number(await registry.getTemplatesCount()) === templateId) throw new Error(`registration of ${type} not confirmed`);
        templates[`v1/${type}`] = templateId;
        console.log(`TEMPLATE|v1/${type}|${templateId}`);
    }

    console.log('\nSet in miniapp/.env.local:');
    console.log(`ACHIEVEMENT_TEMPLATES=${JSON.stringify(templates)}`);
}
