// Open-core seam — see .claude/docs/architecture.md
// Pro package replaces this at composition time; core is always false.
export interface ProModules {
  has(id: string): boolean;
}

export const proModules: ProModules = { has: () => false };
