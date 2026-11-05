import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { KineticRebalancer } from "../target/types/kinetic_rebalancer";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  createAccount,
  mintTo,
} from "@solana/spl-token";
import { expect } from "chai";

describe("Kinetic Rebalancer Anchor Integration Suite", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.KineticRebalancer as Program<KineticRebalancer>;

  let authority: Keypair;
  let keeper: Keypair;
  let maliciousUser: Keypair;
  let tokenAMint: PublicKey;
  let tokenBMint: PublicKey;
  let vaultPda: PublicKey;
  let vaultBump: number;
  let tokenAVault: PublicKey;
  let tokenBVault: PublicKey;

  // Mock Pyth account
  const mockPythOracle = Keypair.generate();

  before(async () => {
    authority = Keypair.generate();
    keeper = Keypair.generate();
    maliciousUser = Keypair.generate();

    // Airdrop SOL to signers
    for (const kp of [authority, keeper, maliciousUser]) {
      const sig = await provider.connection.requestAirdrop(kp.publicKey, 10 * anchor.web3.LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(sig);
    }

    // Create Test SPL Mints
    tokenAMint = await createMint(provider.connection, authority, authority.publicKey, null, 6);
    tokenBMint = await createMint(provider.connection, authority, authority.publicKey, null, 6);

    [vaultPda, vaultBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("kinetic_vault"), tokenAMint.toBuffer(), tokenBMint.toBuffer()],
      program.programId
    );

    [tokenAVault] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault_token_a"), vaultPda.toBuffer()],
      program.programId
    );

    [tokenBVault] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault_token_b"), vaultPda.toBuffer()],
      program.programId
    );
  });

  it("1. Initializes the Kinetic Vault with strict invariants", async () => {
    await program.methods
      .initializeVault(64, 500)
      .accounts({
        vault: vaultPda,
        authority: authority.publicKey,
        keeper: keeper.publicKey,
        tokenAMint: tokenAMint,
        tokenBMint: tokenBMint,
        tokenAVault: tokenAVault,
        tokenBVault: tokenBVault,
        pythPriceFeed: mockPythOracle.publicKey,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([authority])
      .rpc();

    const vaultAccount = await program.account.vaultState.fetch(vaultPda);
    expect(vaultAccount.authority.toBase58()).to.equal(authority.publicKey.toBase58());
    expect(vaultAccount.keeper.toBase58()).to.equal(keeper.publicKey.toBase58());
    expect(vaultAccount.tickSpacing).to.equal(64);
    expect(vaultAccount.isPaused).to.be.false;
  });

  it("2. Blocks unauthorized actors from triggering rebalances", async () => {
    try {
      await program.methods
        .executeRebalance(-640, 640, new anchor.BN(100), new anchor.BN(0), new anchor.BN(0))
        .accounts({
          vault: vaultPda,
          keeper: maliciousUser.publicKey,
          tokenAVault: tokenAVault,
          tokenBVault: tokenBVault,
          pythPriceFeed: mockPythOracle.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([maliciousUser])
        .rpc();

      expect.fail("Should have failed with UnauthorizedKeeper");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("UnauthorizedKeeper");
    }
  });

  it("3. Rejects invalid tick bounds where lower >= upper", async () => {
    try {
      await program.methods
        .executeRebalance(640, -640, new anchor.BN(100), new anchor.BN(0), new anchor.BN(0))
        .accounts({
          vault: vaultPda,
          keeper: keeper.publicKey,
          tokenAVault: tokenAVault,
          tokenBVault: tokenBVault,
          pythPriceFeed: mockPythOracle.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([keeper])
        .rpc();

      expect.fail("Should have failed with InvalidTickBounds");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("InvalidTickBounds");
    }
  });

  it("4. Rejects tick intervals non-conforming to pool tick spacing", async () => {
    try {
      await program.methods
        .executeRebalance(-65, 65, new anchor.BN(100), new anchor.BN(0), new anchor.BN(0)) // 65 is not divisible by 64
        .accounts({
          vault: vaultPda,
          keeper: keeper.publicKey,
          tokenAVault: tokenAVault,
          tokenBVault: tokenBVault,
          pythPriceFeed: mockPythOracle.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([keeper])
        .rpc();

      expect.fail("Should have failed with TickSpacingMismatch");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("TickSpacingMismatch");
    }
  });

  it("5. Governance can pause the vault, halting all rebalancing operations", async () => {
    await program.methods
      .setEmergencyPause(true)
      .accounts({
        vault: vaultPda,
        authority: authority.publicKey,
      })
      .signers([authority])
      .rpc();

    let vaultAccount = await program.account.vaultState.fetch(vaultPda);
    expect(vaultAccount.isPaused).to.be.true;

    // Execution should now fail
    try {
      await program.methods
        .executeRebalance(-128, 128, new anchor.BN(100), new anchor.BN(0), new anchor.BN(0))
        .accounts({
          vault: vaultPda,
          keeper: keeper.publicKey,
          tokenAVault: tokenAVault,
          tokenBVault: tokenBVault,
          pythPriceFeed: mockPythOracle.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([keeper])
        .rpc();

      expect.fail("Should have failed with VaultPaused");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("VaultPaused");
    }

    // Reset unpause
    await program.methods
      .setEmergencyPause(false)
      .accounts({
        vault: vaultPda,
        authority: authority.publicKey,
      })
      .signers([authority])
      .rpc();
  });
});