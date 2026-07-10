// src/client.ts — Public FrpClient class

import { ControlChannel } from './control/index.ts';
import type { IConfig } from './types.ts';

export class FrpClient {
    private ctl: ControlChannel;

    constructor(cfg: IConfig) {
        this.ctl = new ControlChannel(cfg);
    }

    /** Start the client. Runs indefinitely (reconnects on disconnect). */
    start(): Promise<void> { return this.ctl.run(); }

    /** Graceful shutdown */
    stop(): void { this.ctl.stop(); }
}
