import "@stdlib/deploy";
import "@stdlib/ownable";
import "./distributor_messages.tact";
import "./chat_pool.tact";

// Stays on a new pool as its storage reserve (PoolMinTonReserve).
const PoolDeployValue: Int = ton("0.15");
// Master's own gas + forward fee for a CreatePool, paid by the caller.
const CreatePoolGas: Int = ton("0.05");
// TON the master keeps for its own storage rent: Deploy refunds only what
// exceeds it (top-ups are welcome too). The master's state holds the pool
// code; tests/DistributorMasterSecurity.spec.ts measures the rent (about
// 0.012 TON a year at mainnet prices) and checks that this covers it for at
// least 15 years.
const MasterStorageReserve: Int = ton("0.2");

// The master takes no fee and has no way to pay TON out: its balance only
// pays its own storage rent. The ChatPool code it deploys is compiled in
// this unit, so derive pool addresses with poolAddress() or the
// wrappers/ChatPool binding (which re-exports this unit's ChatPool), never
// with the standalone build/ChatPool (different get_abi_ipfs, other code).
contract DistributorMaster with Ownable {
    owner: Address;
    pendingOwner: Address?;          // proposed by the owner, must accept
    backendPubKey: Int as uint256;   // key of pools created from now on

    init(owner: Address, backendPubKey: Int) {
        self.owner = owner;
        self.backendPubKey = backendPubKey;
    }

    // Storage rent top-ups.
    receive() {}

    // Deploy / no-op ping: answers DeployOk with everything above the
    // storage reserve (or above the balance it had, if that was more).
    receive(msg: Deploy) {
        let ctx: Context = context();
        nativeReserve(max(myBalance() - ctx.value, MasterStorageReserve), PoolReserveAtMost);
        send(SendParameters{
            to: ctx.sender,
            value: 0,
            mode: SendRemainingBalance + SendIgnoreErrors,
            bounce: false,
            body: DeployOk{queryId: msg.queryId}.toCell()
        });
    }

    // Deploy the ChatPool of a chat. Anyone may trigger it: a pool is inert
    // until its admin (backend-verified chat creator) claims it, and the
    // caller pays its initial balance and the gas, so repeated calls cannot
    // drain the master. The pool keeps PoolDeployValue as its storage reserve;
    // the rest of the attached TON goes back to the caller. For a pool that
    // already exists, the pool hands PoolDeployValue back too (InitPool is
    // accepted once), so a repeated CreatePool only costs gas.
    //
    // The pool's address depends on (master, chatId) alone; the backend key
    // reaches it in InitPool. Nobody else can initialise a pool at that
    // address, and RotateBackendKey never moves it.
    receive(msg: CreatePool) {
        let ctx: Context = context();
        require(ctx.value >= PoolDeployValue + CreatePoolGas, "attach at least 0.2 TON");
        // Reserve first: the pool's value and the refund come out of the
        // incoming message, never out of the master's own balance.
        nativeReserve(myBalance() - ctx.value, PoolReserveAtMost);
        let init: StateInit = self.poolInit(msg.chatId);
        send(SendParameters{
            to: contractAddress(init),
            value: PoolDeployValue,
            mode: SendPayGasSeparately,
            bounce: false,
            body: InitPool{backendPubKey: self.backendPubKey, excessTo: ctx.sender}.toCell(),
            code: init.code,
            data: init.data
        });
        // Last action: mode 128 sends everything unreserved.
        send(SendParameters{
            to: ctx.sender,
            value: 0,
            mode: SendRemainingBalance + SendIgnoreErrors,
            bounce: false,
            body: TonExcesses{queryId: 0}.toCell()
        });
    }

    // Affects pools created afterwards only: an existing pool moves to a new
    // key through its admin's SetPoolBackendKey. Runbook: the header of
    // scripts/rotateBackendKey.ts.
    receive(msg: RotateBackendKey) {
        self.requireOwner();
        require(msg.backendPubKey != 0 && msg.backendPubKey != self.backendPubKey, "invalid backend key");
        self.backendPubKey = msg.backendPubKey;
        self.returnValue();
    }

    receive(msg: ProposeOwner) {
        self.requireOwner();
        self.pendingOwner = msg.newOwner;
        self.returnValue();
    }

    receive(msg: AcceptOwnership) {
        let next: Address? = self.pendingOwner;
        require(next != null && sender() == next!!, "only the proposed owner may accept");
        self.owner = next!!;
        self.pendingOwner = null;
        self.returnValue();
    }

    fun returnValue() {
        send(SendParameters{
            to: sender(),
            value: 0,
            mode: SendRemainingValue + SendIgnoreErrors,
            bounce: false
        });
    }

    fun poolInit(chatId: Int): StateInit {
        return initOf ChatPool(myAddress(), chatId);
    }

    get fun poolAddress(chatId: Int): Address {
        return contractAddress(self.poolInit(chatId));
    }

    get fun backendKey(): Int {
        return self.backendPubKey;
    }

    get fun pendingOwner(): Address? {
        return self.pendingOwner;
    }

    get fun version(): Int {
        return ProtocolVersion;
    }
}
