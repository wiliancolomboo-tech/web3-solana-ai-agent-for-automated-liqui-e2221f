import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { KineticLpVault } from "../target/types/kinetic_lp_vault";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  createAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import { PublicKey, Keypair, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import { expect } from "chai";

describe("kinetic-lp-vault end-to-end tests", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.KineticLpVault as Program<KineticLpVault>;

  let authority = Keypair.generate();
  let keeper = Keypair.generate();
  let unauthorized = Keypair.generate();
  let whirlpool = Keypair.generate();
  let mockPosition = Keypair.generate();

  let mintA: PublicKey;
  let mintB: PublicKey;
  let vaultPda: PublicKey;
  let tokenVaultAPda: PublicKey;
  let tokenVaultBPda: PublicKey;
  let vaultBump: number;

  before(async () => {
    // Fund test wallets
    for (const kp of [authority, keeper, unauthorized]) {
      const sig = await provider.connection.requestAirdrop(kp.publicKey, 10 * anchor.web3.LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(sig);
    }

    // Create mock tokens
    mintA = await createMint(provider.connection, authority, authority.publicKey, null, 6);
    mintB = await createMint(provider.connection, authority, authority.publicKey, null, 9);

    [vaultPda, vaultBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), whirlpool.publicKey.toBuffer()],
      program.programId
    );

    [tokenVaultAPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("token_a"), vaultPda.toBuffer()],
      program.programId
    );

    [tokenVaultBPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("token_b"), vaultPda.toBuffer()],
      program.programId
    );
  });

  it("1. Initializes the Kinetic Vault Successfully", async () => {
    const tickSpacing = 64;
    const kineticAlpha = 8000; // 0.8
    const maxDeviationBps = 150; // 1.5%

    await program.methods
      .initializeVault(tickSpacing, kineticAlpha, maxDeviationBps)
      .accounts({
        authority: authority.publicKey,
        keeper: keeper.publicKey,
        whirlpool: whirlpool.publicKey,
        vault: vaultPda,
        tokenVaultA: tokenVaultAPda,
        tokenVaultB: tokenVaultBPda,
        tokenMintA: mintA,
        tokenMintB: mintB,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([authority])
      .rpc();

    const vaultAccount = await program.account.vault.fetch(vaultPda);
    expect(vaultAccount.authority.toBase58()).to.equal(authority.publicKey.toBase58());
    expect(vaultAccount.keeper.toBase58()).to.equal(keeper.publicKey.toBase58());
    expect(vaultAccount.tickSpacing).to.equal(64);
    expect(vaultAccount.totalRebalances.toNumber()).to.equal(0);
  });

  it("2. Blocks Unauthorized Keepers from Triggering Rebalance", async () => {
    const dummyParams = {
      oldLowerTick: -1280,
      oldUpperTick: 1280,
      newLowerTick: -640,
      newUpperTick: 1920,
      currentPositionLiquidity: new anchor.BN(1_000_000),
      minTokenAWithdrawn: new anchor.BN(0),
      minTokenBWithdrawn: new anchor.BN(0),
      swapAmount: new anchor.BN(0),
      swapOtherAmountThreshold: new anchor.BN(0),
      swapAToB: true,
      swapSqrtPriceLimit: new anchor.BN(0),
      minLiquidityMinted: new anchor.BN(500_000),
      poolSqrtPriceX64: new anchor.BN("18446744073709551616"), // 1.0 in Q64
      oraclePriceScaled: new anchor.BN(1_000_000), // 1.0 (scaled 1e6)
      kineticEnergyMetric: new anchor.BN(1250),
      minSlotDelay: new anchor.BN(0),
    };

    try {
      await program.methods
        .rebalancePosition(dummyParams)
        .accounts({
          keeper: unauthorized.publicKey,
          vault: vaultPda,
          tokenVaultA: tokenVaultAPda,
          tokenVaultB: tokenVaultBPda,
          whirlpoolProgram: program.programId, // Mock ID
          whirlpool: whirlpool.publicKey,
          position: mockPosition.publicKey,
          positionTokenAccount: tokenVaultAPda,
          tickArrayLower: vaultPda,
          tickArrayUpper: vaultPda,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([unauthorized])
        .rpc();
      expect.fail("Should have failed with UnauthorizedKeeper");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("UnauthorizedKeeper");
    }
  });

  it("3. Rejects Rebalance When Oracle Deviation Exceeds Slippage Limit", async () => {
    // 1.0 in Q64 vs 1.10 in Oracle -> 10% deviation > 1.5% max
    const maliciousDeviationParams = {
      oldLowerTick: -1280,
      oldUpperTick: 1280,
      newLowerTick: -640,
      newUpperTick: 1920,
      currentPositionLiquidity: new anchor.BN(1_000_000),
      minTokenAWithdrawn: new anchor.BN(0),
      minTokenBWithdrawn: new anchor.BN(0),
      swapAmount: new anchor.BN(0),
      swapOtherAmountThreshold: new anchor.BN(0),
      swapAToB: true,
      swapSqrtPriceLimit: new anchor.BN(0),
      minLiquidityMinted: new anchor.BN(500_000),
      poolSqrtPriceX64: new anchor.BN("18446744073709551616"), // 1.0
      oraclePriceScaled: new anchor.BN(1_100_000), // 1.10 (+10% deviation)
      kineticEnergyMetric: new anchor.BN(3400),
      minSlotDelay: new anchor.BN(0),
    };

    try {
      await program.methods
        .rebalancePosition(maliciousDeviationParams)
        .accounts({
          keeper: keeper.publicKey,
          vault: vaultPda,
          tokenVaultA: tokenVaultAPda,
          tokenVaultB: tokenVaultBPda,
          whirlpoolProgram: program.programId,
          whirlpool: whirlpool.publicKey,
          position: mockPosition.publicKey,
          positionTokenAccount: tokenVaultAPda,
          tickArrayLower: vaultPda,
          tickArrayUpper: vaultPda,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([keeper])
        .rpc();
      expect.fail("Should have failed with OracleDeviationBreached");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("OracleDeviationBreached");
    }
  });

  it("4. Rejects Unaligned Ticks Not Matching Tick Spacing", async () => {
    const unalignedTickParams = {
      oldLowerTick: -1280,
      oldUpperTick: 1280,
      newLowerTick: -633, // Not divisible by 64
      newUpperTick: 1920,
      currentPositionLiquidity: new anchor.BN(1_000_000),
      minTokenAWithdrawn: new anchor.BN(0),
      minTokenBWithdrawn: new anchor.BN(0),
      swapAmount: new anchor.BN(0),
      swapOtherAmountThreshold: new anchor.BN(0),
      swapAToB: true,
      swapSqrtPriceLimit: new anchor.BN(0),
      minLiquidityMinted: new anchor.BN(500_000),
      poolSqrtPriceX64: new anchor.BN("18446744073709551616"),
      oraclePriceScaled: new anchor.BN(1_000_000),
      kineticEnergyMetric: new anchor.BN(1500),
      minSlotDelay: new anchor.BN(0),
    };

    try {
      await program.methods
        .rebalancePosition(unalignedTickParams)
        .accounts({
          keeper: keeper.publicKey,
          vault: vaultPda,
          tokenVaultA: tokenVaultAPda,
          tokenVaultB: tokenVaultBPda,
          whirlpoolProgram: program.programId,
          whirlpool: whirlpool.publicKey,
          position: mockPosition.publicKey,
          positionTokenAccount: tokenVaultAPda,
          tickArrayLower: vaultPda,
          tickArrayUpper: vaultPda,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([keeper])
        .rpc();
      expect.fail("Should have failed with UnalignedLowerTick");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("UnalignedLowerTick");
    }
  });

  it("5. Executes Valid Atomic Kinetic Rebalancing", async () => {
    const validParams = {
      oldLowerTick: -1280,
      oldUpperTick: 1280,
      newLowerTick: -640,
      newUpperTick: 1920,
      currentPositionLiquidity: new anchor.BN(1_000_000),
      minTokenAWithdrawn: new anchor.BN(0),
      minTokenBWithdrawn: new anchor.BN(0),
      swapAmount: new anchor.BN(10_000),
      swapOtherAmountThreshold: new anchor.BN(9_900),
      swapAToB: true,
      swapSqrtPriceLimit: new anchor.BN(0),
      minLiquidityMinted: new anchor.BN(800_000),
      poolSqrtPriceX64: new anchor.BN("18446744073709551616"),
      oraclePriceScaled: new anchor.BN(1_000_000),
      kineticEnergyMetric: new anchor.BN(2100),
      minSlotDelay: new anchor.BN(0),
    };

    const tx = await program.methods
      .rebalancePosition(validParams)
      .accounts({
        keeper: keeper.publicKey,
        vault: vaultPda,
        tokenVaultA: tokenVaultAPda,
        tokenVaultB: tokenVaultBPda,
        whirlpoolProgram: program.programId,
        whirlpool: whirlpool.publicKey,
        position: mockPosition.publicKey,
        positionTokenAccount: tokenVaultAPda,
        tickArrayLower: vaultPda,
        tickArrayUpper: vaultPda,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([keeper])
      .rpc();

    expect(tx).to.be.a("string");
    const vaultAccount = await program.account.vault.fetch(vaultPda);
    expect(vaultAccount.totalRebalances.toNumber()).to.equal(1);
  });
});