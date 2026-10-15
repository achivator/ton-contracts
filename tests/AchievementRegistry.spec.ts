import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Address, beginCell, Cell, contractAddress, toNano, Transaction } from '@ton/core';
import { keyPairFromSeed, KeyPair } from '@ton/crypto';
import { createHmac } from 'crypto';
import { AchievementRegistry } from '../wrappers/AchievementRegistry';
import { AchievementItem } from '../wrappers/AchievementItem';
import { AchievementTemplate } from '../wrappers/AchievementTemplate';
import {
    itemIndexOf,
    mintAchievementBody,
    mintVoucherCell,
    offchainContent,
    PLATFORM_CHAT_TAG,
    registerTemplateBody,
    registerVoucherCell,
    templateKeyOf,
} from '../wrappers/Achievements';
import { storeClaimVoucher } from '../wrappers/ChatPool';
import '@ton/test-utils';
import { globalIdOf, signVoucher, TAG } from './helpers/vouchers';

// The miniapp's libs (see MiniappIntegration.spec.ts for the pools).
const voucherLib: any = require('../../miniapp/src/lib/ton/vouchers.js');
const tagsLib: any = require('../../miniapp/src/lib/ton/achievement-tags.js');
const MINIAPP: any = require('../../miniapp/src/lib/ton/constants.js');
const BACKEND_SECRET_HEX = Buffer.alloc(32, 7).toString('hex');
const TAG_KEY = Buffer.alloc(32, 11);

const CHAT_ID = -1001234567890n;
const TG_USER = 424242n;
const URL = 'https://achivator.cc/metadata/items/v1/programmer.json';
const CONTENT_HASH = 0x1234n;
const hmac = (kind: string, id: bigint) =>
    BigInt('0x' + createHmac('sha256', TAG_KEY).update(`${kind}:${id}`).digest('hex'));
const CHAT_TAG = hmac('chat', CHAT_ID);
const USER_TAG = hmac('user', TG_USER);
const KEY = templateKeyOf(CHAT_TAG, CONTENT_HASH);

// Contract constants (contracts/achievement_*.tact).
const ITEM_RESERVE = toNano('0.04');
const TEMPLATE_RESERVE = toNano('0.05');

function fees(txs: Transaction[]) {
    let total = 0n;
    for (const t of txs) total += t.totalFees.coins;
    return total;
}

describe('AchievementRegistry', () => {
    let blockchain: Blockchain;
    let owner: SandboxContract<TreasuryContract>;
    let admin: SandboxContract<TreasuryContract>;
    let member: SandboxContract<TreasuryContract>;
    let stranger: SandboxContract<TreasuryContract>;
    let backend: KeyPair;
    let registry: SandboxContract<AchievementRegistry>;
    let now: number;

    const farFuture = () => BigInt(now + 3600);

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        // A frozen clock: wall-clock time would charge a nanoton of rent now
        // and then and make the balance checks flaky.
        now = Math.floor(Date.now() / 1000);
        blockchain.now = now;
        owner = await blockchain.treasury('owner');
        admin = await blockchain.treasury('admin');
        member = await blockchain.treasury('member');
        stranger = await blockchain.treasury('stranger');
        backend = keyPairFromSeed(Buffer.alloc(32, 7));

        const collectionContent = beginCell()
            .storeUint(1, 8)
            .storeStringTail('https://achivator.cc/collection.json')
            .endCell();
        registry = blockchain.openContract(
            await AchievementRegistry.fromInit(
                owner.address,
                BigInt('0x' + backend.publicKey.toString('hex')),
                collectionContent,
            ),
        );
        const dep = await registry.send(owner.getSender(), { value: toNano('0.5') }, { $$type: 'Deploy', queryId: 0n });
        expect(dep.transactions).toHaveTransaction({ to: registry.address, deploy: true, success: true });
        // the deploy value stays as the registry's storage reserve
        expect((await blockchain.getContract(registry.address)).balance).toBeGreaterThan(toNano('0.49'));
    });

    function registerVoucher(
        registrant: Address,
        opts: { tag?: bigint; target?: Address; chatTag?: bigint; contentHash?: bigint; url?: string } = {},
    ) {
        const voucherCell = registerVoucherCell({
            chatTag: opts.chatTag ?? CHAT_TAG,
            registrant,
            contentHash: opts.contentHash ?? CONTENT_HASH,
            expiry: farFuture(),
            contentUrl: opts.url ?? URL,
        });
        const signature = signVoucher(
            voucherCell,
            backend,
            opts.tag ?? TAG.Register,
            opts.target ?? registry.address,
            globalIdOf(blockchain),
        );
        return { voucherCell, signature };
    }

    function register(
        sender: SandboxContract<TreasuryContract>,
        v: { voucherCell: Cell; signature: Buffer },
        value = toNano('0.2'),
    ) {
        return sender.send({ to: registry.address, value, body: registerTemplateBody(v.voucherCell, v.signature) });
    }

    function mintMessage(templateKey = KEY, userTag = USER_TAG, recipient = member.address) {
        const voucherCell = mintVoucherCell({ templateKey, recipient, userTag, expiry: farFuture() });
        const signature = signVoucher(voucherCell, backend, TAG.Mint, registry.address, globalIdOf(blockchain));
        return mintAchievementBody(voucherCell, signature);
    }

    function mint(value = toNano('0.2'), body = mintMessage()) {
        return member.send({ to: registry.address, value, body });
    }

    async function template(templateKey = KEY) {
        return blockchain.openContract(AchievementTemplate.fromAddress(await registry.getTemplateAddress(templateKey)));
    }

    async function item(templateKey = KEY, userTag = USER_TAG) {
        return blockchain.openContract(
            AchievementItem.fromAddress(await registry.getItemAddress(templateKey, userTag)),
        );
    }

    // What the backend asks: does this (template, user) SBT exist?
    async function isMinted(templateKey = KEY, userTag = USER_TAG) {
        const it = await item(templateKey, userTag);
        if ((await blockchain.getContract(it.address)).accountState?.type !== 'active') return false;
        return (await it.getGetNftData()).is_initialized;
    }

    async function isRegistered(templateKey = KEY) {
        const t = await template(templateKey);
        if ((await blockchain.getContract(t.address)).accountState?.type !== 'active') return false;
        return (await t.getGetTemplateData()).is_initialized;
    }

    const balance = async (a: Address) => (await blockchain.getContract(a)).balance;

    it('registers a template for the named admin: the template keeps its reserve, the rest comes back', async () => {
        const registryBefore = await balance(registry.address);
        const adminBefore = await balance(admin.address);
        const res = await register(admin, registerVoucher(admin.address), toNano('1'));
        const t = await template();
        expect(res.transactions).toHaveTransaction({ from: admin.address, to: registry.address, success: true });
        expect(res.transactions).toHaveTransaction({
            from: registry.address,
            to: t.address,
            deploy: true,
            success: true,
        });
        expect(res.transactions).toHaveTransaction({ from: t.address, to: admin.address, success: true });

        // the registry keeps nothing, the template exactly its reserve
        expect(await balance(registry.address)).toEqual(registryBefore);
        expect(await balance(t.address)).toEqual(TEMPLATE_RESERVE);
        const spent = adminBefore - (await balance(admin.address));
        console.log(
            `register: ${Number(spent) / 1e9} TON spent, ${Number(spent - TEMPLATE_RESERVE) / 1e9} TON of it gas and fees`,
        );
        expect(spent - TEMPLATE_RESERVE).toBeLessThan(toNano('0.03'));

        const d = await t.getGetTemplateData();
        expect(d.is_initialized).toBe(true);
        expect(d.registry.equals(registry.address)).toBe(true);
        expect(d.template_key).toEqual(KEY);
        expect(d.chat_tag).toEqual(CHAT_TAG);
        expect(d.creator!.equals(admin.address)).toBe(true);
        expect(d.content_hash).toEqual(CONTENT_HASH);
        expect(d.content!.equals(offchainContent(URL))).toBe(true);
        expect(await registry.getTemplateKeyOf(CHAT_TAG, CONTENT_HASH)).toEqual(KEY);
        // the wrapper derives the address the registry deploys (AI-9)
        expect((await AchievementTemplate.fromInit(registry.address, KEY)).address.equals(t.address)).toBe(true);
    });

    it('does not accept a member claim voucher as a registration voucher (type confusion)', async () => {
        // Before domain separation, a ClaimVoucher parsed as a RegisterVoucher
        // and let any member who claimed jettons register achievements.
        const claimCell = beginCell()
            .store(
                storeClaimVoucher({
                    $$type: 'ClaimVoucher',
                    chatId: CHAT_ID,
                    recipient: member.address,
                    jettonMaster: stranger.address,
                    amount: toNano('1'),
                    nonce: 1n,
                    expiry: farFuture(),
                }),
            )
            .endCell();
        for (const tag of [TAG.Claim, TAG.Register]) {
            const res = await register(member, {
                voucherCell: claimCell,
                signature: signVoucher(claimCell, backend, tag, registry.address, globalIdOf(blockchain)),
            });
            expect(res.transactions).toHaveTransaction({ from: member.address, to: registry.address, success: false });
        }
        expect(await isRegistered()).toBe(false);
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
        expect(await isRegistered()).toBe(false);
    });

    it('refuses an underpaid registration', async () => {
        const res = await register(admin, registerVoucher(admin.address), toNano('0.09'));
        expect(res.transactions).toHaveTransaction({ from: admin.address, to: registry.address, success: false });
        expect(await isRegistered()).toBe(false);
    });

    it('mints once per user, refunds overpayment, and exposes TEP-62 / TEP-85 data', async () => {
        await register(admin, registerVoucher(admin.address));
        const registryBefore = await balance(registry.address);
        const memberBefore = await balance(member.address);

        const res = await mint(toNano('1'));
        const it = await item();
        expect(res.transactions).toHaveTransaction({
            from: registry.address,
            to: it.address,
            deploy: true,
            success: true,
        });
        // the item refunds the unspent part of the 1 TON
        expect(res.transactions).toHaveTransaction({
            from: it.address,
            to: member.address,
            value: (v) => v! > toNano('0.9'),
        });
        expect(await balance(registry.address)).toEqual(registryBefore);
        expect(await balance(it.address)).toEqual(ITEM_RESERVE);
        const spent = memberBefore - (await balance(member.address));
        console.log(
            `mint: ${Number(spent) / 1e9} TON spent, ${Number(spent - ITEM_RESERVE) / 1e9} TON of it gas and fees`,
        );
        expect(spent - ITEM_RESERVE).toBeLessThan(toNano('0.04'));

        const data = await it.getGetNftData();
        const index = itemIndexOf(KEY, USER_TAG);
        expect(data.is_initialized).toBe(true);
        expect(data.index).toEqual(index);
        expect(data.owner_address.beginParse().loadAddress().equals(member.address)).toBe(true);
        expect(data.collection_address.equals(registry.address)).toBe(true);
        expect(data.individual_content.equals(offchainContent(URL))).toBe(true);
        expect(await it.getGetContentHash()).toEqual(CONTENT_HASH);
        expect(await it.getGetRevokedTime()).toEqual(0n);
        expect((await it.getGetAuthorityAddress()).beginParse().loadAddress().equals(registry.address)).toBe(true);
        expect(await isMinted()).toBe(true);
        expect(await isMinted(KEY, USER_TAG + 1n)).toBe(false);

        const collection = await registry.getGetCollectionData();
        expect(collection.next_item_index).toEqual(-1n);
        expect(collection.owner_address.equals(owner.address)).toBe(true);
        expect((await registry.getGetNftAddressByIndex(index)).equals(it.address)).toBe(true);
        expect(await registry.getItemIndexOf(KEY, USER_TAG)).toEqual(index);
        expect((await AchievementItem.fromInit(registry.address, index)).address.equals(it.address)).toBe(true);

        // the same (template, user) again: refunded by the item, nothing changes
        const again = await mint(toNano('0.2'));
        expect(again.transactions).toHaveTransaction({ from: registry.address, to: it.address, success: true });
        expect(again.transactions).toHaveTransaction({ from: it.address, to: member.address });
        expect(await balance(it.address)).toEqual(ITEM_RESERVE);
        expect(await balance(registry.address)).toEqual(registryBefore);
    });

    it('accepts a register and a mint built and signed by the miniapp lib, byte-identical to the bindings', async () => {
        const env = { ACHIEVEMENT_TAG_KEY: TAG_KEY.toString('hex') };
        // the miniapp's tags and keys are the ones the registry derives
        const key = tagsLib.tagKey(env);
        expect(tagsLib.chatTag(CHAT_ID, key)).toEqual(CHAT_TAG);
        expect(tagsLib.userTag(TG_USER, key)).toEqual(USER_TAG);
        expect(tagsLib.userTag(Number(TG_USER), key)).toEqual(USER_TAG);
        expect(tagsLib.templateKeyOf(CHAT_TAG, CONTENT_HASH)).toEqual(
            await registry.getTemplateKeyOf(CHAT_TAG, CONTENT_HASH),
        );
        expect(tagsLib.itemIndexOf(KEY, USER_TAG)).toEqual(await registry.getItemIndexOf(KEY, USER_TAG));
        expect(tagsLib.PLATFORM_CHAT_TAG).toEqual(PLATFORM_CHAT_TAG);
        expect(BigInt(MINIAPP.VOUCHER_TAG.Register)).toEqual(TAG.Register);
        expect(BigInt(MINIAPP.VOUCHER_TAG.Mint)).toEqual(TAG.Mint);

        const version = Number(await registry.getVersion());
        const globalId = globalIdOf(blockchain);

        // register
        const regFields = {
            chatTag: CHAT_TAG,
            registrant: admin.address,
            contentHash: CONTENT_HASH,
            expiry: farFuture(),
            contentUrl: URL,
        };
        const libReg = voucherLib.buildRegisterVoucherCell(regFields);
        const genReg = registerVoucherCell(regFields);
        expect(libReg.equals(genReg)).toBe(true);
        const regSig: Buffer = voucherLib.signVoucher(libReg, BACKEND_SECRET_HEX, {
            tag: MINIAPP.VOUCHER_TAG.Register,
            target: registry.address,
            version,
            globalId,
        });
        expect(regSig).toEqual(signVoucher(genReg, backend, TAG.Register, registry.address, globalId));
        const regBody: Cell = voucherLib.buildRegisterBody({ voucherCell: libReg, signature: regSig });
        expect(regBody.equals(registerTemplateBody(genReg, regSig))).toBe(true);
        const reg = await admin.send({ to: registry.address, value: toNano('0.15'), body: regBody });
        expect(reg.transactions).toHaveTransaction({ from: admin.address, to: registry.address, success: true });
        expect(await isRegistered()).toBe(true);

        // mint, as the mint route does
        const fields = { templateKey: KEY, recipient: member.address, userTag: USER_TAG, expiry: farFuture() };
        const libVoucher = voucherLib.buildMintVoucherV3Cell(fields);
        const genVoucher = mintVoucherCell(fields);
        expect(libVoucher.equals(genVoucher)).toBe(true);
        const signature: Buffer = voucherLib.signVoucher(libVoucher, BACKEND_SECRET_HEX, {
            tag: MINIAPP.VOUCHER_TAG.Mint,
            target: registry.address,
            version,
            globalId,
        });
        expect(signature).toEqual(signVoucher(genVoucher, backend, TAG.Mint, registry.address, globalId));
        const body: Cell = voucherLib.buildMintBody({ voucherCell: libVoucher, signature });
        expect(body.equals(mintAchievementBody(genVoucher, signature))).toBe(true);

        const res = await member.send({ to: registry.address, value: BigInt(MINIAPP.GAS.mintTon), body });
        expect(res.transactions).toHaveTransaction({ from: member.address, to: registry.address, success: true });
        expect(await isMinted()).toBe(true);
    });

    it('reports the protocol version', async () => {
        expect(await registry.getVersion()).toEqual(3n);
    });

    it('has no way to pay TON out, for the owner or anyone else', async () => {
        await register(admin, registerVoucher(admin.address));
        const before = await balance(registry.address);
        for (const who of [owner, stranger]) {
            const res = await who.send({
                to: registry.address,
                value: toNano('0.05'),
                body: beginCell()
                    .storeUint(0x12345678, 32)
                    .storeCoins(toNano('0.01'))
                    .storeAddress(who.address)
                    .endCell(),
            });
            expect(res.transactions).toHaveTransaction({ from: who.address, to: registry.address, success: false });
        }
        expect(await balance(registry.address)).toBeGreaterThanOrEqual(before);
        // plain TON is accepted as a storage top-up
        const topUp = await stranger.send({ to: registry.address, value: toNano('0.5') });
        expect(topUp.transactions).toHaveTransaction({ from: stranger.address, to: registry.address, success: true });
    });

    it('refuses a mint that does not cover the item reserve and the gas', async () => {
        await register(admin, registerVoucher(admin.address));
        const res = await mint(toNano('0.09'));
        expect(res.transactions).toHaveTransaction({ from: member.address, to: registry.address, success: false });
        expect(await isMinted()).toBe(false);
    });

    it('rejects vouchers with trailing data after the signed fields (endParse)', async () => {
        // The signature covers the whole cell including the junk, so these
        // reach the parser; endParse must then refuse them. Only the backend
        // can produce such a cell, but a bug there must not mint or register.
        const rv = beginCell()
            .storeSlice(registerVoucher(admin.address).voucherCell.beginParse())
            .storeUint(1, 16)
            .endCell();
        const reg = await register(admin, {
            voucherCell: rv,
            signature: signVoucher(rv, backend, TAG.Register, registry.address, globalIdOf(blockchain)),
        });
        expect(reg.transactions).toHaveTransaction({ from: admin.address, to: registry.address, success: false });
        expect(await isRegistered()).toBe(false);

        await register(admin, registerVoucher(admin.address));
        const mv = beginCell()
            .storeSlice(
                mintVoucherCell({
                    templateKey: KEY,
                    recipient: member.address,
                    userTag: USER_TAG,
                    expiry: farFuture(),
                }).beginParse(),
            )
            .storeUint(1, 16)
            .endCell();
        const res = await mint(
            toNano('0.2'),
            mintAchievementBody(mv, signVoucher(mv, backend, TAG.Mint, registry.address, globalIdOf(blockchain))),
        );
        expect(res.transactions).toHaveTransaction({ from: member.address, to: registry.address, success: false });
        expect(await isMinted()).toBe(false);
    });

    it('a pre-deployed item or template cannot be hijacked and does not block the real one', async () => {
        const itemInit = await AchievementItem.init(registry.address, itemIndexOf(KEY, USER_TAG));
        const itemAddr = contractAddress(0, itemInit);
        const templateInit = await AchievementTemplate.init(registry.address, KEY);
        const templateAddr = contractAddress(0, templateInit);

        // a stranger "mints" to themselves: refused
        const hijack = await stranger.send({
            to: itemAddr,
            value: toNano('0.1'),
            init: itemInit,
            body: beginCell()
                .storeUint(0x5fcc3d14, 32)
                .storeUint(0, 64)
                .storeAddress(stranger.address)
                .storeAddress(stranger.address)
                .storeMaybeRef(beginCell().storeUint(1, 256).storeRef(offchainContent(URL)).endCell())
                .storeCoins(0)
                .storeBit(0)
                .endCell(),
        });
        expect(hijack.transactions).toHaveTransaction({ from: stranger.address, to: itemAddr, success: false });
        // or deploys both with a plain top-up: they exist, uninitialised
        for (const [to, init] of [
            [itemAddr, itemInit],
            [templateAddr, templateInit],
        ] as const) {
            await stranger.send({ to, value: toNano('0.1'), init, bounce: false });
            expect((await blockchain.getContract(to)).accountState?.type).toEqual('active');
        }
        expect(
            (await blockchain.openContract(AchievementItem.fromAddress(itemAddr)).getGetNftData()).is_initialized,
        ).toBe(false);

        // a mint before the registration: the unregistered template refunds it
        const early = await mint(toNano('0.2'));
        expect(early.transactions).toHaveTransaction({ from: templateAddr, to: member.address, success: true });
        expect(await isMinted()).toBe(false);

        // the real registration and mint go through, and keep the stranger's TON
        await register(admin, registerVoucher(admin.address));
        expect(await isRegistered()).toBe(true);
        expect(await balance(templateAddr)).toBeGreaterThanOrEqual(toNano('0.1') + TEMPLATE_RESERVE - toNano('0.001'));
        await mint();
        expect(await isMinted()).toBe(true);
        expect(await balance(itemAddr)).toBeGreaterThanOrEqual(toNano('0.1') + ITEM_RESERVE - toNano('0.001'));
    });

    it('measures gas and fees per register and mint hop', async () => {
        const report = (what: string, txs: Transaction[]) => {
            const lines = txs
                .filter((t) => t.description.type === 'generic')
                .map((t) => {
                    const d: any = t.description;
                    const to = t.inMessage!.info.dest as Address;
                    const name = to.equals(registry.address) ? 'registry' : to.toString().slice(0, 8);
                    return `${name}:${d.computePhase.type === 'vm' ? d.computePhase.gasUsed : '-'}gas`;
                });
            console.log(`${what}: ${lines.join(' ')}; total fees ${Number(fees(txs)) / 1e9} TON`);
        };
        report('register', (await register(admin, registerVoucher(admin.address))).transactions);
        report('mint', (await mint()).transactions);
        report('duplicate mint', (await mint()).transactions);
    });
});
