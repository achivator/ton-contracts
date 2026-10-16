import * as fs from 'fs';
import * as path from 'path';
import { Address, toNano } from '@ton/core';
import { keyPairFromSeed, sha256_sync } from '@ton/crypto';
import { NetworkProvider, sleep } from '@ton/blueprint';
import { AchievementRegistry } from '../wrappers/AchievementRegistry';
import { AchievementTemplate } from '../wrappers/AchievementTemplate';
import {
    offchainContent,
    PLATFORM_CHAT_TAG,
    registerTemplateBody,
    registerVoucherCell,
    templateKeyOf,
} from '../wrappers/Achievements';
import { TAG } from '../wrappers/Vouchers';
import { voucherSignerFor } from './network';
import { reqEnv } from './env';

// Env: ACHIEVEMENT_REGISTRY, BACKEND_SECRET
//      METADATA_BASE (default https://achivator.cc/metadata/items/v1/;
//      https:// or ipfs://, and every URL at most 126 bytes)
//
// Registers one platform-wide template (chatTag 0) per built-in bot
// achievement: the ones with a metadata file in
// miniapp/public/metadata/items/v1. The template key is
// hash(chatTag, sha256(file)), so it is known before sending and no
// registration can take another's place. Re-running is safe: a template
// that already exists is skipped (and a repeated registration would only be
// refunded). Each new template keeps 0.05 TON as its storage reserve; the
// rest of the 0.15 TON comes back.
//
// Prints the ACHIEVEMENT_TEMPLATES value the miniapp needs to sign mint
// vouchers: { "v1/<type>": "0x<template key>" }.
export async function run(provider: NetworkProvider) {
    const sender = provider.sender().address;
    if (!sender) throw new Error('Sender address is not defined');
    const registry = provider.open(AchievementRegistry.fromAddress(Address.parse(reqEnv('ACHIEVEMENT_REGISTRY'))));
    const version = Number(await registry.getVersion());
    if (version !== 3) {
        throw new Error(`registry speaks protocol v${version}; this script registers templates on v3 registries only`);
    }
    // the envelope the registry's version asks for, on this network
    const signFor = await voucherSignerFor(provider, registry.address);
    const kp = keyPairFromSeed(Buffer.from(reqEnv('BACKEND_SECRET'), 'hex'));
    const base = process.env.METADATA_BASE ?? 'https://achivator.cc/metadata/items/v1/';

    const dir = path.resolve(__dirname, '../../miniapp/public/metadata/items/v1');
    const files = fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .sort();
    const templates: Record<string, string> = {};

    for (const file of files) {
        const bytes = fs.readFileSync(path.join(dir, file));
        const type = file.replace(/\.json$/, '').replace(/-/g, ' ');
        const url = base + file;
        const contentHash = BigInt('0x' + sha256_sync(bytes).toString('hex'));
        const templateKey = templateKeyOf(PLATFORM_CHAT_TAG, contentHash);
        if ((await registry.getTemplateKeyOf(PLATFORM_CHAT_TAG, contentHash)) !== templateKey) {
            throw new Error('the registry derives another template key: wrong wrappers for this registry');
        }
        const template = provider.open(AchievementTemplate.fromAddress(await registry.getTemplateAddress(templateKey)));
        const key = '0x' + templateKey.toString(16).padStart(64, '0');

        if (!(await registered(provider, template))) {
            const voucherCell = registerVoucherCell({
                chatTag: PLATFORM_CHAT_TAG,
                registrant: sender,
                contentHash,
                expiry: BigInt(Math.floor(Date.now() / 1000) + 3600),
                contentUrl: url,
            });
            const signature = signFor(voucherCell, kp, TAG.Register);
            await provider.sender().send({
                to: registry.address,
                value: toNano('0.15'),
                body: registerTemplateBody(voucherCell, signature),
            });
            for (let i = 0; i < 30 && !(await registered(provider, template)); i++) await sleep(3000);
            if (!(await registered(provider, template))) throw new Error(`registration of ${type} not confirmed`);
        }
        // whoever registered it, it must be this very content
        const data = await template.getGetTemplateData();
        if (data.content_hash !== contentHash || !data.content?.equals(offchainContent(url))) {
            throw new Error(`template ${key} for ${type} holds other content`);
        }
        templates[`v1/${type}`] = key;
        console.log(`TEMPLATE|v1/${type}|${key}|${template.address.toString()}`);
    }

    console.log('\nSet in miniapp/.env.local:');
    console.log(`ACHIEVEMENT_TEMPLATES=${JSON.stringify(templates)}`);
}

async function registered(
    provider: NetworkProvider,
    template: { address: Address; getGetTemplateData: () => Promise<{ is_initialized: boolean }> },
) {
    if (!(await provider.isContractDeployed(template.address))) return false;
    return (await template.getGetTemplateData()).is_initialized;
}
