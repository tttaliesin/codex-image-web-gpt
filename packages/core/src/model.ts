import { createHash } from 'node:crypto';
import type { ContractTypes } from '../../contracts/src';
export type Job = ContractTypes['job'];
export type Session = ContractTypes['session'];
export type Artifact = ContractTypes['artifact'];
export type Export = ContractTypes['export'];
export type Event = ContractTypes['event'];
export type BridgeError = ContractTypes['error'];
export type Submit = ContractTypes['submit_input'];
export type Input = ContractTypes['input'];
export interface StoredInput {
  ordinal: number;
  role: Input['role'];
  source: Input;
  path: string;
  sha256: string;
  bytes: number;
}
export interface JobRecord {
  snapshot: Job;
  request: Submit;
  inputs: StoredInput[];
  digest: string;
  observation_only?: boolean;
  browser_state?: unknown;
}
export interface DownloadedFile {
  path: string;
  source: Artifact['source'];
}
export interface SubmissionAttempt {
  attempt_id: string;
  baseline: unknown;
  evidence?: { conversation_url: string; message_id: string };
}
export interface Receipt {
  digest: string;
  target: string;
  outcome: 'applied' | 'no_change';
}
export class ExecutionInterrupted extends Error {
  constructor() {
    super('EXECUTION_INTERRUPTED');
  }
}
export class Fault extends Error {
  constructor(
    readonly code: BridgeError['code'],
    readonly next: BridgeError['next_action'] = 'fix_input',
    readonly retryable = false,
  ) {
    super(code);
  }
}
export function failure(error: unknown): BridgeError {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  const e =
    error instanceof Fault
      ? error
      : code === 'ENOSPC'
        ? new Fault('DISK_FULL', 'free_disk', true)
        : code === 'ENOENT'
          ? new Fault('NOT_FOUND')
          : code === 'EACCES' || code === 'EPERM'
            ? new Fault('PATH_DENIED')
            : new Fault('IO_ERROR', 'wait', true);
  return { code: e.code, message: e.code, retryable: e.retryable, next_action: e.next };
}
export const now = () => new Date().toISOString();
export const digest = (value: unknown): string =>
  createHash('sha256').update(canonical(value)).digest('hex');
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
export function withoutKey<T extends object>(value: T, key: string): object {
  return Object.fromEntries(Object.entries(value).filter(([name]) => name !== key));
}
export class Serial {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(work: () => Promise<T> | T): Promise<T> {
    const result = this.tail.then(work);
    this.tail = result.catch(() => {});
    return result;
  }
}
