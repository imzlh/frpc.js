// src/auth.ts - Client auth providers for frp control messages

import { genPrivKey } from './protocol/index.ts';
import type { AuthScope, IConfig, OIDCAuthConfig } from './types.ts';
import type { LoginMsg, NewWorkConnMsg, PingMsg } from './protocol/index.ts';

type LoginAuthFields = Pick<LoginMsg, 'privilege_key' | 'timestamp'>;

export interface ClientAuth {
    readonly encryptionKey: string;
    login(timestamp: number): Promise<LoginAuthFields>;
    ping(): Promise<Partial<PingMsg>>;
    newWorkConn(runId: string): Promise<NewWorkConnMsg>;
}

export function createClientAuth(cfg: IConfig): ClientAuth {
    const method = cfg.auth?.method ?? 'token';
    const token = cfg.auth?.token ?? cfg.token ?? '';
    const encryptionKey = cfg.token ?? cfg.auth?.token ?? '';
    const scopes = new Set(cfg.auth?.additionalScopes ?? []);

    if (method === 'oidc') {
        return new OIDCAuth(encryptionKey, scopes, cfg.auth?.oidc ?? {});
    }
    return new TokenAuth(token, encryptionKey, scopes);
}

class TokenAuth implements ClientAuth {
    constructor(
        readonly token: string,
        readonly encryptionKey: string,
        private scopes: Set<AuthScope>,
    ) {}

    async login(timestamp: number): Promise<LoginAuthFields> {
        return {
            privilege_key: await genPrivKey(this.token, timestamp),
            timestamp,
        };
    }

    async ping(): Promise<Partial<PingMsg>> {
        if (!this.scopes.has('HeartBeats')) return {};
        const timestamp = nowSeconds();
        return {
            privilege_key: await genPrivKey(this.token, timestamp),
            timestamp,
        };
    }

    async newWorkConn(runId: string): Promise<NewWorkConnMsg> {
        const msg: NewWorkConnMsg = { run_id: runId };
        if (!this.scopes.has('NewWorkConns')) return msg;

        const timestamp = nowSeconds();
        msg.timestamp = timestamp;
        msg.privilege_key = await genPrivKey(this.token, timestamp);
        return msg;
    }
}

class OIDCAuth implements ClientAuth {
    private cachedToken = '';
    private cachedUntil = 0;
    private pending: Promise<string> | undefined;

    constructor(
        readonly encryptionKey: string,
        private scopes: Set<AuthScope>,
        private cfg: OIDCAuthConfig,
    ) {}

    async login(timestamp: number): Promise<LoginAuthFields> {
        return {
            privilege_key: await this.accessToken(),
            timestamp,
        };
    }

    async ping(): Promise<Partial<PingMsg>> {
        if (!this.scopes.has('HeartBeats')) return {};
        return { privilege_key: await this.accessToken() };
    }

    async newWorkConn(runId: string): Promise<NewWorkConnMsg> {
        const msg: NewWorkConnMsg = { run_id: runId };
        if (!this.scopes.has('NewWorkConns')) return msg;
        msg.privilege_key = await this.accessToken();
        return msg;
    }

    private accessToken(): Promise<string> {
        if (this.cfg.tokenSource) return Promise.resolve(this.cfg.tokenSource());

        const now = Date.now();
        if (this.cachedToken && now < this.cachedUntil) return Promise.resolve(this.cachedToken);
        if (!this.pending) {
            this.pending = this.fetchToken().finally(() => {
                this.pending = undefined;
            });
        }
        return this.pending;
    }

    private async fetchToken(): Promise<string> {
        const endpoint = this.cfg.tokenEndpointURL;
        if (!endpoint) throw new Error('auth.oidc.tokenEndpointURL is required');
        if (!this.cfg.clientID) throw new Error('auth.oidc.clientID is required');
        if (!this.cfg.clientSecret) throw new Error('auth.oidc.clientSecret is required');

        const body = new URLSearchParams();
        body.set('grant_type', 'client_credentials');
        body.set('client_id', this.cfg.clientID);
        body.set('client_secret', this.cfg.clientSecret);
        if (this.cfg.scope) body.set('scope', this.cfg.scope);
        if (this.cfg.audience) body.set('audience', this.cfg.audience);
        for (const [key, value] of Object.entries(this.cfg.additionalEndpointParams ?? {})) {
            body.set(key, value);
        }

        const resp = await fetch(endpoint, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body,
        });
        const text = await resp.text();
        if (!resp.ok) {
            throw new Error(`OIDC token request failed: ${resp.status} ${text}`);
        }

        let parsed: unknown;
        try {
            parsed = JSON.parse(text);
        } catch {
            throw new Error('OIDC token response is not valid JSON');
        }
        const token = oidcAccessToken(parsed);
        const expiresIn = oidcExpiresIn(parsed);
        if (expiresIn !== undefined) {
            this.cachedToken = token;
            this.cachedUntil = Date.now() + Math.max(0, expiresIn - 10) * 1_000;
        }
        return token;
    }
}

function oidcAccessToken(value: unknown): string {
    if (typeof value !== 'object' || value === null) {
        throw new Error('OIDC token response must be an object');
    }
    const accessToken = (value as { access_token?: unknown }).access_token;
    if (typeof accessToken !== 'string' || accessToken === '') {
        throw new Error('OIDC token response missing access_token');
    }
    return accessToken;
}

function oidcExpiresIn(value: unknown): number | undefined {
    if (typeof value !== 'object' || value === null) return undefined;
    const expiresIn = (value as { expires_in?: unknown }).expires_in;
    if (typeof expiresIn === 'number' && Number.isFinite(expiresIn)) return expiresIn;
    if (typeof expiresIn === 'string' && expiresIn !== '') {
        const n = Number(expiresIn);
        if (Number.isFinite(n)) return n;
    }
    return undefined;
}

function nowSeconds(): number {
    return Math.floor(Date.now() / 1000);
}
