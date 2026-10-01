import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Address, beginCell, Cell, storeMessage, toNano } from '@ton/core';
import { keyPairFromSeed, KeyPair, sign } from '@ton/crypto';
import { TestJettonMinter, TestJettonWallet } from '../wrappers/TestJetton';
import {
    ChatPool,
    storeAdminInitVoucher,
    storeClaim,
    storeClaimVoucher,
    storeCreatePool,
    storeDepositVoucher,
    storeJettonTransfer,
    storeSetAdmin,
    storeSetClaimLimit,
    storeSetClaimsPaused,
    storeSetPoolBackendKey,
    storeSignedVoucher,
    storeWithdrawRemainder,
} from '../wrappers/ChatPool';
import { DistributorMaster } from '../wrappers/DistributorMaster';
import '@ton/test-utils';
import { signVoucher, TAG } from './helpers/vouchers';

// The miniapp signs and builds all wire cells with miniapp/src/lib/ton/vouchers.js
// (plain CJS with its own @ton/* deps, pinned back to this package through the
// jest moduleNameMapper). This spec is the contract between the app and the
// chain: every cell the app can produce must serialize byte-identically to the
// generated bindings and must be accepted by the real contracts in sandbox.
const voucherLib: any = require('../../miniapp/src/lib/ton/vouchers.js');
const TAGS: Record<string, number> = require('../../miniapp/src/lib/ton/constants.js').VOUCHER_TAG;
const CONTRACTS_VERSION: number = require('../../miniapp/src/lib/ton/constants.js').CONTRACTS_VERSION;

const BACKEND_SEED = Buffer.alloc(32, 7);
const BACKEND_SECRET_HEX = BACKEND_SEED.toString('hex');
const WRONG_SEED = Buffer.alloc(32, 9);

function rawInternal(src: Address, dest: Address, value: bigint, body: Cell): Cell {
    return beginCell()
        .store(
            storeMessage({
                info: {
                    type: 'internal',
                    ihrDisabled: true,
                    bounce: true,
                    bounced: false,
                    src,
                    dest,
                    value: { coins: value },
                    ihrFee: 0n,
                    forwardFee: 0n,
                    createdAt: 0,
                    createdLt: 0n,
                },
                body,
            }),
        )
        .endCell();
}

const boc = (c: Cell) => c.toBoc().toString('base64');

describe('miniapp lib <-> contracts', () => {
    const CHAT_ID = 1001234567890n;
    const AMOUNT = toNano('100');
    const CLAIM_AMOUNT = toNano('30');
    const FAR_FUTURE = BigInt(Math.floor(Date.now() / 1000) + 3600);

    let blockchain: Blockchain;
    let owner: SandboxContract<TreasuryContract>;
    let creator: SandboxContract<TreasuryContract>;
    let client: SandboxContract<TreasuryContract>;
    let backend: KeyPair;
    let master: SandboxContract<DistributorMaster>;
    let minter: SandboxContract<TestJettonMinter>;
    let pool: SandboxContract<ChatPool>;

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        owner = await blockchain.treasury('owner');
        creator = await blockchain.treasury('creator');
        client = await blockchain.treasury('client');
        backend = keyPairFromSeed(BACKEND_SEED);

        master = blockchain.openContract(
            await DistributorMaster.fromInit(owner.address, BigInt('0x' + backend.publicKey.toString('hex'))),
        );
        const depMaster = await master.send(
            owner.getSender(),
            { value: toNano('0.1') },
            { $$type: 'Deploy', queryId: 0n },
        );
        expect(depMaster.transactions).toHaveTransaction({ to: master.address, deploy: true, success: true });

        const content = beginCell().storeUint(0, 8).storeStringTail('test').endCell();
        minter = blockchain.openContract(await TestJettonMinter.fromInit(owner.address, content));
        await minter.send(owner.getSender(), { value: toNano('0.05') }, { $$type: 'Deploy', queryId: 0n });
        const mintRes = await minter.send(owner.getSender(), { value: toNano('0.2') }, {
            $$type: 'Mint',
            amount: toNano('1000'),
            recipient: creator.address,
        });
        expect(mintRes.transactions).toHaveTransaction({ to: minter.address, success: true });
    });

    // The miniapp refuses to sign deposit vouchers for a pool of another
    // version; both sides must move together.
    it('speaks the protocol version the miniapp signs for', async () => {
        expect(await master.getVersion()).toEqual(BigInt(CONTRACTS_VERSION));
    });

    it('builds byte-identical cells to the generated bindings', async () => {
        const NEGATIVE_CHAT_ID_FOR_ADMIN = -1009876543210n;
        const jettonMaster = minter.address;
        const expectedJettonWallet = await minter.getGetWalletAddress(creator.address);

        // Deposit voucher.
        const genDeposit = beginCell()
            .store(
                storeDepositVoucher({
                    $$type: 'DepositVoucher',
                    chatId: CHAT_ID,
                    jettonMaster,
                    expectedJettonWallet,
                    expiry: FAR_FUTURE,
                }),
            )
            .endCell();
        const libDeposit = voucherLib.buildDepositVoucherCell({
            chatId: CHAT_ID,
            jettonMaster,
            expectedJettonWallet,
            expiry: FAR_FUTURE,
        });
        expect(boc(libDeposit)).toEqual(boc(genDeposit));

        // Claim voucher.
        const genClaimVoucher = beginCell()
            .store(
                storeClaimVoucher({
                    $$type: 'ClaimVoucher',
                    chatId: CHAT_ID,
                    recipient: client.address,
                    jettonMaster,
                    amount: CLAIM_AMOUNT,
                    nonce: 1n,
                    expiry: FAR_FUTURE,
                }),
            )
            .endCell();
        const libClaimVoucher = voucherLib.buildClaimVoucherCell({
            chatId: CHAT_ID,
            recipient: client.address,
            jettonMaster,
            amount: CLAIM_AMOUNT,
            nonce: 1n,
            expiry: FAR_FUTURE,
        });
        expect(boc(libClaimVoucher)).toEqual(boc(genClaimVoucher));

        // The lib signs the SignedVoucher envelope, never the bare cell: the
        // envelope and the resulting 512 bits must match the bindings.
        const tags = TAGS;
        expect(BigInt(tags.Deposit)).toEqual(TAG.Deposit);
        expect(BigInt(tags.Claim)).toEqual(TAG.Claim);
        expect(BigInt(tags.Admin)).toEqual(TAG.Admin);
        expect(BigInt(tags.Register)).toEqual(TAG.Register);
        expect(BigInt(tags.Mint)).toEqual(TAG.Mint);
        const target = master.address;
        const genEnvelope = beginCell()
            .store(storeSignedVoucher({ $$type: 'SignedVoucher', tag: TAG.Claim, target, voucher: genClaimVoucher }))
            .endCell();
        expect(boc(voucherLib.signedVoucherCell(libClaimVoucher, { tag: tags.Claim, target }))).toEqual(boc(genEnvelope));
        const libSignature: Buffer = voucherLib.signVoucher(libClaimVoucher, BACKEND_SECRET_HEX, { tag: tags.Claim, target });
        expect(libSignature).toEqual(signVoucher(libClaimVoucher, backend, TAG.Claim, target));
        // an unsigned-kind call must never silently sign the bare cell
        expect(() => voucherLib.signVoucher(libClaimVoucher, BACKEND_SECRET_HEX)).toThrow();

        // Admin voucher + SetAdmin + WithdrawRemainder bodies.
        const genAdminVoucher = beginCell()
            .store(
                storeAdminInitVoucher({
                    $$type: 'AdminInitVoucher',
                    chatId: NEGATIVE_CHAT_ID_FOR_ADMIN,
                    master: master.address,
                    admin: creator.address,
                    expiry: FAR_FUTURE,
                }),
            )
            .endCell();
        const libAdminVoucher = voucherLib.buildAdminVoucherCell({
            chatId: NEGATIVE_CHAT_ID_FOR_ADMIN,
            master: master.address,
            admin: creator.address,
            expiry: FAR_FUTURE,
        });
        expect(boc(libAdminVoucher)).toEqual(boc(genAdminVoucher));
        const genSetAdmin = beginCell()
            .store(
                storeSetAdmin({
                    $$type: 'SetAdmin',
                    voucherCell: genAdminVoucher,
                    signature: beginCell().storeBuffer(libSignature).endCell(),
                }),
            )
            .endCell();
        expect(boc(voucherLib.buildSetAdminBody({ voucherCell: libAdminVoucher, signature: libSignature }))).toEqual(
            boc(genSetAdmin),
        );
        for (const paused of [true, false]) {
            expect(boc(voucherLib.buildSetClaimsPausedBody(paused))).toEqual(
                boc(beginCell().store(storeSetClaimsPaused({ $$type: 'SetClaimsPaused', paused })).endCell()),
            );
        }
        expect(boc(voucherLib.buildSetClaimLimitBody({ jettonMaster, dailyLimit: AMOUNT }))).toEqual(
            boc(beginCell().store(storeSetClaimLimit({ $$type: 'SetClaimLimit', jettonMaster, dailyLimit: AMOUNT })).endCell()),
        );
        const keyHex = backend.publicKey.toString('hex');
        expect(boc(voucherLib.buildSetPoolBackendKeyBody(keyHex))).toEqual(
            boc(
                beginCell()
                    .store(storeSetPoolBackendKey({ $$type: 'SetPoolBackendKey', backendPubKey: BigInt('0x' + keyHex) }))
                    .endCell(),
            ),
        );

        const genWithdraw = beginCell()
            .store(
                storeWithdrawRemainder({
                    $$type: 'WithdrawRemainder',
                    jettonMaster,
                    amount: AMOUNT,
                    to: creator.address,
                }),
            )
            .endCell();
        expect(
            boc(voucherLib.buildWithdrawRemainderBody({ jettonMaster, amount: AMOUNT, to: creator.address })),
        ).toEqual(boc(genWithdraw));

        // Full claim message: opcode + ref(voucher) + inline signature.
        const genClaim = beginCell()
            .store(
                storeClaim({
                    $$type: 'Claim',
                    voucherCell: genClaimVoucher,
                    signature: beginCell().storeBuffer(libSignature).endCell(),
                }),
            )
            .endCell();
        const libClaim = voucherLib.buildClaimBody({ voucherCell: libClaimVoucher, signature: libSignature });
        expect(boc(libClaim)).toEqual(boc(genClaim));

        // Deposit forward payload + full jetton transfer body (the exact bytes
        // the user's wallet puts on the wire).
        const destination = master.address;
        const forwardPayload = voucherLib.buildDepositForwardPayload(libDeposit, libSignature);
        const genTransfer = beginCell()
            .store(
                storeJettonTransfer({
                    $$type: 'JettonTransfer',
                    queryId: 0n,
                    amount: AMOUNT,
                    destination,
                    responseDestination: creator.address,
                    customPayload: null,
                    forwardTonAmount: toNano('0.15'),
                    forwardPayload,
                }),
            )
            .endCell();
        const libTransfer = voucherLib.buildJettonTransferBody({
            amount: AMOUNT,
            destination,
            responseDestination: creator.address,
            forwardTonAmount: toNano('0.15'),
            forwardPayload,
        });
        expect(boc(libTransfer)).toEqual(boc(genTransfer));

        // CreatePool request.
        const genCreate = beginCell().store(storeCreatePool({ $$type: 'CreatePool', chatId: CHAT_ID })).endCell();
        expect(boc(voucherLib.buildCreatePoolBody(CHAT_ID))).toEqual(boc(genCreate));

        // Telegram supergroup ids are negative; int64 must be two's complement
        // on both sides or every production chat would encode differently.
        const NEGATIVE_CHAT_ID = -1001234567890n;
        const genNegDeposit = beginCell()
            .store(
                storeDepositVoucher({
                    $$type: 'DepositVoucher',
                    chatId: NEGATIVE_CHAT_ID,
                    jettonMaster,
                    expectedJettonWallet,
                    expiry: FAR_FUTURE,
                }),
            )
            .endCell();
        const libNegDeposit = voucherLib.buildDepositVoucherCell({
            chatId: NEGATIVE_CHAT_ID,
            jettonMaster,
            expectedJettonWallet,
            expiry: FAR_FUTURE,
        });
        expect(boc(libNegDeposit)).toEqual(boc(genNegDeposit));

        const genNegCreate = beginCell()
            .store(storeCreatePool({ $$type: 'CreatePool', chatId: NEGATIVE_CHAT_ID }))
            .endCell();
        expect(boc(voucherLib.buildCreatePoolBody(NEGATIVE_CHAT_ID))).toEqual(boc(genNegCreate));
    });

    it('runs the full app flow with lib-built raw messages', async () => {
        // --- 1. createPool: exactly the body the miniapp hands to TON Connect.
        const createRes = await blockchain.sendMessage(
            rawInternal(creator.address, master.address, toNano('0.3'), voucherLib.buildCreatePoolBody(CHAT_ID)),
        );
        expect(createRes.transactions).toHaveTransaction({
            from: creator.address,
            to: master.address,
            success: true,
        });

        // The master deploys the pool at its own derived address (its
        // poolAddress getter is what the miniapp reads over RPC). The compiled
        // code inside the master's unit differs from the standalone ChatPool
        // build, so the address is only trustworthy through the getter.
        const poolAddress = await master.getPoolAddress(CHAT_ID);
        pool = blockchain.openContract(ChatPool.fromAddress(poolAddress));
        expect(createRes.transactions).toHaveTransaction({
            from: master.address,
            to: poolAddress,
            deploy: true,
            success: true,
        });
        expect(await pool.getPoolChatId()).toEqual(CHAT_ID);

        // --- 1b. admin onboarding: deposits are refunded until the pool has
        // an admin, so this comes first in the app too.
        const adminVoucher = voucherLib.buildAdminVoucherCell({
            chatId: CHAT_ID,
            master: master.address,
            admin: creator.address,
            expiry: FAR_FUTURE,
        });
        const setAdminRes = await blockchain.sendMessage(
            rawInternal(
                creator.address,
                pool.address,
                toNano('0.05'),
                voucherLib.buildSetAdminBody({
                    voucherCell: adminVoucher,
                    signature: voucherLib.signVoucher(adminVoucher, BACKEND_SECRET_HEX, {
                        tag: TAGS.Admin,
                        target: pool.address,
                    }),
                }),
            ),
        );
        expect(setAdminRes.transactions).toHaveTransaction({ from: creator.address, to: pool.address, success: true });
        expect((await pool.getPoolAdmin())!.equals(creator.address)).toBe(true);

        // Lift the default 10%/day claim budget (lib-built admin control).
        const limitRes = await blockchain.sendMessage(
            rawInternal(
                creator.address,
                pool.address,
                toNano('0.05'),
                voucherLib.buildSetClaimLimitBody({ jettonMaster: minter.address, dailyLimit: AMOUNT }),
            ),
        );
        expect(limitRes.transactions).toHaveTransaction({ from: creator.address, to: pool.address, success: true });
        expect(await pool.getClaimLimit(minter.address)).toEqual(AMOUNT);

        // --- 2. deposit: lib-built voucher + forward payload + transfer body,
        // delivered as a raw message from the creator to their own jetton
        // wallet (what TON Connect produces in production).
        const creatorWalletAddr = await minter.getGetWalletAddress(creator.address);
        const poolWalletAddr = await minter.getGetWalletAddress(pool.address);

        const depositVoucher = voucherLib.buildDepositVoucherCell({
            chatId: CHAT_ID,
            jettonMaster: minter.address,
            expectedJettonWallet: poolWalletAddr,
            expiry: FAR_FUTURE,
        });
        const depositSignature: Buffer = voucherLib.signVoucher(depositVoucher, BACKEND_SECRET_HEX, {
            tag: TAGS.Deposit,
            target: pool.address,
        });
        const forwardTonAmount = toNano('0.15');

        const depositRes = await blockchain.sendMessage(
            rawInternal(
                creator.address,
                creatorWalletAddr,
                forwardTonAmount + toNano('0.1'),
                voucherLib.buildJettonTransferBody({
                    amount: AMOUNT,
                    destination: pool.address,
                    responseDestination: creator.address,
                    forwardTonAmount,
                    forwardPayload: voucherLib.buildDepositForwardPayload(depositVoucher, depositSignature),
                }),
            ),
        );
        expect(depositRes.transactions).toHaveTransaction({
            from: creator.address,
            to: creatorWalletAddr,
            success: true,
        });
        expect(depositRes.transactions).toHaveTransaction({
            from: creatorWalletAddr,
            to: poolWalletAddr,
            deploy: true,
            success: true,
        });
        expect(depositRes.transactions).toHaveTransaction({
            from: poolWalletAddr,
            to: pool.address,
            success: true,
        });
        // No fee: nothing reaches the master, the forwarded TON minus gas
        // goes back to the creator.
        expect(depositRes.transactions).not.toHaveTransaction({ from: pool.address, to: master.address });
        expect(depositRes.transactions).toHaveTransaction({
            from: pool.address,
            to: creator.address,
            op: 0xd53276db,
            value: (v) => v! > toNano('0.1'),
        });

        expect(await pool.getBalanceOf(minter.address)).toEqual(AMOUNT);
        expect((await pool.getPoolAdmin())!.equals(creator.address)).toBe(true);
        expect((await pool.getJettonWallet(minter.address))!.equals(poolWalletAddr)).toBe(true);

        // --- 3. claim: lib-built claim message from the user's wallet.
        const claimVoucher = voucherLib.buildClaimVoucherCell({
            chatId: CHAT_ID,
            recipient: client.address,
            jettonMaster: minter.address,
            amount: CLAIM_AMOUNT,
            nonce: 1n,
            expiry: FAR_FUTURE,
        });
        const claimBody = voucherLib.buildClaimBody({
            voucherCell: claimVoucher,
            signature: voucherLib.signVoucher(claimVoucher, BACKEND_SECRET_HEX, {
                tag: TAGS.Claim,
                target: pool.address,
            }),
        });
        const claimRes = await blockchain.sendMessage(
            rawInternal(client.address, pool.address, toNano('0.15'), claimBody),
        );
        expect(claimRes.transactions).toHaveTransaction({
            from: client.address,
            to: pool.address,
            success: true,
        });
        expect(claimRes.transactions).toHaveTransaction({
            from: pool.address,
            to: poolWalletAddr,
            success: true,
        });

        const clientWallet = blockchain.openContract(
            TestJettonWallet.fromAddress(await minter.getGetWalletAddress(client.address)),
        );
        expect(await clientWallet.getWalletBalance()).toEqual(CLAIM_AMOUNT);
        expect(await pool.getBalanceOf(minter.address)).toEqual(AMOUNT - CLAIM_AMOUNT);
        expect(await pool.getIsNonceUsed(1n)).toBe(true);

        // --- 4. replay of the identical claim must fail (nonce burned).
        const replayRes = await blockchain.sendMessage(
            rawInternal(client.address, pool.address, toNano('0.16'), claimBody),
        );
        expect(replayRes.transactions).toHaveTransaction({
            from: client.address,
            to: pool.address,
            success: false,
        });
        expect(await pool.getBalanceOf(minter.address)).toEqual(AMOUNT - CLAIM_AMOUNT);

        // --- 5. a lib-built message signed with the wrong key must fail.
        const forgedKey = keyPairFromSeed(WRONG_SEED);
        const forgedVoucher = voucherLib.buildClaimVoucherCell({
            chatId: CHAT_ID,
            recipient: client.address,
            jettonMaster: minter.address,
            amount: toNano('10'),
            nonce: 2n,
            expiry: FAR_FUTURE,
        });
        const forgedRes = await blockchain.sendMessage(
            rawInternal(
                client.address,
                pool.address,
                toNano('0.15'),
                voucherLib.buildClaimBody({
                    voucherCell: forgedVoucher,
                    signature: signVoucher(forgedVoucher, forgedKey, TAG.Claim, pool.address),
                }),
            ),
        );
        expect(forgedRes.transactions).toHaveTransaction({
            from: client.address,
            to: pool.address,
            success: false,
        });
        expect(await pool.getIsNonceUsed(2n)).toBe(false);
        expect(await pool.getBalanceOf(minter.address)).toEqual(AMOUNT - CLAIM_AMOUNT);

        // --- 6. withdrawal by the admin with a lib-built message.
        const rest = AMOUNT - CLAIM_AMOUNT;
        await blockchain.sendMessage(
            rawInternal(
                creator.address,
                pool.address,
                toNano('0.15'),
                voucherLib.buildWithdrawRemainderBody({ jettonMaster: minter.address, amount: rest, to: creator.address }),
            ),
        );
        const creatorWallet = blockchain.openContract(TestJettonWallet.fromAddress(creatorWalletAddr));
        expect(await creatorWallet.getWalletBalance()).toEqual(toNano('1000') - AMOUNT + rest);
        expect(await pool.getBalanceOf(minter.address)).toEqual(0n);
    });
});
