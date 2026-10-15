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
import { AchievementRegistry } from '../wrappers/AchievementRegistry';
import {
    mintAchievementBody,
    mintVoucherCell,
    PLATFORM_CHAT_TAG,
    registerTemplateBody,
    registerVoucherCell,
    templateKeyOf,
} from '../wrappers/Achievements';
import '@ton/test-utils';
import { NetworkProvider } from '@ton/blueprint';
import { networkGlobalId, refuseKeySharedWithOtherNetwork, voucherSignerFor } from '../scripts/network';
import { GLOBAL_ID, signLegacyVoucher } from '../wrappers/Vouchers';
import { globalIdOf, setGlobalId, signatureCell, signVoucher, TAG } from './helpers/vouchers';

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
    it('the wrappers sign exactly these envelopes', () => {
        expect(GLOBAL_ID).toEqual({ mainnet: MAINNET, testnet: TESTNET });
        const voucher = beginCell().storeUint(42, 64).endCell();
        const target = new Address(0, Buffer.alloc(32, 5));
        for (const globalId of [MAINNET, TESTNET]) {
            expect(signVoucher(voucher, backend, TAG.Claim, target, globalId)).toEqual(
                signForNetwork(voucher, backend, TAG.Claim, target, globalId),
            );
        }
        expect(signLegacyVoucher(voucher, backend, TAG.Claim, target)).toEqual(
            signUnbound(voucher, backend, TAG.Claim, target),
        );
    });

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

        const TEMPLATE_KEY = templateKeyOf(PLATFORM_CHAT_TAG, 1n);
        const USER_TAG = 555n;

        function register(net: Net, globalId: number, target = net.registry.address) {
            const voucherCell = registerVoucherCell({
                chatTag: PLATFORM_CHAT_TAG,
                registrant: net.admin.address,
                contentHash: 1n,
                expiry: farFuture(),
                contentUrl: 'https://achivator.cc/metadata/first-steps.json',
            });
            const sig = signForNetwork(voucherCell, backend, TAG.Register, target, globalId);
            return net.admin.send({
                to: net.registry.address,
                value: toNano('0.2'),
                body: registerTemplateBody(voucherCell, sig),
            });
        }

        function mint(net: Net, globalId: number) {
            const voucherCell = mintVoucherCell({
                templateKey: TEMPLATE_KEY,
                recipient: net.member.address,
                userTag: USER_TAG,
                expiry: farFuture(),
            });
            const sig = signForNetwork(voucherCell, backend, TAG.Mint, net.registry.address, globalId);
            return net.member.send({
                to: net.registry.address,
                value: toNano('0.2'),
                body: mintAchievementBody(voucherCell, sig),
            });
        }

        async function isActive(net: Net, address: Address) {
            return (await net.bc.getContract(address)).accountState?.type === 'active';
        }
        const isRegistered = async (net: Net) => isActive(net, await net.registry.getTemplateAddress(TEMPLATE_KEY));
        const isMinted = async (net: Net) => isActive(net, await net.registry.getItemAddress(TEMPLATE_KEY, USER_TAG));

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
            expect(await isRegistered(mainnet)).toBe(false);

            const ownRegister = await register(mainnet, MAINNET);
            expect(ownRegister.transactions).toHaveTransaction({ to: mainnet.registry.address, success: true });
            expect(await isRegistered(mainnet)).toBe(true);

            const replayedMint = await mint(mainnet, TESTNET);
            expect(replayedMint.transactions).toHaveTransaction({
                to: mainnet.registry.address,
                success: false,
                exitCode: errorCode(mainnet.registry, 'bad mint voucher signature'),
            });
            expect(await isMinted(mainnet)).toBe(false);

            const ownMint = await mint(mainnet, MAINNET);
            expect(ownMint.transactions).toHaveTransaction({ to: mainnet.registry.address, success: true });
            expect(await isMinted(mainnet)).toBe(true);

            // and testnet takes its own vouchers
            expect((await register(testnet, TESTNET)).transactions).toHaveTransaction({
                to: testnet.registry.address,
                success: true,
            });
            expect((await mint(testnet, TESTNET)).transactions).toHaveTransaction({
                to: testnet.registry.address,
                success: true,
            });
            expect(await isMinted(testnet)).toBe(true);
        });
    });

    describe('scripts', () => {
        const fakeProvider = (network: 'mainnet' | 'testnet' | 'custom', bc?: Blockchain) =>
            ({ network: () => network, provider: (a: Address) => bc!.provider(a) }) as unknown as NetworkProvider;

        it('derive the global id from the blueprint network', () => {
            expect(networkGlobalId(fakeProvider('mainnet'))).toBe(MAINNET);
            expect(networkGlobalId(fakeProvider('testnet'))).toBe(TESTNET);
            const saved = process.env.TON_GLOBAL_ID;
            try {
                delete process.env.TON_GLOBAL_ID;
                expect(() => networkGlobalId(fakeProvider('custom'))).toThrow(/TON_GLOBAL_ID/);
                process.env.TON_GLOBAL_ID = '-217';
                expect(networkGlobalId(fakeProvider('custom'))).toBe(-217);
            } finally {
                if (saved === undefined) delete process.env.TON_GLOBAL_ID;
                else process.env.TON_GLOBAL_ID = saved;
            }
        });

        it("sign in the envelope of the pool's version for the blueprint network", async () => {
            const bc = await Blockchain.create();
            setGlobalId(bc, TESTNET);
            const owner = await bc.treasury('owner');
            const creator = await bc.treasury('creator');
            const master = bc.openContract(await DistributorMaster.fromInit(owner.address, pub(backend)));
            await master.send(owner.getSender(), { value: toNano('0.1') }, { $$type: 'Deploy', queryId: 0n });
            await master.send(creator.getSender(), { value: toNano('0.3') }, { $$type: 'CreatePool', chatId: CHAT_ID });
            const pool = bc.openContract(ChatPool.fromAddress(await master.getPoolAddress(CHAT_ID)));
            const voucherCell = beginCell()
                .store(
                    storeAdminInitVoucher({
                        $$type: 'AdminInitVoucher',
                        chatId: CHAT_ID,
                        master: master.address,
                        admin: creator.address,
                        expiry: farFuture(),
                    }),
                )
                .endCell();
            const setAdmin = (sig: Buffer) =>
                pool.send(
                    creator.getSender(),
                    { value: toNano('0.05') },
                    { $$type: 'SetAdmin', voucherCell, signature: signatureCell(sig) },
                );

            // run against mainnet by mistake: the testnet pool rejects it
            const wrong = await voucherSignerFor(fakeProvider('mainnet', bc), pool.address);
            expect((await setAdmin(wrong(voucherCell, backend, TAG.Admin))).transactions).toHaveTransaction({
                to: pool.address,
                success: false,
            });
            const right = await voucherSignerFor(fakeProvider('testnet', bc), pool.address);
            expect((await setAdmin(right(voucherCell, backend, TAG.Admin))).transactions).toHaveTransaction({
                to: pool.address,
                success: true,
            });
        });

        it('refuse to deploy a contract that already exists on the other network', async () => {
            const address = new Address(0, Buffer.alloc(32, 9));
            const asked: string[] = [];
            const lookup = (state: string) => async (network: string) => {
                asked.push(network);
                return state;
            };
            await expect(
                refuseKeySharedWithOtherNetwork(
                    fakeProvider('mainnet'),
                    address,
                    'DistributorMaster',
                    lookup('active'),
                ),
            ).rejects.toThrow(/already deployed on testnet/);
            await expect(
                refuseKeySharedWithOtherNetwork(
                    fakeProvider('testnet'),
                    address,
                    'DistributorMaster',
                    lookup('frozen'),
                ),
            ).rejects.toThrow(/already deployed on mainnet/);
            await refuseKeySharedWithOtherNetwork(fakeProvider('mainnet'), address, 'X', lookup('uninitialized'));
            expect(asked).toEqual(['testnet', 'mainnet', 'testnet']);
            // custom networks are not checked; an unreachable API only warns
            await refuseKeySharedWithOtherNetwork(fakeProvider('custom'), address, 'X', lookup('active'));
            const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
            try {
                await refuseKeySharedWithOtherNetwork(fakeProvider('mainnet'), address, 'X', async () => {
                    throw new Error('offline');
                });
                expect(warn).toHaveBeenCalledWith(expect.stringMatching(/Could not check testnet/));
            } finally {
                warn.mockRestore();
            }
        });
    });
});
