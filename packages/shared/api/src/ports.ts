// Port exposure shapes shared between the server proxy/routes and the web UI.

export interface PortInfo {
  port: number;
  public: boolean;
  /** `https://<name>-<port>.<previewDomain>` or null when no preview domain is configured. */
  url: string | null;
}

export interface PortsListResponse {
  ports: PortInfo[];
}

export interface PortCreateBody {
  port: number;
}

export interface PortPatchBody {
  public: boolean;
}

export interface PreviewGrantResponse {
  /** Fixed preview-host endpoint that accepts the grant in a top-level POST body. */
  url: string;
  /** One-time opaque exchange code, scoped to the exact sandbox and port. */
  grant: string;
  expiresAt: number;
}
