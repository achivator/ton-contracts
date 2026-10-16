// The ChatPool exactly as the DistributorMaster deploys it: compiled inside
// the master's unit (build/DistributorMaster). The standalone build
// (build/ChatPool, from ChatPool.compile.ts) has another get_abi_ipfs and so
// another code hash: an address derived from it is NOT the pool's (DM-8).
export * from '../build/DistributorMaster/tact_ChatPool';
