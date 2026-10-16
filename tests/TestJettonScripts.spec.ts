import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Address, beginCell, toNano } from '@ton/core';
import { keyPairFromSeed } from '@ton/crypto';
import '@ton/test-utils';
import { TestJettonMinter } from '../wrappers/TestJetton';
import { DistributorMaster } from '../wrappers/DistributorMaster';
import { ChatPool, storeAdminInitVoucher } from '../wrappers/ChatPool';
import { globalIdOf, setGlobalId, signatureCell, signVoucher, TAG } from './helpers/vouchers';
import { GLOBAL_ID } from '../wrappers/Vouchers';
import { run as deployTestJetton } from '../scripts/deployTestJetton';
import { run as mintTestJetton } from '../scripts/mintTestJetton';
import { run as deposit } from '../scripts/deposit';
import { jettonBalanceOf } from '../scripts/actors';
import { decimalsFromContent, parseJettonAmount } from '../scripts/jetton';
import {
    buildOnchainContent,
    getJettonData,
    jettonBalance,
    mintBody,
    OP,
    parseOnchainContent,
} from './helpers/jettonMessages';
import { offlineProvider, sandboxProvider } from './helpers/sandboxProvider';

// The test-jetton scripts: network guard (TJM-9 / TJW-7), TEP-64 metadata on
// deploy, balances read through get_wallet_data (scripts/actors.ts) and
// deposit amounts scaled by the jetton's own decimals (scripts/deposit.ts).

describe('test jetton scripts', () => {
    const savedEnv = { ...process.env };
    let blockchain: Blockchain;
    let deployer: SandboxContract<TreasuryContract>;
    let log: jest.SpyInstance;

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        deployer = await blockchain.treasury('deployer');
        log = jest.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
        process.env = { ...savedEnv };
        log.mockRestore();
    });

    async function deployMinter(decimals: string) {
        const minter = blockchain.openContract(
            await TestJettonMinter.fromInit(deployer.address, buildOnchainContent({ name: 'T', decimals })),
        );
        await minter.send(deployer.getSender(), { value: toNano('0.05') }, { $$type: 'Deploy', queryId: 0n });
        return minter;
    }

    async function mintTo(minter: Address, recipient: Address, amount: bigint) {
        await deployer.send({ to: minter, value: toNano('0.1'), body: mintBody({ amount, recipient }) });
    }

    describe('refuse to run anywhere but testnet (TJM-9 / TJW-7)', () => {
        for (const network of ['mainnet', 'custom'] as const) {
            it(`deployTestJetton on ${network}`, async () => {
                await expect(deployTestJetton(offlineProvider(network))).rejects.toThrow(/testnet/);
            });

            it(`mintTestJetton on ${network}`, async () => {
                process.env.JETTON_MASTER = deployer.address.toString();
                process.env.RECIPIENT = deployer.address.toString();
                process.env.AMOUNT = '1';
                await expect(mintTestJetton(offlineProvider(network))).rejects.toThrow(/testnet/);
            });
        }
    });

    it('deployTestJetton deploys TEP-64 on-chain metadata and mints to the deployer', async () => {
        process.env.MINT_AMOUNT = '5';
        const { provider, sent } = sandboxProvider(blockchain, deployer);
        await deployTestJetton(provider);

        const minter = sent[0].to;
        const data = await getJettonData(blockchain, minter);
        const meta = parseOnchainContent(data.content);
        expect(meta.decimals).toEqual('9');
        expect(meta.name).toBeDefined();
        expect(meta.symbol).toBeDefined();
        expect(data.totalSupply).toEqual(toNano('5'));
        const wallet = await blockchain
            .openContract(TestJettonMinter.fromAddress(minter))
            .getGetWalletAddress(deployer.address);
        expect(await jettonBalance(blockchain, wallet)).toEqual(toNano('5'));
    });

    describe('actors.jettonBalanceOf', () => {
        it('reads get_wallet_data, and 0 only for a wallet that does not exist yet', async () => {
            const minter = await deployMinter('9');
            const alice = await blockchain.treasury('alice');
            const bob = await blockchain.treasury('bob');
            await mintTo(minter.address, alice.address, 7n);
            const { provider } = sandboxProvider(blockchain, deployer);
            expect(await jettonBalanceOf(provider, minter.address, alice.address)).toEqual(7n);
            expect(await jettonBalanceOf(provider, minter.address, bob.address)).toEqual(0n);
        });

        it('surfaces errors instead of reporting a 0 balance', async () => {
            const notAJetton = await blockchain.treasury('not-a-jetton');
            const { provider } = sandboxProvider(blockchain, deployer);
            await expect(jettonBalanceOf(provider, notAJetton.address, deployer.address)).rejects.toThrow();
        });
    });

    it('deposit scales AMOUNT by the decimals in get_jetton_data', async () => {
        const backend = keyPairFromSeed(Buffer.alloc(32, 7));
        // the script signs for the blueprint network (testnet here), so the
        // sandbox must run testnet's global id for the pool to accept it
        setGlobalId(blockchain, GLOBAL_ID.testnet);
        const master = blockchain.openContract(
            await DistributorMaster.fromInit(deployer.address, BigInt('0x' + backend.publicKey.toString('hex'))),
        );
        await master.send(deployer.getSender(), { value: toNano('0.1') }, { $$type: 'Deploy', queryId: 0n });
        const minter = await deployMinter('6');
        const admin = await blockchain.treasury('admin');
        await mintTo(minter.address, admin.address, 10_000_000n); // 10 tokens at 6 decimals

        // The pool must exist and have an admin: the script reads its
        // version() to pick the voucher envelope, and an adminless pool
        // refunds every deposit.
        const chatId = -1001234567890n;
        await master.send(deployer.getSender(), { value: toNano('0.2') }, { $$type: 'CreatePool', chatId });
        const pool = blockchain.openContract(ChatPool.fromAddress(await master.getPoolAddress(chatId)));
        const adminVoucher = beginCell()
            .store(
                storeAdminInitVoucher({
                    $$type: 'AdminInitVoucher',
                    chatId,
                    master: master.address,
                    admin: admin.address,
                    expiry: BigInt(Math.floor(Date.now() / 1000) + 3600),
                }),
            )
            .endCell();
        const setAdmin = await pool.send(
            admin.getSender(),
            { value: toNano('0.05') },
            {
                $$type: 'SetAdmin',
                voucherCell: adminVoucher,
                signature: signatureCell(
                    signVoucher(adminVoucher, backend, TAG.Admin, pool.address, globalIdOf(blockchain)),
                ),
            },
        );
        expect(setAdmin.transactions).toHaveTransaction({ to: pool.address, success: true });

        process.env.MASTER_ADDRESS = master.address.toString();
        process.env.JETTON_MASTER = minter.address.toString();
        process.env.CHAT_ID = '-1001234567890';
        process.env.AMOUNT = '2.5';
        process.env.BACKEND_SECRET = Buffer.alloc(32, 7).toString('hex');
        const { provider, sent } = sandboxProvider(blockchain, admin);
        await deposit(provider);

        const body = sent[0].body!.beginParse();
        expect(body.loadUint(32)).toEqual(OP.transfer);
        body.loadUintBig(64);
        expect(body.loadCoins()).toEqual(2_500_000n);
        const poolWallet = await minter.getGetWalletAddress(pool.address);
        expect(await jettonBalance(blockchain, poolWallet)).toEqual(2_500_000n);
        expect(await pool.getBalanceOf(minter.address)).toEqual(2_500_000n);
    }, 30_000);

    it('decimals: TEP-64 default of 9, off-chain metadata needs JETTON_DECIMALS, no silent rounding', () => {
        expect(decimalsFromContent(buildOnchainContent({ name: 'no decimals key' }))).toEqual(9);
        expect(decimalsFromContent(buildOnchainContent({ decimals: '6' }))).toEqual(6);
        const offchain = beginCell().storeUint(1, 8).storeStringTail('https://example.org/jetton.json').endCell();
        expect(() => decimalsFromContent(offchain)).toThrow(/JETTON_DECIMALS/);
        expect(decimalsFromContent(offchain, '2')).toEqual(2);
        expect(parseJettonAmount('2.5', 6)).toEqual(2_500_000n);
        expect(parseJettonAmount('7', 0)).toEqual(7n);
        expect(() => parseJettonAmount('0.0000001', 6)).toThrow();
        expect(() => parseJettonAmount('-1', 6)).toThrow();
    });
});
