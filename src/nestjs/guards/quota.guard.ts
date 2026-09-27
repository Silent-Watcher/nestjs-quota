import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { QuotaEngine } from '../../core/application/engine.js';
import { isQuotaError, QuotaExceededError, QuotaStoreError } from '../../core/errors/errors.js';
import type { QuotaStatus } from '../../core/application/types.js';
import { QUOTA_METADATA_KEY, SKIP_QUOTA_METADATA_KEY, QUOTA_ENGINE } from '../tokens/tokens.js';
import type { QuotaRouteOptions } from '../decorators/quota.decorator.js';
import type { QuotaModuleOptions } from '../module/quota-module-options.js';
import { applyQuotaHeaders } from '../context/http-response.js';
import { QUOTA_REQUEST_STATE, type QuotaCarryingRequest } from '../context/request-marker.js';
import { QUOTA_MODULE_OPTIONS } from '../tokens/tokens.js';

/**
 * NestJS guard that turns `@Quota()` metadata into an actual quota
 * check/consume/reserve against the shared `QuotaEngine`.
 *
 * Single-purpose by design: it resolves metadata, identity and cost, talks
 * to the engine, attaches the resulting statuses to the request, and
 * allows/rejects. It does not implement business logic beyond that.
 */
@Injectable()
export class QuotaGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(QUOTA_ENGINE) private readonly engine: QuotaEngine,
    @Inject(QUOTA_MODULE_OPTIONS) private readonly options: QuotaModuleOptions,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const skip = this.reflector.getAllAndOverride<boolean>(SKIP_QUOTA_METADATA_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (skip) return true;

    const routeOptions = this.reflector.getAllAndOverride<QuotaRouteOptions | undefined>(
      QUOTA_METADATA_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!routeOptions) return true; // route without quota metadata: not this guard's concern

    const httpCtx = context.switchToHttp();
    const request = httpCtx.getRequest<QuotaCarryingRequest>();

    // Double-charge guard: if a previous QuotaGuard instance already
    // processed this exact request (e.g. a global guard + a controller
    // guard both registered), do not consume again.
    if (request[QUOTA_REQUEST_STATE]?.handled) {
      return true;
    }

    const mode = routeOptions.mode ?? this.options.defaultMode ?? 'consume';

    const applications = await Promise.all(
      routeOptions.policies.map(async (p) => {
        const policyName = typeof p === 'string' ? p : p.policy;
        const staticCost = typeof p === 'string' ? undefined : p.cost;
        const subject = await this.options.identityResolver({ raw: context, policy: policyName });
        const cost = staticCost ?? (await this.options.costResolver?.({ raw: context, policy: policyName }));
        return { policy: policyName, subject, cost };
      }),
    );

    try {
      let statuses: readonly QuotaStatus[];
      let retryAfterSeconds: number | undefined;

      if (mode === 'reserve') {
        // Reservation mode currently supports a single policy application per route,
        // matching the engine's single-policy reservation semantics (see docs/design.md).
        const app = applications[0];
        if (!app) throw new QuotaStoreError('no policy application resolved for reservation');
        const { handle, result } = await this.engine.reserve(
          app,
          request,
          routeOptions.reservationLeaseMs,
        );
        (request as Record<string, unknown>).quotaReservation = handle;
        statuses = result.decision.statuses;
      } else {
        const op = { applications, context: request };
        const result = mode === 'check' ? await this.engine.check(op) : await this.engine.consume(op);
        if (result.decision.kind === 'rejected') {
          statuses = result.decision.statuses;
          retryAfterSeconds = result.decision.retryAfterSeconds;
          applyQuotaHeaders(httpCtx.getResponse(), result.decision.statuses, this.options.headers, retryAfterSeconds);
          const violated = result.decision.violated?.[0];
          throw new QuotaExceededError(
            `quota exceeded${violated ? ` for policy "${violated.policy}"` : ''}`,
            {
              policy: String(violated?.policy ?? applications[0]?.policy ?? ''),
              scope: '',
              subject: String(applications[0]?.subject ?? ''),
              limit: violated?.limit ?? 0,
              used: violated?.used ?? 0,
              remaining: violated?.remaining ?? 0,
              resetAt: violated?.resetAt ?? new Date(),
              requestedCost: applications[0]?.cost ?? 1,
            },
          );
        }
        statuses = result.decision.statuses;
      }

      request[QUOTA_REQUEST_STATE] = { handled: true, statuses };
      applyQuotaHeaders(httpCtx.getResponse(), statuses, this.options.headers);
      return true;
    } catch (err) {
      if (err instanceof QuotaExceededError) {
        throw new HttpException(
          {
            error: 'QUOTA_EXCEEDED',
            message: err.message,
            ...err.metadata,
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      if (err instanceof QuotaStoreError || (isQuotaError(err) && !(err instanceof QuotaExceededError))) {
        // Infrastructure failure (fail-closed) or any other engine error:
        // never surfaced as 429, since it is not "quota exceeded".
        throw new HttpException(
          { error: 'QUOTA_UNAVAILABLE', message: 'quota system unavailable' },
          HttpStatus.SERVICE_UNAVAILABLE,
        );
      }
      throw err;
    }
  }
}
