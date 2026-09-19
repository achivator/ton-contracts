// ---------------------------------------------------------------------------
// Test jetton (TEP-74) for testnet E2E runs.
//
// NOT for production: minimal implementation, no mintable flag, no burn, no
// admin controls beyond owner-only minting. It reuses the shared message
// structs from distributor_messages.tact so transfers to/from ChatPool are
// wire-compatible byte for byte.
// ---------------------------------------------------------------------------

import "@stdlib/deploy";
import "@stdlib/ownable";
import "./distributor_messages.tact";

// wallet -> wallet internal transfer (TEP-74 wire format)
message(0x178d4519) JettonTransferInternal {
    queryId: Int as uint64;
    amount: Int as coins;
    sender: Address;                     // owner of the sending wallet
    responseDestination: Address?;
    forwardTonAmount: Int as coins;
    forwardPayload: Slice as remaining;
}

message(0xd53276db) Excesses {
    queryId: Int as uint64;
}

message(0x4d494e54) Mint {               // "MINT"
    amount: Int as coins;
    recipient: Address;
}

contract TestJettonMinter with Deployable, Ownable {
    owner: Address;
    totalSupply: Int as coins = 0;
    content: Cell;

    init(owner: Address, content: Cell) {
        self.owner = owner;
        self.content = content;
    }

    fun walletInit(owner: Address): StateInit {
        return initOf TestJettonWallet(owner, myAddress());
    }

    receive(msg: Mint) {
        self.requireOwner();
        let init: StateInit = self.walletInit(msg.recipient);
        send(SendParameters{
            to: contractAddress(init),
            value: 0,
            mode: SendRemainingValue,
            bounce: false,
            body: JettonTransferInternal{
                queryId: 0,
                amount: msg.amount,
                sender: self.owner,
                responseDestination: msg.recipient,
                forwardTonAmount: 0,
                forwardPayload: emptySlice()
            }.toCell(),
            code: init.code,
            data: init.data
        });
        self.totalSupply = self.totalSupply + msg.amount;
    }

    // TEP-89: the jetton wallet address of an owner.
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

    // Incoming internal transfer: mint (from the master) or a regular wallet
    // transfer, which is only accepted from a sibling wallet of the same
    // master whose owner matches the advertised sender.
    receive(msg: JettonTransferInternal) {
        if (sender() != self.jettonMaster) {
            let expected: Address = contractAddress(initOf TestJettonWallet(msg.sender, self.jettonMaster));
            require(sender() == expected, "untrusted internal transfer");
        }
        self.balance = self.balance + msg.amount;

        if (msg.forwardTonAmount > 0) {
            // A deposit voucher + signature (513 bits) cannot ride inline in a
            // transfer body alongside two addresses, so it travels ref-wrapped
            // as [1 bit][ref payload]. Unwrap it here and deliver the canonical
            // form (ChatPool accepts both this and the verbatim ref-wrapped one).
            let fp: Slice = msg.forwardPayload;
            require(fp.loadUint(1) == 1, "expected a ref-wrapped forward payload");
            send(SendParameters{
                to: self.owner,
                value: msg.forwardTonAmount,
                mode: SendPayGasSeparately,
                bounce: true,
                body: JettonTransferNotification{
                    queryId: msg.queryId,
                    amount: msg.amount,
                    sender: msg.sender,
                    forwardPayload: fp.loadRef().beginParse()
                }.toCell()
            });
        }

        // Return leftover gas to the response destination. Explicit leftover +
        // SendIgnoreErrors mirrors the reference TEP-74 wallet: SendRemainingValue
        // (64) would re-demand the full inbound value after the notification send
        // and abort the whole action phase (rc 37, no messages sent).
        let excessTo: Address = self.owner;
        if (msg.responseDestination != null) {
            excessTo = msg.responseDestination!!;
        }
        let excess: Int = context().value - msg.forwardTonAmount - 20000000; // reserve for gas + storage
        if (excess > 0) {
            send(SendParameters{
                to: excessTo,
                value: excess,
                mode: SendIgnoreErrors,
                bounce: false,
                body: Excesses{queryId: msg.queryId}.toCell()
            });
        }
    }

    // Owner-initiated outgoing transfer.
    receive(msg: JettonTransfer) {
        require(sender() == self.owner, "only the owner can transfer");
        require(self.balance >= msg.amount, "insufficient jetton balance");
        self.balance = self.balance - msg.amount;

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
