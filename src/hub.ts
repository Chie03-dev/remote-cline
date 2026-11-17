/**
 * Hub - Core routing and policy logic for Agent Bridge
 * 
 * Protocol (JSON over WebSocket):
   - phone to hub: {"t":"prompt","agent":"cline","text":""}, {"t":"message",...},
     {"t":"approve","agent":"cline","id":""}, {"t":"reject","agent":"cline","id":"","reason":""},
     {"t":"cancel","agent":"cline"}
   - hub to phone: {"t":"say","agent":"cline","text":"","partial":true},
     {"t":"think",...}, {"t":"ask","agent":"cline","id":"","kind":"command|edit|other","text":""},
     {"t":"state","agent":"cline","status":"working|waiting|done"}
 * 
 * Audit log: append JSONL to extension's global storage
 * Replay buffer: last 200 events in memory for reconnecting phones
 */

// ----- Types -----
export interface HubMessage {
  t: string
  [key: string]: any
}

export interface PolicyRule {
  match: string
  pattern: string
  action: "allow" | "ask" | "deny"
}

// ----- Hub Class -----
export class Hub {
  private ws: WebSocket | null = null
  private phoneWs: WebSocket | null = null
  private policy: PolicyRule[]
  private auditLog: (entry: string) => void
  private replayBuffer: Map<string, number> = new Map() // timestamp->messageKey
  private readonly maxReplay = 200
  private connectAttempts = 0
  private readonly maxReconnectAttempts = 10
  private readonly baseReconnectDelay = 1000

  private onPhoneMessage: (msg: HubMessage) => void = () => {}
  private onPhoneConnect: () => void = () => {}
  private onPhoneDisconnect: () => void = () => {}

  constructor(policy: PolicyRule[], auditLog: (entry: string) => void) {
    this.policy = policy
    this.auditLog = auditLog

    // Ensure default actions
    for (const rule of this.policy) {
      if (!rule.action) rule.action = "ask"
    }
  }

  setPhoneWebSocket = (ws: WebSocket): void => {
    this.phoneWs = ws
    this.phoneWs.onmessage = (event) => this.handlePhoneMessage(event)
    this.onPhoneConnect()
  }

  setOnPhoneMessage = (callback: (msg: HubMessage) => void): void => {
    this.onPhoneMessage = callback
  }

  setOnPhoneConnect = (callback: () => void): void => {
    this.onPhoneConnect = callback
  }

  setOnPhoneDisconnect = (callback: () => void): void => {
    this.onPhoneDisconnect = callback
  }

  connect = (wsUrl: string): void => {
    if (this.ws) return
    this.ws = new WebSocket(wsUrl)
    this.ws.onopen = () => this.onConnect()
    this.ws.onmessage = (event) => this.handleHubOutgoing(event)
    this.ws.onclose = () => this.onDisconnect()
    this.ws.onerror = (e) => this.onError(e)
    this.auditLog(`HUB: connected to ${wsUrl}`)
  }

  disconnect = (): void => {
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
    this.onPhoneDisconnect()
  }

  sendToPhone = (msg: HubMessage): void => {
    if (this.phoneWs && this.phoneWs.readyState === WebSocket.OPEN) {
      this.phoneWs.send(JSON.stringify(msg))
    }
  }

  private handlePhoneMessage = (event: MessageEvent): void => {
    try {
      const msg: HubMessage = JSON.parse(event.data as string)
      this.handleIncoming(msg)
    } catch (e) {
      this.auditLog(`ERROR: parse phone message: ${event.data}`)
    }
  }

  private handleIncoming(msg: HubMessage): void {
    this.auditLog(`PHONE->HUB:${JSON.stringify(msg)}`)
    this.onPhoneMessage(msg)

    const type = msg.t
    switch (type) {
      case "prompt":
      case "message": this.handlePromptMessage(msg); break
      case "approve": this.handleApprove(msg); break
      case "reject": this.handleReject(msg); break
      case "cancel": this.handleCancel(); break
      case "state": this.handleState(msg); break
      default: this.auditLog(`UNHANDLED: ${JSON.stringify(msg)}`)
    }
  }

  private handlePromptMessage(msg: HubMessage): void {
    const text = msg.text || ""
    const agent = msg.agent || "cline"

    const policyRule = this.policy.find((p) => this.matchesPattern(p.pattern, text))
    const action = policyRule?.action ?? "ask"

    this.auditLog(`POLICY:${agent}:${action}:${text.substring(0, 50)}...`)

    if (action === "allow") {
      this.auditLog(`AUTO-APPROVE: ${text.substring(0, 50)}...`)
      this.sendToPhone({ t: "state", agent: agent, status: "done" })
      return
    }
    if (action === "deny") {
      this.auditLog(`AUTO-REJECT: ${text.substring(0, 50)}...`)
      this.sendToPhone({ t: "state", agent: agent, status: "done" })
      return
    }

    // ask - forward to phone
    this.auditLog(`FORWARD:ask:${text.substring(0, 50)}...`)
    this.sendToPhone({
      t: "ask",
      agent: agent,
      id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      kind: "command",
      text: text
    })
  }

  private handleApprove(msg: HubMessage): void {
    this.auditLog(`APPROVE:${msg.id}`)
    this.sendToPhone({ t: "state", agent: "cline", status: "done" })
  }

  private handleReject(msg: HubMessage): void {
    this.auditLog(`REJECT:${msg.id}`)
    this.sendToPhone({ t: "state", agent: "cline", status: "done" })
  }

  private handleCancel(): void {
    this.auditLog(`CANCEL`)
    this.sendToPhone({ t: "state", agent: "cline", status: "done" })
  }

  private handleState(msg: HubMessage): void {
    this.auditLog(`STATE:${JSON.stringify(msg)}`)
    this.sendToPhone(msg)
  }

  private auditLogEntry = (entry: string): void => {
    this.auditLog(entry)
  }

  private matchesPattern = (pattern: string, text: string): boolean => {
    if (!pattern) return true
    try { return new RegExp(pattern, "i").test(text) } catch { return false }
  }
}