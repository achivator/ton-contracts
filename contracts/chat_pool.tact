import "@stdlib/deploy";
import "./distributor_messages.tact";

// Reserved so the pool always keeps enough TON for storage rent.
const PoolMinTonForStorage: Int = ton("0.03");
// Hard cap on the per-deposit TON fee. Protects chat admins from a rogue
// backend signing an inflated fee: the contract enforces the ceiling on-chain.
const MaxDepositFee: Int = ton("5");

contract ChatPool with Deployable {
    master: Address;
    chatId: Int as int64;
    backendPubKey: Int as uint256;

    admin: Address?;                       // set on the first deposit (the depositor)
    tier: Int as uint16 = 0;
    balances: map<Address, Int>;           // jettonMaster -> credited amount (ledger)
    jettonWallets: map<Address, Address>;  // jettonMaster -> this pool's jetton wallet
    usedNonces: map<Int, Bool>;            // claim replay protection

    init(master: Address, chatId: Int, backendPubKey: Int) {
        self.master = master;
        self.chatId = chatId;
        self.backendPubKey = backendPubKey;
    }

    // ---- Deposit: jettons land on the pool's jetton wallet ----
    // Accepted forwardPayload shapes:
    //   1) unwrapped: ref(DepositVoucher cell) ++ 512-bit signature
    //   2) verbatim TEP-74 ref payload: 1 bit flag ++ ref(shape 1)
    // Stock jetton wallets forward the transfer's forward_payload as-is
    // (shape 2); cooperating wallets may deliver shape 1. The two are
    // unambiguous: a valid shape 1 always carries 512 bits of signature.
    receive(msg: JettonTransferNotification) {
        let fp: Slice = msg.forwardPayload;
        if (fp.bits() == 1 && fp.refs() == 1) {
            fp = fp.loadRef().beginParse();
        }
        let voucherCell: Cell = fp.loadRef();
        let signature: Slice = fp.loadBits(512);
        require(checkSignature(voucherCell.hash(), signature, self.backendPubKey),
            "bad deposit voucher signature");

        let vs: Slice = voucherCell.beginParse();
        let vChatId: Int = vs.loadInt(64);
        let vJettonMaster: Address = vs.loadAddress();
        let vExpectedWallet: Address = vs.loadAddress();
        let vTier: Int = vs.loadUint(16);
        let vFeeTon: Int = vs.loadCoins();
        let vExpiry: Int = vs.loadUint(64);

        require(vChatId == self.chatId, "voucher for another chat");
        require(now() < vExpiry, "voucher expired");
        require(vFeeTon <= MaxDepositFee, "fee above cap");
        // The critical source check: the jettons really arrived from the
        // pool's own jetton wallet, not a forged notification.
        require(sender() == vExpectedWallet, "untrusted jetton wallet");

        if (self.admin == null) {
            self.admin = msg.sender;       // the depositor becomes the chat admin
        }
        self.tier = vTier;
        self.jettonWallets.set(vJettonMaster, vExpectedWallet);

        let prev: Int = 0;
        let existing: Int? = self.balances.get(vJettonMaster);
        if (existing != null) {
            prev = existing!!;
        }
        self.balances.set(vJettonMaster, prev + msg.amount);

        // Forward the flat TON fee to the master.
        if (vFeeTon > 0) {
            send(SendParameters{
                to: self.master,
                value: vFeeTon,
                mode: SendPayGasSeparately,
                bounce: false,
                body: CollectFee{chatId: self.chatId}.toCell()
            });
        }
    }

    // ---- Claim: backend-signed voucher, recipient pays the gas ----
    receive(msg: Claim) {
        require(checkSignature(msg.voucherCell.hash(), msg.signature, self.backendPubKey),
            "bad claim voucher signature");

        let cs: Slice = msg.voucherCell.beginParse();
        let vChatId: Int = cs.loadInt(64);
        let vRecipient: Address = cs.loadAddress();
        let vJettonMaster: Address = cs.loadAddress();
        let vAmount: Int = cs.loadCoins();
        let vNonce: Int = cs.loadUint(64);
        let vExpiry: Int = cs.loadUint(64);

        require(vChatId == self.chatId, "voucher for another chat");
        require(now() < vExpiry, "voucher expired");
        require(self.usedNonces.get(vNonce) == null, "voucher already used");

        let bal: Int? = self.balances.get(vJettonMaster);
        require(bal != null && bal!! >= vAmount, "insufficient pool balance");
        let wallet: Address? = self.jettonWallets.get(vJettonMaster);
        require(wallet != null, "jetton not registered");

        self.balances.set(vJettonMaster, bal!! - vAmount);
        self.usedNonces.set(vNonce, true);

        send(SendParameters{
            to: wallet!!,
            value: 0,
            mode: SendRemainingValue,
            bounce: true,
            body: JettonTransfer{
                queryId: 0,
                amount: vAmount,
                destination: vRecipient,
                responseDestination: vRecipient,
                customPayload: null,
                forwardTonAmount: 0,
                forwardPayload: emptySlice()
            }.toCell()
        });
    }

    // ---- Withdraw: admin only, no backend; the jetton wallet is the source
    // of truth for the amount actually moved, so the ledger is best-effort. ----
    receive(msg: WithdrawRemainder) {
        require(self.admin != null && sender() == self.admin!!, "only chat admin");
        let wallet: Address? = self.jettonWallets.get(msg.jettonMaster);
        require(wallet != null, "jetton not registered");

        let bal: Int? = self.balances.get(msg.jettonMaster);
        if (bal != null) {
            let remaining: Int = bal!! - msg.amount;
            if (remaining < 0) {
                remaining = 0;
            }
            self.balances.set(msg.jettonMaster, remaining);
        }

        send(SendParameters{
            to: wallet!!,
            value: 0,
            mode: SendRemainingValue,
            bounce: true,
            body: JettonTransfer{
                queryId: 0,
                amount: msg.amount,
                destination: msg.to,
                responseDestination: msg.to,
                customPayload: null,
                forwardTonAmount: 0,
                forwardPayload: emptySlice()
            }.toCell()
        });
    }

    // ---- Getters ----
    get fun balanceOf(jettonMaster: Address): Int {
        let b: Int? = self.balances.get(jettonMaster);
        if (b == null) {
            return 0;
        }
        return b!!;
    }

    get fun jettonWallet(jettonMaster: Address): Address? {
        return self.jettonWallets.get(jettonMaster);
    }

    get fun poolAdmin(): Address? {
        return self.admin;
    }

    get fun currentTier(): Int {
        return self.tier;
    }

    get fun isNonceUsed(nonce: Int): Bool {
        return self.usedNonces.get(nonce) != null;
    }

    get fun poolChatId(): Int {
        return self.chatId;
    }
}
