import { Blockchain } from '@ton/sandbox';
import { NetworkProvider } from '@ton/blueprint';
import { Address, Sender, SenderArguments } from '@ton/core';

type Network = ReturnType<NetworkProvider['network']>;

// A blueprint NetworkProvider backed by the sandbox, so scripts/*.ts can run
// in tests. `sent` records every message the script sends through sender().
// Sandbox sends are synchronous, so the sender's "last transaction lt" that
// scripts poll for confirmation is simply the number of messages sent.
export function sandboxProvider(blockchain: Blockchain, sender: Sender, network: Network = 'testnet') {
    const sent: SenderArguments[] = [];
    const recording: Sender = {
        address: sender.address,
        send: async (args) => {
            sent.push(args);
            await sender.send(args);
        },
    };
    const isDeployed = async (a: Address) => (await blockchain.getContract(a)).accountState?.type === 'active';
    const api = {
        isContractDeployed: isDeployed,
        getBalance: async (a: Address) => (await blockchain.getContract(a)).balance,
        getTransactions: async (a: Address) => (a.equals(sender.address!) ? [{ lt: BigInt(sent.length) }] : []),
    };
    const provider: NetworkProvider = {
        network: () => network,
        sender: () => recording,
        api: () => api as any,
        provider: (address, init) => blockchain.provider(address, init as any),
        isContractDeployed: isDeployed,
        waitForDeploy: async () => {},
        deploy: async () => {
            throw new Error('deprecated deploy() is not supported');
        },
        open: (contract) => blockchain.openContract(contract) as any,
        ui: () => {
            throw new Error('no UI in tests');
        },
    };
    return { provider, sent };
}

// A provider for a network the scripts must refuse: only network() works,
// anything else fails the test loudly.
export function offlineProvider(network: Network): NetworkProvider {
    const touched = () => {
        throw new Error('the script touched the network');
    };
    return {
        network: () => network,
        sender: touched,
        api: touched,
        provider: touched,
        isContractDeployed: touched,
        waitForDeploy: touched,
        deploy: touched,
        open: touched,
        ui: touched,
    };
}
