import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  createAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import { expect } from "chai";
import { KineticVolatilityEngine } from "../src/kinetic_engine";

describe("Kinetic CLMM Rebalance Program & Engine Test Matrix", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const wallet = provider.wallet as anchor.Wallet;
  // Fallback IDL interface
  const program = anchor.workspace.KineticRebalance as Program<any>;

  let mintA: PublicKey;
  let mintB: PublicKey;
  let userTokenA: PublicKey;
  let userTokenB: PublicKey;

  const operator = Keypair.generate();
  const unauthorizedUser = Keypair.generate();
  const strategyId = new anchor.BN(888);

  let vaultPda: PublicKey;
  let tokenVaultA: PublicKey;
  let tokenVaultB: PublicKey;

  before(async () => {
    // Airdrop SOL to test actors
    const signature = await provider.connection.requestAirdrop(operator.publicKey, 2 * anchor.web3.LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(signature, "confirmed");

    // Initialize mock tokens
    mintA = await createMint(provider.connection, wallet.payer, wallet.publicKey, null, 6);
    mintB = await createMint(provider.connection, wallet.payer, wallet.publicKey, null, 6);

    userTokenA = await createAccount(provider.connection, wallet.payer, mintA, wallet.publicKey);
    userTokenB = await createAccount(provider.connection, wallet.payer, mintB, wallet.publicKey);

    await mintTo(provider.connection, wallet.payer, mintA, userTokenA, wallet.payer, 100_000_000);
    await mintTo(provider.connection, wallet.payer, mintB, userTokenB, wallet.payer, 100_000_000);

    [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("kinetic_vault"), wallet.publicKey.toBuffer(), strategyId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    [tokenVaultA] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault_token_a"), vaultPda.toBuffer()],
      program.programId
    );

    [tokenVaultB] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault_token_b"), vaultPda.toBuffer()],
      program.programId
    );
  });

  it("1. Successfully initializes the Kinetic Rebalance Vault with security bounds", async () => {
    const maxSlippageBps = 300; // 3%

    await program.methods
      .initializeVault(strategyId, maxSlippageBps, operator.publicKey)
      .accounts({
        vaultState: vaultPda,
        tokenMintA: mintA,
        tokenMintB: mintB,
        tokenVaultA: tokenVaultA,
        tokenVaultB: tokenVaultB,
        owner: wallet.publicKey,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    const vaultAccount = await program.account.vaultState.fetch(vaultPda);
    expect(vaultAccount.owner.toBase58()).to.equal(wallet.publicKey.toBase58());
    expect(vaultAccount.operator.toBase58()).to.equal(operator.publicKey.toBase58());
    expect(vaultAccount.maxSlippageBps).to.equal(300);
    expect(vaultAccount.isPaused).to.be.false;
  });

  it("2. Enforces Slippage Threshold Limit during vault initialization", async () => {
    const invalidStrategyId = new anchor.BN(999);
    const [invalidVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("kinetic_vault"), wallet.publicKey.toBuffer(), invalidStrategyId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );
    const [invalidTokenA] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault_token_a"), invalidVaultPda.toBuffer()],
      program.programId
    );
    const [invalidTokenB] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault_token_b"), invalidVaultPda.toBuffer()],
      program.programId
    );

    try {
      await program.methods
        .initializeVault(invalidStrategyId, 1500, operator.publicKey) // 15% > 10% limit
        .accounts({
          vaultState: invalidVaultPda,
          tokenMintA: mintA,
          tokenMintB: mintB,
          tokenVaultA: invalidTokenA,
          tokenVaultB: invalidTokenB,
          owner: wallet.publicKey,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .rpc();
      expect.fail("Should have failed on excessive slippage tolerance");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("ExcessiveSlippageTolerance");
    }
  });

  it("3. Accepts deposits and credits Vault Token Accounts", async () => {
    const depositAmountA = new anchor.BN(10_000_000);
    const depositAmountB = new anchor.BN(20_000_000);

    await program.methods
      .deposit(depositAmountA, depositAmountB)
      .accounts({
        vaultState: vaultPda,
        tokenVaultA: tokenVaultA,
        tokenVaultB: tokenVaultB,
        userTokenA: userTokenA,
        userTokenB: userTokenB,
        userAuthority: wallet.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    const vaultAccountA = await getAccount(provider.connection, tokenVaultA);
    const vaultAccountB = await getAccount(provider.connection, tokenVaultB);

    expect(Number(vaultAccountA.amount)).to.equal(10_000_000);
    expect(Number(vaultAccountB.amount)).to.equal(20_000_000);
  });

  it("4. Blocks rebalancing if attempted by an unauthorized entity", async () => {
    const rebalanceParams = {
      newLowerTick: -1280,
      newUpperTick: 1280,
      slippageBps: 100,
      observedKineticVolatility: 25000,
      kineticDriftMetric: 40,
    };

    try {
      await program.methods
        .executeRebalance(rebalanceParams)
        .accounts({
          vaultState: vaultPda,
          operator: unauthorizedUser.publicKey,
        })
        .signers([unauthorizedUser])
        .rpc();
      expect.fail("Unauthorized rebalance attempt should have thrown an error");
    } catch (err: any) {
      expect(err.message).to.include("ConstraintHasOne");
    }
  });

  it("5. Rejects kinetic rebalancing if slot cooldown is violated", async () => {
    const rebalanceParams = {
      newLowerTick: -1280,
      newUpperTick: 1280,
      slippageBps: 100,
      observedKineticVolatility: 25000,
      kineticDriftMetric: 40,
    };

    try {
      // Cooldown is 75 slots (~30 seconds); calling immediately must fail
      await program.methods
        .executeRebalance(rebalanceParams)
        .accounts({
          vaultState: vaultPda,
          operator: operator.publicKey,
        })
        .signers([operator])
        .rpc();
      expect.fail("Should have failed due to rebalance cooldown");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("RebalanceCooldownActive");
    }
  });

  it("6. Mathematical Verification: KineticVolatilityEngine correctly scales ranges", () => {
    const engine = new KineticVolatilityEngine(64, 2.0, 640);
    const mockCandles = [
      { open: 100, high: 102, low: 99, close: 101, slot: 1 },
      { open: 101, high: 108, low: 97, close: 106, slot: 5 }, // High volatility spike
      { open: 106, high: 112, low: 103, close: 111, slot: 10 },
    ];

    const result = engine.evaluateKineticState(111, 1000, 800, 1200, mockCandles);

    expect(result.garmanKlassVolatility).to.be.greaterThan(0);
    expect(result.momentumDriftBps).to.be.greaterThan(0);
    expect(result.suggestedUpperTick - result.suggestedLowerTick).to.be.greaterThan(640);
  });
});