import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { KineticRebalanceVault } from "../target/types/kinetic_rebalance_vault";
import {
  createMint,
  createAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import { expect } from "chai";

describe("kinetic_rebalance_vault protocol tests", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.KineticRebalanceVault as Program<KineticRebalanceVault>;

  const admin = (provider.wallet as any).payer as Keypair;
  const keeper = Keypair.generate();
  const unauthorizedAttacker = Keypair.generate();
  const dummyWhirlpool = Keypair.generate();

  let mintA: PublicKey;
  let mintB: PublicKey;
  let vaultConfigPda: PublicKey;
  let tokenVaultAPda: PublicKey;
  let tokenVaultBPda: PublicKey;

  before(async () => {
    // Airdrop SOL to test participants
    for (const kp of [keeper, unauthorizedAttacker]) {
      const sig = await provider.connection.requestAirdrop(kp.publicKey, 2 * anchor.web3.LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(sig);
    }

    // Deploy test token mints
    mintA = await createMint(provider.connection, admin, admin.publicKey, null, 6);
    mintB = await createMint(provider.connection, admin, admin.publicKey, null, 6);

    // Derive PDA addresses
    [vaultConfigPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("kinetic_vault"),
        admin.publicKey.toBuffer(),
        mintA.toBuffer(),
        mintB.toBuffer(),
      ],
      program.programId
    );

    [tokenVaultAPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("token_a"), vaultConfigPda.toBuffer()],
      program.programId
    );

    [tokenVaultBPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("token_b"), vaultConfigPda.toBuffer()],
      program.programId
    );
  });

  it("1. Initializes the Kinetic Vault with deterministic guardrails", async () => {
    const maxTickShift = 500;
    const minWidth = 128;
    const maxWidth = 4096;
    const maxSlippageBps = 100; // 1%

    await program.methods
      .initializeVault(maxTickShift, minWidth, maxWidth, maxSlippageBps)
      .accounts({
        vaultConfig: vaultConfigPda,
        admin: admin.publicKey,
        keeper: keeper.publicKey,
        tokenMintA: mintA,
        tokenMintB: mintB,
        tokenVaultA: tokenVaultAPda,
        tokenVaultB: tokenVaultBPda,
        whirlpool: dummyWhirlpool.publicKey,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    const vaultAccount = await program.account.vaultConfig.fetch(vaultConfigPda);
    expect(vaultAccount.admin.toBase58()).to.equal(admin.publicKey.toBase58());
    expect(vaultAccount.keeper.toBase58()).to.equal(keeper.publicKey.toBase58());
    expect(vaultAccount.minTickWidth).to.equal(minWidth);
    expect(vaultAccount.maxTickWidth).to.equal(maxWidth);
    expect(vaultAccount.isPaused).to.be.false;
  });

  it("2. Permits the authorized keeper to rebalance within valid kinetic bounds", async () => {
    const newLower = -256;
    const newUpper = 256;
    const kineticIndex = new anchor.BN(1420);

    await program.methods
      .rebalancePosition(newLower, newUpper, kineticIndex, 50)
      .accounts({
        vaultConfig: vaultConfigPda,
        keeper: keeper.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([keeper])
      .rpc();

    const vaultAccount = await program.account.vaultConfig.fetch(vaultConfigPda);
    expect(vaultAccount.lowerTick).to.equal(newLower);
    expect(vaultAccount.upperTick).to.equal(newUpper);
  });

  it("3. Rejects rebalance attempts from unauthorized callers", async () => {
    try {
      await program.methods
        .rebalancePosition(-256, 256, new anchor.BN(100), 50)
        .accounts({
          vaultConfig: vaultConfigPda,
          keeper: unauthorizedAttacker.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([unauthorizedAttacker])
        .rpc();
      expect.fail("Should have thrown UnauthorizedKeeper error");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("UnauthorizedKeeper");
    }
  });

  it("4. Prevents position width violation (too narrow)", async () => {
    try {
      // min width is 128; difference here is only 64
      await program.methods
        .rebalancePosition(0, 64, new anchor.BN(100), 50)
        .accounts({
          vaultConfig: vaultConfigPda,
          keeper: keeper.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([keeper])
        .rpc();
      expect.fail("Should have thrown TickSpreadTooNarrow error");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("TickSpreadTooNarrow");
    }
  });

  it("5. Triggers circuit breaker and asserts frozen operations", async () => {
    // Admin toggles pause
    await program.methods
      .setCircuitBreaker(true)
      .accounts({
        vaultConfig: vaultConfigPda,
        admin: admin.publicKey,
      })
      .rpc();

    let vaultAccount = await program.account.vaultConfig.fetch(vaultConfigPda);
    expect(vaultAccount.isPaused).to.be.true;

    // Keeper execution must now fail
    try {
      await program.methods
        .rebalancePosition(-512, 512, new anchor.BN(50), 50)
        .accounts({
          vaultConfig: vaultConfigPda,
          keeper: keeper.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([keeper])
        .rpc();
      expect.fail("Should have failed with VaultPaused error");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("VaultPaused");
    }

    // Reset circuit breaker
    await program.methods
      .setCircuitBreaker(false)
      .accounts({
        vaultConfig: vaultConfigPda,
        admin: admin.publicKey,
      })
      .rpc();
  });
});