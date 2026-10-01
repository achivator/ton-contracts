import "@stdlib/deploy";
import "@stdlib/ownable";
import "./distributor_messages.tact";
import "./chat_pool.tact";

const PoolDeployValue: Int = ton("0.1");
// Master's own gas + forward fee for a CreatePool, paid by the caller.
const CreatePoolGas: Int = ton("0.05");

// The master takes no fee and has no way to pay TON out: its balance only
// covers its own storage rent (plain TON top-ups are accepted for that).
contract DistributorMaster with Deployable, Ownable {
    owner: Address;
    backendPubKey: Int as uint256;

    init(owner: Address, backendPubKey: Int) {
        self.owner = owner;
        self.backendPubKey = backendPubKey;
    }

    // Storage rent top-ups.
    receive() {}

    // Deploy a ChatPool for a chat. Anyone may trigger creation; the pool
    // becomes useful only once the admin funds it (and thereby claims it).
    // The caller pays the pool's initial balance and the gas, so repeated
    // CreatePool calls cannot drain the master. The pool keeps
    // PoolDeployValue as its storage reserve (plain-TON deploy, no DeployOk
    // echo back to the master); the rest of the attached TON goes back to
    // the caller.
    receive(msg: CreatePool) {
        let ctx: Context = context();
        require(ctx.value >= PoolDeployValue + CreatePoolGas, "attach at least 0.15 TON");
        // Reserve first: the pool's value and the refund come out of the
        // incoming message, never out of the master's own balance.
        nativeReserve(myBalance() - ctx.value, PoolReserveAtMost);
        let init: StateInit = self.poolInit(msg.chatId);
        send(SendParameters{
            to: contractAddress(init),
            value: PoolDeployValue,
            mode: SendPayGasSeparately,
            bounce: false,
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

    receive(msg: RotateBackendKey) {
        self.requireOwner();
        self.backendPubKey = msg.backendPubKey;
        send(SendParameters{
            to: sender(),
            value: 0,
            mode: SendRemainingValue + SendIgnoreErrors,
            bounce: false
        });
    }

    fun poolInit(chatId: Int): StateInit {
        return initOf ChatPool(myAddress(), chatId, self.backendPubKey);
    }

    // NOTE: the pool address embeds backendPubKey, so this getter is correct
    // for pools created under the current key. After RotateBackendKey, track
    // pre-rotation pool addresses off-chain.
    get fun poolAddress(chatId: Int): Address {
        return contractAddress(self.poolInit(chatId));
    }

    get fun backendKey(): Int {
        return self.backendPubKey;
    }

    get fun version(): Int {
        return ProtocolVersion;
    }
}
