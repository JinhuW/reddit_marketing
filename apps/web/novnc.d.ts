// Minimal types for the parts of noVNC's RFB client that components/browsers/VncViewer.tsx uses.
// @novnc/novnc ships no declarations. API: https://github.com/novnc/noVNC/blob/v1.4.0/docs/API.md
declare module '@novnc/novnc/lib/rfb' {
  export interface RfbOptions {
    shared?: boolean;
    credentials?: { username?: string; password?: string; target?: string };
    wsProtocols?: string[];
  }
  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, urlOrChannel: string | WebSocket, options?: RfbOptions);
    viewOnly: boolean;
    scaleViewport: boolean;
    resizeSession: boolean;
    clipViewport: boolean;
    focusOnClick: boolean;
    qualityLevel: number;
    compressionLevel: number;
    background: string;
    disconnect(): void;
    sendCtrlAltDel(): void;
    sendCredentials(credentials: { username?: string; password?: string; target?: string }): void;
    clipboardPasteFrom(text: string): void;
    toDataURL(type?: string, encoderOptions?: number): string;
    focus(): void;
  }
}
