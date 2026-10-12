// X-2 (DM-1 / CP-8 / AR-4): the same owner wallet and backend key give every
// contract the same address on testnet and mainnet, so a voucher must name
// the network it is for. The verifying contract reads the network's global id
// from config param 19 and hashes it into the SignedVoucher envelope.
//
// Two sandboxes pose as the two networks (config param 19 = -3 / -239). They
// produce identical addresses, exactly like the real networks do.
import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Address, beginCell, Cell, ContractABI, toNano } from '@ton/core';
import { keyPairFromSeed, KeyPair, sign } from '@ton/crypto';
import { ChatPool, storeAdminInitVoucher, storeClaimVoucher, storeDepositVoucher } from '../wrappers/ChatPool';
import { DistributorMaster } from '../wrappers/DistributorMaster';
import { AchievementRegistry, storeMintVoucher, storeRegisterVoucher } from '../wrappers/AchievementRegistry';
import '@ton/test-utils';
import { globalIdOf, setGlobalId, signatureCell, TAG } from './helpers/vouchers';

const MAINNET = -239;
const TESTNET = -3;
const CHAT_ID = -1001234567890n;
const JETTON_MASTER = new Address(0, Buffer.alloc(32, 3));
const farFuture = () => BigInt(Math.floor(Date.now() / 1000) + 3600);
const pub = (kp: KeyPair) => BigInt('0x' + kp.publicKey.toString('hex'));

// The network-bound envelope, spelled out independently of the wrappers:
// uint32 tag, int32 globalId, address target, ^voucher.
function signForNetwork(voucher: Cell, kp: KeyPair, tag: bigint, target: Address, globalId: number): Buffer {
    const envelope = beginCell()
        .storeUint(tag, 32)
        .storeInt(globalId, 32)
        .storeAddress(target)
        .storeRef(voucher)
        .endCell();
    return sign(envelope.hash(), kp.secretKey);
}

// The pre-v3 envelope, which names no network: uint32 tag, address target, ^voucher.
function signUnbound(voucher: Cell, kp: KeyPair, tag: bigint, target: Address): Buffer {
    const envelope = beginCell().storeUint(tag, 32).storeAddress(target).storeRef(voucher).endCell();
    return sign(envelope.hash(), kp.secretKey);
}

function errorCode(contract: { abi: ContractABI }, message: string): number {
    const hit = Object.entries(contract.abi.errors ?? {}).find(([, e]) => e.message === message);
    if (!hit) throw new Error(`no error "${message}" in the ABI`);
    return Number(hit[0]);
}

const backend = keyPairFromSeed(Buffer.alloc(32, 7));

describe('vouchers are bound to the network (X-2)', () => {
    describe('ChatPool', () => {
        type Net = {
            bc: Blockchain;
            globalId: number;
            master: SandboxContract<DistributorMaster>;
            pool: SandboxContract<ChatPool>;
            creator: SandboxContract<TreasuryContract>;
            member: SandboxContract<TreasuryContract>;
            jettonWallet: SandboxContract<TreasuryContract>; // stands in for the pool's jetton wallet
        };

        async function network(globalId: number): Promise<Net> {
            const bc = await Blockchain.create();
            setGlobalId(bc, globalId);
            const owner = await bc.treasury('owner');
            const creator = await bc.treasury('creator');
            const member = await bc.treasury('member');
            const jettonWallet = await bc.treasury('jettonWallet');
            const master = bc.openContract(await DistributorMaster.fromInit(owner.address, pub(backend)));
            await master.send(owner.getSender(), { value: toNano('0.1') }, { $$type: 'Deploy', queryId: 0n });
            await master.send(creator.getSender(), { value: toNano('0.3') }, { $$type: 'CreatePool', chatId: CHAT_ID });
            const pool = bc.openContract(ChatPool.fromAddress(await master.getPoolAddress(CHAT_ID)));
            return { bc, globalId, master, pool, creator, member, jettonWallet };
        }

        function adminVoucher(net: Net) {
            return beginCell()
                .store(
                    storeAdminInitVoucher({
                        $$type: 'AdminInitVoucher',
                        chatId: CHAT_ID,
                        master: net.master.address,
                        admin: net.creator.address,
                        expiry: farFuture(),
                    }),
                )
                .endCell();
        }

        function setAdmin(net: Net, voucherCell: Cell, signature: Buffer) {
            return net.pool.send(
                net.creator.getSender(),
                { value: toNano('0.05') },
                { $$type: 'SetAdmin', voucherCell, signature: signatureCell(signature) },
            );
        }

        function deposit(net: Net, amount: bigint, globalId: number) {
            const v = beginCell()
                .store(
                    storeDepositVoucher({
                        $$type: 'DepositVoucher',
                        chatId: CHAT_ID,
                        jettonMaster: JETTON_MASTER,
                        expectedJettonWallet: net.jettonWallet.address,
                        expiry: farFuture(),
                    }),
                )
                .endCell();
            const sig = signForNetwork(v, backend, TAG.Deposit, net.pool.address, globalId);
            return net.pool.send(
                net.jettonWallet.getSender(),
                { value: toNano('0.5') },
                {
                    $$type: 'JettonTransferNotification',
                    queryId: 0n,
                    amount,
                    sender: net.creator.address,
                    forwardPayload: beginCell().storeRef(v).storeBuffer(sig).endCell(),
                },
            );
        }

        function claim(net: Net, amount: bigint, nonce: bigint, globalId: number) {
            const v = beginCell()
                .store(
                    storeClaimVoucher({
                        $$type: 'ClaimVoucher',
                        chatId: CHAT_ID,
                        recipient: net.member.address,
                        jettonMaster: JETTON_MASTER,
                        amount,
                        nonce,
                        expiry: farFuture(),
                    }),
                )
                .endCell();
            const sig = signForNetwork(v, backend, TAG.Claim, net.pool.address, globalId);
            return net.pool.send(
                net.member.getSender(),
                { value: toNano('0.15') },
                { $$type: 'Claim', voucherCell: v, signature: signatureCell(sig) },
            );
        }

        let testnet: Net;
        let mainnet: Net;

        beforeEach(async () => {
            testnet = await network(TESTNET);
            mainnet = await network(MAINNET);
        });

        it('the two sandboxes are two networks with the same addresses', () => {
            expect(globalIdOf(testnet.bc)).toBe(TESTNET);
            expect(globalIdOf(mainnet.bc)).toBe(MAINNET);
            expect(testnet.master.address.equals(mainnet.master.address)).toBe(true);
            expect(testnet.pool.address.equals(mainnet.pool.address)).toBe(true);
        });

        it('an admin voucher signed for testnet is rejected on mainnet and accepted on testnet', async () => {
            const v = adminVoucher(testnet);
            const sig = signForNetwork(v, backend, TAG.Admin, testnet.pool.address, TESTNET);

            const onMainnet = await setAdmin(mainnet, v, sig);
            expect(onMainnet.transactions).toHaveTransaction({
                to: mainnet.pool.address,
                success: false,
                exitCode: errorCode(mainnet.pool, 'bad admin voucher signature'),
            });
            expect(await mainnet.pool.getPoolAdmin()).toBeNull();

            const onTestnet = await setAdmin(testnet, v, sig);
            expect(onTestnet.transactions).toHaveTransaction({ to: testnet.pool.address, success: true });
            expect((await testnet.pool.getPoolAdmin())!.equals(testnet.creator.address)).toBe(true);

            // mainnet still takes its own voucher
            const own = signForNetwork(v, backend, TAG.Admin, mainnet.pool.address, MAINNET);
            const r = await setAdmin(mainnet, v, own);
            expect(r.transactions).toHaveTransaction({ to: mainnet.pool.address, success: true });
            expect((await mainnet.pool.getPoolAdmin())!.equals(mainnet.creator.address)).toBe(true);
        });

        it('the unbound (pre-v3) envelope is rejected on every network', async () => {
            const v = adminVoucher(testnet);
            const sig = signUnbound(v, backend, TAG.Admin, testnet.pool.address);
            for (const net of [testnet, mainnet]) {
                const r = await setAdmin(net, v, sig);
                expect(r.transactions).toHaveTransaction({
                    to: net.pool.address,
                    success: false,
                    exitCode: errorCode(net.pool, 'bad admin voucher signature'),
                });
                expect(await net.pool.getPoolAdmin()).toBeNull();
            }
        });

        it('deposit and claim vouchers only work on the network they were signed for', async () => {
            const v = adminVoucher(mainnet);
            await setAdmin(mainnet, v, signForNetwork(v, backend, TAG.Admin, mainnet.pool.address, MAINNET));
            expect(await mainnet.pool.getPoolAdmin()).not.toBeNull();

            // a testnet deposit voucher is refunded: nothing is credited
            await deposit(mainnet, toNano('1000'), TESTNET);
            expect(await mainnet.pool.getBalanceOf(JETTON_MASTER)).toEqual(0n);
            await deposit(mainnet, toNano('1000'), MAINNET);
            expect(await mainnet.pool.getBalanceOf(JETTON_MASTER)).toEqual(toNano('1000'));

            // a testnet claim voucher pays nothing out on mainnet
            const replay = await claim(mainnet, toNano('50'), 1n, TESTNET);
            expect(replay.transactions).toHaveTransaction({
                to: mainnet.pool.address,
                success: false,
                exitCode: errorCode(mainnet.pool, 'bad claim voucher signature'),
            });
            expect(replay.transactions).not.toHaveTransaction({
                from: mainnet.pool.address,
                to: mainnet.jettonWallet.address,
            });
            expect(await mainnet.pool.getIsNonceUsed(1n)).toBe(false);

            const own = await claim(mainnet, toNano('50'), 1n, MAINNET);
            expect(own.transactions).toHaveTransaction({
                from: mainnet.pool.address,
                to: mainnet.jettonWallet.address,
                success: true,
            });
            expect(await mainnet.pool.getBalanceOf(JETTON_MASTER)).toEqual(toNano('950'));
        });
    });

    describe('AchievementRegistry', () => {
        type Net = {
            bc: Blockchain;
            registry: SandboxContract<AchievementRegistry>;
            admin: SandboxContract<TreasuryContract>;
            member: SandboxContract<TreasuryContract>;
        };

        async function network(globalId: number): Promise<Net> {
            const bc = await Blockchain.create();
            setGlobalId(bc, globalId);
            const owner = await bc.treasury('owner');
            const admin = await bc.treasury('admin');
            const member = await bc.treasury('member');
            const content = beginCell()
                .storeUint(1, 8)
                .storeStringTail('https://achivator.cc/collection.json')
                .endCell();
            const registry = bc.openContract(await AchievementRegistry.fromInit(owner.address, pub(backend), content));
            await registry.send(owner.getSender(), { value: toNano('0.1') }, { $$type: 'Deploy', queryId: 0n });
            return { bc, registry, admin, member };
        }

        function register(net: Net, globalId: number, target = net.registry.address) {
            const voucherCell = beginCell()
                .store(
                    storeRegisterVoucher({
                        $$type: 'RegisterVoucher',
                        chatId: CHAT_ID,
                        registrant: net.admin.address,
                        expiry: farFuture(),
                    }),
                )
                .endCell();
            const sig = signForNetwork(voucherCell, backend, TAG.Register, target, globalId);
            return net.registry.send(
                net.admin.getSender(),
                { value: toNano('0.2') },
                {
                    $$type: 'RegisterTemplate',
                    contentUrl: 'https://achivator.cc/metadata/first-steps.json',
                    contentHash: 1n,
                    royalty: {
                        $$type: 'RoyaltyParams',
                        numerator: 5n,
                        denominator: 100n,
                        destination: net.admin.address,
                    },
                    voucherCell,
                    signature: signatureCell(sig),
                },
            );
        }

        function mint(net: Net, globalId: number, nonce: bigint) {
            const voucherCell = beginCell()
                .store(
                    storeMintVoucher({
                        $$type: 'MintVoucher',
                        templateId: 0n,
                        recipient: net.member.address,
                        tgUserId: 555n,
                        nonce,
                        expiry: farFuture(),
                    }),
                )
                .endCell();
            const sig = signForNetwork(voucherCell, backend, TAG.Mint, net.registry.address, globalId);
            return net.registry.send(
                net.member.getSender(),
                { value: toNano('0.2') },
                { $$type: 'MintAchievement', voucherCell, signature: signatureCell(sig) },
            );
        }

        it('register and mint vouchers signed for testnet are rejected on mainnet', async () => {
            const testnet = await network(TESTNET);
            const mainnet = await network(MAINNET);
            expect(testnet.registry.address.equals(mainnet.registry.address)).toBe(true);

            const replayedRegister = await register(mainnet, TESTNET);
            expect(replayedRegister.transactions).toHaveTransaction({
                to: mainnet.registry.address,
                success: false,
                exitCode: errorCode(mainnet.registry, 'bad register voucher signature'),
            });
            expect(await mainnet.registry.getTemplatesCount()).toEqual(0n);

            const ownRegister = await register(mainnet, MAINNET);
            expect(ownRegister.transactions).toHaveTransaction({ to: mainnet.registry.address, success: true });
            expect(await mainnet.registry.getTemplatesCount()).toEqual(1n);

            const replayedMint = await mint(mainnet, TESTNET, 1n);
            expect(replayedMint.transactions).toHaveTransaction({
                to: mainnet.registry.address,
                success: false,
                exitCode: errorCode(mainnet.registry, 'bad mint voucher signature'),
            });
            expect(await mainnet.registry.getIsMinted(0n, 555n)).toBe(false);
            expect(await mainnet.registry.getIsNonceUsed(1n)).toBe(false);

            const ownMint = await mint(mainnet, MAINNET, 1n);
            expect(ownMint.transactions).toHaveTransaction({ to: mainnet.registry.address, success: true });
            expect(await mainnet.registry.getIsMinted(0n, 555n)).toBe(true);

            // and testnet takes its own vouchers
            expect((await register(testnet, TESTNET)).transactions).toHaveTransaction({
                to: testnet.registry.address,
                success: true,
            });
            expect((await mint(testnet, TESTNET, 1n)).transactions).toHaveTransaction({
                to: testnet.registry.address,
                success: true,
            });
            expect(await testnet.registry.getIsMinted(0n, 555n)).toBe(true);
        });
    });
});
