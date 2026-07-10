// src/protocol/index.ts — Protocol layer public API

export { MsgType } from './message.ts';
export type { MsgTypeByte, LoginMsg, LoginRespMsg, NewProxyMsg, NewProxyRespMsg,
    NewWorkConnMsg, StartWorkConnMsg, NewVisitorConnMsg, NewVisitorConnRespMsg,
    PingMsg, PongMsg } from './message.ts';
export { readMsg, readMsgWithTail, writeMsg, pipeConn, MessageBuffer, MessageReader } from './codec.ts';
export type { MessageSocket } from './codec.ts';
export { V2_MAGIC, FRAME_TYPE_CLIENT_HELLO, FRAME_TYPE_SERVER_HELLO, FRAME_TYPE_MESSAGE, WireFrameBuffer, beginV2Handshake, readV2ServerHello, readWireFrame, writeV2Magic } from './wire.ts';
export type { WireFrame, V2BootstrapInfo, V2CryptoContext, WireProtocol } from './wire.ts';
export { genPrivKey } from './auth.ts';
export { createAeadCryptoConn, createCryptoConn, createEncryptedConn } from './crypto.ts';
export { createCompressedConn } from './compression.ts';
export { createRateLimitedConn, RateLimitedConn, TokenBucket } from './limit.ts';
