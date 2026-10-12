import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';

/** A problem the person can fix; sent as `{ success: false, error }` with this status. */
export class UserError extends Error {
    constructor(message: string, readonly status = 400) {
        super(message);
    }
}

/** Express 5 forwards rejected promises to the error handler; this keeps handlers short. */
export function handler(fn: (req: Request, res: Response) => Promise<unknown>) {
    return async (req: Request, res: Response, next: NextFunction) => {
        try {
            const data = await fn(req, res);
            if (!res.headersSent) res.json({ success: true, data });
        } catch (error) {
            next(error);
        }
    };
}

/** Validate a body; a zod error becomes one readable UserError. */
export function parseBody<T extends z.ZodType>(schema: T, body: unknown): z.infer<T> {
    const result = schema.safeParse(body ?? {});
    if (!result.success) {
        const first = result.error.issues[0];
        const where = first.path.length ? `${first.path.join('.')}: ` : '';
        throw new UserError(`${where}${first.message}`);
    }
    return result.data;
}

/** Money and dates arrive as text (never JS numbers). */
export const zMoney = z.string().regex(/^-?[\d,]{1,16}(\.\d{1,2})?$/, 'must be an amount like 1200.50');
export const zDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a date YYYY-MM-DD');
