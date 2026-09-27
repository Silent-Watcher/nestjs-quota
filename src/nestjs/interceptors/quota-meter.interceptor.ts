import {
  CallHandler,
  ExecutionContext,
  Inject,
  Injectable,
  NestInterceptor,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { QuotaEngine } from '../../core/application/engine.js';
import { QUOTA_ENGINE } from '../tokens/tokens.js';
import type { QuotaModuleOptions } from '../module/quota-module-options.js';
import { QUOTA_MODULE_OPTIONS } from '../tokens/tokens.js';

export const QUOTA_METER_METADATA_KEY = Symbol('QUOTA_METER_METADATA_KEY');

export interface QuotaMeterOptions<TResult = unknown> {
  readonly policy: string;
  /** Computes the actual usage amount from the handler's return value. */
  readonly amountFromResult: (result: TResult) => number;
}

/**
 * Declares post-handler usage metering: the actual cost is only known once
 * the handler has produced a result (e.g. LLM token counts, response size,
 * number of generated records). This is metering, not admission control —
 * pair it with a separate pre-request `@Quota()` check/consume if the
 * operation should also be gated up-front.
 */
export function MeterUsage<TResult = unknown>(
  options: QuotaMeterOptions<TResult>,
): MethodDecorator {
  return SetMetadata(QUOTA_METER_METADATA_KEY, options);
}

@Injectable()
export class QuotaMeterInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    @Inject(QUOTA_ENGINE) private readonly engine: QuotaEngine,
    @Inject(QUOTA_MODULE_OPTIONS) private readonly options: QuotaModuleOptions,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const meterOptions = this.reflector.get<QuotaMeterOptions | undefined>(
      QUOTA_METER_METADATA_KEY,
      context.getHandler(),
    );
    if (!meterOptions) return next.handle();

    return next.handle().pipe(
      tap((result) => {
        void (async () => {
          const amount = meterOptions.amountFromResult(result);
          if (!Number.isFinite(amount) || amount <= 0) return;
          const request = context.switchToHttp().getRequest();
          const subject = await this.options.identityResolver({ raw: context, policy: meterOptions.policy });
          await this.engine.recordUsage({
            applications: [{ policy: meterOptions.policy, subject, cost: Math.trunc(amount) }],
            context: request,
          });
        })();
      }),
    );
  }
}
