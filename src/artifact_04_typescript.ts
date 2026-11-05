import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { KinetixVault } from "../target/types/kinetix_vault";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  createAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import { expect } from "chai";

describe("kinetix-vault deterministic test matrix", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.KinetixVault as Program<KinetixVault>;
  const owner = Keypair.generate();
  const agent = Keypair.generate();
  const maliciousActor = Keypair.generate();

  let mintA: anchor.web3.PublicKey;
  let mintB: anchor.web3.PublicKey;
  let vaultPda: anchor.web3.PublicKey;
  let vaultBump: number;
  let userTokenA: anchor.web3.PublicKey;
  let userTokenB: anchor.web3.PublicKey;
  let vaultTokenA: anchor.web3.PublicKey;
  let vaultTokenB: anchor.web3.PublicKey;

  before(async () => {
    // Airdrop SOL to test actors
    for (const actor of [owner, agent, maliciousActor]) {
      const sig = await provider.connection.requestAirdrop(
        actor.publicKey,
        10 * anchor.web3.LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(sig);
    }

    // Create dual test tokens
    mintA = await createMint(provider.connection, owner, owner.publicKey, null, 6);
    mintB = await createMint(provider.connection, owner, owner.publicKey, null, 6);

    [vaultPda, vaultBump] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("kinetix_vault"), owner.publicKey.toBuffer()],
      program.programId
    );

    // Create user token accounts
    userTokenA = await createAccount(provider.connection, owner, mintA, owner.publicKey);
    userTokenB = await createAccount(provider.connection, owner, mintB, owner.publicKey);

    // Create vault-owned token accounts
    vaultTokenA = await createAccount(provider.connection, owner, mintA, vaultPda);
    vaultTokenB = await createAccount(provider.connection, owner, mintB, vaultPda);

    // Mint test liquidity
    await mintTo(provider.connection, owner, mintA, userTokenA, owner, 1_000_000_000);
    await mintTo(provider.connection, owner, mintB, userTokenB, owner, 1_000_000_000);
  });

  it("QA-01: Correctly initializes vault with non-custodial parameters", async () => {
    await program.methods
      .initializeVault(100, 64) // 100 bps max slippage, 64 min tick spacing
      .accounts({
        vault: vaultPda,
        owner: owner.publicKey,
        agent: agent.publicKey,
        tokenAMint: mintA,
        tokenBMint: mintB,
        systemProgram: anchor.web3.SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([owner])
      .rpc();

    const vaultAccount = await program.account.vaultState.fetch(vaultPda);
    expect(vaultAccount.owner.toBase58()).to.equal(owner.publicKey.toBase58());
    expect(vaultAccount.agent.toBase58()).to.equal(agent.publicKey.toBase58());
    expect(vaultAccount.maxSlippageBps).to.equal(100);
    expect(vaultAccount.minTickWidth).to.equal(64);
    expect(vaultAccount.totalRebalances.toNumber()).to.equal(0);
    expect(vaultAccount.isPaused).to.be.false;
  });

  it("QA-02: Allows user to deposit token liquidity into PDA", async () => {
    const depositAmount = new anchor.BN(500_000_000);

    await program.methods
      .depositTokens(depositAmount, depositAmount)
      .accounts({
        vault: vaultPda,
        owner: owner.publicKey,
        userTokenA,
        userTokenB,
        vaultTokenA,
        vaultTokenB,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([owner])
      .rpc();

    const vA = await getAccount(provider.connection, vaultTokenA);
    const vB = await getAccount(provider.connection, vaultTokenB);

    expect(Number(vA.amount)).to.equal(500_000_000);
    expect(Number(vB.amount)).to.equal(500_000_000);
  });

  it("QA-03: Rejects rebalance attempts from unauthorized agents", async () => {
    let failed = false;
    try {
      await program.methods
        .executeRebalance(-640, 640, 50, new anchor.BN(1500))
        .accounts({
          vault: vaultPda,
          agent: maliciousActor.publicKey,
        })
        .signers([maliciousActor])
        .rpc();
    } catch (_err) {
      failed = true;
    }
    expect(failed).to.be.true;
  });

  it("QA-04: Rejects rebalances exceeding maximum slippage cap", async () => {
    let failed = false;
    try {
      await program.methods
        .executeRebalance(-640, 640, 250, new anchor.BN(1500)) // 250 bps > 100 bps max
        .accounts({
          vault: vaultPda,
          agent: agent.publicKey,
        })
        .signers([agent])
        .rpc();
    } catch (err: any) {
      failed = true;
      expect(err.error.errorCode.code).to.equal("SlippageExceeded");
    }
    expect(failed).to.be.true;
  });

  it("QA-05: Executes compliant rebalance from authorized agent", async () => {
    await program.methods
      .executeRebalance(-128, 128, 50, new anchor.BN(2200))
      .accounts({
        vault: vaultPda,
        agent: agent.publicKey,
      })
      .signers([agent])
      .rpc();

    const vaultAccount = await program.account.vaultState.fetch(vaultPda);
    expect(vaultAccount.totalRebalances.toNumber()).to.equal(1);
    expect(vaultAccount.currentLowerTick).to.equal(-128);
    expect(vaultAccount.currentUpperTick).to.equal(128);
  });

  it("QA-06: Emergency withdraw recovers all funds to owner and pauses vault", async () => {
    await program.methods
      .emergencyWithdraw()
      .accounts({
        vault: vaultPda,
        owner: owner.publicKey,
        userTokenA,
        userTokenB,
        vaultTokenA,
        vaultTokenB,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([owner])
      .rpc();

    const vA = await getAccount(provider.connection, vaultTokenA);
    const vB = await getAccount(provider.connection, vaultTokenB);
    const vaultAccount = await program.account.vaultState.fetch(vaultPda);

    expect(Number(vA.amount)).to.equal(0);
    expect(Number(vB.amount)).to.equal(0);
    expect(vaultAccount.isPaused).to.be.true;
  });
});