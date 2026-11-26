// Shapes shared by the document generators. Extras are fed by the caller from node kinds that lib/model.ts does not carry yet.
import type { Model, PlanConfig } from '../model.ts';
import type { DataPolicy } from './policy.ts';

export type Requirement = { id: string; text?: string; status?: string; kind?: string; priority?: string; acceptance?: string[]; satisfiedBy?: string[] };
export type Decision = { id: string; title?: string; status?: string; date?: string; affects?: string[]; supersedes?: string[]; derivation?: string };
export type Repo = { id: string; stack?: string[]; commands?: Record<string, string> };
export type Team = { id: string; name?: string; members?: string[]; owns?: string[] };
export type TaskEvent = { task: string; to?: string; at?: string; by?: string; evidence?: string[] };
export type Module = { repo: string; path: string; hotspot?: number; churn?: number; authors?: string[]; bus1?: boolean };
export type Extras = { requirements?: readonly Requirement[]; decisions?: readonly Decision[]; repos?: readonly Repo[]; teams?: readonly Team[]; events?: readonly TaskEvent[]; modules?: readonly Module[] };

export type Ctx = { extras: Extras; cfg: PlanConfig; policy: DataPolicy; key?: string };
export type Generator = {
  id: string;
  title: (key?: string) => string;
  v: number;
  /** relative output path under the docs out directory */
  out(cfg: PlanConfig, key?: string): string;
  /** one file per key (repo-page); absent for a single-file generator */
  keys?(model: Model, extras: Extras): string[];
  inputs(model: Model, c: Ctx): string[];
  render(model: Model, policy: DataPolicy, c: Ctx): string;
};
