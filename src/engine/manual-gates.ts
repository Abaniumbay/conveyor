import type { Database } from "bun:sqlite";

import { eventLog } from "../events/log";

export interface ManualGateRequirement {
  issueId: string;
  stageId: string;
  gateId: string;
  changedAt: string;
}

export interface ManualGateApproval {
  issueId: string;
  stageId: string;
  gateId: string;
  stageEpoch: number;
  attempt: number;
  accountId: string;
  accountName: string;
  approvedAt: string;
}

interface RequirementRow { issue_id: string; stage_id: string; gate_id: string; changed_at: string }
interface ApprovalRow extends RequirementRow { stage_epoch: number; attempt: number; account_id: string; account_name: string; approved_at: string }

/** Durable item-specific requirements and the append-only stage-visit approval receipts. */
export class ManualGateApprovals {
  constructor(private readonly database: Database) {}

  setRequirement(input: ManualGateRequirement & { required: boolean }): void {
    this.database.transaction(() => {
      const before = this.hasItemRequirement(input.issueId, input.stageId, input.gateId);
      if (input.required) {
        this.database.query(
          `INSERT INTO item_manual_gate_requirements(issue_id, stage_id, gate_id, changed_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(issue_id, stage_id, gate_id) DO UPDATE SET changed_at = excluded.changed_at`,
        ).run(input.issueId, input.stageId, input.gateId, input.changedAt);
      } else {
        this.database.query(
          "DELETE FROM item_manual_gate_requirements WHERE issue_id = ? AND stage_id = ? AND gate_id = ?",
        ).run(input.issueId, input.stageId, input.gateId);
      }
      const changed = before !== input.required;
      if (changed) {
        eventLog(this.database).append("gate.requirementChanged", { stageId: input.stageId, gateId: input.gateId, required: input.required }, { issueId: input.issueId });
      }
    })();
  }

  hasItemRequirement(issueId: string, stageId: string, gateId: string): boolean {
    return this.database.query(
      "SELECT 1 FROM item_manual_gate_requirements WHERE issue_id = ? AND stage_id = ? AND gate_id = ?",
    ).get(issueId, stageId, gateId) !== null;
  }

  listRequirements(issueId: string): ManualGateRequirement[] {
    return (this.database.query(
      "SELECT issue_id, stage_id, gate_id, changed_at FROM item_manual_gate_requirements WHERE issue_id = ? ORDER BY stage_id, gate_id",
    ).all(issueId) as RequirementRow[]).map((row) => ({
      issueId: row.issue_id, stageId: row.stage_id, gateId: row.gate_id, changedAt: row.changed_at,
    }));
  }

  /** Returns false for a harmless duplicate receipt. */
  approve(input: ManualGateApproval): boolean {
    return this.database.transaction(() => {
      const result = this.database.query(
        `INSERT INTO manual_gate_approvals(issue_id, stage_id, gate_id, stage_epoch, attempt, account_id, account_name, approved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(issue_id, stage_id, gate_id, stage_epoch, attempt) DO NOTHING`,
      ).run(input.issueId, input.stageId, input.gateId, input.stageEpoch, input.attempt, input.accountId, input.accountName, input.approvedAt);
      if (result.changes > 0) eventLog(this.database).append("gate.approved", { stageId: input.stageId, gateId: input.gateId }, { issueId: input.issueId });
      return result.changes > 0;
    })();
  }

  getApproval(issueId: string, stageId: string, gateId: string, stageEpoch: number, attempt: number): ManualGateApproval | null {
    const row = this.database.query(
      `SELECT issue_id, stage_id, gate_id, stage_epoch, attempt, account_id, account_name, approved_at
       FROM manual_gate_approvals WHERE issue_id = ? AND stage_id = ? AND gate_id = ? AND stage_epoch = ? AND attempt = ?`,
    ).get(issueId, stageId, gateId, stageEpoch, attempt) as ApprovalRow | null;
    return row === null ? null : {
      issueId: row.issue_id, stageId: row.stage_id, gateId: row.gate_id, stageEpoch: row.stage_epoch, attempt: row.attempt,
      accountId: row.account_id, accountName: row.account_name, approvedAt: row.approved_at,
    };
  }
}
