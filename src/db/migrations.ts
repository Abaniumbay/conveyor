export interface Migration {
  version: number;
  sql: string;
}

export const migrations: readonly Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE config_snapshots (
        hash TEXT PRIMARY KEY,
        config_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE repositories (
        id TEXT PRIMARY KEY,
        config_name TEXT NOT NULL UNIQUE,
        source TEXT NOT NULL,
        address TEXT NOT NULL,
        folder TEXT NOT NULL,
        config_hash TEXT NOT NULL,
        health TEXT NOT NULL DEFAULT 'unknown',
        last_reconciled_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE issues (
        id TEXT PRIMARY KEY,
        repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
        source_number INTEGER NOT NULL,
        source_url TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        source_state TEXT NOT NULL,
        labels_json TEXT NOT NULL,
        source_updated_at TEXT NOT NULL,
        queue_rank REAL,
        parent_id TEXT REFERENCES issues(id) ON DELETE SET NULL,
        projected_stage TEXT,
        projected_state TEXT,
        warning TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(repository_id, source_number)
      );

      CREATE INDEX issues_repository_idx ON issues(repository_id);
      CREATE INDEX issues_queue_rank_idx ON issues(queue_rank);

      CREATE TABLE issue_relationships (
        parent_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
        child_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
        sibling_order INTEGER,
        PRIMARY KEY(parent_id, child_id)
      );

      CREATE TABLE dependencies (
        issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
        blocker_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
        PRIMARY KEY(issue_id, blocker_id)
      );

      CREATE TABLE enrollments (
        id TEXT PRIMARY KEY,
        issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
        generation INTEGER NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        UNIQUE(issue_id, generation)
      );

      CREATE TABLE workspaces (
        id TEXT PRIMARY KEY,
        enrollment_id TEXT NOT NULL REFERENCES enrollments(id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        branch TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        removed_at TEXT
      );

      CREATE TABLE pull_requests (
        id TEXT PRIMARY KEY,
        enrollment_id TEXT NOT NULL REFERENCES enrollments(id) ON DELETE CASCADE,
        source_number INTEGER NOT NULL,
        url TEXT NOT NULL,
        state TEXT NOT NULL,
        merged_at TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE stage_states (
        issue_id TEXT PRIMARY KEY REFERENCES issues(id) ON DELETE CASCADE,
        stage_id TEXT NOT NULL,
        status TEXT NOT NULL,
        feedback_cycle INTEGER NOT NULL DEFAULT 0,
        config_hash TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE stage_attempts (
        id TEXT PRIMARY KEY,
        issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
        stage_id TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        outcome TEXT,
        status TEXT NOT NULL,
        result_json TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        UNIQUE(issue_id, stage_id, attempt)
      );

      CREATE TABLE stage_transitions (
        id TEXT PRIMARY KEY,
        issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
        from_stage TEXT,
        to_stage TEXT,
        status TEXT NOT NULL,
        source_mutation_id TEXT,
        created_at TEXT NOT NULL,
        completed_at TEXT
      );

      CREATE TABLE feedback_cycles (
        id TEXT PRIMARY KEY,
        issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
        boundary_stage TEXT NOT NULL,
        cycle INTEGER NOT NULL,
        reason TEXT NOT NULL,
        required_fixes_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE runs (
        id TEXT PRIMARY KEY,
        issue_id TEXT REFERENCES issues(id) ON DELETE SET NULL,
        stage_id TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        config_hash TEXT NOT NULL,
        session_id TEXT,
        pid INTEGER,
        started_at TEXT NOT NULL,
        heartbeat_at TEXT,
        finished_at TEXT,
        exit_code INTEGER,
        result_json TEXT
      );

      CREATE TABLE run_leases (
        run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
        owner TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE run_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(run_id, sequence)
      );

      CREATE TABLE questions (
        id TEXT PRIMARY KEY,
        issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
        run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
        prompt TEXT NOT NULL,
        reason TEXT NOT NULL,
        options_json TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        answered_at TEXT
      );

      CREATE UNIQUE INDEX questions_one_open_per_issue
        ON questions(issue_id) WHERE status = 'open';

      CREATE TABLE answers (
        id TEXT PRIMARY KEY,
        question_id TEXT NOT NULL UNIQUE REFERENCES questions(id) ON DELETE CASCADE,
        source TEXT NOT NULL,
        answer_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE source_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL,
        delivery_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        received_at TEXT NOT NULL,
        UNIQUE(source, delivery_id)
      );

      CREATE TABLE source_mutations (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        source TEXT NOT NULL,
        operation TEXT NOT NULL,
        status TEXT NOT NULL,
        request_json TEXT NOT NULL,
        response_json TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE artifacts (
        id TEXT PRIMARY KEY,
        run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
        name TEXT NOT NULL,
        path TEXT NOT NULL,
        media_type TEXT,
        size_bytes INTEGER,
        created_at TEXT NOT NULL
      );

      CREATE TABLE log_files (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        stream TEXT NOT NULL,
        path TEXT NOT NULL,
        size_bytes INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );

      CREATE TABLE usage_cost_entries (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cached_tokens INTEGER NOT NULL DEFAULT 0,
        amount REAL NOT NULL DEFAULT 0,
        currency TEXT NOT NULL DEFAULT 'USD',
        source TEXT NOT NULL,
        duration_ms INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE source_cursors (
        repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
        cursor_type TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(repository_id, cursor_type)
      );

      CREATE TABLE web_sessions (
        id_hash TEXT PRIMARY KEY,
        csrf_hash TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 2,
    sql: `
      ALTER TABLE questions ADD COLUMN min_selections INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE questions ADD COLUMN max_selections INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE questions ADD COLUMN allow_free_text INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    version: 3,
    sql: `
      ALTER TABLE issues ADD COLUMN source_state_reason TEXT;
    `,
  },
  {
    version: 4,
    sql: `
      CREATE TABLE conversation_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
        run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
        stage_id TEXT,
        actor_type TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        actor_name TEXT NOT NULL,
        actor_title TEXT,
        message TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX conversation_messages_issue_idx
        ON conversation_messages(issue_id, id);
    `,
  },
  {
    version: 5,
    sql: `
      ALTER TABLE stage_transitions ADD COLUMN kind TEXT NOT NULL DEFAULT 'observed';
      ALTER TABLE stage_transitions ADD COLUMN detail_json TEXT NOT NULL DEFAULT '{}';

      CREATE INDEX stage_transitions_issue_idx
        ON stage_transitions(issue_id, created_at, id);

      WITH ordered_runs AS (
        SELECT
          id AS run_id,
          issue_id,
          stage_id,
          started_at,
          LAG(stage_id) OVER (
            PARTITION BY issue_id ORDER BY started_at, id
          ) AS previous_stage,
          LAG(result_json) OVER (
            PARTITION BY issue_id ORDER BY started_at, id
          ) AS previous_result
        FROM runs
        WHERE issue_id IS NOT NULL
      )
      INSERT INTO stage_transitions(
        id, issue_id, from_stage, to_stage, status, source_mutation_id,
        created_at, completed_at, kind, detail_json
      )
      SELECT
        'backfill:' || run_id,
        issue_id,
        previous_stage,
        stage_id,
        'completed',
        NULL,
        started_at,
        started_at,
        CASE
          WHEN previous_stage IS NULL THEN 'onboarded'
          WHEN json_extract(previous_result, '$.status') = 'changes-requested' THEN 'correction'
          ELSE 'advance'
        END,
        json_object(
          'reason', COALESCE(
            json_extract(previous_result, '$.reason'),
            json_extract(previous_result, '$.summary'),
            CASE WHEN previous_stage IS NULL THEN 'First recorded Conveyor run.' ELSE NULL END
          ),
          'requiredFixes', json('[]'),
          'resultStatus', json_extract(previous_result, '$.status')
        )
      FROM ordered_runs
      WHERE previous_stage IS NULL OR previous_stage <> stage_id;
    `,
  },
  {
    version: 6,
    sql: `
      CREATE TABLE item_contexts (
        issue_id TEXT PRIMARY KEY REFERENCES issues(id) ON DELETE CASCADE,
        schema_version INTEGER NOT NULL,
        config_hash TEXT NOT NULL,
        version INTEGER NOT NULL,
        stage_epoch INTEGER NOT NULL DEFAULT 0,
        context_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE context_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        stage TEXT NOT NULL,
        stage_epoch INTEGER NOT NULL,
        task_instance_id TEXT NOT NULL,
        context_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX context_history_issue_idx ON context_history(issue_id, version);

      CREATE TABLE task_executions (
        id TEXT PRIMARY KEY,
        issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
        stage TEXT NOT NULL,
        stage_epoch INTEGER NOT NULL,
        attempt INTEGER NOT NULL,
        list TEXT NOT NULL,
        task_instance_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL,
        recovery_state TEXT NOT NULL,
        started_at TEXT NOT NULL,
        pending_since TEXT,
        wake_at TEXT,
        deadline_at TEXT,
        result_json TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX task_executions_issue_idx ON task_executions(issue_id, started_at);

      CREATE TABLE stage_cursors (
        issue_id TEXT PRIMARY KEY REFERENCES issues(id) ON DELETE CASCADE,
        stage TEXT NOT NULL,
        stage_epoch INTEGER NOT NULL,
        attempt INTEGER NOT NULL,
        returns INTEGER NOT NULL,
        list TEXT NOT NULL,
        task_instance_id TEXT,
        state TEXT NOT NULL,
        feedback_json TEXT,
        pending_since TEXT,
        wake_at TEXT,
        deadline_at TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX stage_cursors_wake_idx ON stage_cursors(wake_at);
    `,
  },
  {
    version: 7,
    sql: `
      -- Durable CI gate facts per (item, head): first sight, announcement, reruns, started checks.
      CREATE TABLE ci_marks (
        issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
        head_sha TEXT NOT NULL,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (issue_id, head_sha, kind, name)
      );
    `,
  },
  {
    version: 8,
    sql: `
      -- Durable advisory CI watches: outlive the stage that started them and never route the item.
      CREATE TABLE advisory_ci_watches (
        id TEXT PRIMARY KEY,
        repository_id TEXT NOT NULL,
        item_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
        head_sha TEXT NOT NULL,
        stage TEXT NOT NULL,
        change_id TEXT NOT NULL,
        change_url TEXT NOT NULL,
        state TEXT NOT NULL,
        started_at TEXT NOT NULL,
        settle_ms INTEGER NOT NULL,
        wake_at TEXT NOT NULL,
        deadline_at TEXT NOT NULL,
        announced_at TEXT,
        final_message_at TEXT,
        UNIQUE (repository_id, item_id, head_sha)
      );
      CREATE INDEX advisory_ci_watches_wake_idx ON advisory_ci_watches(state, wake_at);
    `,
  },
  {
    version: 9,
    sql: `
      -- Reviewer approvals of acceptance criteria, bound to the change head they were given for.
      CREATE TABLE criterion_approvals (
        issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
        criterion_id TEXT NOT NULL,
        reviewer TEXT NOT NULL,
        head_sha TEXT NOT NULL,
        checked_at TEXT NOT NULL,
        PRIMARY KEY (issue_id, criterion_id)
      );
    `,
  },
];
