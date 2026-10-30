import type { HardhatUserConfig } from 'hardhat/config';
import '@nomicfoundation/hardhat-toolbox'; // includes hardhat-gas-reporter, chai matchers, ethers v6
import * as dotenv from 'dotenv';
dotenv.config({ path: '../.env' });

const sepoliaUrl = process.env.SEPOLIA_RPC_URL;
const deployerKey = process.env.DEPLOYER_PRIVATE_KEY;

const config: HardhatUserConfig = {
  solidity: { version: '0.8.24', settings: { optimizer: { enabled: true, runs: 200 } } },
  networks: {
    hardhat: { chainId: 31337 },
    localhost: { url: process.env.CHAIN_RPC_URL ?? 'http://127.0.0.1:8545' },
    ...(sepoliaUrl && deployerKey ? { sepolia: { url: sepoliaUrl, accounts: [deployerKey] } } : {}),
  },
  gasReporter: { enabled: true, currency: 'USD', noColors: true },
};

export default config;
