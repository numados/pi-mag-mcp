/**
 * Handler table: one entry per contract tool. server.ts registers only the
 * names declared in contract.ts, so the two lists cannot drift silently — the
 * contract test asserts every name has exactly one handler.
 */
import type { Context } from "../context.js";
import type { ToolResult } from "../types.js";
import type {
  CreateArgs,
  GetArgs,
  PbiStatusArgs,
  PrCreateArgs,
  PrListArgs,
  PrShowArgs,
  PrUpdateArgs,
  PrVoteArgs,
  QueryArgs,
  ReposArgs,
  StatusArgs,
  TaskCreateArgs,
  TaskDoneArgs,
  UpdateArgs,
} from "../contract.js";
import { devworkCreate, devworkGet, devworkQuery, devworkUpdate } from "./items.js";
import { devworkPrCreate, devworkPrList, devworkPrShow, devworkPrUpdate, devworkPrVote } from "./prs.js";
import { devworkRepos } from "./repos.js";
import { devworkStatus } from "./status.js";
import { devworkPbiStatus, devworkTaskCreate, devworkTaskDone } from "./tasks.js";

export type Handler = (args: Record<string, unknown>, ctx: Context) => Promise<ToolResult>;

export const HANDLERS: Record<string, Handler> = {
  devwork_status: (_args, ctx) => devworkStatus({} as StatusArgs, ctx),
  devwork_get: (args, ctx) => devworkGet(args as GetArgs, ctx),
  devwork_query: (args, ctx) => devworkQuery(args as QueryArgs, ctx),
  devwork_create: (args, ctx) => devworkCreate(args as CreateArgs, ctx),
  devwork_update: (args, ctx) => devworkUpdate(args as UpdateArgs, ctx),
  devwork_repos: (args, ctx) => devworkRepos(args as ReposArgs, ctx),
  devwork_pr_show: (args, ctx) => devworkPrShow(args as PrShowArgs, ctx),
  devwork_pr_list: (args, ctx) => devworkPrList(args as PrListArgs, ctx),
  devwork_pr_create: (args, ctx) => devworkPrCreate(args as PrCreateArgs, ctx),
  devwork_pr_update: (args, ctx) => devworkPrUpdate(args as PrUpdateArgs, ctx),
  devwork_pr_vote: (args, ctx) => devworkPrVote(args as PrVoteArgs, ctx),
  devwork_task_create: (args, ctx) => devworkTaskCreate(args as TaskCreateArgs, ctx),
  devwork_task_done: (args, ctx) => devworkTaskDone(args as TaskDoneArgs, ctx),
  devwork_pbi_status: (args, ctx) => devworkPbiStatus(args as PbiStatusArgs, ctx),
};
