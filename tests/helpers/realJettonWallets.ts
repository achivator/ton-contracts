import { Blockchain, SandboxContract, SendMessageResult, TreasuryContract } from '@ton/sandbox';
import { Address, beginCell, Cell, contractAddress, StateInit, toNano } from '@ton/core';

// Code of production jetton wallets, for tests that must not rely on the
// lenient TestJettonWallet (contracts/test_jetton.tact).
//
// Provenance: compiled with @ton-community/func-js (0.11) from the `main`
// branches as of 2026-10 of
//   REF:  github.com/ton-blockchain/token-contract       ft/jetton-wallet.fc
//         (reference TEP-74 wallet; rejects a bad forward_payload with 708)
//   USDT: github.com/ton-blockchain/stablecoin-contract contracts/jetton-wallet.fc
//         (USDT wallet; rejects a bad forward_payload with 9)
// The strings are the code BOCs, base64, copied verbatim.
const REF_WALLET_B64 =
    'te6ccgECEgEAAzQAART/APSkE/S88sgLAQIBYgIDAgLMBAUAG6D2BdqJofQB9IH0gahhAgHUBgcCAUgICQDDCDHAJJfBOAB0NMDAXGwlRNfA/AL4PpA+kAx+gAxcdch+gAx+gAwc6m0AALTH4IQD4p+pVIgupUxNFnwCOCCEBeNRRlSILqWMUREA/AJ4DWCEFlfB7y6k1nwCuBfBIQP8vCAAET6RDBwuvLhTYAIBIAoLAgEgEBEB8QD0z/6APpAIfAB7UTQ+gD6QPpA1DBRNqFSKscF8uLBKML/8uLCVDRCcFQgE1QUA8hQBPoCWM8WAc8WzMkiyMsBEvQA9ADLAMkg+QBwdMjLAsoHy//J0AT6QPQEMfoAINdJwgDy4sR3gBjIywVQCM8WcPoCF8trE8yAMA/c7UTQ+gD6QPpA1DAI0z/6AFFRoAX6QPpAU1vHBVRzbXBUIBNUFAPIUAT6AljPFgHPFszJIsjLARL0APQAywDJ+QBwdMjLAsoHy//J0FANxwUcsfLiwwr6AFGooYIImJaAggiYloAStgihggjk4cCgGKEn4w8l1wsBwwAjgDQ4PAK6CEBeNRRnIyx8Zyz9QB/oCIs8WUAbPFiX6AlADzxbJUAXMI5FykXHiUAioE6CCCOThwKoAggiYloCgoBS88uLFBMmAQPsAECPIUAT6AljPFgHPFszJ7VQAcFJ5oBihghBzYtCcyMsfUjDLP1j6AlAHzxZQB88WyXGAEMjLBSTPFlAG+gIVy2oUzMlx+wAQJBAjAA4QSRA4N18EAHbCALCOIYIQ1TJ223CAEMjLBVAIzxZQBPoCFstqEssfEss/yXL7AJM1bCHiA8hQBPoCWM8WAc8WzMntVADbO1E0PoA+kD6QNQwB9M/+gD6QDBRUaFSSccF8uLBJ8L/8uLCggjk4cCqABagFrzy4sOCEHvdl97Iyx8Vyz9QA/oCIs8WAc8WyXGAGMjLBSTPFnD6AstqzMmAQPsAQBPIUAT6AljPFgHPFszJ7VSAAgyAINch7UTQ+gD6QPpA1DAE0x+CEBeNRRlSILqCEHvdl94TuhKx8uLF0z8x+gAwE6BQI8hQBPoCWM8WAc8WzMntVIA==';
const USDT_WALLET_B64 =
    'te6ccgECDwEAA9EAART/APSkE/S88sgLAQIBYgIDAvjQAdDTAwFxsI5IE18DgCDXIe1E0NMD+gD6QPpA0QTTHwGEDyGCEBeNRRm6AoIQe92X3roSsfL0gEDXIfoAMBKgQBMDyMsDWPoCAc8WAc8Wye1U4PpA+kAx+gAx9AH6ADH6AAExcPg6AtMfASCCEA+KfqW6joUwNFnbPOAzBAUCASANDgHyA9M/AQH6APpAIfpEMMAA8uFN7UTQ0wP6APpA+kDRUwnHBSRxsMAAIbHyrVIrxwVQCrHy4ElRFaEgwv/yr/gqVCWQcFRgBBMVA8jLA1j6AgHPFgHPFskhyMsBE/QAEvQAywDJIPkAcHTIywLKB8v/ydAE+kD0AfoAIAYC0CKCEBeNRRm6joQyWts84DQhghBZXwe8uo6EMQHbPOAyIIIQ7tI207qOLzABgEDXIdMD0e1E0NMD+gD6QPpA0TNRQscF8uBKQDMDyMsDWPoCAc8WAc8Wye1U4GwhghDTchWMutyED/LwCAkBmCDXCwCa10vAAQHAAbDysZEw4siCEBeNRRkByx9QCgHLP1AI+gIjzxYBzxYm+gJQB88WyciAGAHLBVAEzxZw+gJAY3dQA8trzMzJRTcHALQhkXKRceL4OSBuk4EkJ5Eg4iFulDGBKHORAeJQI6gToHOBA6Nw+DygAnD4NhKgAXD4NqBzgQQJghAJZgGAcPg3oLzysASAUPsAWAPIywNY+gIBzxYBzxbJ7VQD9O1E0NMD+gD6QPpA0SNysMAC8m0H0z8BAfoAUUGgBPpA+kBTuscF+CpUZOBwVGAEExUDyMsDWPoCAc8WAc8WySHIywET9AAS9ADLAMn5AHB0yMsCygfL/8nQUAzHBRux8uBKCfoAIZJfBOMNJtcLAcAAs5MwbDPjDVUCCgsMAfLtRNDTA/oA+kD6QNEG0z8BAfoA+kD0AdFRQaFSiMcF8uBJJsL/8q/IghB73ZfeAcsfWAHLPwH6AiHPFljPFsnIgBgBywUmzxZw+gIBcVjLaszJA/g5IG6UMIEWn95xgQLycPg4AXD4NqCBGndw+DagvPKwAoBQ+wADDABgyIIQc2LQnAHLHyUByz9QBPoCWM8WWM8WyciAEAHLBSTPFlj6AgFxWMtqzMmAEfsAAHpQVKH4L6BzgQQJghAJZgGAcPg3tgly+wLIgBABywVQBc8WcPoCcAHLaoIQ1TJ22wHLH1gByz/JgQCC+wBZACADyMsDWPoCAc8WAc8Wye1UACe/2BdqJoaYH9AH0gfSBomfwVIJhAAhvFCPaiaGmB/QB9IH0gaK+Bw=';

export const REF_JETTON_WALLET_CODE = Cell.fromBase64(REF_WALLET_B64);
export const USDT_JETTON_WALLET_CODE = Cell.fromBase64(USDT_WALLET_B64);

export interface RealJettonWallet {
    name: string;
    code: Cell;
    // Initial data of `owner`'s wallet, exactly as the wallet itself computes
    // a sibling's StateInit, so contractAddress() matches the real address.
    data(owner: Address, jettonMaster: Address): Cell;
    // exit code the wallet throws on a JettonTransfer without the Either bit
    badPayloadExitCode: number;
}

export const REF_JETTON_WALLET: RealJettonWallet = {
    name: 'reference TEP-74 wallet (token-contract)',
    code: REF_JETTON_WALLET_CODE,
    // balance:Coins owner:MsgAddress master:MsgAddress wallet_code:^Cell
    data: (owner, jettonMaster) =>
        beginCell()
            .storeCoins(0)
            .storeAddress(owner)
            .storeAddress(jettonMaster)
            .storeRef(REF_JETTON_WALLET_CODE)
            .endCell(),
    badPayloadExitCode: 708,
};

export const USDT_JETTON_WALLET: RealJettonWallet = {
    name: 'USDT wallet (stablecoin-contract)',
    code: USDT_JETTON_WALLET_CODE,
    // status:uint4 balance:Coins owner:MsgAddress master:MsgAddress
    data: (owner, jettonMaster) =>
        beginCell().storeUint(0, 4).storeCoins(0).storeAddress(owner).storeAddress(jettonMaster).endCell(),
    badPayloadExitCode: 9,
};

export const REAL_JETTON_WALLETS: RealJettonWallet[] = [REF_JETTON_WALLET, USDT_JETTON_WALLET];

export function realWalletInit(wallet: RealJettonWallet, owner: Address, jettonMaster: Address): StateInit {
    return { code: wallet.code, data: wallet.data(owner, jettonMaster) };
}

export function realWalletAddress(wallet: RealJettonWallet, owner: Address, jettonMaster: Address): Address {
    return contractAddress(0, realWalletInit(wallet, owner, jettonMaster));
}

// Jetton balance from get_wallet_data; 0 for a wallet that is not deployed.
export async function realWalletBalance(blockchain: Blockchain, wallet: Address): Promise<bigint> {
    const state = await blockchain.getContract(wallet);
    if (state.accountState?.type !== 'active') return 0n;
    return (await blockchain.runGetMethod(wallet, 'get_wallet_data')).stackReader.readBigNumber();
}

// Deploys (if needed) and credits `owner`'s real wallet: `jettonMaster` plays
// the minter and sends the TEP-74 internal_transfer the wallets accept from
// their master. The wallets never call back into the master, so a plain
// treasury is enough.
export async function mintToRealWallet(args: {
    wallet: RealJettonWallet;
    jettonMaster: SandboxContract<TreasuryContract>;
    owner: Address;
    amount: bigint;
    value?: bigint;
}): Promise<SendMessageResult> {
    const init = realWalletInit(args.wallet, args.owner, args.jettonMaster.address);
    const body = beginCell()
        .storeUint(0x178d4519, 32) // internal_transfer
        .storeUint(0, 64) // query_id
        .storeCoins(args.amount)
        .storeAddress(args.jettonMaster.address) // from
        .storeUint(0, 2) // response_destination: addr_none
        .storeCoins(0) // forward_ton_amount
        .storeUint(0, 1) // forward_payload: Either left, empty
        .endCell();
    return args.jettonMaster.send({
        to: contractAddress(0, init),
        value: args.value ?? toNano('0.1'),
        init,
        body,
        bounce: false,
    });
}
