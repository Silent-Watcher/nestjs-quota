import { Inject, Injectable } from '@nestjs/common';
import { QuotaEngine } from '../../core/application/engine.js';
import type { QuotaOperationRequest, PolicyApplication } from '../../core/application/engine.js';
import type { QuotaResult, QuotaStatus, ReservationHandle } from '../../core/application/types.js';
import { QUOTA_ENGINE } from '../tokens/tokens.js';

/**
 * Thin injectable wrapper around `QuotaEngine`, for application code that
 * wants to check/consume/inspect quotas outside of the guard (e.g. from a
 * service method, a background job, or a GraphQL resolver).
 */
@Injectable()
export class QuotaService<TContext = unknown> {
  constructor(@Inject(QUOTA_ENGINE) private readonly engine: QuotaEngine<TContext>) {}

  check(request: QuotaOperationRequest<TContext>): Promise<QuotaResult> {
    return this.engine.check(request);
  }

  consume(request: QuotaOperationRequest<TContext>): Promise<QuotaResult> {
    return this.engine.consume(request);
  }

  consumeOrThrow(request: QuotaOperationRequest<TContext>): Promise<QuotaResult> {
    return this.engine.consumeOrThrow(request);
  }

  recordUsage(request: QuotaOperationRequest<TContext>): Promise<readonly QuotaStatus[]> {
    return this.engine.recordUsage(request);
  }

  getUsage(policy: string, subject: string): Promise<QuotaStatus> {
    return this.engine.getUsage(policy, subject);
  }

  reserve(
    application: PolicyApplication,
    context: TContext,
    leaseMs?: number,
  ): Promise<{ handle: ReservationHandle; result: QuotaResult }> {
    return this.engine.reserve(application, context, leaseMs);
  }

  commitReservation(reservationId: string): Promise<QuotaStatus> {
    return this.engine.commitReservation(reservationId);
  }

  releaseReservation(reservationId: string): Promise<void> {
    return this.engine.releaseReservation(reservationId);
  }
}
