export type SandboxStatus = 'creating' | 'running' | 'stopped' | 'destroyed' | 'error';

export interface SandboxResources {
  cpus: number;
  memoryMb: number;
  diskGb: number;
}

export interface VolumeMount {
  volumeId: string;
  path: string;
  readOnly?: boolean;
}

export interface SandboxSpec {
  name: string;
  image: string;
  env: Record<string, string>;
  resources: SandboxResources;
  volumes: VolumeMount[];
}

export interface Sandbox {
  id: string;
  name: string;
  status: SandboxStatus;
  createdAt: string;
  privateIp?: string;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface PortMapping {
  port: number;
  public: boolean;
}

export interface SandboxProvider {
  create(spec: SandboxSpec): Promise<Sandbox>;
  stop(id: string): Promise<void>;
  destroy(id: string): Promise<void>;
  get(id: string): Promise<Sandbox | null>;
  list(): Promise<Sandbox[]>;
  exec(id: string, cmd: string[]): Promise<ExecResult>;
  mount(id: string, mount: VolumeMount): Promise<void>;
  ports(id: string): Promise<PortMapping[]>;
}
