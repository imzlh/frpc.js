// src/protocol/message.ts — Message type constants + interfaces

export const MsgType = {
    Login:              0x6f, // 'o'
    LoginResp:          0x31, // '1'
    NewProxy:           0x70, // 'p'
    NewProxyResp:       0x32, // '2'
    CloseProxy:         0x63, // 'c'
    NewWorkConn:        0x77, // 'w'
    ReqWorkConn:        0x72, // 'r'
    StartWorkConn:      0x73, // 's'
    NewVisitorConn:     0x76, // 'v'
    NewVisitorConnResp: 0x33, // '3'
    Ping:               0x68, // 'h'
    Pong:               0x34, // '4'
    UDPPacket:          0x75, // 'u'
    NatHoleVisitor:     0x69, // 'i'
    NatHoleClient:      0x6e, // 'n'
    NatHoleResp:        0x6d, // 'm'
    NatHoleSid:         0x35, // '5'
    NatHoleReport:      0x36, // '6'
} as const;

export type MsgTypeByte = typeof MsgType[keyof typeof MsgType];

// ── Message interfaces ─────────────────────────────────────────────────────

export interface LoginMsg {
    version: string; hostname: string; os: string; arch: string;
    user: string; privilege_key: string; timestamp: number;
    run_id: string; client_id?: string; pool_count: number;
    metas: Record<string, string>;
    client_spec?: { type?: 'ssh-tunnel'; always_auth_pass?: boolean };
}

export interface LoginRespMsg {
    version: string; run_id: string; error: string;
}

export interface NewProxyMsg {
    proxy_name: string;
    proxy_type: 'tcp' | 'http' | 'https' | 'udp' | 'tcpmux' | 'stcp';
    use_encryption: boolean;
    use_compression: boolean;
    bandwidth_limit?: string;
    bandwidth_limit_mode?: 'server';
    group?: string;
    group_key?: string;
    metas?: Record<string, string>;
    annotations?: Record<string, string>;
    remote_port?: number;
    custom_domains?: string[];
    subdomain?: string;
    locations?: string[];
    http_user?: string;
    http_pwd?: string;
    host_header_rewrite?: string;
    headers?: Record<string, string>;
    response_headers?: Record<string, string>;
    route_by_http_user?: string;
    multiplexer?: string;
    sk?: string;
    allow_users?: string[];
}

export interface NewProxyRespMsg {
    proxy_name: string; remote_addr: string; error: string;
}

export interface NewWorkConnMsg {
    run_id: string; privilege_key?: string; timestamp?: number;
}

export interface StartWorkConnMsg {
    proxy_name: string;
    src_addr: string; src_port: number;
    dst_addr: string; dst_port: number;
    error: string;
    run_id?: string;
}

export interface NewVisitorConnMsg {
    run_id: string;
    proxy_name: string;
    sign_key: string;
    timestamp: number;
    use_encryption: boolean;
    use_compression: boolean;
}

export interface NewVisitorConnRespMsg {
    proxy_name: string;
    error: string;
}

export interface PingMsg { privilege_key?: string; timestamp?: number }
export interface PongMsg { error: string }
