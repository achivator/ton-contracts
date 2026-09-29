import "@stdlib/deploy";
import "./distributor_messages.tact";

// Minimum TON the caller must attach so the outbound jetton transfer cannot
// run out of gas in the jetton wallet (which would bounce the transfer).
const PoolMinClaimValue: Int = ton("0.05");
const PoolMinWithdrawValue: Int = ton("0.05");
// Kept from every claim: pays the storage rent of the claim's nonce entry
// (~0.0003 TON/year each), so a busy pool never rents itself into freezing.
const PoolClaimStorageFee: Int = ton("0.002");
// Default daily claim budget per jetton, as a share of the balance at the
// first claim of the day. Caps what a leaked backend key can drain per day.
const DefaultDailyClaimPercent: Int = 10;
const ClaimDay: Int = 86400;
// Gas of the deposit notification. Must be covered by the depositor's
// forward_ton_amount, never by the pool; whatever is left goes back.
const PoolDepositGas: Int = ton("0.02");
// raw_reserve mode: reserve at most the amount (never fail on a low balance)
const PoolReserveAtMost: Int = 2;

// queryId of outbound JettonTransfers tells the bounce handler what to undo.
// Claims use the voucher nonce, which is therefore limited to (0, 2^63).
const QueryClaimNonceLimit: Int = 0x8000000000000000;
const QueryWithdrawTracked: Int = 0x8000000000000001;   // fully covered by the ledger
const QueryWithdrawUntracked: Int = 0x8000000000000002; // exceeded the ledger
const QueryRefund: Int = 0x8000000000000003;            // returned a rejected deposit

contract ChatPool with Deployable {
    master: Address;
    chatId: Int as int64;
    backendPubKey: Int as uint256;

    admin: Address?;                       // set via backend-signed SetAdmin (init/rotation)
    balances: map<Address, Int>;           // jettonMaster -> credited amount (ledger)
    jettonWallets: map<Address, Address>;  // jettonMaster -> this pool's jetton wallet
    walletMasters: map<Address, Address>;  // reverse of jettonWallets, for bounces
    usedNonces: map<Int, Bool>;            // claim replay protection

    // Safety controls (admin-only), see SetClaimsPaused / SetClaimLimit.
    claimsPaused: Bool = false;
    claimLimits: map<Address, Int>;        // jettonMaster -> explicit daily budget
    claimDay: Int as uint32 = 0;           // UTC day the two maps below belong to
    dayBudgets: map<Address, Int>;         // budget fixed at the day's first claim
    daySpent: map<Address, Int>;           // claimed so far that day

    init(master: Address, chatId: Int, backendPubKey: Int) {
        self.master = master;
        self.chatId = chatId;
        self.backendPubKey = backendPubKey;
    }

    // Plain TON: the master's deploy message and storage top-ups.
    receive() {}

    // ---- Deposit: jettons land on the pool's jetton wallet ----
    // Accepted forwardPayload shapes:
    //   1) unwrapped: ref(DepositVoucher cell) ++ 512-bit signature
    //   2) verbatim TEP-74 ref payload: 1 bit flag ++ ref(shape 1)
    // Stock jetton wallets forward the transfer's forward_payload as-is
    // (shape 2); cooperating wallets may deliver shape 1. The two are
    // unambiguous: a valid shape 1 always carries 512 bits of signature.
    //
    // A deposit that fails validation is refunded instead of thrown: a
    // thrown notification would leave the jettons on the pool's wallet with
    // no ledger entry and no way back to the depositor. Refunding is safe
    // even for a forged notification, because the transfer request goes to
    // the notifying contract itself, which can only move its own jettons.
    receive(msg: JettonTransferNotification) {
        let ctx: Context = context();
        let fp: Slice = msg.forwardPayload;
        if (fp.bits() == 1 && fp.refs() == 1) {
            fp = fp.loadRef().beginParse();
        }
        if (fp.refs() < 1 || fp.bits() < 512) {
            self.refundDeposit(msg);
            return;
        }
        let voucherCell: Cell = fp.loadRef();
        let signature: Slice = fp.loadBits(512);
        if (!checkSignature(signedVoucherHash(VoucherTagDeposit, myAddress(), voucherCell), signature, self.backendPubKey)) {
            self.refundDeposit(msg);
            return;
        }

        // Signed by the backend, so the layout is trusted from here on.
        let vs: Slice = voucherCell.beginParse();
        let vChatId: Int = vs.loadInt(64);
        let vJettonMaster: Address = vs.loadAddress();
        let vExpectedWallet: Address = vs.loadAddress();
        let vExpiry: Int = vs.loadUint(64);
        vs.endParse();

        // The critical source check: the jettons really arrived from the
        // pool's own jetton wallet, not a forged notification. A master can
        // never be re-pointed to another wallet once registered.
        let knownWallet: Address? = self.jettonWallets.get(vJettonMaster);
        let walletMismatch: Bool = false;
        if (knownWallet != null) {
            walletMismatch = knownWallet!! != vExpectedWallet;
        }
        if (vChatId != self.chatId
            // No funds before an admin exists: an adminless pool is the one
            // a leaked backend key could take over (SetAdmin init).
            || self.admin == null
            || now() >= vExpiry
            || ctx.sender != vExpectedWallet
            || walletMismatch
            // This handler's gas comes out of the depositor's
            // forward_ton_amount, never out of the pool balance.
            || ctx.value < PoolDepositGas) {
            self.refundDeposit(msg);
            return;
        }

        self.jettonWallets.set(vJettonMaster, vExpectedWallet);
        self.walletMasters.set(vExpectedWallet, vJettonMaster);
        self.balances.set(vJettonMaster, self.balanceOrZero(vJettonMaster) + msg.amount);

        // No fee: the forwarded TON beyond the gas goes back to the depositor.
        self.refundExcess(ctx, msg.sender, msg.queryId);
    }

    // ---- SetAdmin: backend-signed voucher; init and rotation share the path.
    // Init (slot empty): the wallet named in the voucher must claim itself, so
    // a leaked voucher cannot hand a squatter someone else's slot.
    // Rotation (slot taken): only the current admin may hand over, so a leaked
    // backend key can never hijack an established pool. ----
    receive(msg: SetAdmin) {
        require(checkSignature(signedVoucherHash(VoucherTagAdmin, myAddress(), msg.voucherCell), msg.signature, self.backendPubKey),
            "bad admin voucher signature");

        let vs: Slice = msg.voucherCell.beginParse();
        let vChatId: Int = vs.loadInt(64);
        let vMaster: Address = vs.loadAddress();
        let vAdmin: Address = vs.loadAddress();
        let vExpiry: Int = vs.loadUint(64);
        vs.endParse();

        require(vChatId == self.chatId, "voucher for another chat");
        require(vMaster == self.master, "voucher for another master");
        require(now() < vExpiry, "voucher expired");

        let cur: Address? = self.admin;
        if (cur == null) {
            require(sender() == vAdmin, "only the named admin may init");
        } else {
            require(sender() == cur!!, "only the current admin may rotate");
        }
        self.admin = vAdmin;
        self.refundExcess(context(), sender(), 0);
    }

    // ---- Claim: backend-signed voucher, recipient pays the gas ----
    receive(msg: Claim) {
        require(checkSignature(signedVoucherHash(VoucherTagClaim, myAddress(), msg.voucherCell), msg.signature, self.backendPubKey),
            "bad claim voucher signature");

        let cs: Slice = msg.voucherCell.beginParse();
        let vChatId: Int = cs.loadInt(64);
        let vRecipient: Address = cs.loadAddress();
        let vJettonMaster: Address = cs.loadAddress();
        let vAmount: Int = cs.loadCoins();
        let vNonce: Int = cs.loadUint(64);
        let vExpiry: Int = cs.loadUint(64);
        cs.endParse();

        require(vChatId == self.chatId, "voucher for another chat");
        require(now() < vExpiry, "voucher expired");
        require(vNonce > 0 && vNonce < QueryClaimNonceLimit, "nonce out of range");
        require(vAmount > 0, "zero claim");
        require(self.usedNonces.get(vNonce) == null, "voucher already used");
        require(!self.claimsPaused, "claims are paused by the chat admin");
        let ctx: Context = context();
        require(ctx.value >= PoolMinClaimValue + PoolClaimStorageFee, "attach more TON for gas");

        let bal: Int = self.balanceOrZero(vJettonMaster);
        require(bal >= vAmount, "insufficient pool balance");
        let wallet: Address? = self.jettonWallets.get(vJettonMaster);
        require(wallet != null, "jetton not registered");

        self.rollClaimDay();
        let budget: Int = self.dayBudgetFor(vJettonMaster, bal);
        self.dayBudgets.set(vJettonMaster, budget);
        let spent: Int = self.mapOrZero(self.daySpent, vJettonMaster);
        require(spent + vAmount <= budget, "daily claim limit reached");
        self.daySpent.set(vJettonMaster, spent + vAmount);

        self.balances.set(vJettonMaster, bal - vAmount);
        self.usedNonces.set(vNonce, true);

        // Keep the storage rent, forward the rest of the claimer's TON.
        nativeReserve(myBalance() - ctx.value + PoolClaimStorageFee, 0);
        self.sendJettons(wallet!!, vNonce, vAmount, vRecipient, SendRemainingBalance);
    }

    // ---- Safety controls: admin only ----
    receive(msg: SetClaimsPaused) {
        self.requireAdmin();
        self.claimsPaused = msg.paused;
        self.returnValue();
    }

    receive(msg: SetClaimLimit) {
        self.requireAdmin();
        if (msg.dailyLimit == 0) {
            self.claimLimits.set(msg.jettonMaster, null);
        } else {
            self.claimLimits.set(msg.jettonMaster, msg.dailyLimit);
        }
        // takes effect now: today's budget is recomputed on the next claim
        self.dayBudgets.set(msg.jettonMaster, null);
        self.returnValue();
    }

    // Moves the pool to a new backend key (e.g. after a leak). Vouchers
    // signed by the old key stop working immediately.
    receive(msg: SetPoolBackendKey) {
        self.requireAdmin();
        self.backendPubKey = msg.backendPubKey;
        self.returnValue();
    }

    // ---- Withdraw: admin only, no backend; the jetton wallet is the source
    // of truth for the amount actually moved, so the ledger is best-effort
    // (the admin may also sweep jettons that arrived outside the ledger). ----
    receive(msg: WithdrawRemainder) {
        self.requireAdmin();
        require(msg.amount > 0, "zero withdrawal");
        require(context().value >= PoolMinWithdrawValue, "attach more TON for gas");
        let wallet: Address? = self.jettonWallets.get(msg.jettonMaster);
        require(wallet != null, "jetton not registered");

        let bal: Int = self.balanceOrZero(msg.jettonMaster);
        let queryId: Int = QueryWithdrawTracked;
        if (msg.amount > bal) {
            queryId = QueryWithdrawUntracked;
            self.balances.set(msg.jettonMaster, 0);
        } else {
            self.balances.set(msg.jettonMaster, bal - msg.amount);
        }

        self.sendJettons(wallet!!, queryId, msg.amount, msg.to, SendRemainingValue);
    }

    // ---- Bounced transfer: the jettons never left the pool's wallet, so
    // undo the ledger debit (and release the claim nonce so the backend's
    // reconciliation sees the voucher as unused). Only wallets registered by
    // a verified deposit are trusted as bounce sources. ----
    bounced(msg: bounced<JettonTransfer>) {
        let jettonMaster: Address? = self.walletMasters.get(sender());
        if (jettonMaster == null) {
            return;
        }
        let q: Int = msg.queryId;
        if (q > 0 && q < QueryClaimNonceLimit) {
            self.usedNonces.set(q, null);
            if (self.claimDay == now() / ClaimDay) {
                let spent: Int = self.mapOrZero(self.daySpent, jettonMaster!!) - msg.amount;
                if (spent < 0) {
                    spent = 0;
                }
                self.daySpent.set(jettonMaster!!, spent);
            }
        } else if (q != QueryWithdrawTracked) {
            // Untracked withdrawals and refunds were never (fully) in the
            // ledger; crediting them back could overstate the balance.
            return;
        }
        self.balances.set(jettonMaster!!, self.balanceOrZero(jettonMaster!!) + msg.amount);
    }

    // Everything the incoming message brought beyond this transaction's gas
    // goes back to `to`: the pool keeps its balance as it was, never more.
    // Must be the handler's last action (mode 128 sends all unreserved TON).
    fun refundExcess(ctx: Context, to: Address, queryId: Int) {
        nativeReserve(myBalance() - ctx.value, PoolReserveAtMost);
        send(SendParameters{
            to: to,
            value: 0,
            mode: SendRemainingBalance + SendIgnoreErrors,
            bounce: false,
            body: TonExcesses{queryId: queryId}.toCell()
        });
    }

    fun refundDeposit(msg: JettonTransferNotification) {
        if (msg.amount > 0) {
            self.sendJettons(sender(), QueryRefund, msg.amount, msg.sender, SendRemainingValue);
        }
    }

    // Outbound transfer funded by the incoming message: SendRemainingValue,
    // or SendRemainingBalance after a nativeReserve that keeps the storage rent.
    fun sendJettons(wallet: Address, queryId: Int, amount: Int, to: Address, mode: Int) {
        send(SendParameters{
            to: wallet,
            value: 0,
            mode: mode,
            bounce: true,
            body: JettonTransfer{
                queryId: queryId,
                amount: amount,
                destination: to,
                responseDestination: to,
                customPayload: null,
                forwardTonAmount: 0,
                forwardPayload: emptySlice()
            }.toCell()
        });
    }

    fun requireAdmin() {
        let admin: Address? = self.admin;
        require(admin != null, "only chat admin");
        require(sender() == admin!!, "only chat admin");
    }

    // Admin controls change no balances: hand the TON back.
    fun returnValue() {
        send(SendParameters{
            to: sender(),
            value: 0,
            mode: SendRemainingValue + SendIgnoreErrors,
            bounce: false
        });
    }

    fun rollClaimDay() {
        let day: Int = now() / ClaimDay;
        if (day != self.claimDay) {
            self.claimDay = day;
            self.dayBudgets = emptyMap();
            self.daySpent = emptyMap();
        }
    }

    // Today's budget: fixed at the day's first claim from the explicit limit
    // or the default share of the balance at that moment.
    fun dayBudgetFor(jettonMaster: Address, balance: Int): Int {
        if (self.claimDay == now() / ClaimDay) {
            let fixed: Int? = self.dayBudgets.get(jettonMaster);
            if (fixed != null) {
                return fixed!!;
            }
        }
        let explicit: Int? = self.claimLimits.get(jettonMaster);
        if (explicit != null) {
            return explicit!!;
        }
        return balance * DefaultDailyClaimPercent / 100;
    }

    fun mapOrZero(m: map<Address, Int>, key: Address): Int {
        let v: Int? = m.get(key);
        if (v == null) {
            return 0;
        }
        return v!!;
    }

    fun balanceOrZero(jettonMaster: Address): Int {
        let b: Int? = self.balances.get(jettonMaster);
        if (b == null) {
            return 0;
        }
        return b!!;
    }

    // ---- Getters ----
    get fun balanceOf(jettonMaster: Address): Int {
        return self.balanceOrZero(jettonMaster);
    }

    get fun jettonWallet(jettonMaster: Address): Address? {
        return self.jettonWallets.get(jettonMaster);
    }

    get fun poolAdmin(): Address? {
        return self.admin;
    }

    get fun isNonceUsed(nonce: Int): Bool {
        return self.usedNonces.get(nonce) != null;
    }

    get fun poolChatId(): Int {
        return self.chatId;
    }

    get fun claimsPaused(): Bool {
        return self.claimsPaused;
    }

    // Explicit daily limit, 0 when the default share applies.
    get fun claimLimit(jettonMaster: Address): Int {
        return self.mapOrZero(self.claimLimits, jettonMaster);
    }

    // What claims can still move today (UTC day), for the backend to size
    // vouchers so they never fail on-chain.
    get fun claimableToday(jettonMaster: Address): Int {
        let bal: Int = self.balanceOrZero(jettonMaster);
        let spent: Int = 0;
        if (self.claimDay == now() / ClaimDay) {
            spent = self.mapOrZero(self.daySpent, jettonMaster);
        }
        let left: Int = self.dayBudgetFor(jettonMaster, bal) - spent;
        if (left > bal) {
            left = bal;
        }
        if (left < 0) {
            return 0;
        }
        return left;
    }

    get fun backendKey(): Int {
        return self.backendPubKey;
    }
}
