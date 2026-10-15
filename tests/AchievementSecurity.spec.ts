// Regression tests for the AchievementRegistry (AR-*) and AchievementItem
// (AI-*) findings of docs/security/2026-10-06-contracts-review.md. They
// assert the fixed behaviour and replace the PoCs in tests/poc. Messages and
// getters are spelled out by hand (tests/helpers/achievementWire.ts), so the
// tests pin the wire formats and do not depend on the generated wrappers,
// except where a test is about the wrappers (AI-9).
import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Address, beginCell, Cell, toNano, Transaction } from '@ton/core';
import { keyPairFromSeed, KeyPair } from '@ton/crypto';
import '@ton/test-utils';
import { AchievementRegistry } from '../wrappers/AchievementRegistry';
import { AchievementItem } from '../wrappers/AchievementItem';
import { globalIdOf } from './helpers/vouchers';
import {
    accountCells,
    containsInt64,
    getter,
    isActive,
    itemIndexOf,
    loadMaybeRef,
    mintVoucher,
    offchainContent,
    OP,
    opBody,
    registerVoucher,
    setStoragePrices,
    signedBody,
    signFor,
    TAG,
    tagOf,
    templateKeyOf,
    urlCell,
} from './helpers/achievementWire';

const TAG_KEY = Buffer.alloc(32, 11);
const CHAT_ID = -1001234567890n;
const TG_USER = 424242n;
const OTHER_USER = 777777n;
const CHAT_TAG = tagOf(TAG_KEY, 'chat', CHAT_ID);
const USER_TAG = tagOf(TAG_KEY, 'user', TG_USER);
const OTHER_TAG = tagOf(TAG_KEY, 'user', OTHER_USER);
const URL_A = 'https://achivator.cc/metadata/items/v1/programmer.json';
const URL_B = 'ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi/night-owl.json';
const HASH_A = 0xa1n;
const HASH_B = 0xb2n;
const YEAR = 365 * 24 * 3600;
const DAY = 24 * 3600;

// Mainnet storage prices (config param 18) in force since 2026-04-29:
// 0 per bit and 135 per cell per 2^16 s in the basechain.
const MAINNET_STORAGE_PRICES = { bitPs: 0n, cellPs: 135n, mcBitPs: 1000n, mcCellPs: 500000n };

describe('Achievement SBT security regressions', () => {
    let bc: Blockchain;
    let owner: SandboxContract<TreasuryContract>;
    let admin: SandboxContract<TreasuryContract>;
    let member: SandboxContract<TreasuryContract>;
    let other: SandboxContract<TreasuryContract>;
    let stranger: SandboxContract<TreasuryContract>;
    let backend: KeyPair;
    let registry: SandboxContract<AchievementRegistry>;
    let now: number;

    const expiry = () => BigInt(now + 3600);
    const g = (addr: Address, name: string, args: (bigint | Cell)[] = []) => getter(bc, addr, name, args);

    async function deployRegistry(value = toNano('0.2')) {
        const content = beginCell().storeUint(1, 8).storeStringTail('https://achivator.cc/collection.json').endCell();
        registry = bc.openContract(
            await AchievementRegistry.fromInit(
                owner.address,
                BigInt('0x' + backend.publicKey.toString('hex')),
                content,
            ),
        );
        await registry.send(owner.getSender(), { value }, { $$type: 'Deploy', queryId: 0n });
        // the reserve, whatever the deploy message does with its value
        await owner.send({ to: registry.address, value, bounce: true });
    }

    beforeEach(async () => {
        bc = await Blockchain.create();
        now = Math.floor(Date.now() / 1000);
        bc.now = now;
        owner = await bc.treasury('owner');
        admin = await bc.treasury('admin');
        member = await bc.treasury('member');
        other = await bc.treasury('other');
        stranger = await bc.treasury('stranger');
        backend = keyPairFromSeed(Buffer.alloc(32, 7));
        await deployRegistry();
    });

    function register(
        from: SandboxContract<TreasuryContract>,
        o: {
            chatTag?: bigint;
            contentHash?: bigint;
            url?: Cell;
            expiry?: bigint;
            registrant?: Address;
            key?: KeyPair;
            value?: bigint;
        } = {},
    ) {
        const voucher = registerVoucher({
            chatTag: o.chatTag ?? CHAT_TAG,
            registrant: o.registrant ?? from.address,
            contentHash: o.contentHash ?? HASH_A,
            expiry: o.expiry ?? expiry(),
            url: o.url ?? urlCell(URL_A),
        });
        const sig = signFor(voucher, o.key ?? backend, TAG.Register, registry.address, globalIdOf(bc));
        return from.send({
            to: registry.address,
            value: o.value ?? toNano('0.2'),
            body: signedBody(OP.RegisterTemplate, voucher, sig),
        });
    }

    function mint(
        from: SandboxContract<TreasuryContract>,
        o: {
            templateKey?: bigint;
            userTag?: bigint;
            recipient?: Address;
            expiry?: bigint;
            key?: KeyPair;
            value?: bigint;
        } = {},
    ) {
        const voucher = mintVoucher({
            templateKey: o.templateKey ?? templateKeyOf(CHAT_TAG, HASH_A),
            recipient: o.recipient ?? from.address,
            userTag: o.userTag ?? USER_TAG,
            expiry: o.expiry ?? expiry(),
        });
        const sig = signFor(voucher, o.key ?? backend, TAG.Mint, registry.address, globalIdOf(bc));
        return from.send({
            to: registry.address,
            value: o.value ?? toNano('0.2'),
            body: signedBody(OP.MintAchievement, voucher, sig),
        });
    }

    async function templateAddress(templateKey: bigint) {
        return (await g(registry.address, 'templateAddress', [templateKey])).readAddress();
    }
    async function itemAddress(templateKey: bigint, userTag: bigint) {
        return (await g(registry.address, 'itemAddress', [templateKey, userTag])).readAddress();
    }
    async function nftData(item: Address) {
        const s = await g(item, 'get_nft_data');
        return {
            initialized: s.readBoolean(),
            index: s.readBigNumber(),
            collection: s.readAddress(),
            owner: s.readAddressOpt(),
            content: s.readCell(),
        };
    }
    async function balance(a: Address) {
        return (await bc.getContract(a)).balance;
    }
    // The transaction of `to` that `from` caused (the first one).
    function txOf(txs: Transaction[], from: Address, to: Address) {
        return txs.find(
            (t) =>
                t.inMessage?.info.type === 'internal' &&
                t.inMessage.info.src.equals(from) &&
                t.inMessage.info.dest.equals(to),
        );
    }

    const KEY_A = templateKeyOf(CHAT_TAG, HASH_A);
    const KEY_B = templateKeyOf(CHAT_TAG, HASH_B);

    // ---- AR-2 / AR-13 / AR-11 / AR-15: no unbounded registry state ----

    it('AR-2/AR-13/AR-15: registry storage stays O(1) over registrations, mints and duplicate mints', async () => {
        const base = await accountCells(bc, registry.address);
        expect((await register(admin)).transactions).toHaveTransaction({ to: registry.address, success: true });
        await register(admin, { contentHash: HASH_B, url: urlCell(URL_B) });
        const users = [member, other, stranger];
        for (const key of [KEY_A, KEY_B]) {
            for (let i = 0; i < users.length; i++) {
                const tag = tagOf(TAG_KEY, 'user', 1000n + BigInt(i));
                await mint(users[i], { templateKey: key, userTag: tag });
                // and the same again: refused by the item
                await mint(users[i], { templateKey: key, userTag: tag });
                const d = await nftData(await itemAddress(key, tag));
                expect(d.initialized).toBe(true);
                expect(d.owner!.equals(users[i].address)).toBe(true);
            }
        }
        expect(await accountCells(bc, registry.address)).toEqual(base);
    });

    // ---- AR-1: strict content URL ----

    it('AR-1: a url with refs, a partial byte, over 126 bytes or another scheme is rejected', async () => {
        const base = await accountCells(bc, registry.address);
        const junk = beginCell().storeUint(1, 32).endCell();
        const bad: [string, Cell][] = [
            [
                'refs (the old snakeCells bypass)',
                beginCell()
                    .storeBuffer(Buffer.from('https://evil.example/'))
                    .storeRef(urlCell('x.json'))
                    .storeRef(junk)
                    .storeRef(junk)
                    .endCell(),
            ],
            ['one ref', beginCell().storeBuffer(Buffer.from('https://a.example/')).storeRef(urlCell('b')).endCell()],
            [
                'partial byte',
                beginCell().storeBuffer(Buffer.from('https://a.example/x.json')).storeUint(1, 4).endCell(),
            ],
            ['127 bytes', urlCell('https://a.example/' + 'a'.repeat(127 - 18))],
            ['http', urlCell('http://a.example/x.json')],
            ['data url', urlCell('data:application/json,{}')],
            ['too short', urlCell('ipfs://')],
        ];
        for (const [what, url] of bad) {
            const contentHash = BigInt(what.length) * 1000n;
            const res = await register(admin, { url, contentHash });
            expect(res.transactions).toHaveTransaction({ from: admin.address, to: registry.address, success: false });
            expect(await isActive(bc, await templateAddress(templateKeyOf(CHAT_TAG, contentHash)))).toBe(false);
        }
        // 126 bytes is the cap, and it works
        const max = 'https://a.example/' + 'a'.repeat(126 - 18);
        expect((await register(admin, { url: urlCell(max), contentHash: 7n })).transactions).toHaveTransaction({
            to: registry.address,
            success: true,
        });
        const t = await g(await templateAddress(templateKeyOf(CHAT_TAG, 7n)), 'get_template_data');
        expect(t.readBoolean()).toBe(true);
        expect(await accountCells(bc, registry.address)).toEqual(base);
    });

    it('AR-1: the url is bound by the voucher signature: junk added to a signed url is refused', async () => {
        const url = urlCell(URL_A);
        const voucher = registerVoucher({
            chatTag: CHAT_TAG,
            registrant: admin.address,
            contentHash: HASH_A,
            expiry: expiry(),
            url,
        });
        const sig = signFor(voucher, backend, TAG.Register, registry.address, globalIdOf(bc));
        const tampered = registerVoucher({
            chatTag: CHAT_TAG,
            registrant: admin.address,
            contentHash: HASH_A,
            expiry: expiry(),
            url: beginCell().storeSlice(url.beginParse()).storeRef(beginCell().storeUint(9, 9).endCell()).endCell(),
        });
        const res = await admin.send({
            to: registry.address,
            value: toNano('0.2'),
            body: signedBody(OP.RegisterTemplate, tampered, sig),
        });
        expect(res.transactions).toHaveTransaction({ to: registry.address, success: false });
        expect(await isActive(bc, await templateAddress(KEY_A))).toBe(false);
    });

    // ---- AR-3: a register voucher cannot create more than one template ----

    it('AR-3: replaying a register voucher is a refunded no-op', async () => {
        const voucher = registerVoucher({
            chatTag: CHAT_TAG,
            registrant: admin.address,
            contentHash: HASH_A,
            expiry: expiry(),
            url: urlCell(URL_A),
        });
        const body = signedBody(
            OP.RegisterTemplate,
            voucher,
            signFor(voucher, backend, TAG.Register, registry.address, globalIdOf(bc)),
        );
        await admin.send({ to: registry.address, value: toNano('0.2'), body });
        const template = await templateAddress(KEY_A);
        expect(await isActive(bc, template)).toBe(true);
        const registryState = await accountCells(bc, registry.address);
        const templateState = (await bc.getContract(template)).account.account!.storage.state;
        const templateData = templateState.type === 'active' ? templateState.state.data!.hash() : null;

        for (let i = 0; i < 5; i++) {
            const before = await balance(admin.address);
            const res = await admin.send({ to: registry.address, value: toNano('0.2'), body });
            expect(res.transactions).toHaveTransaction({ from: template, to: admin.address, success: true });
            // gas only: the 0.2 TON come back
            expect(before - (await balance(admin.address))).toBeLessThan(toNano('0.02'));
        }
        const after = (await bc.getContract(template)).account.account!.storage.state;
        expect(after.type === 'active' && after.state.data!.hash()).toEqual(templateData);
        expect(await accountCells(bc, registry.address)).toEqual(registryState);
    });

    // ---- AR-5: deterministic template keys ----

    it('AR-5: the template key is hash(chatTag, contentHash), so a racing registration cannot take a slot', async () => {
        expect((await g(registry.address, 'templateKeyOf', [CHAT_TAG, HASH_A])).readBigNumber()).toEqual(KEY_A);
        // an attacker with a voucher of their own lands first, other content
        await register(stranger, { contentHash: 0xbadn, url: urlCell('https://evil.example/fake.json') });
        await register(admin);
        const t = await g(await templateAddress(KEY_A), 'get_template_data');
        expect(t.readBoolean()).toBe(true);
        expect(t.readAddress().equals(registry.address)).toBe(true);
        expect(t.readBigNumber()).toEqual(KEY_A);
        expect(t.readBigNumber()).toEqual(CHAT_TAG);
        expect(t.readAddressOpt()!.equals(admin.address)).toBe(true);
        expect(t.readBigNumber()).toEqual(HASH_A);
        expect(t.readCellOpt()!.equals(offchainContent(URL_A))).toBe(true);

        // the backend's mint for KEY_A mints the platform's content
        await mint(member);
        const d = await nftData(await itemAddress(KEY_A, USER_TAG));
        expect(d.content.equals(offchainContent(URL_A))).toBe(true);
        expect((await g(await itemAddress(KEY_A, USER_TAG), 'get_content_hash')).readBigNumber()).toEqual(HASH_A);
    });

    // ---- uniqueness from the item address ----

    it('AR-2: one item per (template, user): other templates and users mint, a second mint is refunded', async () => {
        await register(admin);
        await register(admin, { contentHash: HASH_B, url: urlCell(URL_B) });
        await mint(member);
        await mint(member, { templateKey: KEY_B });
        await mint(other, { userTag: OTHER_TAG });
        const items = [
            await itemAddress(KEY_A, USER_TAG),
            await itemAddress(KEY_B, USER_TAG),
            await itemAddress(KEY_A, OTHER_TAG),
        ];
        expect(new Set(items.map((a) => a.toString())).size).toBe(3);
        for (const item of items) expect((await nftData(item)).initialized).toBe(true);

        // the same Telegram user again, from another wallet: refunded
        const before = await balance(stranger.address);
        const res = await mint(stranger, { userTag: USER_TAG, value: toNano('0.5') });
        expect(res.transactions).toHaveTransaction({ from: items[0], to: stranger.address, success: true });
        expect(before - (await balance(stranger.address))).toBeLessThan(toNano('0.05'));
        expect((await nftData(items[0])).owner!.equals(member.address)).toBe(true);
    });

    it('a mint for an unregistered template deploys nothing, and a forged approval is rejected', async () => {
        const unknown = templateKeyOf(CHAT_TAG, 0xdeadn);
        await mint(member, { templateKey: unknown });
        expect(await isActive(bc, await itemAddress(unknown, USER_TAG))).toBe(false);

        // a template approval from anyone but the template itself
        const forged = beginCell()
            .storeUint(OP.TemplateMintApproved, 32)
            .storeUint(unknown, 256)
            .storeAddress(stranger.address)
            .storeUint(USER_TAG, 256)
            .storeRef(beginCell().storeUint(1, 256).storeRef(offchainContent(URL_A)).endCell())
            .endCell();
        const res = await stranger.send({ to: registry.address, value: toNano('0.2'), body: forged });
        expect(res.transactions).toHaveTransaction({ from: stranger.address, to: registry.address, success: false });
        expect(await isActive(bc, await itemAddress(unknown, USER_TAG))).toBe(false);
    });

    it('AR-12: only the named recipient can submit a mint voucher', async () => {
        await register(admin);
        const res = await mint(stranger, { recipient: member.address });
        expect(res.transactions).toHaveTransaction({ from: stranger.address, to: registry.address, success: false });
        expect(await isActive(bc, await itemAddress(KEY_A, USER_TAG))).toBe(false);
    });

    it('vouchers live at most a day: expired and longer-lived vouchers are rejected', async () => {
        await register(admin);
        for (const e of [BigInt(now - 1), BigInt(now + DAY + 1)]) {
            const r = await register(admin, { contentHash: HASH_B, url: urlCell(URL_B), expiry: e });
            expect(r.transactions).toHaveTransaction({ to: registry.address, success: false });
            const m = await mint(member, { expiry: e });
            expect(m.transactions).toHaveTransaction({ to: registry.address, success: false });
        }
        expect(await isActive(bc, await itemAddress(KEY_A, USER_TAG))).toBe(false);
        const ok = await mint(member, { expiry: BigInt(now + DAY) });
        expect(ok.transactions).toHaveTransaction({ to: registry.address, success: true });
        expect((await nftData(await itemAddress(KEY_A, USER_TAG))).initialized).toBe(true);
    });

    // ---- AI-3 / AI-4 / AI-7 / AI-8: soulbound (TEP-85) ----

    describe('with one minted item', () => {
        let item: Address;
        const index = itemIndexOf(KEY_A, USER_TAG);

        beforeEach(async () => {
            await register(admin);
            await mint(member);
            item = await itemAddress(KEY_A, USER_TAG);
        });

        it('AI-3: an SBT cannot be transferred by its owner or anyone else', async () => {
            for (const from of [member, stranger, owner]) {
                const res = await from.send({
                    to: item,
                    value: toNano('0.2'),
                    body: beginCell()
                        .storeUint(OP.Transfer, 32)
                        .storeUint(0, 64)
                        .storeAddress(stranger.address)
                        .storeAddress(from.address)
                        .storeBit(0)
                        .storeCoins(toNano('0.01'))
                        .storeBit(0)
                        .endCell(),
                });
                expect(res.transactions).toHaveTransaction({ from: from.address, to: item, success: false });
            }
            expect((await nftData(item)).owner!.equals(member.address)).toBe(true);
        });

        it('AI-7: the registry owner revokes through the registry, nobody else can', async () => {
            expect((await g(item, 'get_authority_address')).readAddress().equals(registry.address)).toBe(true);
            expect((await g(item, 'get_revoked_time')).readNumber()).toBe(0);

            const revokeBody = opBody(OP.RevokeAchievement, (b) => b.storeUint(5, 64).storeUint(index, 256));
            // the item owner and strangers cannot, neither via the registry nor directly
            for (const from of [member, stranger]) {
                const viaRegistry = await from.send({ to: registry.address, value: toNano('0.1'), body: revokeBody });
                expect(viaRegistry.transactions).toHaveTransaction({ to: registry.address, success: false });
                const direct = await from.send({
                    to: item,
                    value: toNano('0.1'),
                    body: opBody(OP.Revoke, (b) => b.storeUint(5, 64)),
                });
                expect(direct.transactions).toHaveTransaction({ to: item, success: false });
            }
            expect((await g(item, 'get_revoked_time')).readNumber()).toBe(0);

            bc.now = now + 100;
            const res = await owner.send({ to: registry.address, value: toNano('0.1'), body: revokeBody });
            expect(res.transactions).toHaveTransaction({ from: registry.address, to: item, success: true });
            expect((await g(item, 'get_revoked_time')).readNumber()).toBe(now + 100);
            // revoked stays revoked, at the first time
            bc.now = now + 200;
            const again = await owner.send({ to: registry.address, value: toNano('0.1'), body: revokeBody });
            expect(again.transactions).toHaveTransaction({ from: registry.address, to: item, success: false });
            expect((await g(item, 'get_revoked_time')).readNumber()).toBe(now + 100);
            // still owned and displayed
            expect((await nftData(item)).owner!.equals(member.address)).toBe(true);
        });

        it('AI-7: the owner destroys the SBT, and it can never be minted again', async () => {
            const destroy = opBody(OP.Destroy, (b) => b.storeUint(3, 64));
            const denied = await stranger.send({ to: item, value: toNano('0.05'), body: destroy });
            expect(denied.transactions).toHaveTransaction({ to: item, success: false });

            const res = await member.send({ to: item, value: toNano('0.05'), body: destroy });
            expect(res.transactions).toHaveTransaction({ from: item, to: member.address, success: true });
            const d = await nftData(item);
            expect(d.initialized).toBe(true);
            expect(d.owner).toBeNull();
            expect((await g(item, 'get_authority_address')).readAddressOpt()).toBeNull();
            // no revoke after destroy (no authority left)
            const revoke = await owner.send({
                to: registry.address,
                value: toNano('0.1'),
                body: opBody(OP.RevokeAchievement, (b) => b.storeUint(0, 64).storeUint(index, 256)),
            });
            expect(revoke.transactions).toHaveTransaction({ from: registry.address, to: item, success: false });

            await mint(member);
            expect((await nftData(item)).owner).toBeNull();
        });

        it('AI-1/TEP-62: collection and item getters and the static data reply', async () => {
            const c = await g(registry.address, 'get_collection_data');
            expect(c.readBigNumber()).toEqual(-1n); // non-sequential collection
            expect(c.readCell().beginParse().loadUint(8)).toEqual(1);
            expect(c.readAddress().equals(owner.address)).toBe(true);

            expect((await g(registry.address, 'itemIndexOf', [KEY_A, USER_TAG])).readBigNumber()).toEqual(index);
            expect((await g(registry.address, 'get_nft_address_by_index', [index])).readAddress().equals(item)).toBe(
                true,
            );
            const d = await nftData(item);
            expect(d).toMatchObject({ initialized: true, index });
            expect(d.collection.equals(registry.address)).toBe(true);
            expect(d.owner!.equals(member.address)).toBe(true);
            expect(d.content.equals(offchainContent(URL_A))).toBe(true);
            const full = await g(registry.address, 'get_nft_content', [index, d.content]);
            expect(full.readCell().equals(offchainContent(URL_A))).toBe(true);

            const res = await stranger.send({
                to: item,
                value: toNano('0.05'),
                body: opBody(OP.GetStaticData, (b) => b.storeUint(77, 64)),
            });
            const reply = txOf(res.transactions, item, stranger.address)!;
            const s = reply.inMessage!.body.beginParse();
            expect(s.loadUint(32)).toEqual(OP.ReportStaticData);
            expect(s.loadUintBig(64)).toEqual(77n);
            expect(s.loadUintBig(256)).toEqual(index);
            expect(s.loadAddress().equals(registry.address)).toBe(true);
            s.endParse();
        });

        it('AI-8: the mint is a well-formed TEP-62 transfer with the Either bit', async () => {
            const res = await mint(other, { userTag: OTHER_TAG });
            const second = await itemAddress(KEY_A, OTHER_TAG);
            const tx = txOf(res.transactions, registry.address, second)!;
            expect(tx).toBeDefined();
            const s = tx.inMessage!.body.beginParse();
            expect(s.loadUint(32)).toEqual(OP.Transfer);
            s.loadUintBig(64);
            expect(s.loadAddress().equals(other.address)).toBe(true); // new_owner
            expect(s.loadAddress().equals(other.address)).toBe(true); // response_destination
            const payload = loadMaybeRef(s)!;
            expect(payload.beginParse().loadUintBig(256)).toEqual(HASH_A);
            expect(s.loadCoins()).toEqual(0n);
            expect(s.loadBit()).toBe(false); // Either: inline, empty
            s.endParse();
        });

        it('TEP-85: prove_ownership and request_owner answer in the standard layout', async () => {
            const payload = beginCell().storeUint(0xabc, 12).endCell();
            const prove = (from: SandboxContract<TreasuryContract>) =>
                from.send({
                    to: item,
                    value: toNano('0.05'),
                    body: opBody(OP.ProveOwnership, (b) =>
                        b.storeUint(1, 64).storeAddress(admin.address).storeRef(payload).storeBit(1),
                    ),
                });
            expect((await prove(stranger)).transactions).toHaveTransaction({ to: item, success: false });
            const proof = txOf((await prove(member)).transactions, item, admin.address)!;
            const p = proof.inMessage!.body.beginParse();
            expect(p.loadUint(32)).toEqual(OP.OwnershipProof);
            expect(p.loadUintBig(64)).toEqual(1n);
            expect(p.loadUintBig(256)).toEqual(index);
            expect(p.loadAddress().equals(member.address)).toBe(true);
            expect(p.loadRef().equals(payload)).toBe(true);
            expect(p.loadUintBig(64)).toEqual(0n);
            expect(loadMaybeRef(p)!.equals(offchainContent(URL_A))).toBe(true);
            p.endParse();

            const res = await stranger.send({
                to: item,
                value: toNano('0.05'),
                body: opBody(OP.RequestOwner, (b) =>
                    b.storeUint(2, 64).storeAddress(admin.address).storeRef(payload).storeBit(0),
                ),
            });
            const info = txOf(res.transactions, item, admin.address)!.inMessage!.body.beginParse();
            expect(info.loadUint(32)).toEqual(OP.OwnerInfo);
            expect(info.loadUintBig(64)).toEqual(2n);
            expect(info.loadUintBig(256)).toEqual(index);
            expect(info.loadAddress().equals(stranger.address)).toBe(true); // initiator
            expect(info.loadAddress().equals(member.address)).toBe(true); // owner
            expect(info.loadRef().equals(payload)).toBe(true);
            expect(info.loadUintBig(64)).toEqual(0n);
            expect(loadMaybeRef(info)).toBeNull();
            info.endParse();
        });

        it('AI-4: large forward payloads cannot drain the item reserve', async () => {
            let big = beginCell().storeUint(0, 1000).endCell();
            for (let i = 0; i < 200; i++) {
                big = beginCell()
                    .storeUint(i + 1, 1000)
                    .storeRef(big)
                    .endCell();
            }
            const start = await balance(item);
            for (let i = 0; i < 3; i++) {
                const res = await member.send({
                    to: item,
                    value: toNano('0.01'),
                    body: opBody(OP.ProveOwnership, (b) =>
                        b.storeUint(i, 64).storeAddress(stranger.address).storeRef(big).storeBit(1),
                    ),
                });
                expect(res.transactions).toHaveTransaction({ from: member.address, to: item });
            }
            // a proof that fits the value still goes out
            const ok = await member.send({
                to: item,
                value: toNano('0.5'),
                body: opBody(OP.ProveOwnership, (b) =>
                    b.storeUint(9, 64).storeAddress(stranger.address).storeRef(big).storeBit(0),
                ),
            });
            expect(ok.transactions).toHaveTransaction({ from: item, to: stranger.address, success: true });
            expect(await balance(item)).toBeGreaterThanOrEqual(start);
        });

        it('AI-5: the item takes top-ups and never pays a third party top-up out', async () => {
            const top = await stranger.send({ to: item, value: toNano('0.5'), bounce: true });
            expect(top.transactions).toHaveTransaction({ from: stranger.address, to: item, success: true });
            const before = await balance(item);
            expect(before).toBeGreaterThan(toNano('0.5'));
            // owner and stranger actions only spend their own value
            await member.send({
                to: item,
                value: toNano('0.05'),
                body: opBody(OP.ProveOwnership, (b) =>
                    b.storeUint(1, 64).storeAddress(member.address).storeRef(Cell.EMPTY).storeBit(0),
                ),
            });
            await stranger.send({
                to: item,
                value: toNano('0.05'),
                body: opBody(OP.RequestOwner, (b) =>
                    b.storeUint(1, 64).storeAddress(stranger.address).storeRef(Cell.EMPTY).storeBit(1),
                ),
            });
            await mint(member, { value: toNano('0.3') }); // duplicate: refunded from its own value
            expect(await balance(item)).toBeGreaterThanOrEqual(before);
        });
    });

    // ---- AR-7 / AI-10: privacy ----

    it('AR-7/AI-10: events, storage and replies carry tags, never raw Telegram ids', async () => {
        const reg = await register(admin);
        const minted = await mint(member);
        const item = await itemAddress(KEY_A, USER_TAG);
        const template = await templateAddress(KEY_A);

        const externals = [...reg.externals, ...minted.externals];
        const event = externals.find((e) => e.body.beginParse().preloadUint(32) === OP.TemplateRegistered)!;
        expect(event).toBeDefined();
        const s = event.body.beginParse();
        s.loadUint(32);
        expect(s.loadUintBig(256)).toEqual(KEY_A);
        expect(s.loadUintBig(256)).toEqual(CHAT_TAG);
        expect(s.loadAddress().equals(admin.address)).toBe(true);
        s.endParse();

        const cells: Cell[] = externals.map((e) => e.body);
        for (const tx of [...reg.transactions, ...minted.transactions]) {
            if (tx.inMessage) cells.push(tx.inMessage.body);
        }
        for (const a of [registry.address, template, item]) {
            const st = (await bc.getContract(a)).account.account!.storage.state;
            if (st.type === 'active') cells.push(st.state.data!);
        }
        for (const c of cells) {
            expect(containsInt64(c, CHAT_ID)).toBe(false);
            expect(containsInt64(c, TG_USER)).toBe(false);
        }
    });

    // ---- AI-9: wrapper / getter address parity ----

    it('AI-9: the AchievementItem wrapper derives the address the registry deploys', async () => {
        await register(admin);
        await mint(member);
        const index = itemIndexOf(KEY_A, USER_TAG);
        const byIndex = (await g(registry.address, 'get_nft_address_by_index', [index])).readAddress();
        expect((await AchievementItem.fromInit(registry.address, index)).address.equals(byIndex)).toBe(true);
        // and that is where the mint went
        expect(await isActive(bc, byIndex)).toBe(true);
    });

    // ---- AR-6: key rotation and pause ----

    it('AR-6: only the owner rotates the backend key (not to 0 or the same key) and pauses', async () => {
        const newKey = keyPairFromSeed(Buffer.alloc(32, 8));
        const pub = (kp: KeyPair) => BigInt('0x' + kp.publicKey.toString('hex'));
        const rotate = (from: SandboxContract<TreasuryContract>, key: bigint) =>
            from.send({
                to: registry.address,
                value: toNano('0.05'),
                body: opBody(OP.RotateBackendKey, (b) => b.storeUint(key, 256)),
            });
        expect((await rotate(stranger, pub(newKey))).transactions).toHaveTransaction({
            to: registry.address,
            success: false,
        });
        expect((await rotate(owner, 0n)).transactions).toHaveTransaction({ to: registry.address, success: false });
        expect((await rotate(owner, pub(backend))).transactions).toHaveTransaction({
            to: registry.address,
            success: false,
        });
        expect((await rotate(owner, pub(newKey))).transactions).toHaveTransaction({
            to: registry.address,
            success: true,
        });
        expect((await g(registry.address, 'backendKey')).readBigNumber()).toEqual(pub(newKey));

        // the old key is worthless now, the new one works
        await register(admin);
        expect(await isActive(bc, await templateAddress(KEY_A))).toBe(false);
        await register(admin, { key: newKey });
        expect(await isActive(bc, await templateAddress(KEY_A))).toBe(true);
        await mint(member);
        expect(await isActive(bc, await itemAddress(KEY_A, USER_TAG))).toBe(false);

        const pause = (from: SandboxContract<TreasuryContract>, on: boolean) =>
            from.send({
                to: registry.address,
                value: toNano('0.05'),
                body: opBody(OP.SetPaused, (b) => b.storeBit(on)),
            });
        expect((await pause(stranger, true)).transactions).toHaveTransaction({ to: registry.address, success: false });
        expect((await pause(owner, true)).transactions).toHaveTransaction({ to: registry.address, success: true });
        expect((await g(registry.address, 'isPaused')).readBoolean()).toBe(true);
        const paused = await mint(member, { key: newKey });
        expect(paused.transactions).toHaveTransaction({ from: member.address, to: registry.address, success: false });
        const pausedReg = await register(admin, { key: newKey, contentHash: HASH_B, url: urlCell(URL_B) });
        expect(pausedReg.transactions).toHaveTransaction({ from: admin.address, to: registry.address, success: false });
        await pause(owner, false);
        await mint(member, { key: newKey });
        expect((await nftData(await itemAddress(KEY_A, USER_TAG))).initialized).toBe(true);
    });

    // ---- AR-14: two-step ownership ----

    it('AR-14: ownership moves only when the proposed owner accepts', async () => {
        const propose = (from: SandboxContract<TreasuryContract>, to: Address | null) =>
            from.send({
                to: registry.address,
                value: toNano('0.05'),
                body: opBody(OP.ProposeOwner, (b) => b.storeAddress(to)),
            });
        const accept = (from: SandboxContract<TreasuryContract>) =>
            from.send({ to: registry.address, value: toNano('0.05'), body: opBody(OP.AcceptOwnership) });
        const ownerNow = async () => (await g(registry.address, 'owner')).readAddress();

        expect((await propose(stranger, stranger.address)).transactions).toHaveTransaction({
            to: registry.address,
            success: false,
        });
        expect((await accept(stranger)).transactions).toHaveTransaction({ to: registry.address, success: false });
        await propose(owner, admin.address);
        expect((await g(registry.address, 'pendingOwner')).readAddressOpt()!.equals(admin.address)).toBe(true);
        expect((await accept(stranger)).transactions).toHaveTransaction({ to: registry.address, success: false });
        expect((await ownerNow()).equals(owner.address)).toBe(true);
        // cancel, then propose again
        await propose(owner, null);
        expect((await accept(admin)).transactions).toHaveTransaction({ to: registry.address, success: false });
        await propose(owner, admin.address);
        expect((await accept(admin)).transactions).toHaveTransaction({ to: registry.address, success: true });
        expect((await ownerNow()).equals(admin.address)).toBe(true);
        expect((await g(registry.address, 'pendingOwner')).readAddressOpt()).toBeNull();
        const c = await g(registry.address, 'get_collection_data');
        c.readBigNumber();
        c.readCell();
        expect(c.readAddress().equals(admin.address)).toBe(true);
        // the old owner has no power left
        const res = await owner.send({
            to: registry.address,
            value: toNano('0.05'),
            body: opBody(OP.SetPaused, (b) => b.storeBit(true)),
        });
        expect(res.transactions).toHaveTransaction({ to: registry.address, success: false });
    });

    // ---- AR-8 / AI-5: rent horizon at mainnet prices ----

    it('AR-8/AI-5: the registry, template and item reserves cover their stated horizons at mainnet prices', async () => {
        setStoragePrices(bc, MAINNET_STORAGE_PRICES);
        await register(admin);
        await mint(member);
        const template = await templateAddress(KEY_A);
        const item = await itemAddress(KEY_A, USER_TAG);
        // what, address, years its reserve must cover (in increasing order:
        // the clock only moves forward)
        const cases: [string, Address, number][] = [
            ['template', template, 10],
            ['item', item, 10],
            ['registry', registry.address, 25],
        ];
        for (const [what, address, years] of cases) {
            const held = await balance(address);
            const { cells } = await accountCells(bc, address);
            bc.now = now + years * YEAR;
            // a bounceable message: storage is charged before its value is credited
            const res = await stranger.send({
                to: address,
                value: toNano('0.05'),
                bounce: true,
                body: what === 'item' ? opBody(OP.GetStaticData, (b) => b.storeUint(0, 64)) : Cell.EMPTY,
            });
            const tx = txOf(res.transactions, stranger.address, address)!;
            const d: any = tx.description;
            const rent: bigint = d.storagePhase.storageFeesCollected;
            console.log(
                `${what}: ${cells} cells, holds ${Number(held) / 1e9} TON, rent ${Number(rent) / 1e9 / years} TON/year, ` +
                    `covers ${(Number(held) / Number(rent)) * years} years`,
            );
            expect(rent).toBeGreaterThan(0n);
            expect(d.storagePhase.storageFeesDue ?? 0n).toEqual(0n);
            expect(d.storagePhase.statusChange).toEqual('unchanged');
            expect(rent).toBeLessThanOrEqual(held);
        }
    });
});
