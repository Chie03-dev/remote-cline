/**
 * ClineAdapter - reads-only adapter using Cline's exported API
 * Directly wired to Hub (no WebSocket needed internally)
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

// Messages the adapter can receive from the Hub (via direct method calls)
export interface AdapterMessage {
  t: "prompt" | "message" | "approve" | "reject" | "cancel"
  agent?: string
  text?: string
  id?: string
  reason?: string
}

export class ClineAdapter implements AdapterInterface {
  private onEventCallback: ((event: EventType) => void) | null = null
  private readonly auditLog: (entry: string) => void
  private readonly sendToHub: (msg: AdapterMessage) => void
  private pendingAsks: Map<string, { kind: string; text: string; ts: number }> = new Map()
  private status: StatusState = { status: "done" }

  constructor(
    sendToHub: (msg: AdapterMessage) => void,
    auditLog: (entry: string) => void
  ) {
    this.auditLog = auditLog
    this.sendToHub = sendToHub
  }

  // ----- Incoming from Hub (called directly by extension.ts) -----

  handleMessage = (msg: AdapterMessage): void => {
    const t = msg.t
    switch (t) {
      case "prompt":
        this.auditLog(`HUB->PROMPT:${msg.text?.substring(0, 50)}...`)
        break
      case "message":
        this.auditLog(`HUB->MESSAGE:${msg.text?.substring(0, 50)}...`)
        break
      case "approve":
        this.auditLog(`HUB->APPROVE:${msg.id}`)
        break
      case "reject":
        this.auditLog(`HUB->REJECT:${msg.id}`)
        break
      case "cancel":
        this.auditLog(`HUB->CANCEL`)
        break
      default:
        this.auditLog(`UNHANDLED adapter msg:${JSON.stringify(msg)}`)
    }
  }

  // ----- Outgoing to Hub (events that Cline produces) -----

  private emit = (event: EventType): void => {
    this.onEventCallback?.(event)
  }

  // These are called by extension.ts when Cline's storage changes are detected
  // or when Cline's API produces output. The extension.ts wires these to actual Cline events.
  say = (text: string, partial?: boolean): void => {
    const ev: EventType = { type: "say", text, partial: partial !== false }
    this.auditLog(`SAY:${text.substring(0, 50)}...`)
    this.emit(ev)
  }

  think = (text: string): void => {
    const ev: EventType = { type: "think", text }
    this.auditLog(`THINK:${text.substring(0, 50)}...`)
    this.emit(ev)
  }

  ask = (id: string, kind: "command" | "edit" | "other", text: string): void => {
    this.pendingAsks.set(id, { kind, text, ts: Date.now() })
    const ev: EventType = { type: "ask", id, kind, text }
    this.auditLog(`ASK:${id}:${kind}`)
    this.emit(ev)
  }

  state = (status: "working" | "waiting" | "done", progress?: number): void => {
    this.status = { status, progress }
    const ev: EventType = { type: "state", status, progress }
    this.auditLog(`STATE:${status}`)
    this.emit(ev)
  }

  // ----- AdapterInterface -----

  startTask = async (task: string): Promise<void> => {
    this.auditLog(`startTask:${task}`)
    this.sendToHub({ t: "prompt", agent: "cline", text: task })
  }

  sendMessage = async (message: string): Promise<void> => {
    this.auditLog(`sendMessage:${message}`)
    this.sendToHub({ t: "message", agent: "cline", text: message })
  }

  approve = async (askId: string): Promise<boolean> => {
    const pending = this.pendingAsks.get(askId)
    if (!pending) {
      this.auditLog(`APPROVE ${askId}: FAIL - not pending`)
      this.sendToHub({ t: "reject", agent: "cline", id: askId, reason: "not pending" })
      return false
    }
    this.auditLog(`APPROVE ${askId}:${pending.kind}`)
    this.sendToHub({ t: "approve", agent: "cline", id: askId })
    this.pendingAsks.delete(askId)
    return true
  }

  reject = async (askId: string, reason: string): Promise<boolean> => {
    const pending = this.pendingAsks.get(askId)
    if (!pending) {
      this.auditLog(`REJECT ${askId}: FAIL - not pending`)
      this.sendToHub({ t: "reject", agent: "cline", id: askId, reason })
      return false
    }
    this.auditLog(`REJECT ${askId}:${pending.kind} (${reason})`)
    this.sendToHub({ t: "reject", agent: "cline", id: askId, reason })
    this.pendingAsks.delete(askId)
    return true
  }

  cancel = async (): Promise<void> => {
    this.auditLog("cancel")
    this.sendToHub({ t: "cancel", agent: "cline" })
  }

  onEvent = (callback: (event: EventType) => void): void => {
    this.onEventCallback = callback
  }

  getStatus = (): StatusState => {
    return { ...this.status }
  }
}