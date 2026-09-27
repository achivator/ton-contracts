import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Address, beginCell, Cell, toNano } from '@ton/core';
import { keyPairFromSeed, KeyPair } from '@ton/crypto';
import {
    AchievementRegistry,
    storeMintAchievement,
    storeMintVoucher,
    storeRegisterVoucher,
} from '../wrappers/AchievementRegistry';
import { AchievementItem } from '../wrappers/AchievementItem';
import { storeClaimVoucher } from '../wrappers/ChatPool';
import '@ton/test-utils';
import { signatureCell, signVoucher, TAG } from './helpers/vouchers';

// The miniapp's voucher lib (see MiniappIntegration.spec.ts for the pools).
const voucherLib: any = require('../../miniapp/src/lib/ton/vouchers.js');
const TAGS: Record<string, number> = require('../../miniapp/src/lib/ton/constants.js').VOUCHER_TAG;
const BACKEND_SECRET_HEX = Buffer.alloc(32, 7).toString('hex');

const CHAT_ID = -1001234567890n;
const TG_USER = 424242n;
const URL = 'https://achivator.cc/metadata/first-steps.json';

describe('AchievementRegistry', () => {
    let blockchain: Blockchain;
    let owner: SandboxContract<TreasuryContract>;
    let admin: SandboxContract<TreasuryContract>;
    let member: SandboxContract<TreasuryContract>;
    let stranger: SandboxContract<TreasuryContract>;
    let backend: KeyPair;
    let registry: SandboxContract<AchievementRegistry>;

    const farFuture = BigInt(Math.floor(Date.now() / 1000) + 3600);
    const royalty = (destination: Address, numerator = 5n, denominator = 100n) => ({
        $$type: 'RoyaltyParams' as const,
        numerator,
        denominator,
        destination,
    });

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        owner = await blockchain.treasury('owner');
        admin = await blockchain.treasury('admin');
        member = await blockchain.treasury('member');
        stranger = await blockchain.treasury('stranger');
        backend = keyPairFromSeed(Buffer.alloc(32, 7));

        const collectionContent = beginCell().storeUint(1, 8).storeStringTail('https://achivator.cc/collection.json').endCell();
        registry = blockchain.openContract(
            await AchievementRegistry.fromInit(
                owner.address,
                BigInt('0x' + backend.publicKey.toString('hex')),
                collectionContent,
            ),
        );
        const dep = await registry.send(owner.getSender(), { value: toNano('0.1') }, { $$type: 'Deploy', queryId: 0n });
        expect(dep.transactions).toHaveTransaction({ to: registry.address, deploy: true, success: true });
    });

    function registerVoucher(registrant: Address, opts: { tag?: bigint; target?: Address } = {}) {
        const voucherCell = beginCell()
            .store(storeRegisterVoucher({ $$type: 'RegisterVoucher', chatId: CHAT_ID, registrant, expiry: farFuture }))
            .endCell();
        const signature = signatureCell(
            signVoucher(voucherCell, backend, opts.tag ?? TAG.Register, opts.target ?? registry.address),
        );
        return { voucherCell, signature };
    }

    function register(
        sender: SandboxContract<TreasuryContract>,
        v: { voucherCell: Cell; signature: Cell },
        overrides: { contentUrl?: string; royalty?: ReturnType<typeof royalty>; value?: bigint } = {},
    ) {
        return registry.send(
            sender.getSender(),
            { value: overrides.value ?? toNano('0.2') },
            {
                $$type: 'RegisterTemplate',
                contentUrl: overrides.contentUrl ?? URL,
                contentHash: 123n,
                royalty: overrides.royalty ?? royalty(admin.address),
                ...v,
            },
        );
    }

    function mintVoucher(templateId: bigint, nonce: bigint, tgUserId = TG_USER) {
        const voucherCell = beginCell()
            .store(
                storeMintVoucher({
                    $$type: 'MintVoucher',
                    templateId,
                    recipient: member.address,
                    tgUserId,
                    nonce,
                    expiry: farFuture,
                }),
            )
            .endCell();
        return {
            $$type: 'MintAchievement' as const,
            voucherCell,
            signature: signatureCell(signVoucher(voucherCell, backend, TAG.Mint, registry.address)),
        };
    }

    it('registers a template for the named admin, keeps the fee and refunds the rest', async () => {
        const before = (await blockchain.getContract(registry.address)).balance;
        const res = await register(admin, registerVoucher(admin.address), { value: toNano('1') });
        expect(res.transactions).toHaveTransaction({ from: admin.address, to: registry.address, success: true });
        // overpayment comes back
        expect(res.transactions).toHaveTransaction({ from: registry.address, to: admin.address, success: true });
        const after = (await blockchain.getContract(registry.address)).balance;
        expect(after - before).toBeGreaterThanOrEqual(toNano('0.099'));
        expect(after - before).toBeLessThanOrEqual(toNano('0.1'));

        expect(await registry.getTemplatesCount()).toEqual(1n);
        const t = (await registry.getTemplate(0n))!;
        expect(t.chatId).toEqual(CHAT_ID);
        expect(t.creator.equals(admin.address)).toBe(true);
        expect(t.contentUrl).toEqual(URL);
    });

    it('does not accept a member claim voucher as a registration voucher (type confusion)', async () => {
        // Before domain separation, a ClaimVoucher (chatId, recipient, ...)
        // parsed as a RegisterVoucher (chatId, registrant, expiry) and let any
        // member who claimed jettons register achievements for the chat.
        const claimCell = beginCell()
            .store(
                storeClaimVoucher({
                    $$type: 'ClaimVoucher',
                    chatId: CHAT_ID,
                    recipient: member.address,
                    jettonMaster: stranger.address,
                    amount: toNano('1'),
                    nonce: 1n,
                    expiry: farFuture,
                }),
            )
            .endCell();
        for (const tag of [TAG.Claim, TAG.Register]) {
            const res = await register(member, {
                voucherCell: claimCell,
                signature: signatureCell(signVoucher(claimCell, backend, tag, registry.address)),
            });
            expect(res.transactions).toHaveTransaction({ from: member.address, to: registry.address, success: false });
        }
        expect(await registry.getTemplatesCount()).toEqual(0n);
    });

    it('rejects vouchers for another registry, another kind, or another registrant', async () => {
        const cases = [
            { sender: admin, v: registerVoucher(admin.address, { target: stranger.address }) },
            { sender: admin, v: registerVoucher(admin.address, { tag: TAG.Mint }) },
            { sender: stranger, v: registerVoucher(admin.address) },
        ];
        for (const { sender, v } of cases) {
            const res = await register(sender, v);
            expect(res.transactions).toHaveTransaction({ from: sender.address, to: registry.address, success: false });
        }
        expect(await registry.getTemplatesCount()).toEqual(0n);
    });

    it('rejects a zero royalty denominator, an oversized url and an underpaid fee', async () => {
        const v = registerVoucher(admin.address);
        const bad = [
            { royalty: royalty(admin.address, 0n, 0n) },
            { royalty: royalty(admin.address, 101n, 100n) },
            { contentUrl: 'https://x.io/' + 'a'.repeat(400) },
            { value: toNano('0.1') },
        ];
        for (const overrides of bad) {
            const res = await register(admin, v, overrides);
            expect(res.transactions).toHaveTransaction({ from: admin.address, to: registry.address, success: false });
        }
        expect(await registry.getTemplatesCount()).toEqual(0n);
    });

    it('mints once per user, refunds overpayment, and exposes TEP-62 collection data', async () => {
        await register(admin, registerVoucher(admin.address));

        const res = await registry.send(member.getSender(), { value: toNano('1') }, mintVoucher(0n, 1n));
        const itemAddress = await registry.getNftAddress(0n);
        expect(res.transactions).toHaveTransaction({ from: registry.address, to: itemAddress, deploy: true, success: true });
        // the registry refunds the unspent part of the 1 TON
        expect(res.transactions).toHaveTransaction({
            from: registry.address,
            to: member.address,
            value: (v) => v! > toNano('0.8'),
        });

        const item = blockchain.openContract(AchievementItem.fromAddress(itemAddress));
        const data = await item.getGetNftData();
        expect(data.is_initialized).toBe(true);
        expect(data.owner_address.equals(member.address)).toBe(true);
        expect(data.collection_address.equals(registry.address)).toBe(true);

        expect(await registry.getIsMinted(0n, TG_USER)).toBe(true);
        expect(await registry.getIsMinted(0n, TG_USER + 1n)).toBe(false);

        const collection = await registry.getGetCollectionData();
        expect(collection.next_item_index).toEqual(1n);
        expect((await registry.getGetNftAddressByIndex(0n)).equals(itemAddress)).toBe(true);

        // same (template, user) with a fresh nonce is still refused
        const again = await registry.send(member.getSender(), { value: toNano('0.2') }, mintVoucher(0n, 2n));
        expect(again.transactions).toHaveTransaction({ from: member.address, to: registry.address, success: false });
        // and a replayed nonce too
        const replay = await registry.send(member.getSender(), { value: toNano('0.2') }, mintVoucher(0n, 1n, TG_USER + 1n));
        expect(replay.transactions).toHaveTransaction({ from: member.address, to: registry.address, success: false });
        expect(await registry.getItemsCount()).toEqual(1n);
    });

    it('transfers an item with a forward_amount (marketplace style) and keeps its storage reserve', async () => {
        await register(admin, registerVoucher(admin.address));
        await registry.send(member.getSender(), { value: toNano('0.2') }, mintVoucher(0n, 1n));
        const item = blockchain.openContract(AchievementItem.fromAddress(await registry.getNftAddress(0n)));

        const res = await item.send(
            member.getSender(),
            { value: toNano('0.2') },
            {
                $$type: 'Transfer',
                query_id: 9n,
                new_owner: stranger.address,
                response_destination: member.address,
                custom_payload: null,
                forward_amount: toNano('0.05'),
                forward_payload: beginCell().endCell(),
            },
        );
        expect(res.transactions).toHaveTransaction({ from: member.address, to: item.address, success: true });
        expect(res.transactions).toHaveTransaction({ from: item.address, to: stranger.address, value: toNano('0.05') });
        expect(res.transactions).toHaveTransaction({ from: item.address, to: member.address });
        expect((await item.getGetNftData()).owner_address.equals(stranger.address)).toBe(true);
        expect((await blockchain.getContract(item.address)).balance).toBeGreaterThanOrEqual(toNano('0.019'));

        // the new owner cannot drain the reserve into a forward_amount
        const drain = await item.send(
            stranger.getSender(),
            { value: toNano('0.01') },
            {
                $$type: 'Transfer',
                query_id: 10n,
                new_owner: member.address,
                response_destination: stranger.address,
                custom_payload: null,
                forward_amount: toNano('0.015'),
                forward_payload: beginCell().endCell(),
            },
        );
        expect(drain.transactions).toHaveTransaction({ from: stranger.address, to: item.address, success: false });
    });

    it('accepts a mint built and signed by the miniapp lib, byte-identical to the bindings', async () => {
        await register(admin, registerVoucher(admin.address));
        const fields = { templateId: 0n, recipient: member.address, tgUserId: -TG_USER, nonce: 77n, expiry: farFuture };
        const libVoucher = voucherLib.buildMintVoucherCell(fields);
        const genVoucher = beginCell().store(storeMintVoucher({ $$type: 'MintVoucher', ...fields })).endCell();
        expect(libVoucher.toBoc().toString('base64')).toEqual(genVoucher.toBoc().toString('base64'));

        const signature: Buffer = voucherLib.signVoucher(libVoucher, BACKEND_SECRET_HEX, {
            tag: TAGS.Mint,
            target: registry.address,
        });
        expect(signature).toEqual(signVoucher(genVoucher, backend, TAG.Mint, registry.address));
        const body: Cell = voucherLib.buildMintBody({ voucherCell: libVoucher, signature });
        const genBody = beginCell()
            .store(storeMintAchievement({ $$type: 'MintAchievement', voucherCell: genVoucher, signature: signatureCell(signature) }))
            .endCell();
        expect(body.toBoc().toString('base64')).toEqual(genBody.toBoc().toString('base64'));

        const res = await member.send({ to: registry.address, value: toNano('0.15'), body });
        expect(res.transactions).toHaveTransaction({ from: member.address, to: registry.address, success: true });
        expect(await registry.getIsMinted(0n, -TG_USER)).toBe(true);
    });

    // ---- audit regressions: fee withdrawal ----

    it('lets only the owner withdraw fees and keeps the storage reserve', async () => {
        await register(admin, registerVoucher(admin.address));

        const strangerWithdraw = await registry.send(
            stranger.getSender(),
            { value: toNano('0.05') },
            { $$type: 'WithdrawFees', amount: toNano('0.01'), to: stranger.address },
        );
        expect(strangerWithdraw.transactions).toHaveTransaction({ from: stranger.address, to: registry.address, success: false });

        // more than balance minus the storage reserve
        const greedy = await registry.send(
            owner.getSender(),
            { value: toNano('0.05') },
            { $$type: 'WithdrawFees', amount: toNano('10'), to: owner.address },
        );
        expect(greedy.transactions).toHaveTransaction({ from: owner.address, to: registry.address, success: false });

        const res = await registry.send(
            owner.getSender(),
            { value: toNano('0.05') },
            { $$type: 'WithdrawFees', amount: toNano('0.02'), to: owner.address },
        );
        expect(res.transactions).toHaveTransaction({
            from: registry.address,
            to: owner.address,
            value: toNano('0.02'),
            success: true,
        });
        expect((await blockchain.getContract(registry.address)).balance).toBeGreaterThanOrEqual(toNano('0.05'));
    });

    // ---- audit regressions: mint payment and voucher validity ----

    it('refuses a mint that does not cover fee + item value + gas', async () => {
        await register(admin, registerVoucher(admin.address));
        // 0.1 < 0.01 fee + 0.05 item + 0.05 gas
        const res = await registry.send(member.getSender(), { value: toNano('0.1') }, mintVoucher(0n, 1n));
        expect(res.transactions).toHaveTransaction({ from: member.address, to: registry.address, success: false });
        expect(await registry.getItemsCount()).toEqual(0n);
        expect(await registry.getIsNonceUsed(1n)).toBe(false);
    });

    it('rejects expired register and mint vouchers', async () => {
        const past = BigInt(Math.floor(Date.now() / 1000) - 60);

        const rv = beginCell()
            .store(storeRegisterVoucher({ $$type: 'RegisterVoucher', chatId: CHAT_ID, registrant: admin.address, expiry: past }))
            .endCell();
        const reg = await register(admin, {
            voucherCell: rv,
            signature: signatureCell(signVoucher(rv, backend, TAG.Register, registry.address)),
        });
        expect(reg.transactions).toHaveTransaction({ from: admin.address, to: registry.address, success: false });
        expect(await registry.getTemplatesCount()).toEqual(0n);

        await register(admin, registerVoucher(admin.address));
        const mv = beginCell()
            .store(storeMintVoucher({ $$type: 'MintVoucher', templateId: 0n, recipient: member.address, tgUserId: TG_USER, nonce: 1n, expiry: past }))
            .endCell();
        const mint = await registry.send(member.getSender(), { value: toNano('0.2') }, {
            $$type: 'MintAchievement',
            voucherCell: mv,
            signature: signatureCell(signVoucher(mv, backend, TAG.Mint, registry.address)),
        });
        expect(mint.transactions).toHaveTransaction({ from: member.address, to: registry.address, success: false });
        expect(await registry.getIsNonceUsed(1n)).toBe(false);
        expect(await registry.getItemsCount()).toEqual(0n);
    });

    it('rejects a mint for an unknown template without burning the nonce', async () => {
        await register(admin, registerVoucher(admin.address));
        const res = await registry.send(member.getSender(), { value: toNano('0.2') }, mintVoucher(7n, 1n));
        expect(res.transactions).toHaveTransaction({ from: member.address, to: registry.address, success: false });
        expect(await registry.getItemsCount()).toEqual(0n);
        expect(await registry.getIsNonceUsed(1n)).toBe(false);
    });

    it('rejects vouchers with trailing data after the signed fields (endParse)', async () => {
        // The signature covers the whole cell including the junk, so these
        // reach the parser; endParse must then refuse to process them. Only
        // the backend can produce such a cell, but a parsing bug there must
        // not mint or register anything.
        const rv = beginCell()
            .store(storeRegisterVoucher({ $$type: 'RegisterVoucher', chatId: CHAT_ID, registrant: admin.address, expiry: farFuture }))
            .storeUint(1, 16)
            .endCell();
        const reg = await register(admin, {
            voucherCell: rv,
            signature: signatureCell(signVoucher(rv, backend, TAG.Register, registry.address)),
        });
        expect(reg.transactions).toHaveTransaction({ from: admin.address, to: registry.address, success: false });
        expect(await registry.getTemplatesCount()).toEqual(0n);

        await register(admin, registerVoucher(admin.address));
        const mv = beginCell()
            .store(storeMintVoucher({ $$type: 'MintVoucher', templateId: 0n, recipient: member.address, tgUserId: TG_USER, nonce: 1n, expiry: farFuture }))
            .storeUint(1, 16)
            .endCell();
        const mint = await registry.send(member.getSender(), { value: toNano('0.2') }, {
            $$type: 'MintAchievement',
            voucherCell: mv,
            signature: signatureCell(signVoucher(mv, backend, TAG.Mint, registry.address)),
        });
        expect(mint.transactions).toHaveTransaction({ from: member.address, to: registry.address, success: false });
        expect(await registry.getItemsCount()).toEqual(0n);
        expect(await registry.getIsNonceUsed(1n)).toBe(false);
    });

    it('propagates the template royalty to the minted item', async () => {
        await register(admin, registerVoucher(admin.address), { royalty: royalty(stranger.address, 7n, 50n) });
        await registry.send(member.getSender(), { value: toNano('0.2') }, mintVoucher(0n, 1n));

        const item = blockchain.openContract(AchievementItem.fromAddress(await registry.getNftAddress(0n)));
        const r = await item.getGetRoyaltyParams();
        expect(r.numerator).toEqual(7n);
        expect(r.denominator).toEqual(50n);
        expect(r.destination.equals(stranger.address)).toBe(true);
    });
});
