// src/protocol/auth.ts — Authentication: MD5(token + timestamp) → hex

import { createHash } from 'node:crypto';

export function genPrivKey(token: string, ts: number): string {
    return createHash('md5').update(`${token}${ts}`).digest('hex');
}
