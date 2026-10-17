import type { Database } from "bun:sqlite";

import { eventLog } from "../events/log";

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

export interface BoardApprovalRequirement {
  issueId: string;
  stageId: string;
  changedAt: string;
}

export interface BoardApproval extends Omit<ManualGateApproval, "gateId"> {}

interface ApprovalRow { issue_id: string; stage_id: string; gate_id: string; stage_epoch: number; attempt: number; account_id: string; account_name: string; approved_at: string }
interface BoardRequirementRow { issue_id: string; stage_id: string; changed_at: string }
interface BoardApprovalRow { issue_id: string; stage_id: string; stage_epoch: number; attempt: number; account_id: string; account_name: string; approved_at: string }

/** Durable board requirements and append-only configured-manual and board approval receipts. */
export class ManualGateApprovals {
  constructor(private readonly database: Database) {}

  setBoardApprovalRequirement(input: BoardApprovalRequirement & { required: boolean }): void {
    this.database.transaction(() => {
      const before = this.hasBoardApprovalRequirement(input.issueId, input.stageId);
      if (input.required) {
        this.database.query(
          `INSERT INTO item_board_approval_requirements(issue_id, stage_id, changed_at) VALUES (?, ?, ?)
           ON CONFLICT(issue_id, stage_id) DO UPDATE SET changed_at = excluded.changed_at`,
        ).run(input.issueId, input.stageId, input.changedAt);
      } else {
        this.database.query("DELETE FROM item_board_approval_requirements WHERE issue_id = ? AND stage_id = ?")
          .run(input.issueId, input.stageId);
      }
      if (before !== input.required) {
        eventLog(this.database).append("gate.boardApprovalChanged", { stageId: input.stageId, required: input.required }, { issueId: input.issueId });
      }
    })();
  }

  hasBoardApprovalRequirement(issueId: string, stageId: string): boolean {
    return this.database.query(
      "SELECT 1 FROM item_board_approval_requirements WHERE issue_id = ? AND stage_id = ?",
    ).get(issueId, stageId) !== null;
  }

  listBoardApprovalRequirements(issueId: string): BoardApprovalRequirement[] {
    return (this.database.query(
      "SELECT issue_id, stage_id, changed_at FROM item_board_approval_requirements WHERE issue_id = ? ORDER BY stage_id",
    ).all(issueId) as BoardRequirementRow[]).map((row) => ({
      issueId: row.issue_id, stageId: row.stage_id, changedAt: row.changed_at,
    }));
  }


  /** Returns false for a harmless duplicate receipt. */
  approve(input: ManualGateApproval): boolean {
    return this.database.transaction(() => {
      const result = this.database.query(
        `INSERT INTO manual_gate_approvals(issue_id, stage_id, gate_id, stage_epoch, attempt, account_id, account_name, approved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(issue_id, stage_id, gate_id, stage_epoch, attempt) DO NOTHING`,
      ).run(input.issueId, input.stageId, input.gateId, input.stageEpoch, input.attempt, input.accountId, input.accountName, input.approvedAt);
      if (result.changes > 0) eventLog(this.database).append("gate.approved", { stageId: input.stageId, gateId: input.gateId, stageEpoch: input.stageEpoch, attempt: input.attempt }, { issueId: input.issueId });
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

  /** Returns false for a harmless duplicate receipt for this stage visit. */
  approveBoard(input: BoardApproval): boolean {
    return this.database.transaction(() => {
      const result = this.database.query(
        `INSERT INTO board_approvals(issue_id, stage_id, stage_epoch, attempt, account_id, account_name, approved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(issue_id, stage_id, stage_epoch, attempt) DO NOTHING`,
      ).run(input.issueId, input.stageId, input.stageEpoch, input.attempt, input.accountId, input.accountName, input.approvedAt);
      if (result.changes > 0) eventLog(this.database).append("gate.boardApproved", { stageId: input.stageId, stageEpoch: input.stageEpoch, attempt: input.attempt }, { issueId: input.issueId });
      return result.changes > 0;
    })();
  }

  getBoardApproval(issueId: string, stageId: string, stageEpoch: number, attempt: number): BoardApproval | null {
    const row = this.database.query(
      `SELECT issue_id, stage_id, stage_epoch, attempt, account_id, account_name, approved_at
       FROM board_approvals WHERE issue_id = ? AND stage_id = ? AND stage_epoch = ? AND attempt = ?`,
    ).get(issueId, stageId, stageEpoch, attempt) as BoardApprovalRow | null;
    return row === null ? null : {
      issueId: row.issue_id, stageId: row.stage_id, stageEpoch: row.stage_epoch, attempt: row.attempt,
      accountId: row.account_id, accountName: row.account_name, approvedAt: row.approved_at,
    };
  }
}
