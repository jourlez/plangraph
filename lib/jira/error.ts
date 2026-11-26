// lib/jira/error.ts: JiraError, the one error type of the Jira reader; its message is redacted when it is built.
import { redact } from './redact.ts';
import type { JiraErrorCode } from './types.ts';

export class JiraError extends Error {
  // `declare`: type-only fields (no class-field initializer at run time, so status and resetAt stay absent unless given)
  declare readonly code: JiraErrorCode;
  declare status?: number;
  declare resetAt?: string;
  constructor(code: JiraErrorCode, message: string, extra: { status?: number; resetAt?: string | undefined } = {}) {
    super(redact(message)); this.name = 'JiraError'; (this as { code: JiraErrorCode }).code = code; // the one write of the readonly code
    if (extra.status !== undefined) this.status = extra.status;
    if (extra.resetAt !== undefined) this.resetAt = extra.resetAt;
  }
}
