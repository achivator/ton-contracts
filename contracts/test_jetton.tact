// ---------------------------------------------------------------------------
// Test jetton (TEP-74 + TEP-89) for testnet E2E runs. NOT for production.
//
// The wallet follows the reference TEP-74 wallet (ton-blockchain/token-contract
// ft/jetton-wallet.fc) message for message: same checks, same exit codes,
// same gas/reserve arithmetic, forward_payload forwarded verbatim, and the
// stricter forward_payload rule of the USDT wallet (stablecoin-contract). The
// point is that tests built on it fail the same way production wallets do;
// tests/JettonWalletParity.spec.ts runs both side by side to keep it so.
//
// Known, accepted differences from production jettons (informational):
//   - TJM-5: the code is public, so anyone can deploy an identical minter
//     with themselves as owner and mint without limit. Identify the test
//     jetton by its master address, never by its code hash.
//   - TJM-6: Mint sends no transfer_notification, so minting straight to a
//     contract (e.g. a ChatPool) credits its wallet without the contract
//     noticing. Fund contracts with a regular transfer instead.
//   - TJW-11: masterchain addresses are rejected wherever an address is
//     parsed (Tact exit 137); the reference wallet also forces basechain
//     destinations (exit 333).
//   - TJW-12: zero-amount transfers are allowed, as in the reference wallet.
// ---------------------------------------------------------------------------

import "@stdlib/deploy";
import "@stdlib/ownable";
import "./distributor_messages.tact";

// ---- Wallet constants, as in the reference wallet ----
const WalletMinTonsForStorage: Int = ton("0.01");
const WalletGasConsumption: Int = ton("0.015");

// ---- Minter constants ----
// Mint must pay for the minter, the deploy-carrying internal_transfer, the
// wallet's gas allowance and its storage reserve; the rest is refunded.
const MinMintValue: Int = ton("0.05");
// TEP-89 reply gas (stablecoin minter: provide_address_gas_consumption)
const ProvideAddressGasConsumption: Int = ton("0.01");

// ---- Exit codes ----
// wallet: the reference wallet's codes, so tests can compare one to one
const ErrNotOwner: Int = 705;
const ErrBalanceTooLow: Int = 706;
const ErrUntrustedSender: Int = 707;     // also "burn value too low", as in the reference
const ErrBadForwardPayload: Int = 708;
const ErrValueTooLow: Int = 709;
// minter
const ErrNotAWallet: Int = 74;           // burn_notification not from our wallet (reference minter)
const ErrProvideValueTooLow: Int = 75;   // TEP-89 (stablecoin minter)
const ErrMintValueTooLow: Int = 76;
const ErrMintingClosed: Int = 77;

// ---- TEP-74 messages (JettonTransfer, JettonTransferNotification and
// TonExcesses come from distributor_messages.tact) ----

// internal_transfer: wallet -> wallet, or minter -> wallet for a mint.
message(0x178d4519) JettonTransferInternal {
    queryId: Int as uint64;
    amount: Int as coins;
    sender: Address;                     // from: previous owner, or the minter for a mint
    responseDestination: Address?;
    forwardTonAmount: Int as coins;
    forwardPayload: Slice as remaining;  // Either Cell ^Cell, verbatim
}

message(0x595f07bc) JettonBurn {
    queryId: Int as uint64;
    amount: Int as coins;
    responseDestination: Address?;
    customPayload: Cell?;
}

message(0x7bdd97de) JettonBurnNotification {
    queryId: Int as uint64;
    amount: Int as coins;
    sender: Address;                     // owner of the burning wallet
    responseDestination: Address?;
}

// ---- TEP-89 ----
// provide_wallet_address query_id:uint64 owner_address:MsgAddress include_address:Bool
// The owner is parsed by hand: an owner the minter cannot resolve (e.g. a
// masterchain address) must be answered with addr_none, not an exception.
// Hence its own type: ProvideWalletAddress (distributor_messages.tact) has
// the same opcode and wire layout, but parses the owner strictly.
message(0x2c76b973) ProvideWalletAddressRaw {
    queryId: Int as uint64;
    ownerAndFlag: Slice as remaining;
}

// take_wallet_address (0xd1735400): TakeWalletAddress in
// distributor_messages.tact, the reply ChatPool registers its wallet from.

// ---- TestJettonMinter admin messages (not part of TEP-74) ----
message(0x4d494e54) Mint {               // "MINT"
    queryId: Int as uint64;
    amount: Int as coins;
    recipient: Address;
}

message(0x534d4e54) SetMintable {        // "SMNT"
    queryId: Int as uint64;
    mintable: Bool;
}

// TEP-74 getter results. Tact flattens a struct returned by a getter onto
// the stack, which is the layout wallets, explorers and the miniapp expect.
struct JettonData {
    totalSupply: Int;
    mintable: Bool;
    adminAddress: Address;
    content: Cell;
    walletCode: Cell;
}

struct JettonWalletData {
    balance: Int;
    owner: Address;
    master: Address;
    walletCode: Cell;
}

@name(load_msg_addr)
extends mutates native loadMsgAddr(self: Slice): Slice;

// USDT wallet rule (check_either_forward_payload): there must be an Either
// bit; if it says "in a ref", the bit and exactly one ref are all there is.
fun checkEitherForwardPayload(payload: Slice) {
    nativeThrowUnless(ErrBadForwardPayload, payload.bits() >= 1);
    if (payload.preloadUint(1) == 1) {
        nativeThrowUnless(ErrBadForwardPayload, payload.bits() == 1);
        nativeThrowUnless(ErrBadForwardPayload, payload.refs() == 1);
    }
}

// content: TEP-64 metadata cell (see wrappers/TestJetton.ts onchainJettonContent).
contract TestJettonMinter with Deployable, OwnableTransferable {
    owner: Address;
    totalSupply: Int as coins = 0;
    mintable: Bool = true;
    content: Cell;

    init(owner: Address, content: Cell) {
        self.owner = owner;
        self.content = content;
    }

    fun walletInit(owner: Address): StateInit {
        return initOf TestJettonWallet(owner, myAddress());
    }

    // Owner-only mint. Bounceable: if the wallet cannot take the tokens the
    // bounce rolls the supply back. The excess goes back to whoever paid.
    receive(msg: Mint) {
        self.requireOwner();
        nativeThrowUnless(ErrMintingClosed, self.mintable);
        let ctx: Context = context();
        nativeThrowUnless(ErrMintValueTooLow, ctx.value >= MinMintValue);
        self.totalSupply = self.totalSupply + msg.amount; // coins overflow aborts the whole mint
        let init: StateInit = self.walletInit(msg.recipient);
        send(SendParameters{
            to: contractAddress(init),
            value: 0,
            mode: SendRemainingValue,
            bounce: true,
            body: JettonTransferInternal{
                queryId: msg.queryId,
                amount: msg.amount,
                sender: myAddress(),
                responseDestination: ctx.sender,
                forwardTonAmount: 0,
                forwardPayload: beginCell().storeUint(0, 1).asSlice() // Either left, empty
            }.toCell(),
            code: init.code,
            data: init.data
        });
    }

    bounced(msg: bounced<JettonTransferInternal>) {
        self.totalSupply = self.totalSupply - msg.amount;
    }

    receive(msg: SetMintable) {
        self.requireOwner();
        self.mintable = msg.mintable;
        self.reply(TonExcesses{queryId: msg.queryId}.toCell());
    }

    // A wallet burnt tokens: only our own wallets can lower the supply.
    receive(msg: JettonBurnNotification) {
        nativeThrowUnless(ErrNotAWallet, sender() == contractAddress(self.walletInit(msg.sender)));
        self.totalSupply = self.totalSupply - msg.amount;
        if (msg.responseDestination != null) {
            send(SendParameters{
                to: msg.responseDestination!!,
                value: 0,
                mode: SendRemainingValue + SendIgnoreErrors,
                bounce: false,
                body: TonExcesses{queryId: msg.queryId}.toCell()
            });
        }
    }

    // TEP-89 wallet discovery.
    receive(msg: ProvideWalletAddressRaw) {
        let ctx: Context = context();
        nativeThrowUnless(ErrProvideValueTooLow, ctx.value > ctx.readForwardFee() + ProvideAddressGasConsumption);
        let s: Slice = msg.ownerAndFlag;
        let owner: Slice = s.loadMsgAddr();
        let includeAddress: Bool = s.loadUint(1) == 1;
        let wallet: Address? = null;
        // resolvable: addr_std, no anycast, basechain (11-bit prefix 0b100_00000000)
        if (owner.bits() == 267) {
            if (owner.preloadUint(11) == 1024) {
                let parsed: Slice = owner;
                wallet = contractAddress(self.walletInit(parsed.loadAddress()));
            }
        }
        let included: Cell? = null;
        if (includeAddress) {
            included = beginCell().storeSlice(owner).endCell();
        }
        send(SendParameters{
            to: ctx.sender,
            value: 0,
            mode: SendRemainingValue,
            bounce: true,
            body: TakeWalletAddress{queryId: msg.queryId, walletAddress: wallet, ownerAddress: included}.toCell()
        });
    }

    get fun get_jetton_data(): JettonData {
        return JettonData{
            totalSupply: self.totalSupply,
            mintable: self.mintable,
            adminAddress: self.owner,
            content: self.content,
            walletCode: self.walletInit(myAddress()).code
        };
    }

    get fun get_wallet_address(owner: Address): Address {
        return contractAddress(self.walletInit(owner));
    }

    get fun mintedTotal(): Int {
        return self.totalSupply;
    }
}

contract TestJettonWallet {
    balance: Int as coins = 0;
    owner: Address;
    jettonMaster: Address;

    init(owner: Address, jettonMaster: Address) {
        self.owner = owner;
        self.jettonMaster = jettonMaster;
    }

    // Plain TON top-ups are accepted (the reference wallet ignores empty bodies).
    receive() {}

    // Owner-initiated outgoing transfer (reference send_tokens).
    receive(msg: JettonTransfer) {
        let ctx: Context = context();
        nativeThrowUnless(ErrNotOwner, ctx.sender == self.owner);
        self.balance = self.balance - msg.amount;
        nativeThrowUnless(ErrBalanceTooLow, self.balance >= 0);
        checkEitherForwardPayload(msg.forwardPayload);

        // The attached value must carry the forward amount and pay for this
        // hop, the receiving wallet's gas and reserve, and the notification;
        // otherwise the receiver would spend its own TON (TJW-2, TJW-3).
        let fwdCount: Int = 1;
        if (msg.forwardTonAmount > 0) {
            fwdCount = 2;
        }
        nativeThrowUnless(ErrValueTooLow, ctx.value > msg.forwardTonAmount
            + fwdCount * ctx.readForwardFee()
            + 2 * WalletGasConsumption + WalletMinTonsForStorage);

        let destInit: StateInit = initOf TestJettonWallet(msg.destination, self.jettonMaster);
        send(SendParameters{
            to: contractAddress(destInit),
            value: 0,
            mode: SendRemainingValue,
            bounce: true,
            body: JettonTransferInternal{
                queryId: msg.queryId,
                amount: msg.amount,
                sender: self.owner,
                responseDestination: msg.responseDestination,
                forwardTonAmount: msg.forwardTonAmount,
                forwardPayload: msg.forwardPayload
            }.toCell(),
            code: destInit.code,
            data: destInit.data
        });
    }

    // Incoming transfer (reference receive_tokens): a mint from the master,
    // or a transfer from a sibling wallet whose owner is the advertised sender.
    receive(msg: JettonTransferInternal) {
        let ctx: Context = context();
        if (ctx.sender != self.jettonMaster) {
            let sibling: StateInit = initOf TestJettonWallet(msg.sender, self.jettonMaster);
            nativeThrowUnless(ErrUntrustedSender, ctx.sender == contractAddress(sibling));
        }
        self.balance = self.balance + msg.amount; // coins overflow aborts and bounces

        // Keep at least WalletMinTonsForStorage on the wallet and a fixed gas
        // allowance; everything else the message brought goes on (TJW-10).
        let tonBalanceBeforeMsg: Int = myBalance() - ctx.value;
        let storageFee: Int = WalletMinTonsForStorage - min(tonBalanceBeforeMsg, WalletMinTonsForStorage);
        let msgValue: Int = ctx.value - (storageFee + WalletGasConsumption);

        if (msg.forwardTonAmount > 0) {
            msgValue = msgValue - (msg.forwardTonAmount + ctx.readForwardFee());
            // Non-bounceable (the owner may be an uninitialized account), with
            // the forward_payload exactly as the sender wrote it (TJW-5, 8, 9).
            send(SendParameters{
                to: self.owner,
                value: msg.forwardTonAmount,
                mode: SendPayGasSeparately,
                bounce: false,
                body: JettonTransferNotification{
                    queryId: msg.queryId,
                    amount: msg.amount,
                    sender: msg.sender,
                    forwardPayload: msg.forwardPayload
                }.toCell()
            });
        }

        // No response destination: the excess stays here (TJW-8).
        if (msg.responseDestination != null) {
            if (msgValue > 0) {
                send(SendParameters{
                    to: msg.responseDestination!!,
                    value: msgValue,
                    mode: SendIgnoreErrors,
                    bounce: false,
                    body: TonExcesses{queryId: msg.queryId}.toCell()
                });
            }
        }
    }

    // Owner-initiated burn (reference burn_tokens).
    receive(msg: JettonBurn) {
        let ctx: Context = context();
        nativeThrowUnless(ErrNotOwner, ctx.sender == self.owner);
        self.balance = self.balance - msg.amount;
        nativeThrowUnless(ErrBalanceTooLow, self.balance >= 0);
        nativeThrowUnless(ErrUntrustedSender, ctx.value > ctx.readForwardFee() + 2 * WalletGasConsumption);
        send(SendParameters{
            to: self.jettonMaster,
            value: 0,
            mode: SendRemainingValue,
            bounce: true,
            body: JettonBurnNotification{
                queryId: msg.queryId,
                amount: msg.amount,
                sender: self.owner,
                responseDestination: msg.responseDestination
            }.toCell()
        });
    }

    // A transfer or burn that did not go through gives the tokens back (TJW-1).
    bounced(msg: bounced<JettonTransferInternal>) {
        self.balance = self.balance + msg.amount;
    }

    bounced(msg: bounced<JettonBurnNotification>) {
        self.balance = self.balance + msg.amount;
    }

    get fun get_wallet_data(): JettonWalletData {
        return JettonWalletData{
            balance: self.balance,
            owner: self.owner,
            master: self.jettonMaster,
            walletCode: initOf TestJettonWallet(self.owner, self.jettonMaster).code
        };
    }

    // Convenience getters kept for existing scripts and tests.
    get fun walletBalance(): Int {
        return self.balance;
    }

    get fun walletOwner(): Address {
        return self.owner;
    }

    get fun masterAddress(): Address {
        return self.jettonMaster;
    }
}
