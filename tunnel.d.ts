export interface TunnelRuntimeStatusOptions {
  readonly manifestPath: string;
  readonly schemaVersion: number;
  readonly artifacts: Readonly<Record<string, string>>;
}

export interface TunnelRuntimeStatus {
  readonly state: "ready" | "missing" | "invalid";
}

export class TunnelRuntimeService {
  constructor(options: TunnelRuntimeStatusOptions);
  getStatus(): Promise<TunnelRuntimeStatus>;
}
