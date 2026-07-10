// src/protocol/index.ts — Protocol layer public API

export { MsgType } from './message.ts';
export type { MsgTypeByte, LoginMsg, LoginRespMsg, NewProxyMsg, NewProxyRespMsg,
    NewWorkConnMsg, StartWorkConnMsg, NewVisitorConnMsg, NewVisitorConnRespMsg,
    PingMsg, PongMsg } from './message.ts';
export { readMsg, readMsgWithTail, writeMsg, pipeConn, MessageBuffer, MessageReader } from './codec.ts';
export type { MessageSocket } from './codec.ts';
export { genPrivKey } from './auth.ts';
export { createCryptoConn, createEncryptedConn } from './crypto.ts';
export { createCompressedConn } from './compression.ts';
export { createRateLimitedConn, RateLimitedConn, TokenBucket } from './limit.ts';
