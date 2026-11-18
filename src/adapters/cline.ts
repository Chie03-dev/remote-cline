/**
 * ClineAdapter - reads-only adapter using Cline's exported API
 * WebSocket communication with Hub
 */

export interface AdapterInterface {
  startTask: (task: string) => Promise<void>
  sendMessage: (message: string) => Promise<void>
  approve: (askId: string) => Promise<boolean>
  reject: (askId: string, reason: string) => Promise<boolean>
  cancel: () => Promise<void>
  onEvent: (callback: (event: EventType) => void) => void
  getStatus: () => StatusState
}

export type EventType =
  | { type: "say"; text: string; partial: boolean }
  | { type: "think"; text: string }
  | { type: "ask"; id: string; kind: "command" | "edit" | "other"; text: string }
  | { type: "state"; status: "working" | "waiting" | "done"; progress?: number }

export type StatusState = { status: "working" | "waiting" | "done"; progress?: number }

export class ClineAdapter implements AdapterInterface {
  private ws: WebSocket
  private onEventCallback: ((event: EventType) => void) | null = null
  private readonly auditLog: (entry: string) => void
  private pendingAsks: Map<string, { kind: string; text: string; ts: number }> = new Map()
  private status: StatusState = { status: "done" }

  constructor(
    wsUrl: string,
    auditLog: (entry: string) => void
  ) {
    this.auditLog = auditLog
    this.ws = new WebSocket(wsUrl)
    this.ws.onopen = () => this.onWsOpen()
    this.ws.onmessage = (e) => this.onWsMessage(e)
    this.ws.onclose = () => this.onWsClose()
    this.ws.onerror = (ev) => this.onWsError(ev)
  }

  private onWsOpen = (): void => {
    this.auditLog("ClineAdapter: WebSocket opened")
  }

  private onWsMessage = (event: MessageEvent): void => {
    try {
      const data = JSON.parse(event.data as string)
      this.handleHubMessage(data)
    } catch (err) {
      this.auditLog("ERROR: parse hub message")
    }
  }

  private onWsClose = (): void => {
    this.auditLog("ClineAdapter: WebSocket closed")
  }

  private onWsError = (ev: Event): void => {
    this.auditLog("ClineAdapter: WebSocket error")
  }

  private sendWs = (msg: any): void => {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg))
      this.auditLog(`WS->HUB:${JSON.stringify(msg)}`)
    }
  }

  private handleHubMessage = (data: any): void => {
    const t = data.t
    switch (t) {
      case "say": {
        const ev: EventType = { type: "say", text: data.text || "", partial: data.partial !== false }
        this.auditLog(`HUB->SAY:${data.text?.substring(0, 50)}...`)
        this.onEventCallback?.(ev)
        break
      }
      case "think": {
        const ev: EventType = { type: "think", text: data.text || data.reasoning || "" }
        this.auditLog(`HUB->THINK:${data.text?.substring(0, 50)}...`)
        this.onEventCallback?.(ev)
        break
      }
      case "ask": {
        this.pendingAsks.set(data.id, { kind: data.kind, text: data.text || "", ts: Date.now() })
        const ev: EventType = { type: "ask", id: data.id, kind: data.kind, text: data.text || "" }
        this.auditLog(`HUB->ASK:${data.id}:${data.kind}`)
        this.onEventCallback?.(ev)
        break
      }
      case "state": {
        this.status = { status: data.status, progress: data.progress }
        const ev: EventType = { type: "state", status: data.status, progress: data.progress }
        this.auditLog(`HUB->STATE:${data.status}`)
        this.onEventCallback?.(ev)
        break
      }
      default:
        this.auditLog(`UNHANDLED:${JSON.stringify(data)}`)
    }
  }

  // ----- AdapterInterface -----

  startTask = async (task: string): Promise<void> => {
    this.auditLog(`startTask:${task}`)
    this.sendWs({ t: "prompt", agent: "cline", text: task })
  }

  sendMessage = async (message: string): Promise<void> => {
    this.auditLog(`sendMessage:${message}`)
    this.sendWs({ t: "message", agent: "cline", text: message })
  }

  approve = async (askId: string): Promise<boolean> => {
    const pending = this.pendingAsks.get(askId)
    if (!pending) {
      this.auditLog(`APPROVE ${askId}: FAIL - not pending`)
      this.sendWs({ t: "reject", agent: "cline", id: askId, reason: "not pending" })
      return false
    }
    this.auditLog(`APPROVE ${askId}:${pending.kind}`)
    this.sendWs({ t: "approve", agent: "cline", id: askId })
    this.pendingAsks.delete(askId)
    return true
  }

  reject = async (askId: string, reason: string): Promise<boolean> => {
    const pending = this.pendingAsks.get(askId)
    if (!pending) {
      this.auditLog(`REJECT ${askId}: FAIL - not pending`)
      this.sendWs({ t: "reject", agent: "cline", id: askId, reason })
      return false
    }
    this.auditLog(`REJECT ${askId}:${pending.kind} (${reason})`)
    this.sendWs({ t: "reject", agent: "cline", id: askId, reason })
    this.pendingAsks.delete(askId)
    return true
  }

  cancel = async (): Promise<void> => {
    this.auditLog("cancel")
    this.sendWs({ t: "cancel", agent: "cline" })
  }

  onEvent = (callback: (event: EventType) => void): void => {
    this.onEventCallback = callback
  }

  getStatus = (): StatusState => {
    return { ...this.status }
  }
}