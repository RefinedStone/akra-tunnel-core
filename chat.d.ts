export interface CdpPort {
  attach(version: string): void;
  isAttached(): boolean;
  sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown>;
  on(event: string, listener: (...args: any[]) => void): unknown;
}

export interface PagePort {
  evaluate<A, R>(fn: (args: A) => R, args: A): Promise<Awaited<R>>;
  insertText(text: string): void | Promise<void>;
  focus(): void | Promise<void>;
  load(url: string): Promise<void>;
  url(): string | Promise<string>;
  assertActive?(): void;
  cdp?: CdpPort;
}

export interface HostLease {
  readonly active: boolean;
  release(): Promise<void>;
}

export function acquireHostLease(home: string): Promise<HostLease | null>;

export type ChatSession =
  | { mode: "new" | "temporary" }
  | { mode: "continue"; chatUrl: string };

export interface ChatRequest {
  requestId: string;
  session: ChatSession;
  instruction: string;
  maxResumes: number;
}

export type ChatPhase = "running" | "complete" | "stopped" | "failed" | "disconnected" | "blocked" | "unknown" | "load_failed";
export type ChatDelivery = "not_sent" | "sending" | "host_acknowledged" | "message_observed" | "progress_observed" | "send_uncertain";

export interface ChatObservation {
  requestId: string;
  delivery: ChatDelivery;
  phase: ChatPhase;
  evidence: "none" | "dom";
  recovery: "none" | "in_progress" | "exhausted";
  resumes: number;
  chatUrl?: string;
}

export class ChatSessionService {
  constructor(options: {
    home: string;
    lease: HostLease | null;
    pageFor(requestId: string): PagePort | Promise<PagePort>;
    readinessMs?: number;
  });
  status(): { host: boolean; reason?: "chat_host_busy" };
  submit(request: ChatRequest): Promise<ChatObservation>;
  /** Non-owners read only the last persisted observation; only the owner polls or recovers the page. */
  observe(requestId: string): Promise<ChatObservation | null>;
  readResult(requestId: string): Promise<string | null>;
  stop(requestId: string): Promise<ChatObservation | null>;
}
