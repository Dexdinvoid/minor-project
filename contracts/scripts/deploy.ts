import { ethers, network } from 'hardhat';
import * as fs from 'node:fs';
import * as path from 'node:path';

async function main() {
  const [deployer] = await ethers.getSigners();
  const net = await ethers.provider.getNetwork();
  console.log(`network=${network.name} chainId=${net.chainId} deployer=${deployer!.address}`); // M8: print chain + address

  const keyRegistry = await ethers.deployContract('KeyRegistry');
  await keyRegistry.waitForDeployment();
  const anchorRegistry = await ethers.deployContract('AnchorRegistry');
  await anchorRegistry.waitForDeployment();

  const out = {
    network: network.name,
    chainId: Number(net.chainId),
    keyRegistry: await keyRegistry.getAddress(),
    anchorRegistry: await anchorRegistry.getAddress(),
    deployedAt: new Date().toISOString(),
  };
  const dir = path.join(__dirname, '..', 'deployments');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${network.name}.json`), JSON.stringify(out, null, 2));

  console.log('\nAdd these to your .env:');
  console.log(`KEY_REGISTRY_ADDRESS=${out.keyRegistry}`);
  console.log(`ANCHOR_REGISTRY_ADDRESS=${out.anchorRegistry}`);
  console.log(`CHAIN_ID=${out.chainId}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
