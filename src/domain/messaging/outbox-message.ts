import { IntegrationEvent } from '../events/integration-event';
import { DomainError } from '../shared/errors';

export interface OutboxMessageState {
  id: string; aggregateId: string; eventType: string; payload: Record<string, unknown>;
  occurredAt: Date; attempts: number; nextAttemptAt?: Date; publishedAt?: Date;
}

const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 5 * 60_000;

export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt?: Date,
    private _publishedAt?: Date,
  ) {}

  static enqueue(e: IntegrationEvent<unknown>): OutboxMessage {
    return new OutboxMessage(e.eventId, e.aggregateId, e.eventType,
      Object.freeze(e.toJSON() as unknown as Record<string, unknown>), e.occurredAt, 0, e.occurredAt);
  }
  static rehydrate(s: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(s.id, s.aggregateId, s.eventType, s.payload, s.occurredAt,
      s.attempts, s.nextAttemptAt, s.publishedAt);
  }

  get attempts(): number { return this._attempts; }
  get nextAttemptAt(): Date | undefined { return this._nextAttemptAt; }
  get publishedAt(): Date | undefined { return this._publishedAt; }

  isPending(): boolean { return this._publishedAt === undefined; }
  isDue(now: Date): boolean {
    return this.isPending() && (this._nextAttemptAt === undefined || this._nextAttemptAt <= now);
  }
  markPublished(at: Date): void {
    if (!this.isPending()) throw new DomainError('OUTBOX_ALREADY_PUBLISHED', this.id);
    this._publishedAt = at;
  }
  /** attempts+1; atraso exponencial: min(1s × 2^attempts, 5min), com jitter de até 20%. */
  scheduleRetry(now: Date): void {
    if (!this.isPending()) throw new DomainError('OUTBOX_ALREADY_PUBLISHED', this.id);
    const base = Math.min(BASE_DELAY_MS * 2 ** this._attempts, MAX_DELAY_MS);
    const delay = base + Math.floor(Math.random() * base * 0.2);
    this._attempts += 1;
    this._nextAttemptAt = new Date(now.getTime() + delay);
  }
}