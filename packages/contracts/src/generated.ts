/* Generated from packages/contracts/schema.json. Do not edit. */

/**
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "id".
 */
export type Id = string;
/**
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "timestamp".
 */
export type Timestamp = string;
/**
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "sha256".
 */
export type Sha256 = string;
/**
 * Windows drive-absolute syntax only; canonicalization, opened-file identity and allowed roots are application checks
 *
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "local_path".
 */
export type LocalPath = string;
/**
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "conversation_url".
 */
export type ConversationUrl = string;
/**
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "job_state".
 */
export type JobState =
  "queued" | "running" | "waiting_user" | "reconciling" | "unknown" | "succeeded" | "partial" | "failed" | "canceled";
/**
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "phase".
 */
export type Phase = "prepare" | "attach" | "submit" | "generate" | "download" | "complete";
/**
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "submission_state".
 */
export type SubmissionState = "not_sent" | "sending" | "confirmed" | "unknown";
/**
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "mode".
 */
export type Mode = "generate" | "edit";
/**
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "input_role".
 */
export type InputRole = "edit_target" | "reference" | "supporting";
/**
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "capability_state".
 */
export type CapabilityState = "unverified" | "supported" | "unavailable";
/**
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "error_code".
 */
export type ErrorCode =
  | "INPUT_NOT_LOCAL"
  | "INPUT_INVALID"
  | "PATH_DENIED"
  | "IDEMPOTENCY_CONFLICT"
  | "REVISION_CONFLICT"
  | "AUTH_REQUIRED"
  | "HUMAN_CHECK_REQUIRED"
  | "UI_CHANGED"
  | "SUBMISSION_UNKNOWN"
  | "RATE_LIMITED"
  | "GENERATION_REJECTED"
  | "DOWNLOAD_FAILED"
  | "OUTPUT_MISMATCH"
  | "DISK_FULL"
  | "ADAPTER_UNAVAILABLE"
  | "NOT_FOUND"
  | "CAPABILITY_UNAVAILABLE"
  | "STATE_CONFLICT"
  | "EXPORT_CONFLICT"
  | "IO_ERROR";
/**
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "next_action".
 */
export type NextAction =
  | "none"
  | "fix_input"
  | "get_status"
  | "open_app"
  | "reconcile"
  | "resume"
  | "retry_download"
  | "retry_export"
  | "free_disk"
  | "wait"
  | "update_adapter";
/**
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "error".
 */
export type Error = {
  [k: string]: unknown;
} & {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  next_action: NextAction;
  [k: string]: unknown;
};
/**
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "input".
 */
export type Input = {
  path?: LocalPath;
  artifact_id?: Id;
  role: InputRole;
  expected_sha256?: Sha256;
} & Input1;
export type Input1 = {
  [k: string]: unknown;
};
/**
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "job".
 */
export type Job = {
  [k: string]: unknown;
} & {
  job_id: Id;
  request_id: Id;
  session_id: Id;
  mode: Mode;
  state: JobState;
  phase: Phase;
  submission_state: SubmissionState;
  revision: number;
  terminal: boolean;
  requires_action: boolean;
  remote_may_continue: boolean;
  /**
   * @minItems 0
   * @maxItems 4
   */
  artifact_ids: Id[];
  /**
   * @minItems 0
   */
  warnings: Error[];
  error: Error | null;
  created_at: Timestamp;
  updated_at: Timestamp;
  [k: string]: unknown;
};
/**
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "capability".
 */
export type Capability = {
  [k: string]: unknown;
} & {
  state: CapabilityState;
  verified_at: Timestamp | null;
  adapter_version: string | null;
  reason: string | null;
  [k: string]: unknown;
};
/**
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "artifact".
 */
export type Artifact = {
  [k: string]: unknown;
} & {
  artifact_id: Id;
  job_id: Id;
  ordinal: number;
  path: LocalPath;
  sha256: Sha256;
  mime_type: "image/png" | "image/jpeg" | "image/webp";
  size_bytes: number;
  width: number;
  height: number;
  has_alpha: boolean;
  has_transparency: boolean;
  verified_at: Timestamp;
  source: {
    kind: "chatgpt_download";
    session_id: Id;
    conversation_url: ConversationUrl;
    message_id: string | null;
    downloaded_at: Timestamp;
    web_model_id: string | null;
    [k: string]: unknown;
  };
  [k: string]: unknown;
};
/**
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "export_item".
 */
export type ExportItem = {
  [k: string]: unknown;
} & {
  artifact_id: Id;
  state: "pending" | "exported" | "failed";
  path: LocalPath | null;
  sha256: Sha256 | null;
  error: Error | null;
  [k: string]: unknown;
};
/**
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "export".
 */
export type Export = {
  [k: string]: unknown;
} & {
  export_id: Id;
  destination_dir: LocalPath;
  collision: "version" | "error";
  revision: number;
  state: "copying" | "succeeded" | "partial" | "failed";
  /**
   * @minItems 1
   * @maxItems 4
   */
  items: [ExportItem, ...ExportItem[]];
  created_at: Timestamp;
  updated_at: Timestamp;
  [k: string]: unknown;
};
/**
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "session_input".
 */
export type SessionInput =
  | {
      request_id: Id;
      action: "create";
      show?: boolean;
    }
  | {
      request_id: Id;
      action: "show" | "hide";
      session_id: Id;
    }
  | {
      request_id: Id;
      action: "takeover" | "release";
      session_id: Id;
      expected_revision: number;
    };
/**
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "submit_input".
 */
export type SubmitInput = {
  [k: string]: unknown;
} & {
  request_id: Id;
  mode: Mode;
  prompt: string;
  /**
   * @minItems 0
   * @maxItems 8
   */
  inputs?: Input[];
  expected_output?: ExpectedOutput1;
  session_id?: Id;
  parent_job_id?: Id;
};
/**
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "get_input".
 */
export type GetInput = {
  job_id?: Id;
  request_id?: Id;
} & GetInput1;
export type GetInput1 = {
  [k: string]: unknown;
};
/**
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "wait_data".
 */
export type WaitData = {
  [k: string]: unknown;
} & {
  job: Job;
  /**
   * @minItems 0
   * @maxItems 100
   */
  events: Event[];
  cursor: number;
  reason: "changed" | "terminal" | "requires_action" | "timeout" | "resync_required";
  timed_out: boolean;
  resync_required: boolean;
  [k: string]: unknown;
};
/**
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "status_output".
 */
export type StatusOutput =
  | {
      schema_version: "0.1";
      ok: true;
      data: StatusData;
      [k: string]: unknown;
    }
  | ErrorEnvelope;
/**
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "session_output".
 */
export type SessionOutput =
  | {
      schema_version: "0.1";
      ok: true;
      data: SessionData;
      [k: string]: unknown;
    }
  | ErrorEnvelope;
/**
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "submit_output".
 */
export type SubmitOutput =
  | {
      schema_version: "0.1";
      ok: true;
      data: SubmitData;
      [k: string]: unknown;
    }
  | ErrorEnvelope;
/**
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "get_output".
 */
export type GetOutput =
  | {
      schema_version: "0.1";
      ok: true;
      data: GetData;
      [k: string]: unknown;
    }
  | ErrorEnvelope;
/**
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "wait_output".
 */
export type WaitOutput =
  | {
      schema_version: "0.1";
      ok: true;
      data: WaitData;
      [k: string]: unknown;
    }
  | ErrorEnvelope;
/**
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "control_output".
 */
export type ControlOutput =
  | {
      schema_version: "0.1";
      ok: true;
      data: ControlData;
      [k: string]: unknown;
    }
  | ErrorEnvelope;
/**
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "artifacts_output".
 */
export type ArtifactsOutput =
  | {
      schema_version: "0.1";
      ok: true;
      data: ArtifactsData;
      [k: string]: unknown;
    }
  | ErrorEnvelope;
/**
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "export_output".
 */
export type ExportOutput =
  | {
      schema_version: "0.1";
      ok: true;
      data: ExportData;
      [k: string]: unknown;
    }
  | ErrorEnvelope;

export interface ContractTypes {
  id: Id;
  timestamp: Timestamp;
  sha256: Sha256;
  local_path: LocalPath;
  conversation_url: ConversationUrl;
  job_state: JobState;
  phase: Phase;
  submission_state: SubmissionState;
  mode: Mode;
  input_role: InputRole;
  capability_state: CapabilityState;
  error_code: ErrorCode;
  next_action: NextAction;
  error: Error;
  input: Input;
  expected_output: ExpectedOutput;
  session: Session;
  job: Job;
  event: Event;
  capability: Capability;
  artifact: Artifact;
  export_item: ExportItem;
  export: Export;
  status_input: StatusInput;
  session_input: SessionInput;
  submit_input: SubmitInput;
  get_input: GetInput;
  wait_input: WaitInput;
  control_input: ControlInput;
  artifacts_input: ArtifactsInput;
  export_input: ExportInput;
  status_data: StatusData;
  session_data: SessionData;
  submit_data: SubmitData;
  get_data: GetData;
  wait_data: WaitData;
  control_data: ControlData;
  artifacts_data: ArtifactsData;
  export_data: ExportData;
  error_envelope: ErrorEnvelope;
  status_output: StatusOutput;
  session_output: SessionOutput;
  submit_output: SubmitOutput;
  get_output: GetOutput;
  wait_output: WaitOutput;
  control_output: ControlOutput;
  artifacts_output: ArtifactsOutput;
  export_output: ExportOutput;
}
/**
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "expected_output".
 */
export interface ExpectedOutput {
  count?: number;
  width?: number;
  height?: number;
  require_alpha?: boolean;
  strict?: boolean;
}
/**
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "session".
 */
export interface Session {
  session_id: Id;
  profile_id: Id;
  conversation_url: ConversationUrl | null;
  control_owner: "automation" | "manual";
  revision: number;
  window_visible: boolean;
  active_job_id: Id | null;
  [k: string]: unknown;
}
/**
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "event".
 */
export interface Event {
  revision: number;
  at: Timestamp;
  kind:
    | "accepted"
    | "state_changed"
    | "phase_changed"
    | "submission_changed"
    | "artifact_added"
    | "warning_added"
    | "error_changed"
    | "control_applied";
  state: JobState;
  phase: Phase;
  submission_state: SubmissionState;
  [k: string]: unknown;
}
/**
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "status_input".
 */
export interface StatusInput {}
export interface ExpectedOutput1 {
  count?: number;
  width?: number;
  height?: number;
  require_alpha?: boolean;
  strict?: boolean;
}
/**
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "wait_input".
 */
export interface WaitInput {
  job_id: Id;
  after_revision: number;
  timeout_ms?: number;
}
/**
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "control_input".
 */
export interface ControlInput {
  job_id: Id;
  request_id: Id;
  expected_revision: number;
  action: "cancel" | "resume" | "reconcile";
}
/**
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "artifacts_input".
 */
export interface ArtifactsInput {
  job_id: Id;
}
/**
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "export_input".
 */
export interface ExportInput {
  export_id: Id;
  /**
   * @minItems 1
   * @maxItems 4
   */
  artifact_ids: [Id, ...Id[]];
  destination_dir: LocalPath;
  collision?: "version" | "error";
}
/**
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "status_data".
 */
export interface StatusData {
  app_state: "starting" | "ready" | "paused" | "degraded";
  adapter_version: string | null;
  profile: {
    profile_id: Id;
    auth_state: "unknown" | "authenticated" | "auth_required" | "human_check_required" | "account_changed";
    account_verified_at: Timestamp | null;
    [k: string]: unknown;
  };
  queue: {
    waiting_count: number;
    active_job_id: Id | null;
    dispatch_blocked: boolean;
    reason: string | null;
    [k: string]: unknown;
  };
  active_session: Session | null;
  capabilities: {
    web_generate: Capability;
    web_edit: Capability;
    file_attach: Capability;
    hidden_execution: Capability;
    original_download: Capability;
    [k: string]: unknown;
  };
  limits: {
    max_inputs: number;
    input_file_bytes: number;
    input_total_bytes: number;
    prompt_characters: number;
    max_output_count: number;
    download_file_bytes: number;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}
/**
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "session_data".
 */
export interface SessionData {
  deduplicated: boolean;
  outcome: "applied" | "no_change";
  session: Session;
  [k: string]: unknown;
}
/**
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "submit_data".
 */
export interface SubmitData {
  accepted: true;
  deduplicated: boolean;
  job: Job;
  [k: string]: unknown;
}
/**
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "get_data".
 */
export interface GetData {
  job: Job;
  [k: string]: unknown;
}
/**
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "control_data".
 */
export interface ControlData {
  deduplicated: boolean;
  outcome: "applied" | "no_change";
  job: Job;
  [k: string]: unknown;
}
/**
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "artifacts_data".
 */
export interface ArtifactsData {
  job_id: Id;
  /**
   * @minItems 0
   * @maxItems 4
   */
  artifacts: Artifact[];
  [k: string]: unknown;
}
/**
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "export_data".
 */
export interface ExportData {
  deduplicated: boolean;
  export: Export;
  [k: string]: unknown;
}
/**
 * This interface was referenced by `ContractTypes`'s JSON-Schema
 * via the `definition` "error_envelope".
 */
export interface ErrorEnvelope {
  schema_version: "0.1";
  ok: false;
  error: Error;
  [k: string]: unknown;
}
