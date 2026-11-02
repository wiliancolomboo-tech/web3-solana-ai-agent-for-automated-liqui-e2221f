import axios from "axios";
import { Resend } from "resend";
import { logger } from "./logger";

export interface RebalanceDigestPayload {
  poolName: string;
  signature: string;
  oldLowerTick: number;
  oldUpperTick: number;
  newLowerTick: number;
  newUpperTick: number;
  kineticScore: number;
  estSlot: number;
}

export class NotificationService {
  private resend: Resend | null = null;
  private discordWebhookUrl?: string;
  private recipientEmail?: string;

  constructor() {
    if (process.env.RESEND_API_KEY) {
      this.resend = new Resend(process.env.RESEND_API_KEY);
    }
    this.discordWebhookUrl = process.env.DISCORD_WEBHOOK_URL;
    this.recipientEmail = process.env.OPERATIONAL_REPORT_EMAIL;
  }

  public async broadcastRebalance(payload: RebalanceDigestPayload): Promise<void> {
    const msg = `⚡ **Kinetic Rebalance Executed** | ${payload.poolName}
• **Tx Hash**: \`${payload.signature}\`
• **Tick Range Transition**: [${payload.oldLowerTick}, ${payload.oldUpperTick}] ➔ [${payload.newLowerTick}, ${payload.newUpperTick}]
• **Kinetic Volatility Score**: \`${payload.kineticScore.toFixed(4)}\`
• **Block Slot**: \`${payload.estSlot}\``;

    // Send Discord Webhook
    if (this.discordWebhookUrl) {
      try {
        await axios.post(this.discordWebhookUrl, { content: msg });
        logger.info("Dispatched Discord alert notification");
      } catch (err: any) {
        logger.error("Failed to deliver Discord webhook", { error: err.message });
      }
    }

    // Send Transactional Executive Digest via Resend
    if (this.resend && this.recipientEmail) {
      try {
        await this.resend.emails.send({
          from: "agents@anti-gravity.dev",
          to: this.recipientEmail,
          subject: `[SOLANA-CLMM] Rebalanced: ${payload.poolName}`,
          html: `
            <h2>Autonomous Kinetic Agent Liquidity Report</h2>
            <p><strong>Pool:</strong> ${payload.poolName}</p>
            <p><strong>Transaction Signature:</strong> <a href="https://solscan.io/tx/${payload.signature}">${payload.signature}</a></p>
            <ul>
              <li><strong>Previous Ticks:</strong> [${payload.oldLowerTick}, ${payload.oldUpperTick}]</li>
              <li><strong>Updated Dynamic Ticks:</strong> [${payload.newLowerTick}, ${payload.newUpperTick}]</li>
              <li><strong>Kinetic Energy Metric:</strong> ${payload.kineticScore.toFixed(6)}</li>
              <li><strong>Slot Height:</strong> ${payload.estSlot}</li>
            </ul>
            <p style="color: #666;">Generated autonomously by Kinetic Rebalance Engine.</p>
          `,
        });
        logger.info("Dispatched Resend operational email report");
      } catch (err: any) {
        logger.error("Failed to send Resend notification", { error: err.message });
      }
    }
  }
}