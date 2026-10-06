// Security-review PoCs for contracts/achievement_item.tact. Read-only use of
// the existing build/ artifacts; nothing here is part of the regular suite.
import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Address, beginCell, Cell, contractAddress, toNano } from '@ton/core';
import { keyPairFromSeed, KeyPair } from '@ton/crypto';
import { AchievementRegistry, storeMintVoucher, storeRegisterVoucher } from '../../wrappers/AchievementRegistry';
import { AchievementItem } from '../../wrappers/AchievementItem';
import { AchievementItem as AchievementItemAsDeployed } from '../../build/AchievementRegistry/tact_AchievementItem';
import '@ton/test-utils';
import { signatureCell, signVoucher, TAG } from '../helpers/vouchers';

const CHAT_ID = -1001234567890n;
const URL = 'https://achivator.cc/metadata/first-steps.json';
const YEAR = 365 * 24 * 3600;

function computeFees(tx: any): bigint {
    const d = tx.description;
    return d.computePhase?.type === 'vm' ? d.computePhase.gasFees : 0n;
}

describe('AchievementItem PoC', () => {
    let blockchain: Blockchain;
    let owner: SandboxContract<TreasuryContract>;
    let admin: SandboxContract<TreasuryContract>;
    let member: SandboxContract<TreasuryContract>;
    let stranger: SandboxContract<TreasuryContract>;
    let backend: KeyPair;
    let registry: SandboxContract<AchievementRegistry>;
    let t0: number;
    let nonce = 1n;

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        t0 = Math.floor(Date.now() / 1000);
        blockchain.now = t0;
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
        await registry.send(owner.getSender(), { value: toNano('0.1') }, { $$type: 'Deploy', queryId: 0n });

        const rv = beginCell()
            .store(
                storeRegisterVoucher({
                    $$type: 'RegisterVoucher',
                    chatId: CHAT_ID,
                    registrant: admin.address,
                    expiry: BigInt(t0 + 100 * YEAR),
                }),
            )
            .endCell();
        await registry.send(
            admin.getSender(),
            { value: toNano('0.2') },
            {
                $$type: 'RegisterTemplate',
                contentUrl: URL,
                contentHash: 123n,
                royalty: { $$type: 'RoyaltyParams', numerator: 5n, denominator: 100n, destination: admin.address },
                voucherCell: rv,
                signature: signatureCell(signVoucher(rv, backend, TAG.Register, registry.address)),
            },
        );
    });

    async function mint(recipient: Address, tgUserId: bigint) {
        const voucherCell = beginCell()
            .store(
                storeMintVoucher({
                    $$type: 'MintVoucher',
                    templateId: 0n,
                    recipient,
                    tgUserId,
                    nonce: nonce++,
                    expiry: BigInt(t0 + 100 * YEAR),
                }),
            )
            .endCell();
        return registry.send(
            member.getSender(),
            { value: toNano('0.2') },
            {
                $$type: 'MintAchievement',
                voucherCell,
                signature: signatureCell(signVoucher(voucherCell, backend, TAG.Mint, registry.address)),
            },
        );
    }

    async function itemAt(index: bigint) {
        return blockchain.openContract(AchievementItem.fromAddress(await registry.getNftAddress(index)));
    }

    // AI-1: ReportStaticData.index_id is serialized as int257, TEP-62 says uint256.
    it('AI-1: ReportStaticData is not TEP-62 wire-compatible (index int257 vs uint256)', async () => {
        await mint(member.address, 1n);
        await mint(member.address, 2n);
        const item1 = await itemAt(1n);
        const res = await stranger.send({
            to: item1.address,
            value: toNano('0.05'),
            body: beginCell().storeUint(0x2fcb26a2, 32).storeUint(77, 64).endCell(),
        });
        const reply = res.transactions.find(
            (t) =>
                t.inMessage?.info.src?.toString() === item1.address.toString() &&
                t.inMessage?.info.dest?.toString() === stranger.address.toString(),
        )!;
        const body = reply.inMessage!.body.beginParse();
        expect(body.loadUint(32)).toEqual(0x8b771735);
        expect(body.loadUintBig(64)).toEqual(77n);
        // TEP-62 parser: index:uint256 collection:MsgAddress
        const tepIndex = body.clone().loadUintBig(256);
        console.log(
            'AI-1 TEP-62 parse of index for item #1 =',
            tepIndex.toString(),
            ' body bits after query_id =',
            body.remainingBits,
        );
        expect(tepIndex).not.toEqual(1n); // index read as 0 (value >> 1)
        const s = body.clone();
        s.loadUintBig(256);
        let tepCollection: string;
        try {
            tepCollection = String(s.loadAddressAny());
        } catch (e: any) {
            tepCollection = 'PARSE ERROR: ' + e.message;
        }
        console.log('AI-1 TEP-62 parse of collection =', tepCollection, ' (real:', registry.address.toString(), ')');
        expect(tepCollection).not.toEqual(registry.address.toString());
        // What the contract actually wrote: int257
        const a = body.clone();
        expect(a.loadIntBig(257)).toEqual(1n);
        expect(a.loadAddress().equals(registry.address)).toBe(true);
    });

    // AI-2: royalty is unreachable through TEP-66 (royalty_params on the collection).
    it('AI-2: neither the collection nor the item implements TEP-66 royalty_params', async () => {
        await mint(member.address, 1n);
        const item0 = await itemAt(0n);
        for (const addr of [registry.address, item0.address]) {
            let exit: any;
            try {
                const r = await blockchain.runGetMethod(addr, 'royalty_params');
                exit = r.exitCode;
            } catch (e: any) {
                exit = e.exitCode ?? e.message;
            }
            console.log('AI-2 royalty_params on', addr.toString(), '-> exit', exit);
            expect(exit).not.toEqual(0);
        }
        // TEP-66 on-chain query goes to the collection, which bounces it (no receiver)
        const q = await stranger.send({
            to: registry.address,
            value: toNano('0.05'),
            body: beginCell().storeUint(0x693d3950, 32).storeUint(1, 64).endCell(),
        });
        expect(q.transactions).toHaveTransaction({
            from: stranger.address,
            to: registry.address,
            success: false,
            exitCode: 130,
        });
        // the item exposes a non-standard getter name instead
        expect((await item0.getGetRoyaltyParams()).numerator).toEqual(5n);
    });

    // AI-3: achievements are freely transferable; registry still says the original user "holds" it.
    it('AI-3: achievement is transferable (not soulbound); isMinted stays true for the seller', async () => {
        const m = await mint(member.address, 1n);
        const mtx: any = m.transactions.find(
            (t) =>
                t.inMessage?.info.src?.toString() === registry.address.toString() &&
                t.inMessage?.info.dest?.toString() !== member.address.toString(),
        )!;
        console.log(
            'AI-3 item mint gasUsed',
            mtx.description.computePhase.gasUsed,
            'gasFees',
            mtx.description.computePhase.gasFees,
            'item balance',
            (await blockchain.getContract(mtx.inMessage.info.dest)).balance,
        );
        const item0 = await itemAt(0n);
        const res = await item0.send(
            member.getSender(),
            { value: toNano('0.05') },
            {
                $$type: 'Transfer',
                query_id: 0n,
                new_owner: stranger.address,
                response_destination: member.address,
                custom_payload: null,
                forward_amount: 0n,
                forward_payload: beginCell().storeBit(0).endCell(),
            },
        );
        expect(res.transactions).toHaveTransaction({ from: member.address, to: item0.address, success: true });
        expect((await item0.getGetNftData()).owner_address.equals(stranger.address)).toBe(true);
        expect(await registry.getIsMinted(0n, 1n)).toBe(true); // "you already own this NFT"
    });

    // AI-4: the 0.01 TON transfer floor does not cover gas + forward fees; reserve erodes.
    it('AI-4: owner transfers paying exactly forward_amount + 0.01 erode the 0.02 storage reserve', async () => {
        await mint(member.address, 1n);
        const item0 = await itemAt(0n);
        const start = (await blockchain.getContract(item0.address)).balance;
        // big forward_payload: fwd fee of OwnershipAssigned is paid by the item (mode 1)
        let big = beginCell().storeUint(0, 1000).endCell();
        for (let i = 0; i < 200; i++) {
            big = beginCell()
                .storeUint(i + 1, 1000)
                .storeRef(big)
                .endCell();
        }
        let cur = member;
        let other = stranger;
        let lastGas = 0n;
        const balances: bigint[] = [];
        for (let i = 0; i < 3; i++) {
            const res = await cur.send({
                to: item0.address,
                value: toNano('0.01') + 1n,
                body: beginCell()
                    .storeUint(0x5fcc3d14, 32)
                    .storeUint(i, 64)
                    .storeAddress(other.address)
                    .storeAddress(cur.address)
                    .storeBit(0)
                    .storeCoins(1n)
                    .storeBit(1)
                    .storeRef(big)
                    .endCell(),
            });
            const tx = res.transactions.find((t) => t.inMessage?.info.dest?.toString() === item0.address.toString())!;
            expect(tx.description.type === 'generic' && tx.description.aborted).toBe(false);
            lastGas = computeFees(tx);
            const ap: any = (tx.description as any).actionPhase;
            console.log(
                'AI-4 tx',
                i,
                'aborted',
                (tx.description as any).aborted,
                'compute',
                JSON.stringify((tx.description as any).computePhase, (k, v) =>
                    typeof v === 'bigint' ? v.toString() : v,
                ).slice(0, 200),
                'action fwd fees',
                ap?.totalFwdFees,
                'action ok',
                ap?.success,
                'outmsgs',
                tx.outMessagesCount,
                'inbits',
                tx.inMessage?.body.bits.length,
                'inrefs',
                tx.inMessage?.body.refs.length,
            );
            balances.push((await blockchain.getContract(item0.address)).balance);
            [cur, other] = [other, cur];
        }
        const end = (await blockchain.getContract(item0.address)).balance;
        console.log('AI-4 reserve start', start, 'after each transfer', balances, 'compute fee per transfer', lastGas);
        expect(end).toBeLessThan(toNano('0.02'));
    });

    // AI-5: storage rent vs. the fixed 0.02 reserve, plus no plain top-up path.
    it('AI-5: storage rent, no bounceable top-up, and top-ups are swept by the owner', async () => {
        await mint(member.address, 1n);
        const item0 = await itemAt(0n);
        // rent over one year
        blockchain.now = t0 + YEAR;
        const r = await stranger.send({
            to: item0.address,
            value: toNano('0.05'),
            body: beginCell().storeUint(0x2fcb26a2, 32).storeUint(0, 64).endCell(),
        });
        const tx = r.transactions.find((t) => t.inMessage?.info.dest?.toString() === item0.address.toString())!;
        const rent = tx.description.type === 'generic' ? tx.description.storagePhase?.storageFeesCollected : -1n;
        console.log('AI-5 item rent per year (nanoTON):', rent);

        // plain bounceable top-up is rejected (no empty receiver)
        const top = await stranger.send({ to: item0.address, value: toNano('0.5'), bounce: true });
        expect(top.transactions).toHaveTransaction({
            from: stranger.address,
            to: item0.address,
            success: false,
            exitCode: 130,
        });
        // non-bounceable top-up lands, then the owner's next transfer sweeps it to response_destination
        await stranger.send({ to: item0.address, value: toNano('0.5'), bounce: false });
        expect((await blockchain.getContract(item0.address)).balance).toBeGreaterThan(toNano('0.5'));
        const sweep = await item0.send(
            member.getSender(),
            { value: toNano('0.02') },
            {
                $$type: 'Transfer',
                query_id: 0n,
                new_owner: member.address,
                response_destination: member.address,
                custom_payload: null,
                forward_amount: 0n,
                forward_payload: beginCell().storeBit(0).endCell(),
            },
        );
        expect(sweep.transactions).toHaveTransaction({
            from: item0.address,
            to: member.address,
            value: (v) => v! > toNano('0.5'),
        });
        expect((await blockchain.getContract(item0.address)).balance).toBeLessThanOrEqual(toNano('0.02'));

        // advance until frozen
        let years = 0;
        for (const y of [5, 10, 20, 40, 80]) {
            blockchain.now = t0 + y * YEAR;
            try {
                await stranger.send({
                    to: item0.address,
                    value: toNano('0.05'),
                    bounce: true,
                    body: beginCell().storeUint(0x2fcb26a2, 32).storeUint(0, 64).endCell(),
                });
            } catch (e: any) {
                console.log('AI-5 send error at year', y, e.message);
                break;
            }
            const st = (await blockchain.getContract(item0.address)).accountState?.type;
            console.log(`AI-5 year ${y}: state=${st} balance=${(await blockchain.getContract(item0.address)).balance}`);
            if (st !== 'active') {
                years = y;
                break;
            }
        }
    });

    // Validation of a non-finding: anyone can pre-deploy a future item, but cannot hijack it.
    it('OK: pre-deploying a future item address does not let a stranger initialize or block the mint', async () => {
        const future = await registry.getNftAddress(0n);
        // NB: the standalone build (wrappers/AchievementItem) has a different ABI-ipfs string in its code
        // and derives a different address (see AI-9); use the copy embedded in the registry build.
        const init = await AchievementItemAsDeployed.init(registry.address, 0n);
        expect(contractAddress(0, init).equals(future)).toBe(true);
        expect((await AchievementItem.fromInit(registry.address, 0n)).address.equals(future)).toBe(false);
        // stranger deploys with a Transfer naming themselves owner -> refused
        const hijack = await stranger.send({
            to: future,
            value: toNano('0.1'),
            init,
            body: beginCell()
                .storeUint(0x5fcc3d14, 32)
                .storeUint(0, 64)
                .storeAddress(stranger.address)
                .storeUint(0, 2)
                .storeBit(1)
                .storeRef(
                    beginCell()
                        .storeUint(0, 16)
                        .storeUint(1, 16)
                        .storeAddress(stranger.address)
                        .storeRef(Cell.EMPTY)
                        .endCell(),
                )
                .storeCoins(0)
                .storeBit(0)
                .endCell(),
        });
        expect(hijack.transactions).toHaveTransaction({
            from: stranger.address,
            to: future,
            success: false,
            exitCode: 5887,
        });
        console.log(
            'OK-predeploy state after refused hijack:',
            (await blockchain.getContract(future)).accountState?.type,
        );
        // stranger deploys with GetStaticData (succeeds, init() runs with owner = registry)
        await stranger.send({
            to: future,
            value: toNano('0.1'),
            init,
            body: beginCell().storeUint(0x2fcb26a2, 32).storeUint(0, 64).endCell(),
        });
        const pre = await (await itemAt(0n)).getGetNftData();
        expect(pre.is_initialized).toBe(false);
        expect(pre.owner_address.equals(registry.address)).toBe(true);
        // genuine mint still works
        const m = await mint(member.address, 1n);
        expect(m.transactions).toHaveTransaction({ from: registry.address, to: future, success: true });
        expect((await (await itemAt(0n)).getGetNftData()).owner_address.equals(member.address)).toBe(true);
        // a second "mint" Transfer from anyone is now an owner-only transfer
        const again = await stranger.send({
            to: future,
            value: toNano('0.1'),
            body: beginCell()
                .storeUint(0x5fcc3d14, 32)
                .storeUint(0, 64)
                .storeAddress(stranger.address)
                .storeUint(0, 2)
                .storeBit(0)
                .storeCoins(0)
                .storeBit(0)
                .endCell(),
        });
        expect(again.transactions).toHaveTransaction({ to: future, success: false, exitCode: 61451 });
    });

    // AI-7: transferring to the registry (or any non-wallet) bricks the item forever.
    it('AI-7: an item sent to the registry is permanently stuck', async () => {
        await mint(member.address, 1n);
        const item0 = await itemAt(0n);
        await item0.send(
            member.getSender(),
            { value: toNano('0.05') },
            {
                $$type: 'Transfer',
                query_id: 0n,
                new_owner: registry.address,
                response_destination: member.address,
                custom_payload: null,
                forward_amount: 0n,
                forward_payload: beginCell().storeBit(0).endCell(),
            },
        );
        const d = await item0.getGetNftData();
        expect(d.owner_address.equals(registry.address)).toBe(true);
        expect(d.is_initialized).toBe(true);
    });

    // AI-8: mint Transfer / forwarded OwnershipAssigned lack the TEP-62 Either bit.
    it('AI-8: OwnershipAssigned forward_payload is relayed verbatim even without the Either bit', async () => {
        await mint(member.address, 1n);
        const item0 = await itemAt(0n);
        const res = await item0.send(
            member.getSender(),
            { value: toNano('0.1') },
            {
                $$type: 'Transfer',
                query_id: 0n,
                new_owner: stranger.address,
                response_destination: member.address,
                custom_payload: null,
                forward_amount: toNano('0.01'),
                forward_payload: beginCell().endCell(),
            },
        );
        const tx = res.transactions.find(
            (t) =>
                t.inMessage?.info.dest?.toString() === stranger.address.toString() &&
                t.inMessage?.info.src?.toString() === item0.address.toString(),
        )!;
        const b = tx.inMessage!.body.beginParse();
        b.loadUint(32);
        b.loadUint(64);
        b.loadAddress();
        console.log('AI-8 OwnershipAssigned bits left for Either(forward_payload):', b.remainingBits);
        expect(b.remainingBits).toEqual(0);
    });
});
