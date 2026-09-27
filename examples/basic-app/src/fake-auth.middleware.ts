import type { NestMiddleware } from '@nestjs/common';
import { Injectable } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

export interface AuthContext {
  tenantId: string;
  userId: string;
  plan: 'free' | 'pro';
}

const API_KEYS: Record<string, AuthContext> = {
  'free-tenant-key': { tenantId: 'tenant_free', userId: 'user_1', plan: 'free' },
  'pro-tenant-key': { tenantId: 'tenant_pro', userId: 'user_2', plan: 'pro' },
};

declare module 'express' {
  interface Request {
    auth?: AuthContext;
  }
}

/**
 * Stand-in for real authentication. In a real app this would validate a
 * JWT/session/API key against a database and attach the *authenticated*
 * identity to the request -- exactly the kind of already-authenticated
 * context `identityResolver` is meant to read from (see the README's
 * "Security considerations" section: never resolve identity from raw,
 * unauthenticated request fields).
 */
@Injectable()
export class FakeAuthMiddleware implements NestMiddleware {
  use(req: Request, _res: Response, next: NextFunction): void {
    const apiKey = req.header('x-api-key');
    const auth = apiKey ? API_KEYS[apiKey] : undefined;
    if (!auth) {
      next(new Error('unknown or missing x-api-key header'));
      return;
    }
    req.auth = auth;
    next();
  }
}
