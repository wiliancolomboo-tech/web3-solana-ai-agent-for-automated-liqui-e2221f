import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { KineticRebalancer } from "../target/types/kinetic_rebalancer";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, createMint, createAccount, mintTo } from "@solana/spl-token";
import { expect } from "chai";

describe("kinetic-rebalancer test suite", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.KineticRebalancer as Program<KineticRebalancer>;

  let owner: Keypair;
  let operator: Keypair;
  let maliciousUser: Keypair;
  let tokenAMint: PublicKey;
  let tokenBMint: PublicKey;
  let vaultStatePda: PublicKey;
  let vaultAuthPda: PublicKey;
  let tokenAVault: Keypair;
  let tokenBVault: Keypair;

  before(async () => {
    owner = Keypair.generate();
    operator = Keypair.generate();
    maliciousUser = Keypair.generate();
    tokenAVault = Keypair.generate();
    tokenBVault = Keypair.generate();

    // Fund test wallets
    for (const kp of [owner, operator, maliciousUser]) {
      const sig = await provider.connection.requestAirdrop(kp.publicKey, 10 * anchor.web3.LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(sig);
    }

    // Create Mints
    tokenAMint = await createMint(provider.connection, owner, owner.publicKey, null, 6);
    tokenBMint = await createMint(provider.connection, owner, owner.publicKey, null, 6);

    [vaultStatePda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("kinetic_vault"),
        owner.publicKey.toBuffer(),
        tokenAMint.toBuffer(),
        tokenBMint.toBuffer(),
      ],
      program.programId
    );

    [vaultAuthPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("kinetic_authority")],
      program.programId
    );
  });

  it("1. Successfully initializes a non-custodial kinetic vault", async () => {
    const maxSlippageBps = 100; // 1%
    const cooldownSeconds = new anchor.BN(10);

    await program.methods
      .initializeVault(maxSlippageBps, cooldownSeconds)
      .accounts({
        owner: owner.publicKey,
        operator: operator.publicKey,
        tokenAMint: tokenAMint,
        tokenBMint: tokenBMint,
        vaultState: vaultStatePda,
        vaultAuthority: vaultAuthPda,
        tokenAVault: tokenAVault.publicKey,
        tokenBVault: tokenBVault.publicKey,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([owner, tokenAVault, tokenBVault])
      .rpc();

    const vaultAccount = await program.account.vaultState.fetch(vaultStatePda);
    expect(vaultAccount.owner.toBase58()).to.equal(owner.publicKey.toBase58());
    expect(vaultAccount.operator.toBase58()).to.equal(operator.publicKey.toBase58());
    expect(vaultAccount.maxSlippageBps).to.equal(100);
    expect(vaultAccount.totalRebalanceCount.toNumber()).to.equal(0);
  });

  it("2. Rejects initialization with excessive slippage (>5%)", async () => {
    const invalidSlippage = 600; // 6%
    const tempOwner = Keypair.generate();
    const sig = await provider.connection.requestAirdrop(tempOwner.publicKey, 2 * anchor.web3.LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(sig);

    const [tempVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("kinetic_vault"), tempOwner.publicKey.toBuffer(), tokenAMint.toBuffer(), tokenBMint.toBuffer()],
      program.programId
    );

    try {
      await program.methods
        .initializeVault(invalidSlippage, new anchor.BN(10))
        .accounts({
          owner: tempOwner.publicKey,
          operator: operator.publicKey,
          tokenAMint: tokenAMint,
          tokenBMint: tokenBMint,
          vaultState: tempVaultPda,
          vaultAuthority: vaultAuthPda,
          tokenAVault: Keypair.generate().publicKey,
          tokenBVault: Keypair.generate().publicKey,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .signers([tempOwner])
        .rpc();
      expect.fail("Should have failed with ExcessiveSlippageSetting");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("ExcessiveSlippageSetting");
    }
  });

  it("3. Executes valid kinetic rebalance by authorized operator", async () => {
    const targetLowerTick = -1200;
    const targetUpperTick = 1200;
    const minTokenA = new anchor.BN(0);
    const minTokenB = new anchor.BN(0);

    const tx = await program.methods
      .executeRebalance(targetLowerTick, targetUpperTick, minTokenA, minTokenB)
      .accounts({
        operator: operator.publicKey,
        vaultState: vaultStatePda,
        vaultAuthority: vaultAuthPda,
        tokenAVault: tokenAVault.publicKey,
        tokenBVault: tokenBVault.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([operator])
      .rpc();

    expect(tx).to.be.a("string");
    const vaultAccount = await program.account.vaultState.fetch(vaultStatePda);
    expect(vaultAccount.totalRebalanceCount.toNumber()).to.equal(1);
  });

  it("4. Rejects rebalance attempts within the cooldown window", async () => {
    try {
      await program.methods
        .executeRebalance(-1000, 1000, new anchor.BN(0), new anchor.BN(0))
        .accounts({
          operator: operator.publicKey,
          vaultState: vaultStatePda,
          vaultAuthority: vaultAuthPda,
          tokenAVault: tokenAVault.publicKey,
          tokenBVault: tokenBVault.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([operator])
        .rpc();
      expect.fail("Should have failed due to active cooldown");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("CooldownActive");
    }
  });

  it("5. Rejects unauthorized callers attempting to rebalance", async () => {
    try {
      await program.methods
        .executeRebalance(-800, 800, new anchor.BN(0), new anchor.BN(0))
        .accounts({
          operator: maliciousUser.publicKey,
          vaultState: vaultStatePda,
          vaultAuthority: vaultAuthPda,
          tokenAVault: tokenAVault.publicKey,
          tokenBVault: tokenBVault.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([maliciousUser])
        .rpc();
      expect.fail("Should have thrown UnauthorizedOperator");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("UnauthorizedOperator");
    }
  });
});