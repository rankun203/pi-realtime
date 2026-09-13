import type { Server } from "node:http";
export function createDashboard(options?: { registryDir?: string; publicHost?: string }): Server;
export function discoverHelpers(directory: string): Promise<Array<{ id: string; port: number; project: string; sessions: Array<{ id: string; model: string; mode: string }> }>>;
